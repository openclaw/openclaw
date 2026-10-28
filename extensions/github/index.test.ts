import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ControlUiGitHubPreview } from "./api.js";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

vi.mock("openclaw/plugin-sdk/gateway-method-runtime", () => ({
  dispatchGatewayMethod: vi.fn(),
}));

const date = "2026-09-13T12:00:00Z";
const closedAt = "2026-09-03T12:00:00Z";
const pullUrl = "https://github.com/octocat/repo/pull/1";
const issueUrl = "https://github.com/octocat/repo/issues/1";
const imageUrl = "https://user-images.githubusercontent.com/image.png";
const assetUrl = "https://github-production-user-asset-6210df.s3.amazonaws.com/image.png";
const pullTarget = { kind: "pull", owner: "octocat", repo: "repo", number: 1 } as const;
const avatar = "data:image/png;base64,iVBORw==";
const meta = { source: "host-preview" };
type Respond = GatewayRequestHandlerOptions["respond"];
type HostReply = Awaited<ReturnType<typeof dispatchGatewayMethod>>;
function registered(host?: string) {
  const fixture = createPluginRegistryFixture(
    host ? { gateway: { github: { host, apiBaseUrl: `https://${host}/api/v3` } } } : {},
  );
  registerVirtualTestPlugin({
    ...fixture,
    ...plugin,
    contracts: { ...manifest.contracts, gatewayMethodDispatch: ["authenticated-request"] },
    register: plugin.register,
  });
  return fixture.registry;
}
const document = (url = pullUrl) => ({ url, title: "Plugin reader", body: "**Public**" });
function preview(
  overrides: Partial<ControlUiGitHubPreview & { kind: "issue" | "pull" }> = {},
): ControlUiGitHubPreview {
  return {
    ...pullTarget,
    title: "Plugin reader",
    state: "open",
    login: "octocat",
    createdAt: date,
    updatedAt: date,
    ...overrides,
  };
}

function hostSuccess(payload: unknown, info?: HostReply["meta"]) {
  vi.mocked(dispatchGatewayMethod).mockResolvedValueOnce({ ok: true, payload, meta: info });
}

const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

function expectReader(registry: ReturnType<typeof registered>, host?: string) {
  const id = host ? "github-session" : "github";
  const descriptor = registry.registry.controlUiDescriptors.find(
    (entry) => entry.descriptor.id === id,
  )?.descriptor;
  expect(descriptor?.requiredScopes).toEqual(["operator.read"]);
  expect(descriptor?.linkReader).toMatchObject({
    hosts: [host ?? "github.com"],
    progressive: true,
    previewMethod: host ? "github.sessionPreview" : "github.preview",
    detailMethod: host ? "github.sessionDetail" : "github.detail",
    ...(host ? { sessionScoped: true } : { imageMethod: "github.image" }),
  });
}

