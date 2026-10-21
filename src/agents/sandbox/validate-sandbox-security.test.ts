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

function directories(first: string, second: string) {
  const root = tempDirs.make("openclaw-bind-");
  const make = (name: string) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  return [make(first), make(second)] as const;
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

  it.each([undefined, []])("allows absent binds: %s", (binds) => {
    expect(validateBindMounts(binds)).toBeUndefined();
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
      expect(getBlockedBindReason(bind)?.kind).toBe(
        label === "host root mount" ? "covers" : "targets",
      );
    }
  });

  it("blocks allowed source roots that cover blocked descendants", () => {
    withEnv({ HOME: "/home/tester" }, () => {
      for (const [root, blockedPath] of [
        ["/var", "/var/run"],
        ["/home/tester", "/home/tester/.aws"],
      ] as const) {
        const bind = `${root}:/mnt:ro`;
        expect(getBlockedBindReason(bind)).toMatchObject({ kind: "covers", blockedPath });
        bindResult(bind, { allowedSourceRoots: [root] }).toThrow(
          `covers blocked path "${blockedPath}"`,
        );
      }
    });
  });

  it("blocks sensitive home credential binds", () => {
    withEnv({ HOME: "/home/tester" }, () => {
      bindResult("/home/tester/.docker/config.json:/mnt/docker:ro").toThrow(/blocked path/);
      bindResult("/home/tester/.netrc:/mnt/netrc:ro").toThrow(/blocked path/);
    });
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
      const bind = `${join(realHome, ".docker", "config.json")}:/mnt/docker:ro`;
      expect(getBlockedBindReason(bind)).toMatchObject({
        kind: "targets",
        blockedPath: resolveSandboxHostPathViaExistingAncestor(
          join(realHome, ".docker"),
        ).replaceAll("\\", "/"),
      });
      bindResult(bind).toThrow(/credential paths/);
    });
  });

  it.each([
    ["/etc", "passwd", "blocked path"],
    [null, "not-yet-created", "outside allowed roots"],
    ["/var/run", "openclaw-not-created", "blocked path"],
  ] as const)("blocks symlink escape into %s/%s", (destination, leaf, error) => {
    if (process.platform === "win32") {
      return;
    }
    const [workspace, outside] = directories("workspace", "outside");
    const link = join(workspace, "escape");
    symlinkSync(destination ?? outside, link);
    bindResult(`${join(link, leaf)}:/mnt/data:ro`, { allowedSourceRoots: [workspace] }).toThrow(
      error,
    );
  });

  it.runIf(process.platform !== "win32")(
    "validates the exact spaced source and target instead of a trimmed sibling",
    () => {
      const [plain, spaced] = directories("allowed", "allowed ");
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
      const [allowed, outside] = directories("allowed", "outside");
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
    const [allowedRoot, externalRoot] = directories("allowed", "external");
    bindResult(`${externalRoot}:/data:ro`, { allowedSourceRoots: [allowedRoot] }).toThrow(
      /outside allowed roots/,
    );
  });

  it("blocks reserved container target paths by default", () => {
    const projectRoot = tempDirs.make("openclaw-sbx-reserved-default-");
    expect(() =>
      validateBindMounts([`${projectRoot}:/workspace:rw`, `${projectRoot}:/agent/cache:rw`]),
    ).toThrow(/reserved container path/);
  });

  it.each([
    ["project rw", "ROOT/source:/source:rw", {}],
    ["project ro", "ROOT/projects:/projects:ro", {}],
    ["project default", "ROOT/data:/data", {}],
    ["project config", "ROOT/config:/config:ro", {}],
    ["non-sensitive parent", "/var/data:/data", {}],
    ["Windows forward slash", "D:/data/openclaw/src:/src:ro", {}],
    ["Windows backslash", "D:\\data\\openclaw\\output:/output:rw", {}],
    ["allowed root", "ROOT/cache:/data:ro", {}],
    [
      "outside-root override",
      "ROOT/../external:/data:ro",
      { allowSourcesOutsideAllowedRoots: true },
    ],
    ["reserved-target override", "ROOT:/workspace:rw", { allowReservedContainerTargets: true }],
  ] as const)("accepts %s", (name, binds, options) => {
    const [root] = directories("allowed", "external");
    const allowedSourceRoots =
      name === "allowed root" || name === "outside-root override" ? [root] : undefined;
    expect(
      validateBindMounts([binds.replace("ROOT", root)], { allowedSourceRoots, ...options }),
    ).toBeUndefined();
  });
});

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
  it.each(["seccomp", "apparmor"] as const)("blocks unconfined %s profiles", (name) => {
    for (const profile of ["unconfined", "Unconfined"]) {
      const config =
        name === "seccomp" ? { seccompProfile: profile } : { apparmorProfile: profile };
      expect(() => validateSandboxSecurity(config)).toThrow(
        `${name} profile "${profile}" is blocked`,
      );
    }
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
