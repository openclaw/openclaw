// Sandbox security validation tests cover bind, network, seccomp, and AppArmor
// hardening rules before Docker runtimes are created.
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withEnv } from "../../test-utils/env.js";
import { resolveSandboxHostPathViaExistingAncestor } from "./host-paths.js";
import {
  getBlockedBindReason,
  validateNetworkMode,
  validateSandboxSecurity,
} from "./validate-sandbox-security.js";

type SandboxSecurityConfig = Parameters<typeof validateSandboxSecurity>[0];

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function validateBindMounts(
  binds: string[] | undefined,
  options?: Omit<SandboxSecurityConfig, "binds">,
): void {
  validateSandboxSecurity({ ...options, binds });
}

function bindResult(bind: string, options?: Omit<SandboxSecurityConfig, "binds">) {
  return expect(() => validateBindMounts([bind], options));
}

function homeAlias(credentialDir: string) {
  const dir = tempDirs.make("openclaw-home-");
  const realHome = join(dir, "real-home");
  const aliasHome = join(dir, "alias-home");
  mkdirSync(join(realHome, credentialDir), { recursive: true });
  symlinkSync(realHome, aliasHome);
  return { realHome, aliasHome };
}

function expectBlockedTargetReason(
  bind: string,
): Extract<NonNullable<ReturnType<typeof getBlockedBindReason>>, { kind: "targets" }> {
  const reason = getBlockedBindReason(bind);
  expect(reason?.kind).toBe("targets");
  if (reason?.kind !== "targets") {
    throw new Error(`expected blocked target reason for ${bind}`);
  }
  return reason;
}

describe("getBlockedBindReason", () => {
  it("blocks common Docker socket directories", () => {
    expectBlockedTargetReason("/run:/run");
    expectBlockedTargetReason("/var/run:/var/run:ro");
  });

  it("blocks parent sources that cover blocked descendants", () => {
    const reason = getBlockedBindReason("/var:/var");
    expect(reason).toMatchObject({ kind: "covers", blockedPath: "/var/run" });
  });

  it("blocks home parent sources that cover credential descendants", () => {
    withEnv({ HOME: "/home/tester" }, () => {
      const reason = getBlockedBindReason("/home/tester:/mnt/home:ro");
      expect(reason).toMatchObject({ kind: "covers", blockedPath: "/home/tester/.aws" });
    });
  });

  it("blocks sensitive home credential paths", () => {
    withEnv({ HOME: "/home/tester" }, () => {
      const cases = [
        "/home/tester/.aws/credentials",
        "/home/tester/.cargo/credentials.toml",
        "/home/tester/.config/gcloud",
        "/home/tester/.docker/config.json",
        "/home/tester/.gnupg/private-keys-v1.d",
        "/home/tester/.netrc",
        "/home/tester/.npm/_logs",
        "/home/tester/.ssh/config",
      ] as const;

      for (const source of cases) {
        expectBlockedTargetReason(`${source}:/mnt/test:ro`);
      }
    });
  });

  it("still blocks OS-home credential paths when OPENCLAW_HOME points elsewhere", () => {
    withEnv({ HOME: "/home/tester", OPENCLAW_HOME: "/srv/openclaw-home" }, () => {
      const reason = expectBlockedTargetReason("/home/tester/.gnupg/secring.gpg:/mnt/gnupg:ro");
      expect(reason?.blockedPath).toBe("/home/tester/.gnupg");
    });
  });

  it("blocks Windows USERPROFILE credential paths when HOME points elsewhere", () => {
    withEnv({ HOME: "D:\\Users\\shell-home", USERPROFILE: "C:\\Users\\tester" }, () => {
      const reason = expectBlockedTargetReason(
        "C:\\Users\\tester\\.docker\\config.json:/mnt/docker:ro",
      );
      expect(reason?.blockedPath).toBe("C:/Users/tester/.docker");
    });
  });

  it("blocks canonical OS-home aliases for credential paths", () => {
    if (process.platform === "win32") {
      return;
    }

    const { realHome, aliasHome } = homeAlias(".ssh");
    withEnv({ HOME: aliasHome }, () => {
      const reason = expectBlockedTargetReason(`${join(realHome, ".ssh", "config")}:/mnt/ssh:ro`);
      expect(reason?.blockedPath).toBe(normalizePathForSnapshot(join(realHome, ".ssh")));
    });
  });
});

