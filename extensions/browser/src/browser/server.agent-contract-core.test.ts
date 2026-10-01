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

async function postActAndReadError(base: string, body?: unknown) {
  const response = await realFetch(`${base}/act`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as { error?: string; code?: string },
  };
}

const state = getBrowserControlServerTestState();
const cdpMocks = getCdpMocks();
const pwMocks = getPwMocks();
function requirePwMock<K extends keyof typeof pwMocks>(name: K): NonNullable<(typeof pwMocks)[K]> {
  return expectDefined(pwMocks[name], `Playwright mock ${name}`);
}

function replaceActedOnTab() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/json/list")) {
        return makeResponse([
          {
            id: "fresh5678",
            title: "Submitted",
            url: "https://submitted.example",
            webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/fresh5678",
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
  ["POST", "/trace/start", { targetId: "abcd1234" }, "traceStartViaPlaywright"],
  ["POST", "/trace/stop", { targetId: "abcd1234" }, "traceStopViaPlaywright"],
  [
    "POST",
    "/response/body",
    { targetId: "abcd1234", url: "**/api/data" },
    "responseBodyViaPlaywright",
  ],
  ["POST", "/highlight", { targetId: "abcd1234", ref: "e1" }, "highlightViaPlaywright"],
  ["GET", "/console?targetId=abcd1234", undefined, "getConsoleMessagesViaPlaywright"],
  ["POST", "/pdf", { targetId: "abcd1234" }, "pdfViaPlaywright"],
  ["POST", "/screenshot", { targetId: "abcd1234" }, "takeScreenshotViaPlaywright"],
  [
    "POST",
    "/download",
    { targetId: "abcd1234", currentDocument: true, expectedUrl: "https://example.com" },
    "downloadCurrentDocumentViaPlaywright",
  ],
  [
    "POST",
    "/act",
    {
      targetId: "abcd1234",
      kind: "batch",
      actions: [{ kind: "evaluate", fn: "() => document.body.innerText" }],
    },
    "executeActViaPlaywright",
  ],
  ["GET", "/cookies?targetId=abcd1234", undefined, "cookiesGetViaPlaywright"],
  ["GET", "/storage/local?targetId=abcd1234", undefined, "storageGetViaPlaywright"],
] as const;

type MockWithCalls = { mock: { calls: unknown[][] } };

const requireRecord = createRequireRecord("record", "expected-label-object");

function requireMockArg(mock: MockWithCalls) {
  return requireRecord(mock.mock.calls[0]?.[0], "mock call argument");
}

function expectBrowserCallFields(mock: MockWithCalls, expected: Record<string, unknown>) {
  expect(requireMockArg(mock)).toMatchObject({ cdpUrl: expect.any(String), ...expected });
}

describe("browser control server", () => {
  installAgentContractHooks();

  it("returns ACT_EXISTING_SESSION_UNSUPPORTED for unsupported existing-session actions", async () => {
    setBrowserControlServerProfiles({
      openclaw: {
        color: "#FF4500",
        driver: "existing-session",
      },
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
    expect(requirePwMock("executeActViaPlaywright")).not.toHaveBeenCalled();
  });

  it("canonicalizes request and batch target aliases with the resolved proxy policy", async () => {
    setBrowserControlServerExtraArgs(["--proxy-server=http://proxy.example:8080"]);
    const base = await startServerAndBase();
    const response = await postJson<{ ok: boolean }>(`${base}/act`, {
      kind: "batch",
      targetId: "abcd",
      // Sub-action references the same tab via a unique prefix alias.
      actions: [{ kind: "click", ref: "1", targetId: "abcd" }],
    });

    expect(response.ok).toBe(true);
    expect(requirePwMock("executeActViaPlaywright").mock.calls[0]?.[0]).toMatchObject({
      browserProxyMode: "explicit-browser-proxy",
      action: { targetId: "abcd1234", actions: [{ targetId: "abcd1234" }] },
    });
  });

  it.each([
    { replacement: undefined, expectedTarget: "abcd1234" },
    { replacement: "fresh5678", expectedTarget: "fresh5678" },
  ])(
    "only adopts a replacement proven by the acted-on page: $replacement",
    async ({ replacement, expectedTarget }) => {
      const base = await startServerAndBase();
      requirePwMock("executeActViaPlaywright").mockImplementationOnce(async () => {
        replaceActedOnTab();
        return { targetId: replacement };
      });
      expect(
        await postJson(`${base}/act`, { kind: "click", ref: "5", targetId: "abcd1234" }),
      ).toMatchObject({
        ok: true,
        targetId: expectedTarget,
      });
    },
  );

  it("returns blocked dialog state for action-triggered modals", async () => {
    const base = await startServerAndBase();
    const pending = [
      { id: "d1", type: "confirm", message: "Continue?", openedAt: "2026-05-17T12:00:00.000Z" },
    ];
    requirePwMock("executeActViaPlaywright").mockResolvedValueOnce({
      blockedByDialog: true,
      browserState: { dialogs: { pending, recent: [] } },
    });
    expect(await postJson(`${base}/act`, { kind: "click", ref: "5" })).toMatchObject({
      ok: true,
      blockedByDialog: true,
      browserState: { dialogs: { pending } },
    });
  });

  it("returns action download metadata from /act responses", async () => {
    const base = await startServerAndBase();
    const downloads = [
      {
        url: "https://example.com/report.pdf",
        suggestedFilename: "report.pdf",
        path: "/tmp/openclaw/downloads/report.pdf",
      },
    ];
    requirePwMock("executeActViaPlaywright").mockResolvedValueOnce({ downloads });
    expect(await postJson(`${base}/act`, { kind: "click", ref: "5" })).toEqual({
      ok: true,
      targetId: "abcd1234",
      url: "https://example.com",
      downloads,
    });
  });

  it("blocks evaluation while preserving cookie and storage reads", async () => {
    setBrowserControlServerEvaluateEnabled(false);
    const base = await startServerAndBase();
    const response = await postActAndReadError(base, {
      kind: "evaluate",
      fn: "() => 1",
    });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("ACT_EVALUATE_DISABLED");
    expect(response.body.error).toContain("browser.evaluateEnabled=false");
    expect(requirePwMock("evaluateViaPlaywright")).not.toHaveBeenCalled();
    requirePwMock("cookiesGetViaPlaywright").mockResolvedValueOnce({
      cookies: [{ name: "session", value: "abc123" }],
    });
    requirePwMock("storageGetViaPlaywright").mockResolvedValueOnce({ values: { token: "value" } });
    const fetch = getBrowserTestFetch();
    expect(await (await fetch(`${base}/cookies`)).json()).toMatchObject({
      ok: true,
      cookies: [{ name: "session" }],
    });
    expect(await (await fetch(`${base}/storage/local?key=token`)).json()).toMatchObject({
      ok: true,
      values: { token: "value" },
    });
    expect(requirePwMock("cookiesGetViaPlaywright")).toHaveBeenCalledWith({
      cdpUrl: state.cdpBaseUrl,
      targetId: "abcd1234",
    });
    expect(requirePwMock("storageGetViaPlaywright")).toHaveBeenCalledWith({
      cdpUrl: state.cdpBaseUrl,
      targetId: "abcd1234",
      kind: "local",
      key: "token",
    });
  });

  it("blocks disallowed snapshot tabs before reading Playwright browser state", async () => {
    setBrowserControlServerSsrFPolicy({ allowPrivateNetwork: false });
    setBrowserControlServerTabUrl("http://127.0.0.1:8080/admin");
    const response = await getBrowserTestFetch()(
      `${await startServerAndBase()}/snapshot?format=ai`,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: BROWSER_NAVIGATION_BLOCKED_MESSAGE });
    expect(requirePwMock("getObservedBrowserStateViaPlaywright")).not.toHaveBeenCalled();
    expect(requirePwMock("snapshotRoleViaPlaywright")).not.toHaveBeenCalled();
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

  it("forwards the minimum navigation timeout to Playwright", async () => {
    const base = await startServerAndBase();

    const response = await postJson<{ ok: boolean }>(`${base}/navigate`, {
      url: "https://example.com/slow",
      timeoutMs: 10,
    });

    expect(response.ok).toBe(true);
    expect(requirePwMock("navigateViaPlaywright")).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com/slow",
        timeoutMs: 1_000,
      }),
    );
  });

  it.each([
    { ownerTarget: undefined, backendTarget: "unrelated-999", expected: "abcd1234" },
    { ownerTarget: "replacement-target", backendTarget: undefined, expected: "replacement-target" },
  ])(
    "navigation preserves captured relay ownership: $ownerTarget",
    async ({ ownerTarget, backendTarget, expected }) => {
      const base = await startServerAndBase();
      const runtime = expectDefined(await startBrowserControlServerFromConfig(), "browser runtime");
      const previousRelays = runtime.extensionRelays;
      runtime.extensionRelays = new Map([
        ["openclaw", { bridge: { captureOperationTarget: () => () => ownerTarget } }],
      ]) as unknown as NonNullable<typeof runtime.extensionRelays>;
      requirePwMock("navigateViaPlaywright").mockImplementationOnce(async (options) => {
        const targetId = await (
          options as {
            resolveOperationTarget?: () => string | undefined | Promise<string | undefined>;
          }
        ).resolveOperationTarget?.();
        expect(targetId).toBe(ownerTarget);
        return { url: "https://example.com/recovered", targetId: backendTarget ?? targetId };
      });
      try {
        expect(
          await postJson(`${base}/navigate`, {
            url: "https://example.com/recovered",
            targetId: "abcd1234",
          }),
        ).toMatchObject({ ok: true, targetId: expected });
      } finally {
        runtime.extensionRelays = previousRelays;
      }
    },
  );

  it("clamps overflowing navigation timeouts for Chrome MCP", async () => {
    setBrowserControlServerProfiles({
      openclaw: { color: "#FF4500", driver: "existing-session" },
    });
    const base = await startServerAndBase();

    const response = await postJson<{ ok: boolean }>(`${base}/navigate`, {
      url: "https://example.com/slow",
      targetId: "7",
      timeoutMs: 3_000_000_000,
    });

    expect(response.ok).toBe(true);
    const chromeMcp = await vi.importMock<typeof import("./chrome-mcp.js")>("./chrome-mcp.js");
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
    const base = await startServerAndBase();
    expect(await postJson(`${base}/navigate`, { url: "https://example.com" })).toMatchObject({
      ok: true,
      targetId: "abcd1234",
    });
    expect(requirePwMock("navigateViaPlaywright")).toHaveBeenCalledWith(
      expect.objectContaining({
        cdpUrl: state.cdpBaseUrl,
        targetId: "abcd1234",
        url: "https://example.com",
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
      }),
    );
    const actions: Array<{ input: Record<string, unknown>; normalized?: Record<string, unknown> }> =
      [
        { input: { kind: "click", ref: "1", button: "left", modifiers: ["Shift"] } },
        { input: { kind: "click", selector: "button.save" } },
        {
          input: {
            kind: "clickCoords",
            x: "42.5",
            y: 64,
            doubleClick: "true",
            button: "left",
            delayMs: "10",
          },
          normalized: { x: 42.5, doubleClick: true, delayMs: 10 },
        },
        { input: { kind: "type", ref: "1", text: "" } },
        { input: { kind: "press", key: "Enter" } },
        {
          input: { kind: "press", key: "Ctrl+Shift+Esc" },
          normalized: { key: "Control+Shift+Escape" },
        },
        { input: { kind: "hover", ref: "2" } },
        { input: { kind: "scrollIntoView", ref: "2" } },
        { input: { kind: "drag", startRef: "3", endRef: "4" } },
      ];
    for (const { input, normalized } of actions) {
      expect(await postJson(`${base}/act`, input)).toMatchObject({
        ok: true,
        url: "https://example.com",
      });
      expect(requirePwMock("executeActViaPlaywright")).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: { ...input, ...normalized },
          cdpUrl: state.cdpBaseUrl,
          targetId: "abcd1234",
          ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
        }),
      );
    }
  });
  it("rejects tab creation for an unknown profile", async () => {
    await startBrowserControlServerFromConfig();
    const response = await realFetch(
      `${getBrowserControlServerBaseUrl()}/tabs/open?profile=unknown`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com" }),
      },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("not found") });
  });

  it("POST /tabs/open returns 400 for invalid URLs", async () => {
    setBrowserControlServerReachable(true);
    await startBrowserControlServerFromConfig();
    const base = getBrowserControlServerBaseUrl();

    const result = await realFetch(`${base}/tabs/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "not a url" }),
    });
    expect(result.status).toBe(400);
    const body = (await result.json()) as { error: string };
    expect(body.error).toContain("Invalid URL:");
  });

  it("agent contract: form + layout act commands", async () => {
    const base = await startServerAndBase();
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
      expect(await postJson(`${base}/act`, action)).toMatchObject({ ok: true });
      expect(requirePwMock("executeActViaPlaywright")).toHaveBeenLastCalledWith(
        expect.objectContaining({
          cdpUrl: state.cdpBaseUrl,
          targetId: "abcd1234",
          action: action.kind === "fill" ? { kind: "fill", fields: normalizedFields } : action,
        }),
      );
    }
    const invalidFill = await postJson(`${base}/act`, {
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
    expect(requirePwMock("fillFormViaPlaywright")).toHaveBeenCalledOnce();
    for (const [width, error] of [
      [0, "resize requires positive width and height"],
      [8193, "resize width and height must not exceed 8192"],
    ] as const) {
      expect(await postJson(`${base}/act`, { kind: "resize", width, height: 600 })).toMatchObject({
        code: "ACT_INVALID_REQUEST",
        error: expect.stringContaining(error),
      });
    }
    expect(requirePwMock("resizeViewportViaPlaywright")).toHaveBeenCalledOnce();
    expect(await postJson(`${base}/act`, { kind: "evaluate", fn: "() => 1" })).toMatchObject({
      ok: true,
      result: "ok",
    });
    expectBrowserCallFields(requirePwMock("evaluateViaPlaywright"), {
      cdpUrl: state.cdpBaseUrl,
      targetId: "abcd1234",
      fn: "() => 1",
      ref: undefined,
      signal: expect.any(AbortSignal),
    });
  });

  it("normalizes batch actions and threads evaluateEnabled into the batch executor", async () => {
    const base = await startServerAndBase();

    const batchRes = await postJson<{ ok: boolean; results?: Array<{ ok: boolean }> }>(
      `${base}/act`,
      {
        kind: "batch",
        stopOnError: "false",
        actions: [
          { kind: "click", selector: "button.save", doubleClick: "true", delayMs: "25" },
          { kind: "wait", fn: " () => window.ready === true " },
          { kind: "type", selector: "input.name", text: "  padded  " },
          { kind: "type", selector: "input.clearable", text: "" },
          { kind: "select", selector: "select.choice", values: ["", "  spaced  "] },
        ],
      },
    );

    expect(batchRes.ok).toBe(true);
    expectBrowserCallFields(requirePwMock("batchViaPlaywright"), {
      targetId: "abcd1234",
      stopOnError: false,
      evaluateEnabled: true,
      actions: [
        {
          kind: "click",
          selector: "button.save",
          doubleClick: true,
          delayMs: 25,
        },
        {
          kind: "wait",
          fn: "() => window.ready === true",
        },
        { kind: "type", selector: "input.name", text: "  padded  " },
        { kind: "type", selector: "input.clearable", text: "" },
        { kind: "select", selector: "select.choice", values: ["", "  spaced  "] },
      ],
    });
  });

  it("rejects malformed batch actions before dispatch", async () => {
    const base = await startServerAndBase();

    const batchRes = await postJson<{ error?: string; code?: string }>(`${base}/act`, {
      kind: "batch",
      actions: [{ kind: "click", ref: {} }],
    });

    expect(batchRes.error).toContain("click requires ref or selector");
    expect(batchRes.code).toBe("ACT_INVALID_REQUEST");
    expect(requirePwMock("batchViaPlaywright")).not.toHaveBeenCalled();
  });

  it("rejects loose response body numeric options before dispatch", async () => {
    const base = await startServerAndBase();
    for (const [key, value] of [
      ["timeoutMs", "1e3"],
      ["maxChars", "0x10"],
    ] as const) {
      expect(
        await postJson(`${base}/response/body`, { url: "**/api/data", [key]: value }),
      ).toMatchObject({
        error: expect.stringContaining(`${key} must be a positive integer.`),
      });
    }
    expect(requirePwMock("responseBodyViaPlaywright")).not.toHaveBeenCalled();
  });

  it("rejects loose hook and download timeout options before dispatch", async () => {
    const base = await startServerAndBase();
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
      expect(await postJson(`${base}${route}`, body)).toMatchObject({
        error: expect.stringContaining("timeoutMs must be a positive integer."),
      });
      expect(requirePwMock(mockName)).not.toHaveBeenCalled();
    }
    expect(requirePwMock("uploadViaPlaywright")).not.toHaveBeenCalled();
  });

  it("agent contract: hooks + response + downloads + screenshot", async () => {
    const base = await startServerAndBase();
    async function call(
      route: string,
      body: unknown,
      mockName: string,
      expected: Record<string, unknown>,
    ) {
      expect(await postJson(`${base}${route}`, body)).toMatchObject({ ok: true });
      expectBrowserCallFields(requirePwMock(mockName), { targetId: "abcd1234", ...expected });
    }
    await call(
      "/hooks/file-chooser",
      { paths: ["a.txt"], timeoutMs: 1234 },
      "armFileUploadViaPlaywright",
      {
        paths: [path.resolve(DEFAULT_UPLOAD_DIR, "a.txt")],
        timeoutMs: 1234,
      },
    );
    await call("/hooks/file-chooser", { paths: ["b.txt"], ref: "e12" }, "uploadViaPlaywright", {
      paths: [path.resolve(DEFAULT_UPLOAD_DIR, "b.txt")],
      ref: "e12",
      signal: expect.any(AbortSignal),
    });
    for (const selector of [{ inputRef: "e99" }, { element: "input[type=file]" }]) {
      expect(
        await postJson(`${base}/hooks/file-chooser`, { paths: ["c.txt"], ...selector }),
      ).toMatchObject({ ok: true });
    }
    await call(
      "/hooks/dialog",
      { accept: true, dialogId: "d1", timeoutMs: 5678 },
      "armDialogViaPlaywright",
      {
        accept: true,
        dialogId: "d1",
        timeoutMs: 5678,
      },
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
      await postJson(`${base}/response/body`, {
        url: "**/api/data",
        timeoutMs: 2222,
        maxChars: 10,
      }),
    ).toMatchObject({ ok: true });
    expect(await (await realFetch(`${base}/console?level=error`)).json()).toMatchObject({
      ok: true,
      messages: [],
    });
    expect(await postJson(`${base}/pdf`, {})).toMatchObject({ ok: true, path: expect.any(String) });
    expect(
      await postJson(`${base}/screenshot`, { element: "body", type: "jpeg", timeoutMs: 3333 }),
    ).toMatchObject({ ok: true, path: expect.any(String) });
    expect(requireMockArg(requirePwMock("takeScreenshotViaPlaywright"))).toMatchObject({
      element: "body",
      type: "jpeg",
      timeoutMs: 3333,
    });
  });

  it("blocks file chooser traversal / absolute paths outside uploads dir", async () => {
    const base = await startServerAndBase();

    const traversal = await postJson<{ error?: string }>(`${base}/hooks/file-chooser`, {
      paths: ["../../../../etc/passwd"],
    });
    expect(traversal.error).toContain("Invalid path");
    expect(requirePwMock("armFileUploadViaPlaywright")).not.toHaveBeenCalled();

    const absOutside = path.join(path.parse(DEFAULT_UPLOAD_DIR).root, "etc", "passwd");
    const abs = await postJson<{ error?: string }>(`${base}/hooks/file-chooser`, {
      paths: [absOutside],
    });
    expect(abs.error).toContain("Invalid path");
    expect(requirePwMock("armFileUploadViaPlaywright")).not.toHaveBeenCalled();
  });

  it("agent contract: stop endpoint", async () => {
    const base = await startServerAndBase();

    const stopped = (await realFetch(`${base}/stop`, {
      method: "POST",
    }).then((r) => r.json())) as { ok: boolean; stopped?: boolean };
    expect(stopped.ok).toBe(true);
    expect(stopped.stopped).toBe(true);
  });

  it("trace stop rejects traversal path outside trace dir", async () => {
    const base = await startServerAndBase();
    const res = await postJson<{ error?: string }>(`${base}/trace/stop`, {
      path: "../../pwned.zip",
    });
    expect(res.error).toContain("Invalid path");
    expect(requirePwMock("traceStopViaPlaywright")).not.toHaveBeenCalled();
  });

  it("trace stop returns the path committed by the Playwright trace owner", async () => {
    const committedPath = path.join(DEFAULT_TRACE_DIR, "committed-trace.zip");
    requirePwMock("traceStopViaPlaywright").mockResolvedValueOnce(committedPath);
    const base = await startServerAndBase();

    const res = await postJson<{ ok?: boolean; path?: string }>(`${base}/trace/stop`, {
      path: "requested-trace.zip",
    });

    expect(res).toMatchObject({ ok: true, path: committedPath });
    const traceCall = requireMockArg(requirePwMock("traceStopViaPlaywright"));
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
      expect(requirePwMock(mockName)).not.toHaveBeenCalled();
    },
  );

  it("allows resizing a disallowed tab", async () => {
    setBrowserControlServerSsrFPolicy({ allowPrivateNetwork: false });
    setBrowserControlServerTabUrl("http://127.0.0.1:8080/admin");
    expect(
      await postJson(`${await startServerAndBase()}/act`, {
        kind: "resize",
        targetId: "abcd1234",
        width: 1024,
        height: 768,
      }),
    ).toMatchObject({ ok: true });
    expect(requirePwMock("resizeViewportViaPlaywright")).toHaveBeenCalled();
  });

  it("keeps a disallowed tab close bound to the tab it closed", async () => {
    setBrowserControlServerSsrFPolicy({ allowPrivateNetwork: false });
    setBrowserControlServerTabUrl("http://127.0.0.1:8080/admin");
    const base = await startServerAndBase();
    requirePwMock("closePageViaPlaywright").mockImplementationOnce(async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (!url.includes("/json/list")) {
            return makeResponse({}, { ok: false, status: 500, text: "unexpected" });
          }
          return makeResponse([
            {
              id: "abce9999",
              title: "Survivor",
              url: "https://other",
              webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/abce9999",
              type: "page",
            },
          ]);
        }),
      );
    });

    const result = await postJson<{ ok?: boolean; targetId?: string; url?: string }>(
      `${base}/act`,
      { kind: "close", targetId: "abcd1234" },
    );

    expect(result).toMatchObject({
      ok: true,
      targetId: "abcd1234",
    });
    expect(result.url).toBeUndefined();
  });

  it("download rejects traversal path outside downloads dir", async () => {
    const base = await startServerAndBase();
    const downloadRes = await postJson<{ error?: string }>(`${base}/download`, {
      ref: "e12",
      path: "../../pwned.pdf",
    });
    expect(downloadRes.error).toContain("Invalid path");
    expect(requirePwMock("downloadViaPlaywright")).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== "win32")("trace writes reject symlink escapes", async () => {
    const base = await startServerAndBase();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-route-escape-"));
    const linkName = path.basename(outside);
    const linkPath = path.join(DEFAULT_TRACE_DIR, linkName);
    await fs.mkdir(DEFAULT_TRACE_DIR, { recursive: true });
    await fs.symlink(outside, linkPath);
    try {
      expect(await postJson(`${base}/trace/stop`, { path: `${linkName}/pwned.zip` })).toMatchObject(
        { error: expect.stringContaining("Invalid path") },
      );
      expect(requirePwMock("traceStopViaPlaywright")).not.toHaveBeenCalled();
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
      requirePwMock("downloadCurrentDocumentViaPlaywright").mockImplementationOnce(
        async (value) => {
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
        },
      );
      response = client.fetch(`${base}/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentDocument: true, expectedUrl: "https://example.com" }),
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
    const base = await startServerAndBase();
    const res = await postJson<{ ok?: boolean; download?: { path?: string } }>(`${base}/download`, {
      targetId: "abcd1234",
      currentDocument: true,
      expectedUrl: "https://example.com/inline.png",
      timeoutMs: 120_000,
    });
    expect(res).toMatchObject({ ok: true, download: { path: "/tmp/managed-inline.png" } });
    const call = requireMockArg(requirePwMock("downloadCurrentDocumentViaPlaywright"));
    expect(call).toMatchObject({
      targetId: "abcd1234",
      expectedUrl: "https://example.com/inline.png",
      timeoutMs: 120_000,
      rootDir: DEFAULT_DOWNLOAD_DIR,
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
    });
    expect(call.signal).toBeInstanceOf(AbortSignal);
    expect(call).not.toHaveProperty("path");
    expect(call).not.toHaveProperty("ref");
    expect(requirePwMock("downloadViaPlaywright")).not.toHaveBeenCalled();
  });

  it.each([
    { currentDocument: true },
    { currentDocument: true, expectedUrl: "https://example.com", path: "chosen.png" },
    { currentDocument: "true", expectedUrl: "https://example.com" },
    { expectedUrl: "https://example.com", ref: "e1", path: "chosen.png" },
  ])("rejects ambiguous or incomplete current-document download input %j", async (body) => {
    const base = await startServerAndBase();
    const response = await realFetch(`${base}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    expect(requirePwMock("downloadCurrentDocumentViaPlaywright")).not.toHaveBeenCalled();
    expect(requirePwMock("downloadViaPlaywright")).not.toHaveBeenCalled();
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
      const response = await getBrowserTestFetch()(`${base}/profiles/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
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
