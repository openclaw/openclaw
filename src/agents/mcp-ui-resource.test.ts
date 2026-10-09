import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import {
  getMcpAppModelContext,
  subscribeMcpAppModelContext,
  updateMcpAppModelContext,
} from "./mcp-app-model-context.js";
import { buildMcpAppSandboxPath, resolveMcpAppSandboxPort } from "./mcp-app-sandbox.js";
import {
  acquireMcpAppViewRequest,
  leaseMcpAppModelContextForSessionTurn,
  fetchMcpAppView,
  getMcpAppViewLease,
  getMcpAppViewLeaseForSession,
} from "./mcp-ui-resource.js";
import { testing as mcpUiResourceTesting } from "./mcp-ui-resource.test-support.js";

const MCP_APP_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const MCP_APP_RESOURCE_MAX_BYTES = 2 * 1024 * 1024;

function runtime(readResource: SessionMcpRuntime["readResource"]): SessionMcpRuntime {
  return {
    sessionId: "session-1",
    sessionKey: "agent:main:main",
    workspaceDir: "/tmp",
    configFingerprint: "fingerprint",
    createdAt: 0,
    lastUsedAt: 0,
    mcpAppsEnabled: true,
    activeLeases: 0,
    acquireLease: vi.fn(() => vi.fn()),
    markUsed: () => {},
    getCatalog: async () => ({ version: 1, generatedAt: 0, servers: {}, tools: [] }),
    peekCatalog: () => null,
    callTool: vi.fn(),
    readResource,
    dispose: async () => {},
  };
}

type ViewParams = Parameters<typeof fetchMcpAppView>[0];

function fetchView(params: Pick<ViewParams, "runtime"> & Partial<Omit<ViewParams, "runtime">>) {
  return fetchMcpAppView({
    serverName: "demo",
    toolName: "show",
    uiResourceUri: "ui://demo/app",
    toolInput: {},
    toolResult: { content: [] },
    ...params,
  });
}

function html(text = "<html>demo</html>") {
  return { contents: [{ uri: "ui://demo/app", mimeType: MCP_APP_RESOURCE_MIME_TYPE, text }] };
}

