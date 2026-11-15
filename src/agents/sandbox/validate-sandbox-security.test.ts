import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withEnv } from "../../test-utils/env.js";
import { validateNetworkMode, validateSandboxSecurity } from "./validate-sandbox-security.js";

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

function expectAllowedBind(bind: string, options?: Omit<SandboxSecurityConfig, "binds">) {
  expect(validateBindMounts([bind], options)).toBeUndefined();
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

describe("credential binds", () => {
  it("blocks sensitive home credential paths", () => {
    withEnv({ HOME: "/home/tester" }, () => {
      for (const source of [
        "/home/tester/.aws/credentials",
        "/home/tester/.cargo/credentials.toml",
        "/home/tester/.config/gcloud",
        "/home/tester/.docker/config.json",
        "/home/tester/.gnupg/private-keys-v1.d",
        "/home/tester/.netrc",
        "/home/tester/.npm/_logs",
        "/home/tester/.ssh/config",
      ]) {
        bindResult(`${source}:/mnt/test:ro`).toThrow(/blocked path/);
      }
    });
  });

  it("still blocks OS-home credential paths when OPENCLAW_HOME points elsewhere", () => {
    withEnv({ HOME: "/home/tester", OPENCLAW_HOME: "/srv/openclaw-home" }, () => {
      bindResult("/home/tester/.gnupg/secring.gpg:/mnt/gnupg:ro").toThrow(
        'blocked path "/home/tester/.gnupg"',
      );
    });
  });

  it("blocks Windows USERPROFILE credential paths when HOME points elsewhere", () => {
    withEnv({ HOME: "D:\\Users\\shell-home", USERPROFILE: "C:\\Users\\tester" }, () => {
      bindResult("C:\\Users\\tester\\.docker\\config.json:/mnt/docker:ro").toThrow(
        'blocked path "C:/Users/tester/.docker"',
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
    for (const [bind, expected] of [
      ["/:/mnt/host", /covers blocked path "\/"/],
      ["/etc/passwd:/mnt/passwd:ro", /targets blocked path "\/etc"/],
      ["/proc:/proc:ro", /blocked path "\/proc"/],
      ["/var/run/docker.sock:/var/run/docker.sock", /docker\.sock/],
      ["/run/docker.sock:/run/docker.sock", /docker\.sock/],
      ["/run:/run", /blocked path/],
      ["/var/run:/var/run", /blocked path/],
      ["/home/user/../../etc/shadow:/mnt/shadow", /blocked path "\/etc"/],
      ["//etc//passwd:/mnt/passwd", /blocked path "\/etc"/],
    ] as const) {
      bindResult(bind).toThrow(expected);
    }
  });

  it("blocks allowed source roots that cover blocked descendants", () => {
    withEnv({ HOME: "/home/tester" }, () => {
      for (const [root, blockedPath] of [
        ["/var", "/var/run"],
        ["/home/tester", "/home/tester/.aws"],
      ] as const) {
        const bind = `${root}:/mnt:ro`;
        bindResult(bind, { allowedSourceRoots: [root] }).toThrow(
          `covers blocked path "${blockedPath}"`,
        );
      }
    });
  });

  it("compares Windows allowed roots case-insensitively", () => {
    expectAllowedBind("d:/DATA/OpenClaw/src:/src:ro", { allowedSourceRoots: ["D:/data/openclaw"] });
    scopedBind("D:/other/project", "d:/data/openclaw", "/src:ro").toThrow(/outside allowed roots/);
  });

  it("blocks credential binds through canonical home aliases", () => {
    if (process.platform === "win32") {
      return;
    }

    const [realHome, aliasParent] = directories("real-home", "alias-parent");
    const aliasHome = join(aliasParent, "home");
    mkdirSync(join(realHome, ".docker"));
    symlinkSync(realHome, aliasHome);
    withEnv({ HOME: aliasHome }, () => {
      const bind = `${join(realHome, ".docker", "config.json")}:/mnt/docker:ro`;
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
    for (const source of ["../etc/passwd:/mnt/passwd", "etc/passwd:/mnt/passwd", "myvol:/mnt"]) {
      expect(() => validateBindMounts([source]), source).toThrow(/non-absolute/);
    }
  });

  it("blocks reserved container target paths by default", () => {
    const projectRoot = tempDirs.make("openclaw-sbx-reserved-default-");
    expect(() =>
      validateBindMounts([`${projectRoot}:/workspace:rw`, `${projectRoot}:/agent/cache:rw`]),
    ).toThrow(/reserved container path/);
  });

  it.each([
    ["project rw", "ROOT/source:/source:rw", {}],
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
    expectAllowedBind(binds.replace("ROOT", root), { allowedSourceRoots, ...options });
  });
});

describe("validateNetworkMode", () => {
  it.each(["my-custom-network", undefined])("allows network %s", (mode) => {
    expect(validateNetworkMode(mode)).toBeUndefined();
  });
  it.each(["HOST", "CONTAINER:ABC123"])("blocks network %s", (mode) => {
    const suffix = mode.toLowerCase().startsWith("container:") ? " by default" : "";
    expect(() => validateNetworkMode(mode), mode).toThrow(
      `network mode "${mode}" is blocked${suffix}`,
    );
  });

  it("allows container namespace joins with explicit dangerous override", () => {
    expect(
      validateNetworkMode("container:abc123", { allowContainerNamespaceJoin: true }),
    ).toBeUndefined();
  });
});

describe("profile hardening", () => {
  it.each(["seccomp", "apparmor"] as const)("blocks unconfined %s profiles", (name) => {
    const profile = "Unconfined";
    const config = name === "seccomp" ? { seccompProfile: profile } : { apparmorProfile: profile };
    expect(() => validateSandboxSecurity(config)).toThrow(
      `${name} profile "${profile}" is blocked`,
    );
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
