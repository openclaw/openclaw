import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import "../test-support/browser-security.mock.js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { DEFAULT_DOWNLOAD_DIR, DEFAULT_TRACE_DIR, DEFAULT_UPLOAD_DIR } from "./paths.js";
import {
  installAgentContractHooks,
  postJson,
  startServerAndBase,
} from "./server.agent-contract.test-harness.js";
import {
  cleanupBrowserControlServerTestContext,
  resetBrowserControlServerTestContext,
  getBrowserControlServerBaseUrl,
  getBrowserControlServerTestState,
  getCdpMocks,
  getPwMocks,
  makeResponse,
  setBrowserControlServerEvaluateEnabled,
  setBrowserControlServerExtraArgs,
  setBrowserControlServerProfiles,
  setBrowserControlServerReachable,
  setBrowserControlServerSsrFPolicy,
  setBrowserControlServerTabUrl,
  startBrowserControlServerFromConfig,
} from "./server.control-server.test-harness.js";
import { createBrowserTestClient, getBrowserTestFetch } from "./test-support/fetch.js";

const BROWSER_NAVIGATION_BLOCKED_MESSAGE = "browser navigation blocked by policy";
const targetId = "abcd1234";
const TAB_URL = "https://example.com";

function postResponse(base: string, route: string, body?: unknown) {
  return realFetch(`${base}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function postActAndReadError(base: string, body?: unknown) {
  const response = await postResponse(base, "/act", body);
  return {
    status: response.status,
    body: (await response.json()) as { error?: string; code?: string },
  };
}

const state = getBrowserControlServerTestState();
const cdpMocks = getCdpMocks();
const pwMocks = getPwMocks();
function pw<K extends keyof typeof pwMocks>(name: K): NonNullable<(typeof pwMocks)[K]> {
  return expectDefined(pwMocks[name], `Playwright mock ${name}`);
}

function replaceActedOnTab(
  id = "fresh5678",
  title = "Submitted",
  tabUrl = "https://submitted.example",
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/json/list")) {
        return makeResponse([
          {
            id,
            title,
            url: tabUrl,
            webSocketDebuggerUrl: `ws://127.0.0.1/devtools/page/${id}`,
            type: "page",
          },
        ]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

const realFetch: ReturnType<typeof getBrowserTestFetch> = (input, init) =>
  getBrowserTestFetch()(input, init);

const guardedCurrentTabRouteCases = [
  ["GET", "/errors?targetId=abcd1234", undefined, "getPageErrorsViaPlaywright"],
  ["GET", "/requests?targetId=abcd1234", undefined, "getNetworkRequestsViaPlaywright"],
  ["POST", "/trace/start", { targetId }, "traceStartViaPlaywright"],
  ["POST", "/trace/stop", { targetId }, "traceStopViaPlaywright"],
  ["POST", "/response/body", { targetId, url: "**/api/data" }, "responseBodyViaPlaywright"],
  ["POST", "/highlight", { targetId, ref: "e1" }, "highlightViaPlaywright"],
  ["GET", "/console?targetId=abcd1234", undefined, "getConsoleMessagesViaPlaywright"],
  ["POST", "/pdf", { targetId }, "pdfViaPlaywright"],
  ["POST", "/screenshot", { targetId }, "takeScreenshotViaPlaywright"],
  [
    "POST",
    "/download",
    { targetId, currentDocument: true, expectedUrl: TAB_URL },
    "downloadCurrentDocumentViaPlaywright",
  ],
  [
    "POST",
    "/act",
    {
      targetId,
      kind: "batch",
      actions: [{ kind: "evaluate", fn: "() => document.body.innerText" }],
    },
    "executeActViaPlaywright",
  ],
  ["GET", "/cookies?targetId=abcd1234", undefined, "cookiesGetViaPlaywright"],
  ["GET", "/storage/local?targetId=abcd1234", undefined, "storageGetViaPlaywright"],
  [
    "GET",
    "/snapshot?format=ai",
    undefined,
    ["getObservedBrowserStateViaPlaywright", "snapshotRoleViaPlaywright"],
  ],
] as const;

