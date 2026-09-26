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
function document(url = "https://github.com/octocat/repo/pull/1") {
  return { url, title: "Plugin reader", body: "**Public**", author: "octocat" };
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
          name: "github.image",
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
              imageMethod: "github.image",
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
    {},
    { url: "https://github.com/login" },
    { url: "https://github-production-user-asset-6210df.s3.amazonaws.com/image.png" },
    { url: "https://example.com/image.png" },
    { url: "https://user:password@user-images.githubusercontent.com/image.png" },
  ])("rejects invalid image params without a request: %j", async (params) => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    expect(await request("github.image", params)).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "invalid github.image params" }),
      undefined,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads anonymous attachment redirects without browser CORS headers", async () => {
    const url = "https://github.com/user-attachments/assets/3c11071f-21b8-4123-b9b2-711dc7ca47fd";
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7WQAAAAASUVORK5CYII=",
      "base64",
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            location:
              "https://github-production-user-asset-6210df.s3.amazonaws.com/image.png?signature=fixture",
          },
        }),
      )
      .mockResolvedValueOnce(new Response(png, { headers: { "content-type": "image/png" } }));
    vi.stubGlobal("fetch", fetchMock);
    const respond = await request("github.image", { url });
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        url,
        dataUrl: `data:image/png;base64,${png.toString("base64")}`,
      },
      undefined,
      undefined,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      const headers = new Headers(init?.headers);
      expect(headers.has("authorization")).toBe(false);
      expect(headers.has("cookie")).toBe(false);
      expect(init?.credentials).toBe("omit");
    }
  });

  it.each([
    "https://evil.example/image.png?signature=private",
    "http://user-images.githubusercontent.com/image.png",
    "https://user-images.githubusercontent.com:444/image.png",
    "https://user:password@user-images.githubusercontent.com/image.png",
    "https://github.com/login",
    "https://127.0.0.1/image.png",
  ])("blocks unsafe image redirect %s before fetching it", async (location) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const respond = await request("github.image", {
      url: "https://user-images.githubusercontent.com/image.png",
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "GitHub image is unavailable",
      }),
      undefined,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["<svg xmlns='http://www.w3.org/2000/svg'></svg>", "image/png"],
    ["<html>not an image</html>", "image/png"],
    ["x".repeat(2 * 1024 * 1024 + 1), "image/jpeg"],
  ])("rejects unsupported or oversized image content", async (body, contentType) => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(body, {
          headers: { "content-type": contentType },
        }),
      ),
    );
    expect(
      await request("github.image", {
        url: "https://user-images.githubusercontent.com/image.png",
      }),
    ).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "GitHub image is unavailable",
      }),
      undefined,
    );
  });

  it.each([
    ["github.detail", { url: "https://example.com/owner/repo/issues/1" }],
    ["github.detail", { url: "https://github.com/owner/repo/pull/1/checks" }],
    ["github.detail", { url: "https://github.com/owner/repo/commit/main" }],
    ["github.preview", { url: "https://github.com/owner/repo/commit/abcdef0" }],
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
        payload:
          method === "github.preview"
            ? preview({ repo: new URL(url).pathname.split("/")[2] })
            : document(url.split("/files")[0]),
      });
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

  it("uses the host identity adapter for documents and preserves files-page expansion", async () => {
    vi.stubEnv("GH_TOKEN", "unused-ambient-token");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(dispatchGatewayMethod).mockResolvedValueOnce({
      ok: true,
      payload: document(),
    });
    const respond = await request("github.detail", {
      url: "https://github.com/octocat/repo/pull/1/files#diff-example",
      agentId: "selected-agent",
      refresh: true,
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ title: "Plugin reader", body: "**Public**", filesExpanded: true }),
      undefined,
      undefined,
    );
    expect(dispatchGatewayMethod).toHaveBeenCalledExactlyOnceWith("controlUi.githubDetail", {
      kind: "pull",
      owner: "octocat",
      repo: "repo",
      number: 1,
      agentId: "selected-agent",
      refresh: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([undefined, {}, { ...document(), url: "https://github.com/octocat/private/pull/1" }])(
    "rejects an invalid host document before delivery: %#",
    async (payload) => {
      vi.mocked(dispatchGatewayMethod).mockResolvedValueOnce({ ok: true, payload });
      expect(await request("github.detail", { url: document().url })).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE" }),
        undefined,
      );
    },
  );

  it.each([
    [{ state: "open" }, { label: "Open", tone: "positive" }],
    [
      { state: "open", draft: true },
      { label: "Draft", tone: "neutral" },
    ],
    [
      { state: "closed", mergedAt: date },
      { label: "Merged", tone: "accent", timestamp: date },
    ],
    [{ state: "closed" }, { label: "Closed", tone: "negative" }],
    [
      { state: "closed", closedAt: "2026-09-03T12:00:00Z" },
      { label: "Closed", tone: "negative", timestamp: "2026-09-03T12:00:00Z" },
    ],
    [
      { state: "closed", draft: true, closedAt: "2026-09-03T12:00:00Z" },
      { label: "Closed", tone: "negative", timestamp: "2026-09-03T12:00:00Z" },
    ],
    [
      { state: "open", closedAt: "2026-09-03T12:00:00Z" },
      { label: "Open", tone: "positive" },
    ],
    [
      { state: "closed", mergedAt: "2026-09-03T12:00:00Z", closedAt: date },
      { label: "Merged", tone: "accent", timestamp: "2026-09-03T12:00:00Z" },
    ],
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
          authorUrl: "https://github.com/octocat",
          metadata: [
            { label: "", value: "+3", tone: "positive" },
            { label: "", value: "−1", tone: "negative" },
          ],
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

  it.each([
    ["completed", "accent"],
    ["not_planned", "negative"],
  ] as const)("shows the closure date for %s issues", async (stateReason, tone) => {
    const closedAt = "2026-09-03T12:00:00Z";
    vi.mocked(dispatchGatewayMethod).mockResolvedValueOnce({
      ok: true,
      payload: preview({ kind: "issue", state: "closed", stateReason, closedAt }),
    });
    const respond = await request("github.preview", {
      url: "https://github.com/octocat/repo/issues/1",
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        createdAt: date,
        badge: { label: "Closed", tone, timestamp: closedAt },
      }),
      undefined,
      undefined,
    );
  });

  it.each([undefined, 0, 7])(
    "only shows an issue comment count when it is known: %s",
    async (comments) => {
      vi.mocked(dispatchGatewayMethod).mockResolvedValueOnce({
        ok: true,
        payload: preview({ kind: "issue", comments }),
      });
      const respond = await request("github.preview", {
        url: "https://github.com/octocat/repo/issues/1",
      });
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          metadata: comments === undefined ? [] : [{ label: "Comments", value: String(comments) }],
        }),
        undefined,
        undefined,
      );
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
        coAuthors: [{ name: "ada", imageUrl: "data:image/png;base64,iVBORw==" }],
        coAuthorCount: 2,
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
      const respond = await request("github.detail", {
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
