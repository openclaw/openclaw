// Codex tests cover request plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const sharedClientMocks = vi.hoisted(() => ({
  createIsolatedCodexAppServerClient: vi.fn(),
  getSharedCodexAppServerClient: vi.fn(),
  releaseLeasedSharedCodexAppServerClient: vi.fn(),
}));

vi.mock("./shared-client.js", () => ({
  ...sharedClientMocks,
  getLeasedSharedCodexAppServerClient: sharedClientMocks.getSharedCodexAppServerClient,
}));

const { requestCodexAppServerJson } = await import("./request.js");

describe("requestCodexAppServerJson sandbox guard", () => {
  beforeEach(() => {
    sharedClientMocks.createIsolatedCodexAppServerClient.mockReset();
    sharedClientMocks.getSharedCodexAppServerClient.mockReset();
    sharedClientMocks.releaseLeasedSharedCodexAppServerClient.mockReset();
  });

  it("fails closed before raw app-server bypass methods in sandboxed sessions", async () => {
    await expect(
      requestCodexAppServerJson({
        method: "command/exec",
        requestParams: { command: ["sh", "-lc", "id"] },
        config: { agents: { defaults: { sandbox: { mode: "all" } } } },
        sessionKey: "sandboxed-session",
      }),
    ).rejects.toThrow(
      "Codex-native app-server method `command/exec` is unavailable because OpenClaw sandboxing is active for this session.",
    );

    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("fails closed before raw app-server bypass methods when exec host=node is active", async () => {
    for (const method of ["command/exec", "process/spawn"]) {
      await expect(
        requestCodexAppServerJson({
          method,
          requestParams: { command: ["sh", "-lc", "id"] },
          config: { tools: { exec: { host: "node", node: "worker-1" } } },
          sessionKey: "node-session",
        }),
      ).rejects.toThrow(
        `Codex-native app-server method \`${method}\` is unavailable because OpenClaw exec host=node is active for this session.`,
      );
    }

    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("allows metadata methods in sandboxed sessions", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });

    await expect(
      requestCodexAppServerJson({
        method: "thread/list",
        requestParams: { limit: 10 },
        config: { agents: { defaults: { sandbox: { mode: "all" } } } },
        sessionKey: "sandboxed-session",
      }),
    ).resolves.toEqual({ ok: true });

    expect(request).toHaveBeenCalledWith(
      "thread/list",
      { limit: 10 },
      expect.objectContaining({ timeoutMs: 60_000, signal: expect.anything() }),
    );
  });

  it("allows current native thread management methods in sandboxed sessions", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });

    for (const method of ["thread/name/set", "thread/archive", "thread/unarchive"] as const) {
      await expect(
        requestCodexAppServerJson({
          method,
          requestParams:
            method === "thread/name/set"
              ? { threadId: "thread-1", name: "Shared thread" }
              : { threadId: "thread-1" },
          config: { agents: { defaults: { sandbox: { mode: "all" } } } },
          sessionKey: "sandboxed-session",
        }),
      ).resolves.toEqual({ ok: true });
    }

    expect(request).toHaveBeenCalledTimes(3);
  });

  it("fails closed for config-level exec host=node even without a session key", async () => {
    await expect(
      requestCodexAppServerJson({
        method: "command/exec",
        requestParams: { command: ["sh", "-lc", "id"] },
        config: { tools: { exec: { host: "node", node: "worker-1" } } },
      }),
    ).rejects.toThrow(
      "Codex-native app-server method `command/exec` is unavailable because OpenClaw exec host=node is active for this session.",
    );

    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("fails closed for MCP reload when config-level exec host=node is active", async () => {
    await expect(
      requestCodexAppServerJson({
        method: "config/mcpServer/reload",
        requestParams: {},
        config: { tools: { exec: { host: "node", node: "worker-1" } } },
      }),
    ).rejects.toThrow(
      "Codex-native app-server method `config/mcpServer/reload` is unavailable because OpenClaw exec host=node is active for this session.",
    );

    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("allows metadata methods when exec host=node is active", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });

    await expect(
      requestCodexAppServerJson({
        method: "thread/list",
        requestParams: { limit: 10 },
        config: { tools: { exec: { host: "node", node: "worker-1" } } },
        sessionKey: "node-session",
      }),
    ).resolves.toEqual({ ok: true });

    expect(request).toHaveBeenCalledWith(
      "thread/list",
      { limit: 10 },
      expect.objectContaining({ timeoutMs: 60_000, signal: expect.anything() }),
    );
  });

  it("allows config value writes in sandboxed sessions", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });
    const params = {
      keyPath: 'apps."google-calendar-app".tools',
      value: null,
      mergeStrategy: "replace",
    };

    await expect(
      requestCodexAppServerJson({
        method: "config/value/write",
        requestParams: params,
        config: { agents: { defaults: { sandbox: { mode: "all" } } } },
        sessionKey: "sandboxed-session",
      }),
    ).resolves.toEqual({ ok: true });

    expect(request).toHaveBeenCalledWith(
      "config/value/write",
      params,
      expect.objectContaining({ timeoutMs: 60_000, signal: expect.anything() }),
    );
  });

  it("allows config reads in sandboxed sessions", async () => {
    const request = vi.fn(async () => ({ config: { apps: { apps: {} } } }));
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });
    const params = { includeLayers: false };

    await expect(
      requestCodexAppServerJson({
        method: "config/read",
        requestParams: params,
        config: { agents: { defaults: { sandbox: { mode: "all" } } } },
        sessionKey: "sandboxed-session",
      }),
    ).resolves.toEqual({ config: { apps: { apps: {} } } });

    expect(request).toHaveBeenCalledWith(
      "config/read",
      params,
      expect.objectContaining({ timeoutMs: 60_000, signal: expect.anything() }),
    );
  });

  it("allows sandbox-pinned thread starts in sandboxed sessions", async () => {
    const request = vi.fn(async () => ({ thread: { id: "thread-1" }, model: "gpt-5.5" }));
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });
    const params = {
      cwd: "/workspace",
      environments: [{ environmentId: "openclaw-sandbox-abc123", cwd: "/workspace" }],
    };

    await expect(
      requestCodexAppServerJson({
        method: "thread/start",
        requestParams: params,
        config: { agents: { defaults: { sandbox: { mode: "all" } } } },
        sessionKey: "sandboxed-session",
      }),
    ).resolves.toEqual({ thread: { id: "thread-1" }, model: "gpt-5.5" });

    expect(request).toHaveBeenCalledWith(
      "thread/start",
      params,
      expect.objectContaining({ timeoutMs: 60_000, signal: expect.anything() }),
    );
  });

  it("never sends a remote mutation after its compatibility deadline expires", async () => {
    vi.useFakeTimers();
    let resolveRequirements: ((value: { requirements: null }) => void) | undefined;
    const requirements = new Promise<{ requirements: null }>((resolve) => {
      resolveRequirements = resolve;
    });
    const request = vi.fn(async (method: string) => {
      if (method === "configRequirements/read") {
        return await requirements;
      }
      if (method === "config/read") {
        return { config: {}, origins: {}, layers: [] };
      }
      if (method === "hooks/list") {
        return { data: [{ cwd: "/workspace", hooks: [], errors: [] }] };
      }
      if (method === "thread/fork") {
        return { thread: { id: "unexpected" }, model: "gpt-5.5" };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });
    const released = new Promise<void>((resolve) => {
      sharedClientMocks.releaseLeasedSharedCodexAppServerClient.mockImplementation(() => resolve());
    });

    try {
      const result = requestCodexAppServerJson({
        method: "thread/fork",
        requestParams: { threadId: "thread-1" },
        timeoutMs: 25,
        remoteExecution: {
          remoteExecutionFingerprint: "sha256:remote",
          requestTimeoutMs: 60_000,
        },
        remoteExecutionHookCwd: "/workspace",
      });
      const rejected = expect(result).rejects.toThrow("codex app-server thread/fork timed out");

      await vi.advanceTimersByTimeAsync(25);
      await rejected;
      expect(request.mock.calls.map(([method]) => method)).toEqual(["configRequirements/read"]);

      resolveRequirements?.({ requirements: null });
      await released;
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "configRequirements/read",
        "config/read",
        "hooks/list",
      ]);
      expect(request).not.toHaveBeenCalledWith("thread/fork", expect.anything(), expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks thread starts with sandbox environments when exec host=node is active", async () => {
    const params = {
      cwd: "/workspace",
      environments: [{ environmentId: "openclaw-sandbox-abc123", cwd: "/workspace" }],
    };

    await expect(
      requestCodexAppServerJson({
        method: "thread/start",
        requestParams: params,
        config: {
          agents: { defaults: { sandbox: { mode: "all" } } },
          tools: { exec: { host: "node", node: "worker-1" } },
        },
        sessionKey: "node-session",
      }),
    ).rejects.toThrow(
      "Codex-native app-server method `thread/start` is unavailable because OpenClaw exec host=node is active for this session.",
    );

    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });
});
