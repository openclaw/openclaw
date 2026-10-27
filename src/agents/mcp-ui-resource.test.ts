import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { staticRuntime } from "./agent-bundle-mcp-fixture.test-support.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import {
  getMcpAppModelContext as getContext,
  subscribeMcpAppModelContext,
  updateMcpAppModelContext as updateContext,
} from "./mcp-app-model-context.js";
import { buildMcpAppSandboxPath, resolveMcpAppSandboxPort } from "./mcp-app-sandbox.js";
import {
  acquireMcpAppViewRequest,
  leaseMcpAppModelContextForSessionTurn as leaseContext,
  fetchMcpAppView,
  getMcpAppViewLease as getView,
  getMcpAppViewLeaseForSession as getSessionView,
} from "./mcp-ui-resource.js";
import { testing as mcpUiResourceTesting } from "./mcp-ui-resource.test-support.js";

const APP_MIME = "text/html;profile=mcp-app";
const MAX_BYTES = 2 * 1024 * 1024;

function runtime(overrides: Partial<SessionMcpRuntime> = {}): SessionMcpRuntime {
  return staticRuntime({
    sessionId: "session-1",
    sessionKey: "agent:main:main",
    workspaceDir: "/tmp",
    configFingerprint: "fingerprint",
    acquireLease: vi.fn(() => vi.fn()),
    getCatalog: async () => ({ version: 1, generatedAt: 0, servers: {}, tools: [] }),
    peekCatalog: () => null,
    callTool: vi.fn(),
    readResource: async () => html(),
    ...overrides,
  });
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

function html(text = "<html>demo</html>", _meta?: Record<string, unknown>) {
  return { contents: [{ uri: "ui://demo/app", mimeType: APP_MIME, text, _meta }] };
}

function context(active: SessionMcpRuntime, view: object, text: string) {
  return updateContext(active, view, { content: [{ type: "text", text }] });
}

async function createView({
  content,
  ...params
}: Partial<ViewParams> & { content?: ReturnType<typeof html> } = {}) {
  const active = params.runtime ?? runtime();
  if (content) {
    active.readResource = async () => content;
  }
  const descriptor = await fetchView({ ...params, runtime: active });
  const viewId = descriptor!.viewId;
  return { active, viewId, view: getView(viewId, active)! };
}

describe("MCP App UI resources", () => {
  beforeEach(() => mcpUiResourceTesting.clearViewStore());

  afterEach(() => {
    mcpUiResourceTesting.clearViewStore();
    vi.useRealTimers();
  });

  it.each([
    { preferred: "fullscreen", requested: undefined, available: undefined, expected: "fullscreen" },
    { preferred: "fullscreen", requested: "fullscreen", available: ["inline"], expected: "inline" },
  ] as const)(
    "selects an advertised initial display mode ($expected)",
    async ({ preferred, requested, available, expected }) => {
      const { view } = await createView({
        content: html("<p>app</p>", {
          "openai/ui": { preferredDisplayMode: preferred, availableDisplayModes: available },
        }),
        displayMode: requested,
      });
      expect(view.displayMode).toBe(expected);
    },
  );

  it("leases next-turn context only for exact live session and requester identities across native facades", async () => {
    const native = runtime();
    const params = { runtime: native, allowedAppToolNames: new Set<string>() };
    const { view: alice } = await createView({ ...params, requesterId: "alice" });
    context(native, alice, "alice-private");
    const target = {
      sessionKey: native.sessionKey,
      sessionId: native.sessionId,
      requesterId: "alice",
    };
    expect(await leaseContext({ ...target, sessionId: "replacement" })).toBeUndefined();
    expect(await leaseContext({ ...target, sessionKey: "agent:main:other" })).toBeUndefined();
    expect(await leaseContext({ ...target, requesterId: "mallory" })).toBeUndefined();
    const lease = await leaseContext(target);
    expect(lease?.project(0).context.text).toContain("alice-private");
    lease?.commit();
    expect(getContext(native, alice)).toBeNull();
  });

  it("does not infer a Gateway profile from transport requester scope", async () => {
    const { active, view } = await createView({
      runtime: runtime({
        requesterScope: { requesterSenderId: "channel-user", messageChannel: "discord" },
      }),
    });
    expect(view.requesterId).toBeUndefined();
    view.allowedAppToolNames = new Set();
    context(active, view, "shared selection");
    const lease = await leaseContext({
      sessionId: active.sessionId,
      sessionKey: active.sessionKey,
      requesterId: "verified-profile",
    });
    expect(lease?.project(0).context.text).toContain("shared selection");
    lease?.rollback();
  });

  it.each([
    ["agent:main:main", undefined, "main"],
    ["global", "ops", "ops"],
  ] as const)(
    "isolates %s views and their tool data by owner",
    async (sessionKey, agentId, owner) => {
      const authorizeAppInteraction = vi.fn(async () => true);
      const { active, viewId, view } = await createView({
        runtime: runtime({ sessionKey }),
        agentId,
        content: html(undefined, { ui: { permissions: { geolocation: {} } } }),
        toolInput: { city: "Paris" },
        authorizeAppInteraction,
      });

      expect(viewId).toMatch(/^mcp-app-/u);
      expect(view).toMatchObject({
        html: "<html>demo</html>",
        toolInput: { city: "Paris" },
        permissions: { geolocation: {} },
        authorizeAppInteraction,
      });
      expect(getView(viewId, runtime())).toBeUndefined();
      expect(getSessionView(viewId, sessionKey, owner)).toMatchObject({
        html: "<html>demo</html>",
        runtime: active,
        agentId: owner,
      });
      expect(getSessionView(viewId, sessionKey, "research")).toBeUndefined();
      expect(getSessionView(viewId, "agent:other:main", "other")).toBeUndefined();
    },
  );

  it("keeps valid Apps when optional listing metadata fails", async () => {
    const listResources = async () => {
      throw new Error("resources/list unavailable");
    };
    const result = await fetchView({ runtime: runtime({ listResources }) });
    expect(result?.viewId).toMatch(/^mcp-app-/u);
  });

  it("rejects oversized and incorrectly typed resources", async () => {
    for (const content of [
      { ...html("<html></html>").contents[0], mimeType: "text/html" },
      html("x".repeat(MAX_BYTES + 1)).contents[0],
    ]) {
      const result = await fetchView({
        runtime: runtime({ readResource: async () => ({ contents: [content] }) }),
      });
      expect(result).toBeUndefined();
    }
  });

  it("bounds concurrent app bridge requests", async () => {
    const { view } = await createView();
    const now = view.requestWindowStartedAtMs + 1;
    const releases = Array.from({ length: 4 }, () => acquireMcpAppViewRequest(view, "read", now));
    expect(() => acquireMcpAppViewRequest(view, "read", now)).toThrow("concurrency limit");
    releases[0]?.();
    releases[0]?.();
    const release = acquireMcpAppViewRequest(view, "read", now);
    expect(() => acquireMcpAppViewRequest(view, "read", now)).toThrow("concurrency limit");
    release();
    releases.slice(1).forEach((entry) => entry());
  });

  it("normalizes CSP before retaining the view", async () => {
    const { view } = await createView({
      content: html("<!doctype html>", {
        ui: {
          csp: {
            connectDomains: ["https://api.example.com", "javascript:alert(1)"],
            resourceDomains: ["https://cdn.example.com"],
          },
        },
      }),
    });
    expect(view?.csp).toEqual({
      connectDomains: ["https://api.example.com"],
      resourceDomains: ["https://cdn.example.com"],
    });
    expect(view?.html.startsWith("<!doctype html>")).toBe(true);
  });

  it("deletes sensitive view data when the lease expires without later activity", async () => {
    vi.useFakeTimers();
    const { active, viewId, view } = await createView({
      content: html("<html>secret</html>"),
      toolInput: { token: "secret" },
    });
    const changed = vi.fn();
    view.disposeCallbacks = new Set([subscribeMcpAppModelContext(view, changed)]);
    context(active, view, "ephemeral context");
    expect(getContext(active, view)).not.toBeNull();

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(getView(viewId, active)).toBeUndefined();
    expect(getContext(active, view)).toBeNull();
    expect(changed).toHaveBeenLastCalledWith(null);
    expect(active.acquireLease).toHaveBeenCalledOnce();
    const release = vi.mocked(active.acquireLease!).mock.results[0]?.value;
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects CSP metadata that cannot fit safe HTTP request and response limits", () => {
    const shortDomains = Array.from({ length: 65 }, (_, i) => `https://cdn-${i}.example.com`);
    const path = buildMcpAppSandboxPath({ connectDomains: shortDomains });
    const encoded = new URL(path, "https://gateway.example").searchParams.get("csp");
    expect(encoded).toBeTruthy();

    const domains = Array.from(
      { length: 64 },
      (_, i) => `https://${"a".repeat(120)}-${i}.example.com`,
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
    const error = "MCP Apps require distinct valid Gateway and sandbox ports";
    expect(() => resolveMcpAppSandboxPort(65535)).toThrow(error);
    expect(() => resolveMcpAppSandboxPort(18789, 18789)).toThrow(error);
  });

  it("replaces a reconstructed view id without leaking the previous runtime lease", async () => {
    const releases = [vi.fn(), vi.fn()];
    const sessionRuntime = runtime({
      acquireLease: vi.fn().mockReturnValueOnce(releases[0]).mockReturnValueOnce(releases[1]),
    });

    for (const version of [1, 2]) {
      await fetchView({
        runtime: sessionRuntime,
        viewId: "mcp-app-restored",
        toolInput: { version },
      });
    }

    expect(releases[0]).toHaveBeenCalledOnce();
    expect(releases[1]).not.toHaveBeenCalled();
    expect(getView("mcp-app-restored", sessionRuntime)?.toolInput).toEqual({ version: 2 });
  });
});
