import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerStartOptions } from "./config.js";
import {
  createStdioTransport,
  resolveCodexAppServerSpawnEnv,
  withCodexAppServerGitConfig,
} from "./transport-stdio.js";

const spawnMock = vi.hoisted(() => vi.fn(() => ({ pid: 1234 })));
const prepareRegistration = vi.hoisted(() => vi.fn(async () => async () => {}));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("./transport-process-registration.js", () => ({
  prepareCodexAppServerProcessRegistration: prepareRegistration,
}));

beforeEach(() => {
  spawnMock.mockClear();
  prepareRegistration.mockReset().mockResolvedValue(async () => {});
});
afterEach(() => vi.unstubAllEnvs());

function startOptions(command: string): CodexAppServerStartOptions {
  return {
    transport: "stdio",
    command,
    args: ["app-server", "--listen", "stdio://"],
    headers: {},
  };
}

describe("createStdioTransport", () => {
  it("does not let a missing working directory poison another launch of the same executable", async () => {
    const options = startOptions("/installed/cwd-fixture/codex");
    spawnMock.mockImplementationOnce(() => {
      throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT", syscall: "spawn" });
    });
    await expect(createStdioTransport({ ...options, cwd: "/missing" })).rejects.toThrow(
      "working directory",
    );
    await expect(createStdioTransport({ ...options, cwd: "/available" })).resolves.toMatchObject({
      pid: 1234,
    });
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("runs the managed package launcher with the current interpreter, independent of PATH", async () => {
    const command = "/installed/node_modules/@openai/codex/bin/codex.js";
    await createStdioTransport(
      { ...startOptions(command), commandSource: "resolved-managed" },
      { PATH: "/wrong-architecture/bin" },
    );
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [command, "app-server", "--listen", "stdio://"],
      expect.any(Object),
    );
  });

  it.each([
    { errno: -86, code: "Unknown system error -86", reason: "is not runnable on this CPU" },
    { code: "ENOENT", reason: "or its working directory was not found" },
    { code: "EACCES", reason: "is not executable" },
  ])(
    "identifies a terminal $code spawn failure without exposing arguments",
    async ({ reason, ...fields }) => {
      const command = `/installed/${fields.code}/codex`;
      const failure = Object.assign(new Error("spawn failed"), { ...fields, syscall: "spawn" });
      spawnMock.mockImplementationOnce(() => {
        throw failure;
      });
      await expect(createStdioTransport(startOptions(command))).rejects.toMatchObject({
        message: expect.stringContaining(`${command} ${reason}`),
        cause: failure,
      });
      vi.resetModules();
      const reloaded = await import("./transport-stdio.js");
      await expect(reloaded.createStdioTransport(startOptions(command))).rejects.toMatchObject({
        cause: failure,
      });
      expect(spawnMock).toHaveBeenCalledOnce();
    },
  );

  it("rechecks authority after orphan cleanup before spawning", async () => {
    let active = true;
    prepareRegistration.mockImplementationOnce(async () => {
      active = false;
      return async () => {};
    });
    await expect(
      createStdioTransport(startOptions("codex"), {}, () => {
        if (!active) {
          throw new Error("owner closed");
        }
      }),
    ).rejects.toThrow("owner closed");
    expect(spawnMock).not.toHaveBeenCalled();
  });
  it.each<{
    lifeline?: string;
    detached: boolean;
    childOptions?: Pick<CodexAppServerStartOptions, "env" | "clearEnv">;
  }>([
    {
      lifeline: " stdin ",
      childOptions: { clearEnv: ["OPENCLAW_GATEWAY_HOST_LIFELINE"] },
      detached: false,
    },
    {
      childOptions: { env: { OPENCLAW_GATEWAY_HOST_LIFELINE: "stdin" } },
      detached: true,
    },
  ])(
    "spawns an endpoint with host lifeline $lifeline and child overrides $childOptions",
    async ({ lifeline, detached, childOptions }) => {
      await createStdioTransport(
        { ...startOptions("codex"), cwd: "/srv/codex-project", ...childOptions },
        { OPENCLAW_GATEWAY_HOST_LIFELINE: lifeline },
      );

      expect(spawnMock).toHaveBeenCalledWith(
        "codex",
        ["app-server", "--listen", "stdio://"],
        expect.objectContaining({
          cwd: "/srv/codex-project",
          detached: process.platform !== "win32" && detached,
        }),
      );
    },
  );

  it("preserves wrapper prefixes, root option values, and raw override ordering", async () => {
    const overrides = ["-c", 'developer_instructions="app-server = literal"'];
    const args = [
      "/wrapper.js",
      ...overrides,
      "--profile",
      "app-server",
      "app-server",
      "--listen",
      "stdio://",
      "--config=model_reasoning_effort=high",
    ];
    await createStdioTransport({ ...startOptions("node"), args });

    expect(spawnMock).toHaveBeenCalledWith(
      "node",
      [
        "/wrapper.js",
        ...overrides,
        "--profile",
        "app-server",
        "--config=model_reasoning_effort=high",
        "app-server",
        "--listen",
        "stdio://",
      ],
      expect.any(Object),
    );
    expect(args[1]).toBe("-c");
  });

  it("does not reinterpret a wrapper's positional arguments after --", async () => {
    const args = ["/wrapper.js", "--", "-c", "opaque", "app-server"];
    await createStdioTransport({ ...startOptions("node"), args });
    expect(spawnMock).toHaveBeenCalledWith("node", args, expect.any(Object));
  });

  it("preserves a subcommand-shaped socket value", async () => {
    await createStdioTransport({
      ...startOptions("codex"),
      args: ["app-server", "proxy", "--sock", "app-server", "-c", "model_reasoning_effort=high"],
    });
    expect(spawnMock.mock.calls[0]?.slice(0, 2)).toEqual([
      "codex",
      ["-c", "model_reasoning_effort=high", "app-server", "proxy", "--sock", "app-server"],
    ]);
  });
});

describe("resolveCodexAppServerSpawnEnv", () => {
  it.each([
    { label: "configured", parameters: "'user.name=Process'", clear: false, preserve: true },
    { label: "empty", parameters: "", clear: false, preserve: false },
    { label: "cleared", parameters: "'user.name=Process'", clear: true, preserve: false },
    {
      label: "already prepared",
      parameters: "'user.name=Process' 'maintenance.auto=false' 'gc.auto=0'",
      clear: false,
      preserve: true,
    },
  ])("preserves $label Git settings when preparing the private process", (fixture) => {
    vi.stubEnv("GIT_CONFIG_PARAMETERS", "'user.name=Ambient'");
    const parameters = "'maintenance.auto=false' 'gc.auto=0'";
    const original = {
      ...startOptions("codex"),
      env: {
        GIT_CONFIG_PARAMETERS: fixture.parameters,
        OPENCLAW_GIT_ENV_DROP: "fixture",
      },
      clearEnv: ["OPENCLAW_GIT_ENV_DROP", ...(fixture.clear ? ["GIT_CONFIG_PARAMETERS"] : [])],
    };
    const prepared = withCodexAppServerGitConfig(original, parameters);
    const refreshed = withCodexAppServerGitConfig(prepared, parameters);
    const env = resolveCodexAppServerSpawnEnv(refreshed);
    expect(env.GIT_CONFIG_PARAMETERS).toBe(
      fixture.preserve ? `'user.name=Process' ${parameters}` : parameters,
    );
    expect(env.OPENCLAW_GIT_ENV_DROP).toBeUndefined();
    expect(original.env.GIT_CONFIG_PARAMETERS).toBe(fixture.parameters);
  });

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

  it("strips inherited runtime loader injection before spawn", () => {
    expect({
      ...resolveCodexAppServerSpawnEnv(
        {
          env: {
            NODE_PATH: "/configured/node_modules",
            DYLD_INSERT_LIBRARIES: "/configured/inject.dylib",
          },
        },
        {
          NODE_PATH: "/ambient/node_modules",
          LD_PRELOAD: "/ambient/inject.so",
          KEEP: "safe",
        },
      ),
    }).toEqual({ KEEP: "safe" });
  });

  it("uses a null-prototype env map and ignores prototype-polluting keys", () => {
    const overrides: Record<string, string> = JSON.parse(
      '{"__proto__":"polluted","constructor":"polluted","prototype":"polluted","SAFE":"1"}',
    );

    const env = resolveCodexAppServerSpawnEnv(
      {
        env: overrides,
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