type MockWithCalls = { mock: { calls: unknown[][] } };

const requireRecord = createRequireRecord("record", "expected-label-object");

function requireMockArg(mock: MockWithCalls) {
  return requireRecord(mock.mock.calls[0]?.[0], "mock call argument");
}

function expectBrowserCallFields(mock: MockWithCalls, expected: Record<string, unknown>) {
  expect(requireMockArg(mock)).toMatchObject({ cdpUrl: expect.any(String), ...expected });
}

function post<T>(route: string, body?: unknown): Promise<T> {
  return postJson<T>(`${getBrowserControlServerBaseUrl()}${route}`, body);
}

function expectLastAction(action: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  expect(pw("executeActViaPlaywright")).toHaveBeenLastCalledWith(
    expect.objectContaining({ cdpUrl: state.cdpBaseUrl, targetId, action, ...extra }),
  );
}

type ActionCase = [input: Record<string, unknown>, normalized?: Record<string, unknown>];

describe("browser control server", () => {
  installAgentContractHooks();

  it("returns ACT_EXISTING_SESSION_UNSUPPORTED for unsupported existing-session actions", async () => {
    setBrowserControlServerProfiles({
      openclaw: { color: "#FF4500", driver: "existing-session" },
    });

    const base = await startServerAndBase();
    const response = await postActAndReadError(base, {
      kind: "batch",
      actions: [{ kind: "press", key: "Enter" }],
    });

    expect(response.status).toBe(501);
    expect(response.body.code).toBe("ACT_EXISTING_SESSION_UNSUPPORTED");
    expect(response.body.error).toBe(
      "existing-session batch is not supported yet; send actions individually.",
    );
  });

  it.each([
    {
      body: { kind: "batch", actions: [{ kind: "click", ref: "5", targetId: "other-tab" }] },
      error: "batched action targetId must match request targetId",
    },
    // Route selection ignores a numeric target; action normalization stringifies it.
    {
      body: { kind: "click", ref: "5", targetId: 12345 },
      error: "action targetId must match request targetId",
    },
  ])("rejects action target overrides: $error", async ({ body, error }) => {
    const response = await postActAndReadError(await startServerAndBase(), body);
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      code: "ACT_TARGET_ID_MISMATCH",
      error: expect.stringContaining(error),
    });
    expect(pw("executeActViaPlaywright")).not.toHaveBeenCalled();
  });

  it("canonicalizes request and batch target aliases with the resolved proxy policy", async () => {
    setBrowserControlServerExtraArgs(["--proxy-server=http://proxy.example:8080"]);
    await startServerAndBase();
    const response = await post<{ ok: boolean }>("/act", {
      kind: "batch",
      targetId: "abcd",
      // Sub-action references the same tab via a unique prefix alias.
      actions: [{ kind: "click", ref: "1", targetId: "abcd" }],
    });

    expect(response.ok).toBe(true);
    expect(pw("executeActViaPlaywright").mock.calls[0]?.[0]).toMatchObject({
      browserProxyMode: "explicit-browser-proxy",
      action: { targetId, actions: [{ targetId }] },
    });
  });

  it.each([
    { replacement: undefined, expectedTarget: "abcd1234" },
    { replacement: "fresh5678", expectedTarget: "fresh5678" },
  ])(
    "only adopts a replacement proven by the acted-on page: $replacement",
    async ({ replacement, expectedTarget }) => {
      await startServerAndBase();
      pw("executeActViaPlaywright").mockImplementationOnce(async () => {
        replaceActedOnTab();
        return { targetId: replacement };
      });
      expect(await post("/act", { kind: "click", ref: "5", targetId })).toMatchObject({
        ok: true,
        targetId: expectedTarget,
      });
    },
  );

  it("returns blocked dialog state for action-triggered modals", async () => {
    await startServerAndBase();
    const pending = [
      { id: "d1", type: "confirm", message: "Continue?", openedAt: "2026-05-17T12:00:00.000Z" },
    ];
    pw("executeActViaPlaywright").mockResolvedValueOnce({
      blockedByDialog: true,
      browserState: { dialogs: { pending, recent: [] } },
    });
    expect(await post("/act", { kind: "click", ref: "5" })).toMatchObject({
      ok: true,
      blockedByDialog: true,
      browserState: { dialogs: { pending } },
    });
  });

  it("returns action download metadata from /act responses", async () => {
    await startServerAndBase();
    const downloads = [
      {
        url: "https://example.com/report.pdf",
        suggestedFilename: "report.pdf",
        path: "/tmp/openclaw/downloads/report.pdf",
      },
    ];
    pw("executeActViaPlaywright").mockResolvedValueOnce({ downloads });
    expect(await post("/act", { kind: "click", ref: "5" })).toEqual({
      ok: true,
      targetId,
      url: TAB_URL,
      downloads,
    });
  });

  it("blocks evaluation while preserving cookie and storage reads", async () => {
    setBrowserControlServerEvaluateEnabled(false);
    const base = await startServerAndBase();
    const response = await postActAndReadError(base, { kind: "evaluate", fn: "() => 1" });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("ACT_EVALUATE_DISABLED");
    expect(response.body.error).toContain("browser.evaluateEnabled=false");
    expect(pw("evaluateViaPlaywright")).not.toHaveBeenCalled();
    pw("cookiesGetViaPlaywright").mockResolvedValueOnce({
      cookies: [{ name: "session", value: "abc123" }],
    });
    pw("storageGetViaPlaywright").mockResolvedValueOnce({ values: { token: "value" } });
    for (const [route, mock, result, options] of [
      ["/cookies", "cookiesGetViaPlaywright", { cookies: [{ name: "session" }] }, {}],
      [
        "/storage/local?key=token",
        "storageGetViaPlaywright",
        { values: { token: "value" } },
        { kind: "local", key: "token" },
      ],
    ] as const) {
      expect(await (await realFetch(`${base}${route}`)).json()).toMatchObject({
        ok: true,
        ...result,
      });
      expect(pw(mock)).toHaveBeenCalledWith({ cdpUrl: state.cdpBaseUrl, targetId, ...options });
    }
  });

  it("agent contract: doctor deep runs a live snapshot probe", async () => {
    const base = await startServerAndBase();

    const report = (await realFetch(`${base}/doctor?deep=true`).then((r) => r.json())) as {
      ok: boolean;
      checks?: Array<{ id?: string; status?: string; summary?: string }>;
    };

    expect(report.ok).toBe(true);
    const liveSnapshotCheck = report.checks?.find((check) => check.id === "live-snapshot");
    expect(liveSnapshotCheck).toMatchObject({ id: "live-snapshot", status: "pass" });
    expect(cdpMocks.snapshotAria).toHaveBeenCalledWith({
      wsUrl: "ws://127.0.0.1/devtools/page/abcd1234",
      limit: 25,
    });
  });

  it.each([
    { ownerTarget: undefined, backendTarget: "unrelated-999", expected: "abcd1234" },
    { ownerTarget: "replacement-target", backendTarget: undefined, expected: "replacement-target" },
  ])(
    "navigation preserves captured relay ownership: $ownerTarget",
    async ({ ownerTarget, backendTarget, expected }) => {
      await startServerAndBase();
      const runtime = expectDefined(await startBrowserControlServerFromConfig(), "browser runtime");
      const previousRelays = runtime.extensionRelays;
      runtime.extensionRelays = new Map([
        ["openclaw", { bridge: { captureOperationTarget: () => () => ownerTarget } }],
      ]) as unknown as NonNullable<typeof runtime.extensionRelays>;
      pw("navigateViaPlaywright").mockImplementationOnce(async (options) => {
        const operationTargetId = await (
          options as {
            resolveOperationTarget?: () => string | undefined | Promise<string | undefined>;
          }
        ).resolveOperationTarget?.();
        expect(operationTargetId).toBe(ownerTarget);
        return {
          url: "https://example.com/recovered",
          targetId: backendTarget ?? operationTargetId,
        };
      });
      try {
        expect(
          await post("/navigate", { url: "https://example.com/recovered", targetId }),
        ).toMatchObject({ ok: true, targetId: expected });
      } finally {
        runtime.extensionRelays = previousRelays;
      }
    },
  );

  it("clamps overflowing navigation timeouts for Chrome MCP", async () => {
    setBrowserControlServerProfiles({ openclaw: { color: "#FF4500", driver: "existing-session" } });
    await startServerAndBase();

    const response = await post<{ ok: boolean }>("/navigate", {
      url: "https://example.com/slow",
      targetId: "7",
      timeoutMs: 3_000_000_000,
    });

    expect(response.ok).toBe(true);
    const chromeMcp = await import("./chrome-mcp.js");
    expect(chromeMcp.navigateChromeMcpPage).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: "openclaw",
        targetId: "7",
        url: "https://example.com/slow",
        timeoutMs: 120_000,
      }),
    );
  });

  it("agent contract: navigation + common act commands", async () => {
    await startServerAndBase();
    expect(await post("/navigate", { url: TAB_URL })).toMatchObject({ ok: true, targetId });
    expect(pw("navigateViaPlaywright")).toHaveBeenCalledWith(
      expect.objectContaining({
        cdpUrl: state.cdpBaseUrl,
        targetId,
        url: TAB_URL,
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
      }),
    );
    const actions: ActionCase[] = [
      [{ kind: "click", ref: "1", button: "left", modifiers: ["Shift"] }],
      [{ kind: "click", selector: "button.save" }],
      [
        {
          kind: "clickCoords",
          x: "42.5",
          y: 64,
          doubleClick: "true",
          button: "left",
          delayMs: "10",
        },
        { x: 42.5, doubleClick: true, delayMs: 10 },
      ],
      [{ kind: "type", ref: "1", text: "" }],
      [{ kind: "press", key: "Enter" }],
      [{ kind: "press", key: "Ctrl+Shift+Esc" }, { key: "Control+Shift+Escape" }],
      [{ kind: "hover", ref: "2" }],
      [{ kind: "scrollIntoView", ref: "2" }],
      [{ kind: "drag", startRef: "3", endRef: "4" }],
    ];
    for (const [input, normalized] of actions) {
      expect(await post("/act", input)).toMatchObject({ ok: true, url: TAB_URL });
      expectLastAction(
        { ...input, ...normalized },
        { ssrfPolicy: { dangerouslyAllowPrivateNetwork: true } },
      );
    }
  });
  it.each([
    ["?profile=unknown", "https://example.com", 404, "not found"],
    ["", "not a url", 400, "Invalid URL:"],
  ] as const)("rejects tab creation %s %s", async (query, url, status, error) => {
    if (status === 400) {
      setBrowserControlServerReachable(true);
    }
    await startBrowserControlServerFromConfig();
    const response = await postResponse(getBrowserControlServerBaseUrl(), `/tabs/open${query}`, {
      url,
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining(error) });
  });

  it("agent contract: form + layout act commands", async () => {
    await startServerAndBase();
    const fields = [
      { ref: "6", type: "textbox", value: "hello" },
      { ref: "7", value: "world" },
      { ref: "8", type: "   ", value: "trimmed-default" },
      { ref: "9" },
      { ref: "10", value: null },
      { ref: "11", value: "" },
    ];
    const normalizedFields = [
      { ref: "6", type: "textbox", value: "hello" },
      { ref: "7", type: "text", value: "world" },
      { ref: "8", type: "text", value: "trimmed-default" },
      { ref: "9", type: "text" },
      { ref: "10", type: "text" },
      { ref: "11", type: "text", value: "" },
    ];
    for (const action of [
      { kind: "select", ref: "5", values: ["a", "", "  spaced  "] },
      { kind: "fill", fields },
      { kind: "resize", width: 800, height: 600 },
      { kind: "wait", timeMs: 5 },
    ]) {
      expect(await post("/act", action)).toMatchObject({ ok: true });
      expectLastAction(
        action.kind === "fill" ? { kind: "fill", fields: normalizedFields } : action,
      );
    }
    const invalidFill = await post("/act", {
      kind: "fill",
      fields: [
        { ref: "e1", value: "must-not-dispatch" },
        { ref: "e2", value: "Neo", text: "unsupported" },
      ],
    });
    expect(invalidFill).toMatchObject({
      code: "ACT_INVALID_REQUEST",
      error: expect.stringContaining('fields[1] unsupported field key "text"'),
    });
    expect(pw("fillFormViaPlaywright")).toHaveBeenCalledOnce();
    for (const [width, error] of [
      [0, "resize requires positive width and height"],
      [8193, "resize width and height must not exceed 8192"],
    ] as const) {
      expect(await post("/act", { kind: "resize", width, height: 600 })).toMatchObject({
        code: "ACT_INVALID_REQUEST",
        error: expect.stringContaining(error),
      });
    }
    expect(pw("resizeViewportViaPlaywright")).toHaveBeenCalledOnce();
    expect(await post("/act", { kind: "evaluate", fn: "() => 1" })).toMatchObject({
      ok: true,
      result: "ok",
    });
    expectBrowserCallFields(pw("evaluateViaPlaywright"), {
      cdpUrl: state.cdpBaseUrl,
      targetId,
      fn: "() => 1",
      ref: undefined,
      signal: expect.any(AbortSignal),
    });
  });

  it("normalizes batch actions and threads evaluateEnabled into the batch executor", async () => {
    await startServerAndBase();

    const preservedActions = [
      { kind: "type", selector: "input.name", text: "  padded  " },
      { kind: "type", selector: "input.clearable", text: "" },
      { kind: "select", selector: "select.choice", values: ["", "  spaced  "] },
    ];
    const batchRes = await post<{ ok: boolean }>("/act", {
      kind: "batch",
      stopOnError: "false",
      actions: [
        { kind: "click", selector: "button.save", doubleClick: "true", delayMs: "25" },
        { kind: "wait", fn: " () => window.ready === true " },
        ...preservedActions,
      ],
    });

    expect(batchRes.ok).toBe(true);
    expectBrowserCallFields(pw("batchViaPlaywright"), {
      targetId,
      stopOnError: false,
      evaluateEnabled: true,
      actions: [
        { kind: "click", selector: "button.save", doubleClick: true, delayMs: 25 },
        { kind: "wait", fn: "() => window.ready === true" },
        ...preservedActions,
      ],
    });
  });

  it("rejects malformed batch actions before dispatch", async () => {
    await startServerAndBase();

    const batchRes = await post<{ error?: string; code?: string }>("/act", {
      kind: "batch",
      actions: [{ kind: "click", ref: {} }],
    });

    expect(batchRes.error).toContain("click requires ref or selector");
    expect(batchRes.code).toBe("ACT_INVALID_REQUEST");
    expect(pw("batchViaPlaywright")).not.toHaveBeenCalled();
  });

  it("rejects loose hook and download timeout options before dispatch", async () => {
    await startServerAndBase();
    for (const [route, body, mockName] of [
      ["/hooks/file-chooser", { paths: ["a.txt"], timeoutMs: "1e3" }, "armFileUploadViaPlaywright"],
      ["/hooks/dialog", { accept: true, timeoutMs: "0x10" }, "armDialogViaPlaywright"],
      [
        "/wait/download",
        { path: "report.pdf", timeoutMs: "1000ms" },
        "waitForDownloadViaPlaywright",
      ],
      ["/download", { ref: "e12", path: "report.pdf", timeoutMs: "1.5" }, "downloadViaPlaywright"],
    ] as const) {
      expect(await post(route, body)).toMatchObject({
        error: expect.stringContaining("timeoutMs must be a positive integer."),
      });
      expect(pw(mockName)).not.toHaveBeenCalled();
    }
    expect(pw("uploadViaPlaywright")).not.toHaveBeenCalled();
  });

  it("agent contract: hooks + response + downloads + screenshot", async () => {
    const base = await startServerAndBase();
    async function call(
      route: string,
      body: Record<string, unknown>,
      mockName: string,
      expected: Record<string, unknown> = body,
    ) {
      expect(await post(route, body)).toMatchObject({ ok: true });
      expectBrowserCallFields(pw(mockName), { targetId, ...expected });
    }
    await call(
      "/hooks/file-chooser",
      { paths: ["a.txt"], timeoutMs: 1234 },
      "armFileUploadViaPlaywright",
      { paths: [path.resolve(DEFAULT_UPLOAD_DIR, "a.txt")], timeoutMs: 1234 },
    );
    await call("/hooks/file-chooser", { paths: ["b.txt"], ref: "e12" }, "uploadViaPlaywright", {
      paths: [path.resolve(DEFAULT_UPLOAD_DIR, "b.txt")],
      ref: "e12",
      signal: expect.any(AbortSignal),
    });
    for (const selector of [{ inputRef: "e99" }, { element: "input[type=file]" }]) {
      expect(await post("/hooks/file-chooser", { paths: ["c.txt"], ...selector })).toMatchObject({
        ok: true,
      });
    }
    await call(
      "/hooks/dialog",
      { accept: true, dialogId: "d1", timeoutMs: 5678 },
      "armDialogViaPlaywright",
    );
    for (const [route, mockName, body] of [
      ["/wait/download", "waitForDownloadViaPlaywright", { path: "report.pdf", timeoutMs: 1111 }],
      ["/download", "downloadViaPlaywright", { ref: "e12", path: "report.pdf" }],
    ] as const) {
      await call(route, body, mockName, {
        ...body,
        path: path.resolve(DEFAULT_DOWNLOAD_DIR, "report.pdf"),
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
        signal: expect.any(AbortSignal),
      });
    }
    expect(
      await post("/response/body", { url: "**/api/data", timeoutMs: 2222, maxChars: 10 }),
    ).toMatchObject({ ok: true });
    expect(await (await realFetch(`${base}/console?level=error`)).json()).toMatchObject({
      ok: true,
      messages: [],
    });
    expect(await post("/pdf", {})).toMatchObject({ ok: true, path: expect.any(String) });
    const screenshot = { element: "body", type: "jpeg", timeoutMs: 3333 };
    expect(await post("/screenshot", screenshot)).toMatchObject({
      ok: true,
      path: expect.any(String),
    });
    expect(requireMockArg(pw("takeScreenshotViaPlaywright"))).toMatchObject(screenshot);
  });

  it.each([
    ["/hooks/file-chooser", { paths: ["../../../../etc/passwd"] }, "armFileUploadViaPlaywright"],
    [
      "/hooks/file-chooser",
      { paths: [path.join(path.parse(DEFAULT_UPLOAD_DIR).root, "etc", "passwd")] },
      "armFileUploadViaPlaywright",
    ],
    ["/trace/stop", { path: "../../pwned.zip" }, "traceStopViaPlaywright"],
    ["/download", { ref: "e12", path: "../../pwned.pdf" }, "downloadViaPlaywright"],
  ] as const)("rejects %s paths outside managed storage: %j", async (route, body, mock) => {
    await startServerAndBase();
    const result = await post<{ error?: string }>(route, body);
    expect(result.error).toContain("Invalid path");
    expect(pw(mock)).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== "win32").each([
    ["/download", "downloadViaPlaywright", DEFAULT_DOWNLOAD_DIR],
    ["/wait/download", "waitForDownloadViaPlaywright", DEFAULT_DOWNLOAD_DIR],
    ["/trace/stop", "traceStopViaPlaywright", DEFAULT_TRACE_DIR],
  ] as const)("%s preserves a literal path beside a directory", async (route, mock, root) => {
    await startServerAndBase();
    await fs.mkdir(root, { recursive: true });
    const neighbor = path.join(root, "literal-output");
    await fs.mkdir(neighbor);
    try {
      const result = await post<{ ok?: boolean }>(route, { ref: "e12", path: " literal-output " });
      expect(result.ok).toBe(true);
      expectBrowserCallFields(pw(mock), { path: path.join(root, " literal-output ") });
    } finally {
      await fs.rmdir(neighbor);
    }
  });

  it("agent contract: stop endpoint", async () => {
    const base = await startServerAndBase();

    const stopped = (await realFetch(`${base}/stop`, { method: "POST" }).then((r) => r.json())) as {
      ok: boolean;
      stopped?: boolean;
    };
    expect(stopped).toMatchObject({ ok: true, stopped: true });
  });

  it("trace stop returns the path committed by the Playwright trace owner", async () => {
    const committedPath = path.join(DEFAULT_TRACE_DIR, "committed-trace.zip");
    pw("traceStopViaPlaywright").mockResolvedValueOnce(committedPath);
    await startServerAndBase();

    const res = await post<{ ok?: boolean; path?: string }>("/trace/stop", {
      path: "requested-trace.zip",
    });

    expect(res).toMatchObject({ ok: true, path: committedPath });
    const traceCall = requireMockArg(pw("traceStopViaPlaywright"));
    expect(String(traceCall.path)).toContain("requested-trace.zip");
  });

  it.each(guardedCurrentTabRouteCases)(
    "blocks %s %s on disallowed current tab URLs",
    async (method, route, body, mockName) => {
      setBrowserControlServerSsrFPolicy({ allowPrivateNetwork: false });
      setBrowserControlServerTabUrl("http://127.0.0.1:8080/admin");
      const base = await startServerAndBase();

      const res = await realFetch(`${base}${route}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: BROWSER_NAVIGATION_BLOCKED_MESSAGE });
      for (const name of typeof mockName === "string" ? [mockName] : mockName) {
        expect(pw(name)).not.toHaveBeenCalled();
      }
    },
  );

  it("keeps a disallowed tab close bound to the tab it closed", async () => {
    setBrowserControlServerSsrFPolicy({ allowPrivateNetwork: false });
    setBrowserControlServerTabUrl("http://127.0.0.1:8080/admin");
    await startServerAndBase();
    pw("closePageViaPlaywright").mockImplementationOnce(async () => {
      replaceActedOnTab("abce9999", "Survivor", "https://other");
    });

    const result = await post<{ ok?: boolean; targetId?: string; url?: string }>("/act", {
      kind: "close",
      targetId,
    });

    expect(result).toMatchObject({ ok: true, targetId });
    expect(result.url).toBeUndefined();
  });

  it.runIf(process.platform !== "win32")("trace writes reject symlink escapes", async () => {
    await startServerAndBase();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-route-escape-"));
    const linkName = path.basename(outside);
    const linkPath = path.join(DEFAULT_TRACE_DIR, linkName);
    await fs.mkdir(DEFAULT_TRACE_DIR, { recursive: true });
    await fs.symlink(outside, linkPath);
    try {
      expect(await post("/trace/stop", { path: `${linkName}/pwned.zip` })).toMatchObject({
        error: expect.stringContaining("Invalid path"),
      });
      expect(pw("traceStopViaPlaywright")).not.toHaveBeenCalled();
    } finally {
      await fs.unlink(linkPath);
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("cancels a download when its HTTP caller disconnects", async () => {
    const client = createBrowserTestClient();
    const controller = new AbortController();
    const started = Promise.withResolvers<AbortSignal>();
    const aborted = Promise.withResolvers<void>();
    let response: ReturnType<typeof client.fetch> | undefined;
    try {
      const base = await startServerAndBase(client.fetch);
      pw("downloadCurrentDocumentViaPlaywright").mockImplementationOnce(async (value) => {
        const signal = requireRecord(value, "download options").signal;
        if (!(signal instanceof AbortSignal)) {
          throw new Error("download has no caller signal");
        }
        started.resolve(signal);
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted.resolve();
              const reason = signal.reason;
              reject(reason instanceof Error ? reason : new Error("request aborted"));
            },
            { once: true },
          );
        });
      });
      response = client.fetch(`${base}/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentDocument: true, expectedUrl: TAB_URL }),
        signal: controller.signal,
      });
      const signal = await started.promise;
      controller.abort(new Error("caller disconnected"));
      await expect(response).rejects.toThrow();
      await aborted.promise;
      expect(signal.aborted).toBe(true);
    } finally {
      controller.abort();
      await response?.catch(() => {});
      // Aborting a request can leave a replacement connection in the pool.
      await client.close();
    }
  });

  it("downloads the current document into managed storage with navigation policy and request ownership", async () => {
    await startServerAndBase();
    const res = await post<{ ok?: boolean; download?: { path?: string } }>("/download", {
      targetId,
      currentDocument: true,
      expectedUrl: "https://example.com/inline.png",
      timeoutMs: 120_000,
    });
    expect(res).toMatchObject({ ok: true, download: { path: "/tmp/managed-inline.png" } });
    const call = requireMockArg(pw("downloadCurrentDocumentViaPlaywright"));
    expect(call).toMatchObject({
      targetId,
      expectedUrl: "https://example.com/inline.png",
      timeoutMs: 120_000,
      rootDir: DEFAULT_DOWNLOAD_DIR,
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
    });
    expect(call.signal).toBeInstanceOf(AbortSignal);
    expect(call).not.toHaveProperty("path");
    expect(call).not.toHaveProperty("ref");
    expect(pw("downloadViaPlaywright")).not.toHaveBeenCalled();
  });

  it.each([
    { currentDocument: true },
    { currentDocument: true, expectedUrl: TAB_URL, path: "chosen.png" },
    { currentDocument: "true", expectedUrl: TAB_URL },
    { expectedUrl: TAB_URL, ref: "e1", path: "chosen.png" },
  ])("rejects ambiguous or incomplete current-document download input %j", async (body) => {
    const base = await startServerAndBase();
    const response = await postResponse(base, "/download", body);
    expect(response.status).toBe(400);
    expect(pw("downloadCurrentDocumentViaPlaywright")).not.toHaveBeenCalled();
    expect(pw("downloadViaPlaywright")).not.toHaveBeenCalled();
  });
});

