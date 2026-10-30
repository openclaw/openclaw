import type { callGatewayTool } from "openclaw/plugin-sdk/agent-harness-runtime";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { beforeEach, expect, it, vi } from "vitest";

type BrowserNodeResponse = {
  payload?: unknown;
  payloadJSON?: unknown;
};

const runtime = vi.hoisted(() => ({
  callGatewayTool: vi.fn<typeof callGatewayTool<BrowserNodeResponse>>(),
  persistBrowserProxyResultFiles: vi.fn<(result: unknown, files?: unknown) => Promise<unknown>>(),
  fetchBrowserJson: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

const uploads = vi.hoisted(() => ({
  prepareBrowserProxyUploadRequest: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>()),
  callGatewayTool: runtime.callGatewayTool,
}));
vi.mock("./browser/client-fetch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./browser/client-fetch.js")>()),
  fetchBrowserJson: runtime.fetchBrowserJson,
}));
vi.mock("./browser/proxy-files.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./browser/proxy-files.js")>()),
  persistBrowserProxyResultFiles: runtime.persistBrowserProxyResultFiles,
}));
// mock-isolation: Supply upload admission outcomes without reading or transferring local files.
vi.mock("./browser-proxy-upload.js", async (load) => ({
  ...(await load<typeof import("./browser-proxy-upload.js")>()),
  ...uploads,
}));

import { createBrowserNodeProxyRequest } from "./browser-node-proxy.js";
import { BrowserServiceError } from "./browser/client-fetch.js";

function createSessionProxy(
  options: {
    node?: Partial<Parameters<typeof createBrowserNodeProxyRequest>[0]["nodeTarget"]>;
    fallback?: boolean;
    signal?: AbortSignal;
  } = {},
) {
  const { node = {}, fallback = false, signal } = options;
  return createBrowserNodeProxyRequest({
    nodeTarget: {
      nodeId: "node-1",
      commands: ["browser.proxy", "browser.proxy.upload.v1"],
      ...node,
    },
    allowAutomaticHostFallback: fallback,
    signal,
  });
}

const originalBody = { paths: ["/tmp/openclaw/uploads/report.txt"], ref: "e12" };
const uploadRequest = { method: "POST", path: "/hooks/file-chooser", body: originalBody };
const upload = {
  envelope: "browser-upload-v1",
  files: [{ name: "report.txt", contentBase64: "aGVsbG8=" }],
};
const preparedUpload = { body: { ref: "e12" }, upload };
const snapshot = { method: "GET", path: "/snapshot" };
const oldNode = { commands: ["browser.proxy"] };
const hostUnavailable = "Browser control host is not reachable on 127.0.0.1:18791.";

beforeEach(() => {
  runtime.callGatewayTool.mockReset().mockResolvedValue({ payload: { result: { ok: true } } });
  runtime.persistBrowserProxyResultFiles.mockReset().mockImplementation(async (result) => result);
  runtime.fetchBrowserJson.mockReset();
  uploads.prepareBrowserProxyUploadRequest
    .mockReset()
    .mockImplementation(async ({ body }: { body: unknown }) => ({ body }));
});

it.each([
  ["ACT_EVALUATE_DISABLED", { code: "ACT_EVALUATE_DISABLED" }],
  ["ACT_FUTURE_CODE", { code: undefined }],
] as const)("preserves the bounded action-code state for %s", async (code, expected) => {
  const body = { error: "evaluation disabled", code };
  runtime.callGatewayTool.mockResolvedValueOnce({
    payload: { error: { status: 403, body } },
  });

  const error = await createSessionProxy()({ method: "POST", path: "/act" }).catch(
    (caught: unknown) => caught,
  );

  expect(error).toBeInstanceOf(BrowserServiceError);
  expect(error).toMatchObject({
    name: "BrowserServiceError",
    message: "evaluation disabled",
    status: 403,
    ...expected,
  });
});

it.each([false, true])("uses the request signal when present (override=%s)", async (override) => {
  const signal = new AbortController().signal;
  const bound = new AbortController().signal;
  const proxy = createSessionProxy({ node: { commands: undefined }, signal: bound });
  await proxy({ ...snapshot, ...(override ? { signal } : {}) });
  expect(runtime.callGatewayTool.mock.lastCall?.[3]).toEqual({
    scopes: ["operator.admin"],
    signal: override ? signal : bound,
  });
});

it("keeps the bound tool execution signal when a node falls back to the host", async () => {
  const signal = new AbortController().signal;
  runtime.callGatewayTool.mockRejectedValueOnce(new Error(hostUnavailable));
  runtime.fetchBrowserJson.mockResolvedValueOnce({ ok: true, source: "gateway-host" });
  const proxy = createSessionProxy({ node: { commands: undefined }, fallback: true, signal });

  await expect(proxy(snapshot)).resolves.toMatchObject({ ok: true, source: "gateway-host" });

  expect(runtime.fetchBrowserJson).toHaveBeenCalledWith(
    "/snapshot",
    expect.objectContaining({ method: "GET", signal }),
  );
});

