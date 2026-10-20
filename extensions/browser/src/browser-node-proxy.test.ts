import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserProxyRequest } from "./browser-node-proxy.js";

type BrowserNodeRequest = {
  command: string;
  timeoutMs: number;
  params: Parameters<BrowserProxyRequest>[0] & { timeoutMs: number; upload?: unknown };
};

type BrowserNodeResponse = {
  payload: { result: { ok: true; profile?: string } };
};

type BrowserGatewayCall = (
  method: string,
  options: { timeoutMs: number },
  request: BrowserNodeRequest,
  extra: { scopes: string[]; signal?: AbortSignal },
) => Promise<BrowserNodeResponse>;

const runtime = vi.hoisted(() => ({
  callGatewayTool: vi.fn<BrowserGatewayCall>(),
  persistBrowserProxyResultFiles: vi.fn<(result: unknown, files?: unknown) => Promise<unknown>>(),
  fetchBrowserJson: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

const uploads = vi.hoisted(() => ({
  isBrowserProxyUploadRequest: vi.fn(
    (params: { method: string; path: string; body: unknown }) =>
      params.method === "POST" &&
      params.path === "/hooks/file-chooser" &&
      Array.isArray((params.body as { paths?: unknown } | undefined)?.paths) &&
      ((params.body as { paths: unknown[] }).paths.length ?? 0) > 0,
  ),
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
vi.mock("./browser-proxy-upload.js", () => uploads);

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

function readGatewayCall(index = 0) {
  const call = runtime.callGatewayTool.mock.calls[index];
  if (!call) {
    throw new Error(`Expected Browser node invocation ${index}`);
  }
  const [method, gateway, node, extra] = call;
  return { method, gateway, node, extra };
}

beforeEach(() => {
  runtime.callGatewayTool.mockReset().mockResolvedValue({ payload: { result: { ok: true } } });
  runtime.persistBrowserProxyResultFiles.mockReset().mockImplementation(async (result) => result);
  runtime.fetchBrowserJson.mockReset();
  uploads.isBrowserProxyUploadRequest.mockClear();
  uploads.prepareBrowserProxyUploadRequest
    .mockReset()
    .mockImplementation(async ({ body }: { body: unknown }) => ({ body }));
});

describe("Browser node proxy nested watchdogs", () => {
  it.each([
    ["ACT_EVALUATE_DISABLED", { code: "ACT_EVALUATE_DISABLED" }],
    ["ACT_FUTURE_CODE", { code: undefined }],
  ] as const)("preserves the bounded action-code state for %s", async (code, expected) => {
    const body = { error: "evaluation disabled", code };
    runtime.callGatewayTool.mockResolvedValueOnce({
      payload: { error: { status: 403, body } },
    } as unknown as BrowserNodeResponse);

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
    expect(readGatewayCall().extra).toEqual({
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

  it("names the selected node and host-status recovery for an invalid proxy envelope", async () => {
    runtime.callGatewayTool.mockResolvedValueOnce({
      payload: {},
    } as unknown as BrowserNodeResponse);
    const proxy = createSessionProxy({ node: { commands: undefined, label: "Studio Node" } });

    await expect(proxy(snapshot)).rejects.toThrow(/Studio Node.*action=status.*target="host"/i);
  });

  it("rejects node file transfer failures without activating host fallback", async () => {
    const transferError = new Error("browser proxy returned an invalid file envelope");
    const result = { path: "/node/browser/screenshot.png" };
    runtime.callGatewayTool.mockResolvedValueOnce({
      payload: { result, files: [] },
    } as unknown as BrowserNodeResponse);
    runtime.persistBrowserProxyResultFiles.mockRejectedValueOnce(transferError);
    const proxy = createSessionProxy({ node: oldNode, fallback: true });

    await expect(proxy({ method: "POST", path: "/screenshot" })).rejects.toBe(transferError);

    expect(runtime.callGatewayTool).toHaveBeenCalledOnce();
    expect(runtime.persistBrowserProxyResultFiles).toHaveBeenCalledWith(
      { path: "/node/browser/screenshot.png" },
      [],
    );
    expect(proxy.isHostFallbackActive()).toBe(false);
    expect(runtime.fetchBrowserJson).not.toHaveBeenCalled();
  });

  it("sends Gateway-owned upload bytes without node-facing source paths", async () => {
    uploads.prepareBrowserProxyUploadRequest.mockResolvedValueOnce(preparedUpload);

    await createSessionProxy()(uploadRequest);

    expect(readGatewayCall().node).toMatchObject({
      command: "browser.proxy.upload.v1",
      params: preparedUpload,
    });
    expect(readGatewayCall().node.params.body).toMatchObject({ ref: "e12" });
    expect(readGatewayCall().node.params.body).not.toHaveProperty("paths");
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

    await expect(proxy(uploadRequest)).rejects.toThrow(
      "remote upload transfer is pending approval",
    );
    expect(runtime.callGatewayTool).not.toHaveBeenCalled();
    expect(uploads.prepareBrowserProxyUploadRequest).not.toHaveBeenCalled();
  });

  it("reserves both Node-safe watchdog windows for a saturated timeout", async () => {
    const timeoutMs = Number.MAX_SAFE_INTEGER;
    await createSessionProxy()({ ...snapshot, timeoutMs });

    const actionTimeoutMs = Math.min(timeoutMs, MAX_TIMER_TIMEOUT_MS - 130_000);
    const { gateway, node } = readGatewayCall();
    expect([node.params.timeoutMs, node.timeoutMs, gateway.timeoutMs]).toEqual([
      actionTimeoutMs,
      actionTimeoutMs + 125_000,
      actionTimeoutMs + 130_000,
    ]);
    expect(gateway.timeoutMs).toBeLessThanOrEqual(MAX_TIMER_TIMEOUT_MS);
  });
});
