import { describe, expect, it, vi } from "vitest";
import arvenMemoryPlugin from "./index.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  ssrfPolicyFromHttpBaseUrlAllowedOrigin: (baseUrl: string) => ({
    allowedOrigins: [new URL(baseUrl).origin.toLowerCase()],
  }),
}));

function registerPlugin(config: Record<string, unknown>) {
  const registrations: Array<{ tool: any; opts: { names?: string[] } }> = [];
  arvenMemoryPlugin.register({
    pluginConfig: config,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    registerTool: (tool: any, opts: { names?: string[] }) => registrations.push({ tool, opts }),
  } as any);
  return registrations;
}

function findRegisteredTool(
  registrations: Array<{ tool: any; opts: { names?: string[] } }>,
  name: string,
) {
  const tool = registrations.find((entry) => entry.opts.names?.includes(name))?.tool;
  if (!tool) {
    throw new Error(`${name} tool was not registered`);
  }
  return tool;
}

describe("arven-memory plugin", () => {
  it("declares itself as a memory slot plugin", () => {
    expect(arvenMemoryPlugin.id).toBe("arven-memory");
    expect(arvenMemoryPlugin.kind).toBe("memory");
  });

  it("registers compatibility and namespaced tools", () => {
    const registrations = registerPlugin({ baseUrl: "http://127.0.0.1:8765/mcp" });
    const names = registrations.flatMap((entry) => entry.opts.names ?? []);

    expect(names).toContain("arven_memory_recall");
    expect(names).toContain("memory_search");
    expect(names).toContain("arven_memory_get");
    expect(names).toContain("memory_get");
    expect(names).toContain("arven_memory_store");
    expect(names).toContain("arven_memory_status");
  });

  it("calls the configured MCP recall tool through the guarded fetch path", async () => {
    const release = vi.fn();
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      release,
      response: {
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          result: {
            content: [{ type: "text", text: "matched memory" }],
          },
        }),
      },
    });

    try {
      const registrations = registerPlugin({
        baseUrl: "http://127.0.0.1:8765/mcp",
        recallTool: "arven_recall",
      });
      const recall = findRegisteredTool(registrations, "arven_memory_recall");
      const result = await recall.execute("call-1", { query: "release gate", limit: 3 });

      expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "http://127.0.0.1:8765/mcp",
          auditContext: "arven-memory.mcp",
          policy: { allowedOrigins: ["http://127.0.0.1:8765"] },
          timeoutMs: 10000,
          init: expect.objectContaining({
            method: "POST",
            body: expect.stringContaining('"name":"arven_recall"'),
          }),
        }),
      );
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
        expect.objectContaining({
          init: expect.objectContaining({
            body: expect.stringContaining('"query":"release gate"'),
          }),
        }),
      );
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
        expect.objectContaining({
          init: expect.objectContaining({
            body: expect.stringContaining('"question":"release gate"'),
          }),
        }),
      );
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
        expect.objectContaining({
          init: expect.objectContaining({
            headers: expect.objectContaining({
              accept: "application/json",
              "content-type": "application/json",
            }),
          }),
        }),
      );
      expect(release).toHaveBeenCalled();
      expect(result.content[0].text).toBe("matched memory");
    } finally {
      fetchWithSsrFGuardMock.mockReset();
    }
  });

  it("threads optional authorization headers from env without storing credentials", async () => {
    const release = vi.fn();
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      release,
      response: {
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          result: "ok",
        }),
      },
    });
    process.env.ARVEN_TEST_AUTH_HEADER = "Bearer test-token";

    try {
      const registrations = registerPlugin({
        baseUrl: "http://127.0.0.1:8765/mcp",
        authHeaderEnv: "ARVEN_TEST_AUTH_HEADER",
      });
      const status = findRegisteredTool(registrations, "arven_memory_status");
      await status.execute("call-1", {});

      expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
        expect.objectContaining({
          init: expect.objectContaining({
            headers: expect.objectContaining({
              authorization: "Bearer test-token",
            }),
          }),
        }),
      );
    } finally {
      delete process.env.ARVEN_TEST_AUTH_HEADER;
      fetchWithSsrFGuardMock.mockReset();
    }
  });

  it("uses configured timeout and releases guarded fetch resources on MCP errors", async () => {
    const release = vi.fn();
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      release,
      response: {
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          error: { code: -32000, message: "bridge failed" },
        }),
      },
    });

    try {
      const registrations = registerPlugin({
        baseUrl: "http://127.0.0.1:8765/mcp",
        timeoutMs: 2500,
      });
      const status = findRegisteredTool(registrations, "arven_memory_status");

      await expect(status.execute("call-1", {})).rejects.toThrow("bridge failed");
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutMs: 2500 }),
      );
      expect(release).toHaveBeenCalled();
    } finally {
      fetchWithSsrFGuardMock.mockReset();
    }
  });

  it("reports HTTP failures and releases guarded fetch resources", async () => {
    const release = vi.fn();
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      release,
      response: {
        ok: false,
        status: 503,
      },
    });

    try {
      const registrations = registerPlugin({ baseUrl: "http://127.0.0.1:8765/mcp" });
      const status = findRegisteredTool(registrations, "arven_memory_status");

      await expect(status.execute("call-1", {})).rejects.toThrow("Arven Memory HTTP 503");
      expect(release).toHaveBeenCalled();
    } finally {
      fetchWithSsrFGuardMock.mockReset();
    }
  });
});