it.each(["unreachable", "upload-unsupported"] as const)(
  "does not switch browsers after a node action when the next request is %s",
  async (failure) => {
    const proxy = createSessionProxy({ node: oldNode, fallback: true });
    await proxy({ method: "POST", path: "/navigate", profile: "work" });
    runtime.fetchBrowserJson.mockResolvedValue({ ok: true, profile: "wrong-host" });
    if (failure === "unreachable") {
      runtime.callGatewayTool.mockRejectedValueOnce(new Error(hostUnavailable));
    }
    const request =
      failure === "unreachable"
        ? { method: "GET", path: "/snapshot", profile: "work" }
        : { ...uploadRequest, profile: "work" };

    await expect(proxy(request)).rejects.toThrow(
      failure === "unreachable"
        ? "Browser control host is not reachable"
        : "browser node does not support remote upload transfer",
    );
    expect(proxy.isHostFallbackActive()).toBe(false);
    expect(runtime.fetchBrowserJson).not.toHaveBeenCalled();
  },
);

it.each([
  { payload: {} },
  { payloadJSON: "{" },
  { payloadJSON: " " },
  { payloadJSON: "null" },
  { payloadJSON: "[]" },
  { payloadJSON: "42" },
  { payload: null, payloadJSON: '{"result":{"ok":true}}' },
])("rejects an invalid proxy envelope without host fallback: %j", async (response) => {
  runtime.callGatewayTool.mockResolvedValueOnce(response);
  const proxy = createSessionProxy({
    node: { commands: undefined, label: "Studio Node" },
    fallback: true,
  });

  await expect(proxy(snapshot)).rejects.toThrow(/Studio Node.*action=status.*target="host"/i);
  expect(runtime.fetchBrowserJson).not.toHaveBeenCalled();
});

it.each([
  { payloadJSON: '{"result":{"source":"json"}}', expected: "json" },
  { payload: { result: { source: "direct" } }, payloadJSON: "{", expected: "direct" },
])("uses the decoded proxy result with direct-payload precedence: %j", async (response) => {
  runtime.callGatewayTool.mockResolvedValueOnce(response);
  await expect(createSessionProxy()(snapshot)).resolves.toEqual({ source: response.expected });
});

it("rejects node file transfer failures without activating host fallback", async () => {
  const transferError = new Error("browser proxy returned an invalid file envelope");
  const result = { path: "/node/browser/screenshot.png" };
  runtime.callGatewayTool.mockResolvedValueOnce({ payload: { result, files: [] } });
  runtime.persistBrowserProxyResultFiles.mockRejectedValueOnce(transferError);
  const proxy = createSessionProxy({ node: oldNode, fallback: true });

  await expect(proxy({ method: "POST", path: "/screenshot" })).rejects.toBe(transferError);

  expect(runtime.persistBrowserProxyResultFiles).toHaveBeenCalledWith(result, []);
  expect(proxy.isHostFallbackActive()).toBe(false);
  expect(runtime.fetchBrowserJson).not.toHaveBeenCalled();
});

it("sends Gateway-owned upload bytes without node-facing source paths", async () => {
  uploads.prepareBrowserProxyUploadRequest.mockResolvedValueOnce(preparedUpload);

  await createSessionProxy()(uploadRequest);

  expect(runtime.callGatewayTool.mock.lastCall?.[2]).toMatchObject({
    command: "browser.proxy.upload.v1",
    params: preparedUpload,
  });
  expect(runtime.callGatewayTool.mock.lastCall).not.toHaveProperty("2.params.body.paths");
});

it("uses the original Gateway paths when an auto-selected old node lacks upload support", async () => {
  uploads.prepareBrowserProxyUploadRequest.mockResolvedValueOnce(preparedUpload);
  runtime.fetchBrowserJson.mockResolvedValueOnce({ ok: true });
  const proxy = createSessionProxy({ node: oldNode, fallback: true });

  await proxy(uploadRequest);

  expect(runtime.fetchBrowserJson).toHaveBeenCalledWith(
    "/hooks/file-chooser",
    expect.objectContaining({ method: "POST", body: JSON.stringify(originalBody) }),
  );
  expect(runtime.callGatewayTool).not.toHaveBeenCalled();
  expect(uploads.prepareBrowserProxyUploadRequest).not.toHaveBeenCalled();
});

it("explains when remote upload transfer is awaiting node command approval", async () => {
  const proxy = createSessionProxy({
    node: {
      commands: ["browser.proxy"],
      pendingDeclaredCommands: ["browser.proxy", "browser.proxy.upload.v1"],
    },
  });

  await expect(proxy(uploadRequest)).rejects.toThrow("remote upload transfer is pending approval");
  expect(runtime.callGatewayTool).not.toHaveBeenCalled();
  expect(uploads.prepareBrowserProxyUploadRequest).not.toHaveBeenCalled();
});

it("reserves both Node-safe watchdog windows for a saturated timeout", async () => {
  const timeoutMs = Number.MAX_SAFE_INTEGER;
  await createSessionProxy()({ ...snapshot, timeoutMs });

  const actionTimeoutMs = Math.min(timeoutMs, MAX_TIMER_TIMEOUT_MS - 130_000);
  expect(runtime.callGatewayTool.mock.lastCall).toMatchObject([
    "node.invoke",
    { timeoutMs: actionTimeoutMs + 130_000 },
    { timeoutMs: actionTimeoutMs + 125_000, params: { timeoutMs: actionTimeoutMs } },
    expect.anything(),
  ]);
});
