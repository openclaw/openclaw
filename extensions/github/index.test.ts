import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlUiGitHubPreview } from "./api.js";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

vi.mock("openclaw/plugin-sdk/gateway-method-runtime", () => ({
  dispatchGatewayMethod: vi.fn(),
}));

const date = "2026-09-13T12:00:00Z";
let sequence = 0;
function registered() {
  const fixture = createPluginRegistryFixture();
  registerVirtualTestPlugin({
    ...fixture,
    id: "github",
    name: "GitHub",
    contracts: { gatewayMethodDispatch: ["authenticated-request"] },
    register: plugin.register,
  });
  return fixture.registry;
}
function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function issue(overrides: Record<string, unknown> = {}) {
  return {
    title: "Plugin reader",
    body: "**Public**",
    state: "open",
    created_at: date,
    updated_at: date,
    user: { login: "octocat" },
    comments: 0,
    review_comments: 0,
    changed_files: 0,
    ...overrides,
  };
}
function preview(overrides: Partial<ControlUiGitHubPreview> = {}): ControlUiGitHubPreview {
  return {
    kind: "pull",
    owner: "octocat",
    repo: "repo",
    number: 1,
    title: "Plugin reader",
    state: "open",
    login: "octocat",
    createdAt: date,
    updatedAt: date,
    ...overrides,
  };
}

async function request(method: string, params: Record<string, unknown>) {
  const registry = registered();
  const handler = registry.registry.gatewayHandlers[method];
  if (!handler) {
    throw new Error("Missing registered method " + method);
  }
  const respond = vi.fn<GatewayRequestHandlerOptions["respond"]>();
  await handler({
    params,
    respond,
    req: { id: "1", type: "req", method, params },
    client: null,
    context: {} as never,
    isWebchatConnect: () => false,
  });
  registry.rollbackPluginGlobalSideEffects("github", registry.registry.plugins[0]!);
  return respond;
}