describe("validateBindMounts", () => {
  it.runIf(process.platform !== "win32")(
    "distinguishes literal backslash roots and symlink escapes",
    () => {
      const root = tempDirs.make("openclaw-literal-bind-");
      const literal = join(root, "a\\b");
      const slash = join(root, "a/b");
      mkdirSync(literal);
      mkdirSync(slash, { recursive: true });
      symlinkSync(slash, join(literal, "escape"));
      bindResult(`${literal}:/data:ro`, { allowedSourceRoots: [literal] }).not.toThrow();
      for (const source of [slash, join(literal, "escape/missing")]) {
        bindResult(`${source}:/data:ro`, { allowedSourceRoots: [literal] }).toThrow(
          "outside allowed roots",
        );
      }
    },
  );

  it("allows legitimate project directory mounts", () => {
    const projectRoot = tempDirs.make("openclaw-sbx-safe-");
    expect(
      validateBindMounts([
        `${join(projectRoot, "source")}:/source:rw`,
        `${join(projectRoot, "projects")}:/projects:ro`,
        `${join(projectRoot, "data")}:/data`,
        `${join(projectRoot, "config")}:/config:ro`,
      ]),
    ).toBeUndefined();
  });

  it("allows undefined or empty binds", () => {
    expect(validateBindMounts(undefined)).toBeUndefined();
    expect(validateBindMounts([])).toBeUndefined();
  });

  it("blocks dangerous bind source paths", () => {
    const cases = [
      ["host root mount", "/:/mnt/host", /blocked path "\/"/],
      ["etc mount", "/etc/passwd:/mnt/passwd:ro", /blocked path "\/etc"/],
      ["proc mount", "/proc:/proc:ro", /blocked path "\/proc"/],
      ["docker socket in /var/run", "/var/run/docker.sock:/var/run/docker.sock", /docker\.sock/],
      ["docker socket in /run", "/run/docker.sock:/run/docker.sock", /docker\.sock/],
      ["parent /run mount", "/run:/run", /blocked path/],
      ["parent /var/run mount", "/var/run:/var/run", /blocked path/],
      ["traversal into /etc", "/home/user/../../etc/shadow:/mnt/shadow", /blocked path "\/etc"/],
      ["double-slash normalization into /etc", "//etc//passwd:/mnt/passwd", /blocked path "\/etc"/],
    ] as const;
    for (const [label, bind, expected] of cases) {
      expect(() => validateBindMounts([bind]), label).toThrow(expected);
    }
  });

  it("allows parent mounts that do not cover blocked descendants", () => {
    expect(validateBindMounts(["/var/data:/data"])).toBeUndefined();
  });

  it("blocks allowed source roots that cover blocked descendants", () => {
    bindResult("/var:/var", { allowedSourceRoots: ["/var"] }).toThrow(
      /covers blocked path "\/var\/run"/,
    );

    withEnv({ HOME: "/home/tester" }, () => {
      bindResult("/home/tester:/mnt/home:ro", { allowedSourceRoots: ["/home/tester"] }).toThrow(
        /covers blocked path "\/home\/tester\/\.aws"/,
      );
    });
  });

  it("blocks sensitive home credential binds", () => {
    withEnv({ HOME: "/home/tester" }, () => {
      bindResult("/home/tester/.docker/config.json:/mnt/docker:ro").toThrow(/blocked path/);
      bindResult("/home/tester/.netrc:/mnt/netrc:ro").toThrow(/blocked path/);
    });
  });

  it("allows drive-absolute Windows bind sources", () => {
    expect(validateBindMounts(["D:/data/openclaw/src:/src:ro"])).toBeUndefined();
    expect(validateBindMounts(["D:\\data\\openclaw\\output:/output:rw"])).toBeUndefined();
  });

  it("compares Windows allowed roots case-insensitively", () => {
    expect(
      validateBindMounts(["d:/DATA/OpenClaw/src:/src:ro"], {
        allowedSourceRoots: ["D:/data/openclaw"],
      }),
    ).toBeUndefined();
    bindResult("D:/other/project:/src:ro", { allowedSourceRoots: ["d:/data/openclaw"] }).toThrow(
      /outside allowed roots/,
    );
  });

  it("blocks credential binds through canonical home aliases", () => {
    if (process.platform === "win32") {
      return;
    }

    const { realHome, aliasHome } = homeAlias(".docker");
    withEnv({ HOME: aliasHome }, () => {
      bindResult(`${join(realHome, ".docker", "config.json")}:/mnt/docker:ro`).toThrow(
        /credential paths/,
      );
    });
  });

  it("blocks symlink escapes into blocked directories", () => {
    if (process.platform === "win32") {
      return;
    }

    const dir = tempDirs.make("openclaw-sbx-");
    const link = join(dir, "etc-link");
    symlinkSync("/etc", link);
    bindResult(`${link}/passwd:/mnt/passwd:ro`).toThrow(/blocked path/);
  });

  it("blocks symlink-parent escapes with non-existent leaf outside allowed roots", () => {
    // Docker may create the final leaf; validate the existing ancestor so
    // symlink parents cannot escape an allowed root.
    if (process.platform === "win32") {
      return;
    }
    const dir = tempDirs.make("openclaw-sbx-");
    const workspace = join(dir, "workspace");
    const outside = join(dir, "outside");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const link = join(workspace, "alias-out");
    symlinkSync(outside, link);
    const missingLeaf = join(link, "not-yet-created");
    bindResult(`${missingLeaf}:/mnt/data:ro`, { allowedSourceRoots: [workspace] }).toThrow(
      /outside allowed roots/,
    );
  });

  it("blocks symlink-parent escapes into blocked paths when leaf does not exist", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = tempDirs.make("openclaw-sbx-");
    const workspace = join(dir, "workspace");
    mkdirSync(workspace, { recursive: true });
    const link = join(workspace, "run-link");
    symlinkSync("/var/run", link);
    const missingLeaf = join(link, "openclaw-not-created");
    bindResult(`${missingLeaf}:/mnt/run:ro`, { allowedSourceRoots: [workspace] }).toThrow(
      /blocked path/,
    );
  });

  it.runIf(process.platform !== "win32")(
    "validates the exact spaced source and target instead of a trimmed sibling",
    () => {
      const root = tempDirs.make("openclaw-spaced-bind-");
      const plain = join(root, "allowed");
      const spaced = join(root, "allowed ");
      mkdirSync(plain);
      mkdirSync(spaced);
      bindResult(`${spaced}:/workspace `, { allowedSourceRoots: [spaced] }).not.toThrow();
      bindResult(`${spaced}:/data`, { allowedSourceRoots: [plain] }).toThrow(
        "outside allowed roots",
      );
      bindResult(`${plain}:/workspace`).toThrow("reserved container path");
      bindResult(` ${plain}:/data`).toThrow("non-absolute");
    },
  );

  it.runIf(process.platform !== "win32")(
    "checks spaced source symlinks against blocked and allowed roots",
    () => {
      const root = tempDirs.make("openclaw-spaced-bind-");
      const allowed = join(root, "allowed");
      const outside = join(root, "outside");
      mkdirSync(allowed);
      mkdirSync(outside);
      for (const [name, destination, error] of [
        ["blocked", "/etc", "blocked path"],
        ["external", outside, "outside allowed roots"],
      ] as const) {
        mkdirSync(join(allowed, name));
        symlinkSync(destination, join(allowed, `${name} `));
        bindResult(`${join(allowed, `${name} `)}:/data`, { allowedSourceRoots: [allowed] }).toThrow(
          error,
        );
      }
    },
  );

  it("rejects non-absolute source paths (relative or named volumes)", () => {
    const cases = ["../etc/passwd:/mnt/passwd", "etc/passwd:/mnt/passwd", "myvol:/mnt"] as const;
    for (const source of cases) {
      expect(() => validateBindMounts([source]), source).toThrow(/non-absolute/);
    }
  });

  it("blocks bind sources outside allowed roots when allowlist is configured", () => {
    const allowedRoot = tempDirs.make("openclaw-sbx-allowed-root-");
    const externalRoot = tempDirs.make("openclaw-sbx-external-");
    bindResult(`${externalRoot}:/data:ro`, { allowedSourceRoots: [allowedRoot] }).toThrow(
      /outside allowed roots/,
    );
  });

  it("allows bind sources in allowed roots when allowlist is configured", () => {
    const projectRoot = tempDirs.make("openclaw-sbx-allowed-");
    expect(
      validateBindMounts([`${join(projectRoot, "cache")}:/data:ro`], {
        allowedSourceRoots: [projectRoot],
      }),
    ).toBeUndefined();
  });

  it("allows bind sources outside allowed roots with explicit dangerous override", () => {
    const allowedRoot = tempDirs.make("openclaw-sbx-allowed-root-");
    const externalRoot = tempDirs.make("openclaw-sbx-external-");
    expect(
      validateBindMounts([`${externalRoot}:/data:ro`], {
        allowedSourceRoots: [allowedRoot],
        allowSourcesOutsideAllowedRoots: true,
      }),
    ).toBeUndefined();
  });

  it("blocks reserved container target paths by default", () => {
    const projectRoot = tempDirs.make("openclaw-sbx-reserved-default-");
    expect(() =>
      validateBindMounts([`${projectRoot}:/workspace:rw`, `${projectRoot}:/agent/cache:rw`]),
    ).toThrow(/reserved container path/);
  });

  it("allows reserved container target paths with explicit dangerous override", () => {
    const projectRoot = tempDirs.make("openclaw-sbx-reserved-");
    expect(
      validateBindMounts([`${projectRoot}:/workspace:rw`], {
        allowReservedContainerTargets: true,
      }),
    ).toBeUndefined();
  });
});