async function request(method: string, params: Record<string, unknown>) {
  const registry = registered();
  const respond = vi.fn<Respond>();
  await registry.registry.gatewayHandlers[method]!({
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

function expectSuccess(respond: Respond, payload: unknown, info?: unknown) {
  expect(respond).toHaveBeenCalledWith(true, expect.objectContaining(payload), undefined, info);
  expect(fetchMock).not.toHaveBeenCalled();
}

function expectFailure(respond: Respond, error: unknown) {
  expect(respond).toHaveBeenCalledWith(false, undefined, error, undefined);
}

async function expectUnavailable(method: string, url: string, error: object) {
  expectFailure(await request(method, { url }), expect.objectContaining(error));
}

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(dispatchGatewayMethod).mockReset();
  vi.stubEnv("GH_TOKEN", "");
  vi.stubEnv("GITHUB_TOKEN", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each([undefined, "ghe.example.test"])("registers read-scoped readers (%s)", (host) => {
  const registry = registered(host);
  const methods = registry.registry.gatewayMethodDescriptors;
  for (const name of ["github.preview", "github.image", "github.detail"]) {
    expect(methods.find((entry) => entry.name === name)).toMatchObject({
      owner: { kind: "plugin", pluginId: "github" },
      scope: "operator.read",
      profileAccess: "independent",
    });
  }
  if (host) {
    expectReader(registry, host);
    expect(methods.find((entry) => entry.name === "github.sessionPreview")).toMatchObject({
      scope: "operator.read",
    });
  }
  expect(registry.registry.gatewayHandlers).not.toHaveProperty("controlUi.githubDetail");
  expect(registry.registry.gatewayHandlers).not.toHaveProperty("controlUi.githubPreview");
  expectReader(registry);
  expect(registry.registry.controlUiDescriptors).toHaveLength(host ? 4 : 2);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(dispatchGatewayMethod).not.toHaveBeenCalled();
  registry.rollbackPluginGlobalSideEffects("github", registry.registry.plugins[0]!);
  expect(registry.registry.controlUiDescriptors).toEqual([]);
  expect(registry.registry.tools).toEqual([]);
  expect(registry.registry.gatewayHandlers).toEqual({});
  expect(registry.registry.gatewayMethodDescriptors).toEqual([]);
});

it("loads anonymous attachment redirects without browser CORS headers", async () => {
  const url = "https://github.com/user-attachments/assets/3c11071f-21b8-4123-b9b2-711dc7ca47fd";
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7WQAAAAASUVORK5CYII=",
    "base64",
  );
  fetchMock
    .mockResolvedValueOnce(redirect(`${assetUrl}?signature=fixture`))
    .mockResolvedValueOnce(new Response(png, { headers: { "content-type": "image/png" } }));
  const respond = await request("github.image", { url });
  expect(respond).toHaveBeenCalledWith(
    true,
    { url, dataUrl: `data:image/png;base64,${png.toString("base64")}` },
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
])("blocks unsafe image redirect %s before fetching it", async (location) => {
  fetchMock.mockResolvedValueOnce(redirect(location));
  await expectUnavailable("github.image", imageUrl, { message: "GitHub image is unavailable" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it.each([
  ["<svg xmlns='http://www.w3.org/2000/svg'></svg>", "image/png"],
  ["x".repeat(2 * 1024 * 1024 + 1), "image/jpeg"],
])("rejects unsupported or oversized image content", async (body, contentType) => {
  fetchMock.mockResolvedValue(new Response(body, { headers: { "content-type": contentType } }));
  await expectUnavailable("github.image", imageUrl, { message: "GitHub image is unavailable" });
});

it.each([
  ["github.image", {}],
  ["github.image", { url: assetUrl }],
  ["github.detail", { url: "https://example.com/owner/repo/issues/1" }],
  ["github.detail", { url: "https://github.com/owner/repo/pull/1/checks" }],
  ["github.preview", { url: "https://github.com/owner/repo/commit/not-a-sha" }],
  ["github.detail", { url: pullUrl, section: "unknown" }],
  ["github.preview", { url: pullUrl, section: "overview" }],
  ["github.preview", { url: "https://github.com/owner/repo/issues/1", agentId: " " }],
] as const)("rejects malformed %s requests before network access", async (method, params) => {
  const respond = await request(method, params);
  expectFailure(respond, { code: "INVALID_REQUEST", message: "invalid " + method + " params" });
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each([undefined, "overview"])("adapts %s documents with files expanded", async (section) => {
  vi.stubEnv("GH_TOKEN", "unused-ambient-token");
  hostSuccess(document());
  const url = `${pullUrl}/files?view=split#diff-example`;
  const options = { agentId: "selected-agent", refresh: true, ...(section ? { section } : {}) };
  const respond = await request("github.detail", { url, ...options });
  expectSuccess(respond, {
    url,
    body: "**Public**",
    filesExpanded: true,
  });
  expect(dispatchGatewayMethod).toHaveBeenCalledExactlyOnceWith("controlUi.githubDetail", {
    ...pullTarget,
    ...options,
  });
});

it.each([
  ["github.preview", preview({ number: 2 }), { code: "UNAVAILABLE" }],
  ["github.detail", document("https://github.com/octocat/private/pull/1"), { code: "UNAVAILABLE" }],
  [
    "github.preview",
    {},
    { code: "UNAVAILABLE", message: expect.stringContaining("invalid response") },
  ],
] as const)("rejects invalid host payloads for %s", async (method, payload, error) => {
  hostSuccess(payload);
  await expectUnavailable(method, pullUrl, error);
});

it.each([
  ["pull", "open", false, undefined, undefined, "Open", "positive"],
  ["pull", "open", true, undefined, undefined, "Draft", "neutral"],
  ["pull", "closed", true, undefined, closedAt, "Closed", "negative"],
  ["pull", "closed", undefined, closedAt, date, "Merged", "accent"],
  ["commit", "committed", undefined, undefined, undefined, "Commit", "neutral"],
] as const)("maps preview %#", async (kind, state, draft, mergedAt, closed, label, tone) => {
  const target =
    kind === "commit"
      ? { kind, owner: "octocat", repo: "repo", sha: "abcdef0123456789" }
      : pullTarget;
  const url =
    kind === "commit"
      ? "https://github.com/octocat/repo/commit/abcdef0123456789#diff-example"
      : pullUrl;
  hostSuccess(
    {
      ...preview({ state, draft, mergedAt, closedAt: closed }),
      ...target,
      ...(kind === "commit" ? { number: undefined } : {}),
      stale: true,
      additions: 3,
      deletions: 1,
      coAuthors: [{ login: "ada", avatarDataUrl: avatar }],
      coAuthorCount: 2,
    },
    meta,
  );
  const respond = await request("github.preview", { url });
  expectSuccess(
    respond,
    {
      url,
      title: "Plugin reader",
      ...(kind === "commit" ? { subtitle: "octocat/repo · abcdef012345" } : {}),
      badge: { label, tone, timestamp: mergedAt ?? closed },
      stale: true,
      author: "octocat",
      authorUrl: "https://github.com/octocat",
      coAuthors: [{ name: "ada", imageUrl: avatar }],
      coAuthorCount: 2,
      metadata: [
        { label: "", value: "+3", tone: "positive" },
        { label: "", value: "−1", tone: "negative" },
      ],
    },
    meta,
  );
  expect(dispatchGatewayMethod).toHaveBeenCalledWith("controlUi.githubPreview", target);
  expect(respond.mock.calls[0]?.[1]).not.toHaveProperty("kind");
});

it.each([undefined, 0])("shows closed issues with comment count %s", async (comments) => {
  hostSuccess(
    preview({ kind: "issue", state: "closed", stateReason: "completed", closedAt, comments }),
  );
  expectSuccess(await request("github.preview", { url: issueUrl }), {
    createdAt: date,
    badge: { label: "Closed", tone: "accent", timestamp: closedAt },
    metadata: comments === undefined ? [] : [{ label: "Comments", value: "0" }],
  });
});

it("forwards the host error envelope unchanged without an identity fallback", async () => {
  const error = {
    code: "UNAVAILABLE",
    message: "Rate limited",
    retryAfterMs: 60_000,
    details: { reason: "rate-limit" },
  };
  const payload = { status: "unavailable" };
  vi.mocked(dispatchGatewayMethod).mockResolvedValueOnce({ ok: false, payload, error, meta });
  const respond = await request("github.detail", { url: issueUrl, agentId: "alternate" });
  expect(respond).toHaveBeenCalledExactlyOnceWith(false, payload, error, meta);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(dispatchGatewayMethod).toHaveBeenCalledTimes(1);
});
