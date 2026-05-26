import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodexAppServerStartOptions } from "./config.js";
import {
  resolveCodexAppServerSpawnEnv,
  resolveCodexAppServerSpawnInvocation,
  resolveCodexAppServerWorkerScopeSpawn,
} from "./transport-stdio.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-codex-spawn-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function startOptions(command: string): CodexAppServerStartOptions {
  return {
    transport: "stdio",
    command,
    args: ["app-server", "--listen", "stdio://"],
    headers: {},
  };
}

describe("resolveCodexAppServerSpawnInvocation", () => {
  it("keeps non-Windows Codex app-server invocation unchanged", () => {
    const resolved = resolveCodexAppServerSpawnInvocation(startOptions("codex"), {
      platform: "darwin",
      env: {},
      execPath: "/usr/local/bin/node",
    });

    expect(resolved).toEqual({
      command: "codex",
      args: ["app-server", "--listen", "stdio://"],
      shell: undefined,
      windowsHide: undefined,
    });
  });

  it("requires managed Codex commands to be resolved before spawn", () => {
    expect(() =>
      resolveCodexAppServerSpawnInvocation(
        {
          ...startOptions("codex"),
          commandSource: "managed",
        },
        {
          platform: "darwin",
          env: {},
          execPath: "/usr/local/bin/node",
        },
      ),
    ).toThrow("must be resolved before spawn");
  });

  it("resolves Windows npm .cmd Codex shims through Node instead of raw spawn", async () => {
    const binDir = await createTempDir();
    const entryPath = path.join(binDir, "node_modules", "@openai", "codex", "bin", "codex.js");
    const shimPath = path.join(binDir, "codex.cmd");
    await mkdir(path.dirname(entryPath), { recursive: true });
    await writeFile(entryPath, "console.log('codex')\n", "utf8");
    await writeFile(
      shimPath,
      '@ECHO off\r\n"%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
      "utf8",
    );

    const resolved = resolveCodexAppServerSpawnInvocation(startOptions("codex"), {
      platform: "win32",
      env: { PATH: binDir, PATHEXT: ".CMD;.EXE;.BAT" },
      execPath: "C:\\node\\node.exe",
    });

    expect(resolved).toEqual({
      command: "C:\\node\\node.exe",
      args: [entryPath, "app-server", "--listen", "stdio://"],
      shell: undefined,
      windowsHide: true,
    });
  });

  it("rejects Windows Codex app-server commands that include inline script arguments", () => {
    expect(() =>
      resolveCodexAppServerSpawnInvocation(
        startOptions(
          "node C:\\Users\\me\\.openclaw\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
        ),
        {
          platform: "win32",
          env: {},
          execPath: "C:\\node\\node.exe",
        },
      ),
    ).toThrow("Windows spawn command must be an executable path only");
  });
});

describe("resolveCodexAppServerSpawnEnv", () => {
  it("applies configured env overrides before clearing denied env vars", () => {
    expect({
      ...resolveCodexAppServerSpawnEnv(
        {
          env: {
            OPENAI_API_KEY: "configured-openai-key",
            KEEP: "override",
          },
          clearEnv: ["OPENAI_API_KEY", "CODEX_API_KEY", "MISSING"],
        },
        {
          OPENAI_API_KEY: "parent-openai-key",
          CODEX_API_KEY: "parent-codex-key",
          KEEP: "parent",
        },
      ),
    }).toEqual({
      KEEP: "override",
    });
  });

  it("clears denied env vars case-insensitively on Windows", () => {
    expect({
      ...resolveCodexAppServerSpawnEnv(
        {
          env: {
            OpenAI_Api_Key: "configured-openai-key",
            Other: "configured",
          },
          clearEnv: ["OPENAI_API_KEY", " CODEX_API_KEY ", ""],
        },
        {
          Codex_Api_Key: "parent-codex-key",
          KEEP: "parent",
        },
        "win32",
      ),
    }).toEqual({
      KEEP: "parent",
      Other: "configured",
    });
  });

  it("uses a null-prototype env map and ignores prototype-polluting keys", () => {
    const overrides = Object.create(null) as Record<string, string | undefined>;
    Object.defineProperty(overrides, "__proto__", {
      value: "polluted",
      enumerable: true,
    });
    Object.defineProperty(overrides, "constructor", {
      value: "polluted",
      enumerable: true,
    });
    Object.defineProperty(overrides, "prototype", {
      value: "polluted",
      enumerable: true,
    });
    overrides.SAFE = "1";

    const env = resolveCodexAppServerSpawnEnv(
      {
        env: overrides as Record<string, string>,
      },
      {
        BASE: "1",
      },
    );

    expect(Object.getPrototypeOf(env)).toBeNull();
    expect({ ...env }).toEqual({
      BASE: "1",
      SAFE: "1",
    });
    expect(Object.hasOwn(env, "__proto__")).toBe(false);
    expect(Object.hasOwn(env, "constructor")).toBe(false);
    expect(Object.hasOwn(env, "prototype")).toBe(false);
  });
});

describe("resolveCodexAppServerWorkerScopeSpawn", () => {
  it("wraps Codex app-server launches in a user systemd worker scope on Linux services", () => {
    const resolved = resolveCodexAppServerWorkerScopeSpawn({
      command: "/opt/codex/bin/codex",
      args: ["app-server", "--listen", "stdio://"],
      env: {
        OPENCLAW_SERVICE_MARKER: "openclaw",
        KEEP: "1",
      },
      platform: "linux",
      systemdRunPath: "/usr/bin/systemd-run",
      systemdRunExists: () => true,
    });

    expect(resolved).toEqual({
      command: "/usr/bin/systemd-run",
      args: [
        "--user",
        "--scope",
        "--quiet",
        "--property=Slice=openclaw-workers.slice",
        "--property=CollectMode=inactive-or-failed",
        "--",
        "/opt/codex/bin/codex",
        "app-server",
        "--listen",
        "stdio://",
      ],
      env: {
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_CHILD_SYSTEMD_SCOPE: "0",
        KEEP: "1",
      },
      wrapped: true,
    });
  });

  it("does not wrap when the worker scope opt-out is set", () => {
    const resolved = resolveCodexAppServerWorkerScopeSpawn({
      command: "codex",
      args: ["app-server", "--listen", "stdio://"],
      env: {
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_CHILD_SYSTEMD_SCOPE: "0",
      },
      platform: "linux",
      systemdRunPath: "/usr/bin/systemd-run",
      systemdRunExists: () => true,
    });

    expect(resolved).toEqual({
      command: "codex",
      args: ["app-server", "--listen", "stdio://"],
      env: {
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_CHILD_SYSTEMD_SCOPE: "0",
      },
      wrapped: false,
    });
  });

  it("does not wrap outside Linux service-managed runtime", () => {
    const resolved = resolveCodexAppServerWorkerScopeSpawn({
      command: "codex",
      args: ["app-server", "--listen", "stdio://"],
      env: {
        OPENCLAW_SERVICE_MARKER: "openclaw",
      },
      platform: "darwin",
      systemdRunExists: () => true,
    });

    expect(resolved.wrapped).toBe(false);
    expect(resolved.command).toBe("codex");
  });
});