function normalizePathForSnapshot(input: string): string {
  return resolveSandboxHostPathViaExistingAncestor(input).replaceAll("\\", "/");
}

describe("validateNetworkMode", () => {
  it("allows bridge/none/custom/undefined", () => {
    expect(validateNetworkMode("bridge")).toBeUndefined();
    expect(validateNetworkMode("none")).toBeUndefined();
    expect(validateNetworkMode("my-custom-network")).toBeUndefined();
    expect(validateNetworkMode(undefined)).toBeUndefined();
  });

  it("blocks host mode (case-insensitive)", () => {
    for (const mode of ["host", "HOST"]) {
      expect(() => validateNetworkMode(mode), mode).toThrow(`network mode "${mode}" is blocked`);
    }
  });

  it("blocks container namespace joins by default", () => {
    for (const mode of ["container:abc123", "CONTAINER:ABC123"]) {
      expect(() => validateNetworkMode(mode), mode).toThrow(
        `network mode "${mode}" is blocked by default`,
      );
    }
  });

  it("allows container namespace joins with explicit dangerous override", () => {
    expect(
      validateNetworkMode("container:abc123", {
        allowContainerNamespaceJoin: true,
      }),
    ).toBeUndefined();
  });
});

describe("profile hardening", () => {
  it.each([
    {
      name: "seccomp",
      run: (seccompProfile: string) => validateSandboxSecurity({ seccompProfile }),
      expected: /seccomp profile ".+" is blocked/,
    },
    {
      name: "apparmor",
      run: (apparmorProfile: string) => validateSandboxSecurity({ apparmorProfile }),
      expected: /apparmor profile ".+" is blocked/,
    },
  ])("blocks unconfined profiles (case-insensitive): $name", ({ run, expected }) => {
    expect(() => run("unconfined")).toThrow(expected);
    expect(() => run("Unconfined")).toThrow(expected);
  });
});

describe("validateSandboxSecurity", () => {
  it("passes with safe config", () => {
    const projectRoot = tempDirs.make("openclaw-sbx-safe-config-");
    expect(
      validateSandboxSecurity({
        binds: [`${projectRoot}:/src:rw`],
        network: "none",
        seccompProfile: "/tmp/seccomp.json",
        apparmorProfile: "openclaw-sandbox",
      }),
    ).toBeUndefined();
  });
});