describe("MCP App UI resources", () => {
  beforeEach(() => {
    mcpUiResourceTesting.clearViewStore();
  });

  afterEach(() => {
    mcpUiResourceTesting.clearViewStore();
    vi.useRealTimers();
  });

  it.each([
    { preferred: undefined, requested: undefined, available: undefined, expected: "inline" },
    { preferred: "fullscreen", requested: undefined, available: undefined, expected: "fullscreen" },
    {
      preferred: "inline",
      requested: "fullscreen",
      available: ["inline", "fullscreen"],
      expected: "fullscreen",
    },
    { preferred: "fullscreen", requested: "fullscreen", available: ["inline"], expected: "inline" },
  ] as const)(
    "selects an advertised initial display mode ($expected)",
    async ({ preferred, requested, available, expected }) => {
      const active = runtime(async () => ({
        contents: [
          {
            uri: "ui://demo/app",
            mimeType: MCP_APP_RESOURCE_MIME_TYPE,
            text: "<p>app</p>",
            _meta: {
              "openai/ui": { preferredDisplayMode: preferred, availableDisplayModes: available },
            },
          },
        ],
      }));
      const view = await fetchView({ runtime: active, displayMode: requested });
      expect(getMcpAppViewLease(view!.viewId, active)?.displayMode).toBe(expected);
    },
  );

  it("leases next-turn context only for exact live session and requester identities across native facades", async () => {
    const native = runtime(async () => html());
    const first = await fetchView({
      runtime: native,
      requesterId: "alice",
      allowedAppToolNames: new Set(),
    });
    const second = await fetchView({
      runtime: native,
      requesterId: "bob",
      allowedAppToolNames: new Set(),
    });
    const alice = getMcpAppViewLease(first!.viewId, native)!;
    const bob = getMcpAppViewLease(second!.viewId, native)!;
    updateMcpAppModelContext(native, alice, { content: [{ type: "text", text: "alice-private" }] });
    updateMcpAppModelContext(native, bob, { content: [{ type: "text", text: "bob-private" }] });
    const target = {
      sessionKey: native.sessionKey,
      sessionId: native.sessionId,
      requesterId: "alice",
    };
    expect(
      await leaseMcpAppModelContextForSessionTurn({ ...target, sessionId: "replacement" }),
    ).toBeUndefined();
    expect(
      await leaseMcpAppModelContextForSessionTurn({ ...target, sessionKey: "agent:main:other" }),
    ).toBeUndefined();
    expect(
      await leaseMcpAppModelContextForSessionTurn({ ...target, requesterId: "mallory" }),
    ).toBeUndefined();
    const lease = await leaseMcpAppModelContextForSessionTurn(target);
    expect(lease?.project(0).context.text).toContain("alice-private");
    expect(lease?.project(0).context.text).not.toContain("bob-private");
    lease?.commit();
    expect(getMcpAppModelContext(native, alice)).toBeNull();
    expect(getMcpAppModelContext(native, bob)).not.toBeNull();
  });

  it("does not infer a Gateway profile from transport requester scope", async () => {
    const sessionRuntime = runtime(async () => html());
    sessionRuntime.requesterScope = {
      requesterSenderId: "channel-user",
      messageChannel: "discord",
    };
    const descriptor = await fetchView({ runtime: sessionRuntime });
    const view = getMcpAppViewLease(descriptor!.viewId, sessionRuntime)!;
    expect(view.requesterId).toBeUndefined();
    view.allowedAppToolNames = new Set();
    updateMcpAppModelContext(sessionRuntime, view, {
      content: [{ type: "text", text: "shared selection" }],
    });
    const context = await leaseMcpAppModelContextForSessionTurn({
      sessionId: sessionRuntime.sessionId,
      sessionKey: sessionRuntime.sessionKey,
      requesterId: "verified-profile",
    });
    expect(context?.project(0).context.text).toContain("shared selection");
    context?.rollback();
  });

  it("leases HTML and tool data only in memory", async () => {
    const sessionRuntime = runtime(async () => ({
      contents: [
        {
          uri: "ui://demo/app",
          mimeType: MCP_APP_RESOURCE_MIME_TYPE,
          text: "<html>demo</html>",
          _meta: {
            ui: {
              csp: { connectDomains: ["https://api.example.com"] },
              permissions: { geolocation: {} },
            },
          },
        },
      ],
    }));
    const authorizeAppInteraction = vi.fn(async () => true);
    const result = await fetchView({
      runtime: sessionRuntime,
      toolInput: { city: "Paris" },
      toolResult: { content: [{ type: "text", text: "ok" }] },
      authorizeAppInteraction,
    });

    expect(result?.viewId).toMatch(/^mcp-app-/u);
    expect(getMcpAppViewLease(result?.viewId ?? "", sessionRuntime)).toMatchObject({
      html: "<html>demo</html>",
      toolInput: { city: "Paris" },
      permissions: { geolocation: {} },
      authorizeAppInteraction,
    });
    expect(
      getMcpAppViewLease(
        result?.viewId ?? "",
        runtime(async () => ({ contents: [] })),
      ),
    ).toBeUndefined();
    expect(
      getMcpAppViewLeaseForSession(result?.viewId ?? "", "agent:main:main", "main"),
    ).toMatchObject({
      html: "<html>demo</html>",
      runtime: sessionRuntime,
      agentId: "main",
    });
    expect(
      getMcpAppViewLeaseForSession(result?.viewId ?? "", "agent:other:main", "other"),
    ).toBeUndefined();
  });

  it("isolates live views by agent when bare session keys collide", async () => {
    const sessionRuntime = runtime(async () => html("<html>ops</html>"));
    sessionRuntime.sessionKey = "global";
    const result = await fetchView({
      runtime: sessionRuntime,
      agentId: "ops",
    });

    expect(getMcpAppViewLeaseForSession(result?.viewId ?? "", "global", "ops")).toBeDefined();
    expect(
      getMcpAppViewLeaseForSession(result?.viewId ?? "", "global", "research"),
    ).toBeUndefined();
  });

  it("keeps valid Apps when optional listing metadata fails", async () => {
    const readResource = vi.fn(async () => html());
    const sessionRuntime = runtime(readResource);
    sessionRuntime.listResources = vi.fn(async () => {
      throw new Error("resources/list unavailable");
    });

    const result = await fetchView({
      runtime: sessionRuntime,
    });

    expect(result?.viewId).toMatch(/^mcp-app-/u);
    expect(readResource).toHaveBeenCalledWith("demo", "ui://demo/app", {
      failureBackoff: "ignore",
    });
    expect(sessionRuntime.listResources).toHaveBeenCalledWith("demo", {
      failureBackoff: "ignore",
    });
  });

  it("rejects oversized and incorrectly typed resources", async () => {
    for (const content of [
      {
        uri: "ui://demo/app",
        mimeType: "text/html",
        text: "<html></html>",
      },
      {
        uri: "ui://demo/app",
        mimeType: MCP_APP_RESOURCE_MIME_TYPE,
        text: "x".repeat(MCP_APP_RESOURCE_MAX_BYTES + 1),
      },
    ]) {
      const result = await fetchView({
        runtime: runtime(async () => ({ contents: [content] })),
      });
      expect(result).toBeUndefined();
    }
  });

  it("bounds concurrent app bridge requests", () => {
    const view = {
      requestWindowStartedAtMs: 0,
      requestCount: 0,
      toolCallCount: 0,
      activeRequests: 0,
    } as Parameters<typeof acquireMcpAppViewRequest>[0];
    const releases = Array.from({ length: 4 }, () => acquireMcpAppViewRequest(view, "read", 1));
    expect(() => acquireMcpAppViewRequest(view, "read", 1)).toThrow("concurrency limit");
    releases[0]?.();
    const release = acquireMcpAppViewRequest(view, "read", 1);
    release();
    releases.slice(1).forEach((entry) => entry());
  });

  it("normalizes CSP before retaining the view", async () => {
    const sessionRuntime = runtime(async () => ({
      contents: [
        {
          uri: "ui://demo/app",
          mimeType: MCP_APP_RESOURCE_MIME_TYPE,
          text: "<!doctype html><script>globalThis.ready = true</script>",
          _meta: {
            ui: {
              csp: {
                connectDomains: ["https://api.example.com", "javascript:alert(1)"],
                resourceDomains: ["https://cdn.example.com"],
              },
            },
          },
        },
      ],
    }));
    const result = await fetchView({
      runtime: sessionRuntime,
    });
    const view = getMcpAppViewLease(result?.viewId ?? "", sessionRuntime);
    expect(view?.csp).toEqual({
      connectDomains: ["https://api.example.com"],
      resourceDomains: ["https://cdn.example.com"],
    });
    expect(view?.html.startsWith("<!doctype html>")).toBe(true);
    expect(buildMcpAppSandboxPath(view?.csp)).toContain("?csp=");
  });

  it("deletes sensitive view data when the lease expires without later activity", async () => {
    vi.useFakeTimers();
    const sessionRuntime = runtime(async () => html("<html>secret</html>"));
    const result = await fetchView({
      runtime: sessionRuntime,
      toolInput: { token: "secret" },
    });
    const view = getMcpAppViewLease(result?.viewId ?? "", sessionRuntime);
    expect(view).toBeDefined();
    const changed = vi.fn();
    view!.disposeCallbacks = new Set([subscribeMcpAppModelContext(view!, changed)]);
    updateMcpAppModelContext(sessionRuntime, view!, {
      content: [{ type: "text", text: "ephemeral context" }],
    });
    expect(getMcpAppModelContext(sessionRuntime, view!)).not.toBeNull();

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(getMcpAppViewLease(result?.viewId ?? "", sessionRuntime)).toBeUndefined();
    expect(getMcpAppModelContext(sessionRuntime, view!)).toBeNull();
    expect(changed).toHaveBeenLastCalledWith(null);
    expect(sessionRuntime.acquireLease).toHaveBeenCalledOnce();
    const release = vi.mocked(sessionRuntime.acquireLease!).mock.results[0]?.value;
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects CSP metadata that cannot fit safe HTTP request and response limits", () => {
    const shortDomains = Array.from(
      { length: 65 },
      (_, index) => `https://cdn-${index}.example.com`,
    );
    const path = buildMcpAppSandboxPath({ connectDomains: shortDomains });
    const encoded = new URL(path, "https://gateway.example").searchParams.get("csp");
    expect(encoded).toBeTruthy();

    const domains = Array.from(
      { length: 64 },
      (_, index) => `https://${"a".repeat(120)}-${index}.example.com`,
    );
    expect(() =>
      buildMcpAppSandboxPath({
        connectDomains: domains,
        resourceDomains: domains,
        frameDomains: domains,
        baseUriDomains: domains,
      }),
    ).toThrow("MCP App CSP metadata exceeds safe HTTP limits");
  });

  it("derives a distinct listener port without wrapping", () => {
    expect(resolveMcpAppSandboxPort(18789)).toBe(18790);
    expect(resolveMcpAppSandboxPort(18789, 29000)).toBe(29000);
    expect(() => resolveMcpAppSandboxPort(65535)).toThrow(
      "MCP Apps require distinct valid Gateway and sandbox ports",
    );
    expect(() => resolveMcpAppSandboxPort(18789, 18789)).toThrow(
      "MCP Apps require distinct valid Gateway and sandbox ports",
    );
  });

  it("keeps all 32 valid leases during lookup-only pruning", async () => {
    const sessionRuntime = runtime(async () => html());
    const viewIds: string[] = [];
    for (let index = 0; index < 32; index += 1) {
      const result = await fetchView({
        runtime: sessionRuntime,
        toolInput: { index },
      });
      if (result) {
        viewIds.push(result.viewId);
      }
    }

    expect(getMcpAppViewLease(viewIds[0] ?? "", sessionRuntime)).toBeDefined();
    expect(getMcpAppViewLease(viewIds[31] ?? "", sessionRuntime)).toBeDefined();
  });

  it("replaces a reconstructed view id without leaking the previous runtime lease", async () => {
    const releases = [vi.fn(), vi.fn()];
    const sessionRuntime = runtime(async () => html());
    sessionRuntime.acquireLease = vi
      .fn()
      .mockReturnValueOnce(releases[0])
      .mockReturnValueOnce(releases[1]);

    for (const version of [1, 2]) {
      await fetchView({
        runtime: sessionRuntime,
        viewId: "mcp-app-restored",
        toolInput: { version },
      });
    }

    expect(releases[0]).toHaveBeenCalledOnce();
    expect(releases[1]).not.toHaveBeenCalled();
    expect(getMcpAppViewLease("mcp-app-restored", sessionRuntime)?.toolInput).toEqual({
      version: 2,
    });
  });
});