describe("GitHub plugin ownership and RPC migration", () => {
  beforeEach(() => {
    vi.mocked(dispatchGatewayMethod).mockReset();
    clearRuntimeConfigSnapshot();
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("keeps existing behavior default-on, registers read-scoped methods lazily, and removes all surfaces on deactivation", () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const registry = registered();
    expect(manifest.enabledByDefault).toBe(true);
    expect(manifest.activation.onStartup).toBe(true);
    expect(manifest.contracts.gatewayMethodDispatch).toEqual(["authenticated-request"]);
    expect(registry.registry.gatewayMethodDescriptors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "github.preview",
          owner: { kind: "plugin", pluginId: "github" },
          scope: "operator.read",
          profileAccess: "independent",
        }),
        expect.objectContaining({
          name: "github.detail",
          owner: { kind: "plugin", pluginId: "github" },
          scope: "operator.read",
          profileAccess: "independent",
        }),
      ]),
    );
    expect(registry.registry.gatewayHandlers).not.toHaveProperty("controlUi.githubDetail");
    expect(registry.registry.gatewayHandlers).not.toHaveProperty("controlUi.githubPreview");
    expect(registry.registry.controlUiDescriptors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: "github",
          descriptor: expect.objectContaining({
            surface: "link-reader",
            id: "github",
            requiredScopes: ["operator.read"],
            linkReader: expect.objectContaining({
              hosts: ["github.com"],
              detailMethod: "github.detail",
              previewMethod: "github.preview",
            }),
          }),
        }),
      ]),
    );
    expect(registry.registry.controlUiDescriptors).toHaveLength(2);
    expect(
      registry.registry.controlUiDescriptors[1]?.descriptor.linkReader?.previewMethod,
    ).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
    registry.rollbackPluginGlobalSideEffects("github", registry.registry.plugins[0]!);
    expect(registry.registry.controlUiDescriptors).toEqual([]);
    expect(registry.registry.gatewayHandlers).toEqual({});
    expect(registry.registry.gatewayMethodDescriptors).toEqual([]);
  });

  it.each([
    ["github.detail", { url: "https://example.com/owner/repo/issues/1" }],
    ["github.detail", { url: "https://github.com/owner/repo/pull/1/checks" }],
    ["github.detail", { url: "https://github.com/owner/repo/commit/main" }],
    ["github.preview", { url: "https://github.com/owner/repo/issues/1", refresh: "true" }],
    ["github.preview", { url: "https://github.com/owner/repo/issues/1", agentId: " " }],
    ["github.preview", { url: "https://github.com/owner/repo/issues/1", agentId: 1 }],
  ])("rejects malformed %s requests before network access", async (method, params) => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const respond = await request(method as string, params as Record<string, unknown>);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      {
        code: "INVALID_REQUEST",
        message: "invalid " + method + " params",
      },
      undefined,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["github.preview", "github.detail"])(
    "keeps the validated requested URL as %s response identity",
    async (method) => {
      const url =
        "https://github.com/octocat/identity-" + ++sequence + "/pull/1/files?view=split#diff-one";
      vi.mocked(dispatchGatewayMethod).mockResolvedValueOnce({
        ok: true,
        payload: preview({ repo: new URL(url).pathname.split("/")[2] }),
      });
      vi.stubGlobal(
        "fetch",
        vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(response({ private: false }))
          .mockResolvedValueOnce(response(issue())),
      );
      const respond = await request(method, { url });
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ url }),
        undefined,
        undefined,
      );
    },
  );

  it.each([{ number: 2 }, { repo: "another-repo" }, { owner: "another-owner" }])(
    "rejects a well-formed host preview for another resource: %j",
    async (different) => {
      vi.mocked(dispatchGatewayMethod).mockResolvedValueOnce({
        ok: true,
        payload: preview(different),
      });
      const respond = await request("github.preview", {
        url: "https://github.com/octocat/repo/pull/1",
      });
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE" }),
        undefined,
      );
    },
  );

  it("serves generic public detail, preserves files-page expansion, and redacts upstream failures", async () => {
    vi.stubEnv("GH_TOKEN", "unused-ambient-token");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ private: false }))
      .mockResolvedValueOnce(response(issue()))
      .mockResolvedValueOnce(response({ message: "private upstream text" }, 429));
    vi.stubGlobal("fetch", fetchMock);
    const respond = await request("github.detail", {
      url: "https://github.com/octocat/rpc-" + ++sequence + "/pull/1/files#diff-example",
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        title: "Plugin reader",
        author: "octocat",
        body: "**Public**",
        badge: { label: "Open", tone: "positive" },
        filesExpanded: true,
        partial: false,
      }),
      undefined,
      undefined,
    );
    expect(respond.mock.calls[0]?.[1]).not.toHaveProperty("kind");
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
    for (const [, options] of fetchMock.mock.calls) {
      expect(options?.headers).not.toHaveProperty("Authorization");
    }
    const failed = await request("github.detail", {
      url: "https://github.com/octocat/rpc-" + ++sequence + "/issues/1",
    });
    expect(failed).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: expect.stringContaining("GitHub API rate limit exceeded (HTTP 429)"),
        retryable: true,
        retryAfterMs: expect.any(Number),
      }),
      undefined,
    );
  });

  it.each([
    [{ state: "open" }, { label: "Open", tone: "positive" }],
    [
      { state: "open", draft: true },
      { label: "Draft", tone: "neutral" },
    ],
    [
      { state: "closed", mergedAt: date },
      { label: "Merged", tone: "accent" },
    ],
    [{ state: "closed" }, { label: "Closed", tone: "negative" }],
  ] as const)(
    "maps the host preview into generic badges and metadata %#",
    async (fields, badge) => {
      const fetchMock = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", fetchMock);
      const meta = { source: "host-preview" };
      vi.mocked(dispatchGatewayMethod).mockResolvedValueOnce({
        ok: true,
        payload: preview({ ...fields, additions: 3, deletions: 1, changedFiles: 2 }),
        meta,
      });
      const respond = await request("github.preview", {
        url: "https://github.com/octocat/repo/pull/1",
      });
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          badge,
          author: "octocat",
          metadata: expect.arrayContaining([
            { label: "Additions", value: "+3" },
            { label: "Deletions", value: "−1" },
            { label: "Files", value: "2" },
          ]),
        }),
        undefined,
        meta,
      );
      expect(dispatchGatewayMethod).toHaveBeenCalledExactlyOnceWith("controlUi.githubPreview", {
        kind: "pull",
        owner: "octocat",
        repo: "repo",
        number: 1,
      });
      expect(respond.mock.calls[0]?.[1]).not.toHaveProperty("kind");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("retains the host's co-author metadata without another GitHub lookup", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(dispatchGatewayMethod).mockResolvedValueOnce({
      ok: true,
      payload: preview({
        coAuthors: [{ login: "ada", avatarDataUrl: "data:image/png;base64,iVBORw==" }],
        coAuthorCount: 2,
      }),
    });
    const respond = await request("github.preview", {
      url: "https://github.com/octocat/repo/pull/1",
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        metadata: expect.arrayContaining([{ label: "Co-authors", value: "ada +1" }]),
      }),
      undefined,
      undefined,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards the selected agent and explicit refresh without selecting credentials or caching locally", async () => {
    vi.stubEnv("GH_TOKEN", "unused-ambient-token");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(dispatchGatewayMethod)
      .mockResolvedValueOnce({ ok: true, payload: preview({ login: "selected-agent" }) })
      .mockResolvedValueOnce({ ok: true, payload: preview({ login: "selected-agent" }) })
      .mockResolvedValueOnce({
        ok: true,
        payload: preview({ login: "selected-agent", title: "Refreshed" }),
      });
    const params = { url: "https://github.com/octocat/repo/pull/1", agentId: " alternate " };
    for (let requestIndex = 0; requestIndex < 2; requestIndex += 1) {
      const respond = await request("github.preview", params);
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ author: "selected-agent" }),
        undefined,
        undefined,
      );
    }
    const refreshed = await request("github.preview", { ...params, refresh: true });
    expect(refreshed).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ title: "Refreshed" }),
      undefined,
      undefined,
    );
    const target = {
      kind: "pull",
      owner: "octocat",
      repo: "repo",
      number: 1,
      agentId: "alternate",
    };
    expect(dispatchGatewayMethod).toHaveBeenNthCalledWith(1, "controlUi.githubPreview", target);
    expect(dispatchGatewayMethod).toHaveBeenNthCalledWith(2, "controlUi.githubPreview", target);
    expect(dispatchGatewayMethod).toHaveBeenNthCalledWith(3, "controlUi.githubPreview", {
      ...target,
      refresh: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { code: "UNAVAILABLE", message: "Selected GitHub identity unavailable", retryable: false },
    { code: "UNAVAILABLE", message: "GitHub rate limit", retryable: true, retryAfterMs: 60_000 },
    { code: "INVALID_REQUEST", message: "Unknown agent", details: { reason: "unknown-agent" } },
  ])(
    "forwards the host $message envelope unchanged without an identity fallback",
    async (error) => {
      const fetchMock = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", fetchMock);
      const payload = { status: "unavailable" };
      const meta = { source: "host-preview" };
      vi.mocked(dispatchGatewayMethod).mockResolvedValueOnce({ ok: false, payload, error, meta });
      const respond = await request("github.preview", {
        url: "https://github.com/octocat/repo/issues/1",
        agentId: "alternate",
      });
      expect(respond).toHaveBeenCalledExactlyOnceWith(false, payload, error, meta);
      expect(respond.mock.calls[0]?.[2]).toBe(error);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(dispatchGatewayMethod).toHaveBeenCalledTimes(1);
    },
  );

  it.each([undefined, {}, { ...preview(), title: 42 }])(
    "rejects malformed successful host payloads %#",
    async (payload) => {
      vi.mocked(dispatchGatewayMethod).mockResolvedValueOnce({ ok: true, payload });
      const respond = await request("github.preview", {
        url: "https://github.com/octocat/repo/issues/1",
      });
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "UNAVAILABLE",
          message: expect.stringContaining("invalid response"),
        }),
        undefined,
      );
    },
  );
});