describe("profile CRUD endpoints", () => {
  beforeEach(resetBrowserControlServerTestContext);
  afterEach(cleanupBrowserControlServerTestContext);

  it("validates profile create/delete endpoints", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("/json/list")
          ? makeResponse([])
          : makeResponse({}, { ok: false, status: 500, text: "unexpected" }),
      ),
    );
    await startBrowserControlServerFromConfig();
    const base = getBrowserControlServerBaseUrl();
    async function create(body: unknown, status: number, expected: Record<string, unknown>) {
      const response = await postResponse(base, "/profiles/create", body);
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject(expected);
    }
    const invalid: Array<[Record<string, unknown>, number, string]> = [
      [{}, 400, "name is required"],
      [{ name: "Invalid Name!" }, 400, "invalid profile name"],
      [{ name: "openclaw" }, 409, "already exists"],
      [{ name: "badremote", cdpUrl: "ftp://bad" }, 400, "cdpUrl"],
      [{ name: "legacy", driver: "extension" }, 400, 'unsupported profile driver "extension"'],
    ];
    for (const [body, status, error] of invalid) {
      await create(body, status, { error: expect.stringContaining(error) });
    }
    await create({ name: "remote", cdpUrl: "http://10.0.0.42:9222" }, 200, {
      profile: "remote",
      cdpUrl: "http://10.0.0.42:9222",
      isRemote: true,
    });
    await create({ name: "legacyclawd", driver: "clawd" }, 200, {
      profile: "legacyclawd",
      transport: "cdp",
      cdpPort: expect.any(Number),
      userDataDir: null,
    });
    const userDataDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-brave-profile-")),
    );
    onTestFinished(() => fs.rm(userDataDir, { recursive: true, force: true }));
    await create({ name: "brave-live", driver: "existing-session", userDataDir }, 200, {
      profile: "brave-live",
      transport: "chrome-mcp",
      userDataDir,
    });
    await create({ name: "bad-live", userDataDir }, 400, {
      error: expect.stringContaining("driver=existing-session is required"),
    });
    for (const [name, status, error] of [
      ["nonexistent", 404, "not found"],
      ["openclaw", 400, "cannot delete the default profile"],
      ["Invalid-Name!", 400, "invalid profile name"],
    ] as const) {
      const response = await getBrowserTestFetch()(`${base}/profiles/${name}`, {
        method: "DELETE",
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining(error) });
    }
  });
});
