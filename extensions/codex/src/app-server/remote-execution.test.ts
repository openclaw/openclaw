import { describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import { ensureCodexRemoteExecutionCompatibility } from "./remote-execution.js";

function createClient(hooks: unknown[], layers: unknown[] = []) {
  return {
    request: vi.fn(async (method: string) => {
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "config/read") {
        return { config: {}, origins: {}, layers };
      }
      if (method === "hooks/list") {
        return { data: hooks };
      }
      throw new Error(`unexpected method: ${method}`);
    }),
  } as unknown as CodexAppServerClient;
}

const remoteAppServer = {
  remoteExecutionFingerprint: "sha256:remote",
  requestTimeoutMs: 1_000,
};

describe("Codex remote execution hook compatibility", () => {
  it("allows local execution without querying Codex hooks", async () => {
    const client = createClient([]);

    await ensureCodexRemoteExecutionCompatibility({
      appServer: { requestTimeoutMs: 1_000 },
      client,
      cwd: "/workspace",
    });

    expect(client.request).not.toHaveBeenCalled();
  });

  it("allows unmanaged hooks", async () => {
    const client = createClient([
      {
        cwd: "/workspace",
        hooks: [{ enabled: true, handlerType: "command", isManaged: false }],
        errors: [],
      },
    ]);

    await ensureCodexRemoteExecutionCompatibility({
      appServer: remoteAppServer,
      client,
      cwd: "/workspace",
    });
    expect(client.request).toHaveBeenCalledTimes(3);
  });

  it("rejects enabled managed command hooks", async () => {
    const client = createClient([
      {
        cwd: "/workspace",
        hooks: [
          {
            enabled: true,
            eventName: "preToolUse",
            handlerType: "command",
            isManaged: true,
            source: "cloudRequirements",
          },
        ],
        errors: [],
      },
    ]);

    await expect(
      ensureCodexRemoteExecutionCompatibility({
        appServer: remoteAppServer,
        client,
        cwd: "/workspace",
      }),
    ).rejects.toThrow("managed command hooks (cloudRequirements:preToolUse)");
  });

  it("fails closed when hook discovery is incomplete", async () => {
    const client = createClient([{ cwd: "/workspace", hooks: [], errors: [{ message: "bad" }] }]);

    await expect(
      ensureCodexRemoteExecutionCompatibility({
        appServer: remoteAppServer,
        client,
        cwd: "/workspace",
      }),
    ).rejects.toThrow("could not inspect hooks");
  });

  it("rejects active legacy managed config that can override thread safety", async () => {
    const client = createClient(
      [{ cwd: "/workspace", hooks: [], errors: [] }],
      [
        {
          name: { type: "legacyManagedConfigTomlFromFile", file: "/etc/codex/managed_config.toml" },
          version: "1",
          config: {},
        },
      ],
    );

    await expect(
      ensureCodexRemoteExecutionCompatibility({
        appServer: remoteAppServer,
        client,
        cwd: "/workspace",
      }),
    ).rejects.toThrow("active legacy managed_config.toml layer");
    expect(client.request).toHaveBeenCalledTimes(2);
  });

  it("rejects effective local stdio MCP servers", async () => {
    const client = createClient([{ cwd: "/workspace", hooks: [], errors: [] }]);
    vi.mocked(client.request).mockImplementation(async (method: string) => {
      if (method === "configRequirements/read") {
        return { requirements: null } as never;
      }
      if (method === "config/read") {
        return {
          config: { mcp_servers: { computer: { command: "computer-use" } } },
          origins: {},
          layers: [],
        } as never;
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await expect(
      ensureCodexRemoteExecutionCompatibility({
        appServer: remoteAppServer,
        client,
        cwd: "/workspace",
      }),
    ).rejects.toThrow('local stdio MCP server "computer"');
  });

  it("allows disabled local stdio MCP servers", async () => {
    const client = createClient([{ cwd: "/workspace", hooks: [], errors: [] }]);
    vi.mocked(client.request).mockImplementation(async (method: string) => {
      if (method === "configRequirements/read") {
        return { requirements: null } as never;
      }
      if (method === "config/read") {
        return {
          config: {
            mcp_servers: { computer: { command: "computer-use", enabled: false } },
          },
          origins: {},
          layers: [],
        } as never;
      }
      if (method === "hooks/list") {
        return { data: [{ cwd: "/workspace", hooks: [], errors: [] }] } as never;
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await ensureCodexRemoteExecutionCompatibility({
      appServer: remoteAppServer,
      client,
      cwd: "/workspace",
    });
    expect(client.request).toHaveBeenCalledTimes(3);
  });

  it("rejects managed feature requirements that defeat remote safety", async () => {
    const client = createClient([{ cwd: "/workspace", hooks: [], errors: [] }]);
    vi.mocked(client.request).mockImplementation(async (method: string) => {
      if (method === "configRequirements/read") {
        return { requirements: { featureRequirements: { unified_exec: false } } } as never;
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await expect(
      ensureCodexRemoteExecutionCompatibility({
        appServer: remoteAppServer,
        client,
        cwd: "/workspace",
      }),
    ).rejects.toThrow("managed feature requirements");
  });
});
