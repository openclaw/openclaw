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

function scopedBind(source: string, root: string, target = "/data:ro") {
  return bindResult(`${source}:${target}`, { allowedSourceRoots: [root] });
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

function expectBlockedTarget(bind: string, blockedPath?: string) {
  expect(getBlockedBindReason(bind)).toMatchObject({
    kind: "targets",
    ...(blockedPath ? { blockedPath } : {}),
  });
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
        expectBlockedTarget(`${source}:/mnt/test:ro`);
        bindResult(`${source}:/mnt/test:ro`).toThrow(/blocked path/);
      }
    });
  });

  it("still blocks OS-home credential paths when OPENCLAW_HOME points elsewhere", () => {
    withEnv({ HOME: "/home/tester", OPENCLAW_HOME: "/srv/openclaw-home" }, () => {
      expectBlockedTarget("/home/tester/.gnupg/secring.gpg:/mnt/gnupg:ro", "/home/tester/.gnupg");
    });
  });

  it("blocks Windows USERPROFILE credential paths when HOME points elsewhere", () => {
    withEnv({ HOME: "D:\\Users\\shell-home", USERPROFILE: "C:\\Users\\tester" }, () => {
      expectBlockedTarget(
        "C:\\Users\\tester\\.docker\\config.json:/mnt/docker:ro",
        "C:/Users/tester/.docker",
      );
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
      scopedBind(literal, literal).not.toThrow();
      for (const source of [slash, join(literal, "escape/missing")]) {
        scopedBind(source, literal).toThrow("outside allowed roots");
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

  it("compares Windows allowed roots case-insensitively", () => {
    expect(
      validateBindMounts(["d:/DATA/OpenClaw/src:/src:ro"], {
        allowedSourceRoots: ["D:/data/openclaw"],
      }),
    ).toBeUndefined();
    scopedBind("D:/other/project", "d:/data/openclaw", "/src:ro").toThrow(/outside allowed roots/);
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
    scopedBind(join(link, leaf), workspace, "/mnt/data:ro").toThrow(error);
  });

  it.runIf(process.platform !== "win32")(
    "validates the exact spaced source and target instead of a trimmed sibling",
    () => {
      const [plain, spaced] = directories("allowed", "allowed ");
      scopedBind(spaced, spaced, "/workspace ").not.toThrow();
      scopedBind(spaced, plain, "/data").toThrow("outside allowed roots");
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
        scopedBind(join(allowed, `${name} `), allowed, "/data").toThrow(error);
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
    scopedBind(externalRoot, allowedRoot).toThrow(/outside allowed roots/);
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
  it.each(["bridge", "none", "my-custom-network", undefined])("allows network %s", (mode) => {
    expect(validateNetworkMode(mode)).toBeUndefined();
  });
  it.each(["host", "HOST", "container:abc123", "CONTAINER:ABC123"])("blocks network %s", (mode) => {
    const suffix = mode.toLowerCase().startsWith("container:") ? " by default" : "";
    expect(() => validateNetworkMode(mode), mode).toThrow(
      `network mode "${mode}" is blocked${suffix}`,
    );
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
