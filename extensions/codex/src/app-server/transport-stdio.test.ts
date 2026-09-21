// Codex tests cover transport stdio plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerStartOptions } from "./config.js";
import { createStdioTransport, resolveCodexAppServerSpawnEnv } from "./transport-stdio.js";

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
  it("spawns a compatibility endpoint in its configured working directory", async () => {
    await createStdioTransport({
      ...startOptions("codex"),
      cwd: "/srv/codex-project",
    });

    expect(spawnMock).toHaveBeenCalledWith(
      "codex",
      ["app-server", "--listen", "stdio://"],
      expect.objectContaining({ cwd: "/srv/codex-project" }),
    );
  });

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

  it.each([
    { flag: "--ws-issuer", subcommand: [] },
    { flag: "--ws-audience", subcommand: [] },
    { flag: "--sock", subcommand: ["proxy"] },
  ])("preserves a subcommand-shaped $flag value", async ({ flag, subcommand }) => {
    await createStdioTransport({
      ...startOptions("codex"),
      args: ["app-server", ...subcommand, flag, "app-server", "-c", "model_reasoning_effort=high"],
    });
    expect(spawnMock.mock.calls[0]?.slice(0, 2)).toEqual([
      "codex",
      ["-c", "model_reasoning_effort=high", "app-server", ...subcommand, flag, "app-server"],
    ]);
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
