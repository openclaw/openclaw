// Browser tests cover chrome mcp plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  analyzeChromeMcpPerformanceInsight,
  buildChromeMcpArgs,
  clickChromeMcpCoords,
  clickChromeMcpElement,
  closeChromeMcpTab,
  decodeChromeMcpStderrTail,
  dragChromeMcpElement,
  ensureChromeMcpAvailable,
  emulateChromeMcpPage,
  evaluateChromeMcpScript,
  executeChromeMcpThirdPartyDeveloperTool,
  executeChromeMcpWebMcpTool,
  fillChromeMcpElement,
  fillChromeMcpForm,
  focusChromeMcpTab,
  getChromeMcpConsoleMessage,
  getChromeMcpHeapSnapshotClassNodes,
  getChromeMcpHeapSnapshotDetails,
  getChromeMcpHeapSnapshotRetainers,
  getChromeMcpHeapSnapshotSummary,
  getChromeMcpNetworkRequest,
  getChromeMcpTabId,
  handleChromeMcpDialog,
  hoverChromeMcpElement,
  installChromeMcpExtension,
  listChromeMcpExtensions,
  listChromeMcpPages,
  listChromeMcpTabs,
  listChromeMcpConsoleMessages,
  listChromeMcpNetworkRequests,
  listChromeMcpThirdPartyDeveloperTools,
  listChromeMcpWebMcpTools,
  navigateChromeMcpPage,
  openChromeMcpTab,
  pressChromeMcpKey,
  reloadChromeMcpExtension,
  resolveChromeMcpNavigateCallTimeoutMs,
  resetChromeMcpSessionsForTest,
  resizeChromeMcpPage,
  runChromeMcpLighthouseAudit,
  setChromeMcpProcessCleanupDepsForTest,
  setChromeMcpSessionFactoryForTest,
  startChromeMcpPerformanceTrace,
  startChromeMcpScreencast,
  stopChromeMcpPerformanceTrace,
  stopChromeMcpScreencast,
  takeChromeMcpHeapSnapshot,
  takeChromeMcpSnapshot,
  takeChromeMcpScreenshot,
  takeChromeMcpSnapshot,
  triggerChromeMcpExtensionAction,
  uninstallChromeMcpExtension,
  uploadChromeMcpFile,
  waitForChromeMcpText,
} from "./chrome-mcp.js";

type ToolCall = {
  name: string;
  arguments?: Record<string, unknown>;
};
type ToolCallMock = {
  mock: {
    calls: Array<[ToolCall]>;
  };
};

type ChromeMcpSessionFactory = Exclude<
  Parameters<typeof setChromeMcpSessionFactoryForTest>[0],
  null
>;
type ChromeMcpSession = Awaited<ReturnType<ChromeMcpSessionFactory>>;

function createFakeSession(): ChromeMcpSession {
  let currentUrl =
    "https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session";
  let createdPageOpen = false;
  const readUrlArg = (value: unknown, fallback: string) =>
    typeof value === "string" && value.trim() ? value : fallback;
  const callTool = vi.fn(async ({ name, arguments: args }: ToolCall) => {
    if (name === "list_pages") {
      const pageLines = [
        "## Pages",
        `1: ${currentUrl} [selected]`,
        "2: https://github.com/openclaw/openclaw/pull/45318",
      ];
      if (createdPageOpen) {
        pageLines.push(`3: ${currentUrl}`);
      }
      return {
        content: [
          {
            type: "text",
            text: pageLines.join("\n"),
          },
        ],
      };
    }
    if (name === "new_page") {
      currentUrl = readUrlArg(args?.url, "about:blank");
      createdPageOpen = true;
      return {
        content: [
          {
            type: "text",
            text: [
              "## Pages",
              "1: https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session",
              "2: https://github.com/openclaw/openclaw/pull/45318",
              `3: ${currentUrl} [selected]`,
            ].join("\n"),
          },
        ],
      };
    }
    if (name === "navigate_page") {
      currentUrl = readUrlArg(args?.url, currentUrl);
      return { content: [{ type: "text", text: "navigated" }] };
    }
    if (name === "select_page") {
      return { content: [{ type: "text", text: `Selected page ${args?.pageId}` }] };
    }
    if (name === "close_page") {
      return { content: [{ type: "text", text: `Closed page ${args?.pageId}` }] };
    }
    if (name === "take_snapshot") {
      return {
        content: [{ type: "text", text: "Snapshot captured." }],
        structuredContent: {
          snapshot: { role: "RootWebArea", name: "Fixture page", children: [] },
        },
      };
    }
    if (name === "fill") {
      return { content: [{ type: "text", text: `Filled ${args?.uid}` }] };
    }
    if (name === "fill_form") {
      return { content: [{ type: "text", text: "Form filled" }] };
    }
    if (name === "hover") {
      return { content: [{ type: "text", text: `Hovered ${args?.uid}` }] };
    }
    if (name === "drag") {
      return { content: [{ type: "text", text: `Dragged ${args?.from_uid} to ${args?.to_uid}` }] };
    }
    if (name === "upload_file") {
      return { content: [{ type: "text", text: `Uploaded ${args?.filePath}` }] };
    }
    if (name === "press_key") {
      return { content: [{ type: "text", text: `Pressed ${args?.key}` }] };
    }
    if (name === "resize_page") {
      return { content: [{ type: "text", text: `Resized ${args?.width}x${args?.height}` }] };
    }
    if (name === "handle_dialog") {
      return { content: [{ type: "text", text: `Dialog ${args?.action}` }] };
    }
    if (name === "evaluate_script") {
      return {
        content: [
          {
            type: "text",
            text: "```json\n123\n```",
          },
        ],
      };
    }
    if (name === "wait_for") {
      return { content: [{ type: "text", text: 'Element matching one of ["Ready"] found.' }] };
    }
    if (name === "click_at") {
      return { content: [{ type: "text", text: "Successfully clicked at the coordinates" }] };
    }
    if (name === "emulate") {
      return { content: [{ type: "text", text: "Emulation configured successfully" }] };
    }
    if (name === "performance_start_trace") {
      return { content: [{ type: "text", text: "The performance trace is being recorded." }] };
    }
    if (name === "performance_stop_trace") {
      return { content: [{ type: "text", text: "The performance trace has been stopped." }] };
    }
    if (name === "performance_analyze_insight") {
      return { content: [{ type: "text", text: `Insight ${args?.insightName} details.` }] };
    }
    if (name === "take_heapsnapshot") {
      return { content: [{ type: "text", text: `Heap snapshot saved to ${args?.filePath}` }] };
    }
    if (name === "get_heapsnapshot_summary") {
      return {
        content: [{ type: "text", text: "Heap snapshot summary." }],
        structuredContent: { stats: { totalSize: 1024 } },
      };
    }
    if (name === "get_heapsnapshot_details") {
      return { content: [{ type: "text", text: "Heap snapshot details." }] };
    }
    if (name === "get_heapsnapshot_class_nodes") {
      return { content: [{ type: "text", text: "Heap snapshot class nodes." }] };
    }
    if (name === "get_heapsnapshot_retainers") {
      return { content: [{ type: "text", text: "Heap snapshot retainers." }] };
    }
    if (name === "lighthouse_audit") {
      return {
        content: [{ type: "text", text: "Lighthouse audit complete." }],
        structuredContent: { summary: { device: args?.device, mode: args?.mode } },
      };
    }
    if (name === "screencast_start") {
      return {
        content: [{ type: "text", text: `Screencast recording started: ${args?.filePath}` }],
      };
    }
    if (name === "screencast_stop") {
      return { content: [{ type: "text", text: "The screencast recording has been stopped." }] };
    }
    if (name === "list_extensions") {
      return {
        content: [{ type: "text", text: 'id=abc "Fixture Extension" v1.0.0 Enabled' }],
        structuredContent: {
          extensions: [{ id: "abc", name: "Fixture Extension", version: "1.0.0", enabled: true }],
        },
      };
    }
    if (name === "install_extension") {
      return { content: [{ type: "text", text: `Extension installed. Id: ${args?.path}` }] };
    }
    if (name === "uninstall_extension") {
      return { content: [{ type: "text", text: `Extension uninstalled. Id: ${args?.id}` }] };
    }
    if (name === "reload_extension") {
      return { content: [{ type: "text", text: "Extension reloaded." }] };
    }
    if (name === "trigger_extension_action") {
      return { content: [{ type: "text", text: `Extension action triggered for ID ${args?.id}` }] };
    }
    if (name === "get_tab_id") {
      return {
        content: [{ type: "text", text: "Tab ID: 12345" }],
        structuredContent: { tabId: "12345" },
      };
    }
    if (name === "list_3p_developer_tools") {
      return {
        content: [{ type: "text", text: "## Third-party developer tools" }],
        structuredContent: {
          thirdPartyDeveloperTools: {
            name: "Fixture tools",
            description: "Fixture page tools",
            tools: [
              {
                name: "inspectState",
                description: "Inspect state",
                inputSchema: { type: "object" },
              },
            ],
          },
        },
      };
    }
    if (name === "execute_3p_developer_tool") {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, toolName: args?.toolName }) }],
        structuredContent: { result: { ok: true, toolName: args?.toolName } },
      };
    }
    if (name === "list_webmcp_tools") {
      return {
        content: [{ type: "text", text: "## WebMCP tools" }],
        structuredContent: {
          webmcpTools: [
            {
              name: "fixture_web_tool",
              description: "Fixture WebMCP tool",
              inputSchema: { type: "object" },
            },
          ],
        },
      };
    }
    if (name === "execute_webmcp_tool") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ status: "success", output: { toolName: args?.toolName } }),
          },
        ],
        structuredContent: { status: "success", output: { toolName: args?.toolName } },
      };
    }
    if (name === "list_console_messages") {
      return {
        content: [{ type: "text", text: "" }],
        structuredContent: {
          pagination: { currentPage: 0, totalPages: 1, hasNextPage: false },
          consoleMessages: [
            { id: 1, type: "log", text: "fixture log", argsCount: 1 },
            { id: 2, type: "error", text: "fixture error", argsCount: 1 },
          ],
        },
      };
    }
    if (name === "get_console_message") {
      return {
        content: [{ type: "text", text: "ID: 2\nMessage: error> fixture error" }],
        structuredContent: {
          consoleMessage: {
            id: args?.msgid,
            type: "error",
            text: "fixture error",
            argsCount: 1,
            args: ["fixture error"],
          },
        },
      };
    }
    if (name === "list_network_requests") {
      return {
        content: [{ type: "text", text: "" }],
        structuredContent: {
          pagination: { currentPage: 0, totalPages: 1, hasNextPage: false },
          networkRequests: [
            {
              requestId: 7,
              method: "GET",
              url: "https://example.com/api/data.json",
              status: "200",
              selectedInDevToolsUI: false,
            },
          ],
        },
      };
    }
    if (name === "get_network_request") {
      return {
        content: [{ type: "text", text: "## Request https://example.com/api/data.json" }],
        structuredContent: {
          networkRequest: {
            requestId: args?.reqid,
            method: "GET",
            url: "https://example.com/api/data.json",
            status: "200",
            requestHeaders: { authorization: "Bearer fake" },
            responseHeaders: { "content-type": "application/json" },
            responseBody: '{"ok":true}',
          },
        },
      };
    }
    if (name === "take_screenshot") {
      const filePath = typeof args?.filePath === "string" ? args.filePath : undefined;
      const format = args?.format === "jpeg" ? "jpeg" : "png";
      if (!filePath) {
        throw new Error("missing filePath");
      }
      await fs.writeFile(`${filePath}.${format}`, Buffer.from(`screenshot:${format}`));
      return { content: [{ type: "text", text: `Saved screenshot to ${filePath}.${format}.` }] };
    }
    throw new Error(`unexpected tool ${name}`);
  });

  return {
    client: {
      callTool,
      listTools: vi.fn().mockResolvedValue({ tools: [{ name: "list_pages" }] }),
      close: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
    },
    transport: {
      pid: 123,
    },
    ready: Promise.resolve(),
  } as unknown as ChromeMcpSession;
}

describe("chrome MCP page parsing", () => {
  beforeEach(async () => {
    await resetChromeMcpSessionsForTest();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("parses list_pages text responses when structuredContent is missing", async () => {
    const factory: ChromeMcpSessionFactory = async () => createFakeSession();
    setChromeMcpSessionFactoryForTest(factory);

    const tabs = await listChromeMcpTabs("chrome-live");

    expect(tabs).toEqual([
      {
        targetId: "1",
        title: "",
        url: "https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session",
        type: "page",
      },
      {
        targetId: "2",
        title: "",
        url: "https://github.com/openclaw/openclaw/pull/45318",
        type: "page",
      },
    ]);
  });

  it("parses Chrome MCP console message structured responses", async () => {
    const factory: ChromeMcpSessionFactory = async () => createFakeSession();
    setChromeMcpSessionFactoryForTest(factory);

    await expect(
      listChromeMcpConsoleMessages({ profileName: "chrome-live", targetId: "1" }),
    ).resolves.toEqual({
      pagination: { currentPage: 0, totalPages: 1, hasNextPage: false },
      messages: [
        { id: 1, type: "log", text: "fixture log", argsCount: 1 },
        { id: 2, type: "error", text: "fixture error", argsCount: 1 },
      ],
    });

    await expect(
      getChromeMcpConsoleMessage({ profileName: "chrome-live", targetId: "1", msgid: 2 }),
    ).resolves.toEqual({
      id: 2,
      type: "error",
      text: "fixture error",
      argsCount: 1,
      args: ["fixture error"],
    });
  });

  it("parses Chrome MCP network request structured responses", async () => {
    const factory: ChromeMcpSessionFactory = async () => createFakeSession();
    setChromeMcpSessionFactoryForTest(factory);

    await expect(
      listChromeMcpNetworkRequests({ profileName: "chrome-live", targetId: "1" }),
    ).resolves.toEqual({
      pagination: { currentPage: 0, totalPages: 1, hasNextPage: false },
      requests: [
        {
          requestId: 7,
          id: "7",
          method: "GET",
          url: "https://example.com/api/data.json",
          status: "200",
          selectedInDevToolsUI: false,
        },
      ],
    });

    await expect(
      getChromeMcpNetworkRequest({ profileName: "chrome-live", targetId: "1", reqid: 7 }),
    ).resolves.toEqual({
      requestId: 7,
      id: "7",
      method: "GET",
      url: "https://example.com/api/data.json",
      status: "200",
      requestHeaders: { authorization: "Bearer fake" },
      responseHeaders: { "content-type": "application/json" },
      responseBody: '{"ok":true}',
    });
  });

  it("reads screenshot files with the extension written by chrome-devtools-mcp", async () => {
    const factory: ChromeMcpSessionFactory = async () => createFakeSession();
    setChromeMcpSessionFactoryForTest(factory);

    await expect(
      takeChromeMcpScreenshot({
        profileName: "chrome-live",
        targetId: "1",
        format: "jpeg",
      }),
    ).resolves.toEqual(Buffer.from("screenshot:jpeg"));
  });

  it("forwards Chrome MCP page lifecycle, snapshot, and dialog calls", async () => {
    const session = createFakeSession();
    const factory: ChromeMcpSessionFactory = async () => session;
    setChromeMcpSessionFactoryForTest(factory);

    await expect(listChromeMcpPages("chrome-live")).resolves.toEqual([
      {
        id: 1,
        url: "https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session",
        selected: true,
      },
      { id: 2, url: "https://github.com/openclaw/openclaw/pull/45318", selected: false },
    ]);
    await focusChromeMcpTab("chrome-live", "2");
    await closeChromeMcpTab("chrome-live", "2");
    await expect(
      takeChromeMcpSnapshot({ profileName: "chrome-live", targetId: "2" }),
    ).resolves.toEqual({
      role: "RootWebArea",
      name: "Fixture page",
      children: [],
    });
    await handleChromeMcpDialog({
      profileName: "chrome-live",
      targetId: "2",
      action: "accept",
      promptText: "fixture prompt",
    });

    const calls = (session.client.callTool as unknown as ToolCallMock).mock.calls;
    expect(calls.slice(-5).map(([call]) => call)).toEqual([
      { name: "list_pages", arguments: {} },
      { name: "select_page", arguments: { pageId: 2, bringToFront: true } },
      { name: "close_page", arguments: { pageId: 2 } },
      { name: "take_snapshot", arguments: { pageId: 2 } },
      {
        name: "handle_dialog",
        arguments: { pageId: 2, action: "accept", promptText: "fixture prompt" },
      },
    ]);
  });

  it("forwards Chrome MCP element, keyboard, file, and viewport actions", async () => {
    const session = createFakeSession();
    const factory: ChromeMcpSessionFactory = async () => session;
    setChromeMcpSessionFactoryForTest(factory);

    await fillChromeMcpElement({
      profileName: "chrome-live",
      targetId: "2",
      uid: "input-1",
      value: "hello",
    });
    await fillChromeMcpForm({
      profileName: "chrome-live",
      targetId: "2",
      elements: [
        { uid: "input-1", value: "hello" },
        { uid: "input-2", value: "world" },
      ],
    });
    await hoverChromeMcpElement({ profileName: "chrome-live", targetId: "2", uid: "button-1" });
    await dragChromeMcpElement({
      profileName: "chrome-live",
      targetId: "2",
      fromUid: "drag-source",
      toUid: "drop-target",
    });
    await uploadChromeMcpFile({
      profileName: "chrome-live",
      targetId: "2",
      uid: "file-input",
      filePath: "/tmp/openclaw/uploads/fixture.txt",
    });
    await pressChromeMcpKey({ profileName: "chrome-live", targetId: "2", key: "Enter" });
    await resizeChromeMcpPage({
      profileName: "chrome-live",
      targetId: "2",
      width: 1024,
      height: 768,
    });

    const calls = (session.client.callTool as unknown as ToolCallMock).mock.calls;
    expect(calls.slice(-7).map(([call]) => call)).toEqual([
      { name: "fill", arguments: { pageId: 2, uid: "input-1", value: "hello" } },
      {
        name: "fill_form",
        arguments: {
          pageId: 2,
          elements: [
            { uid: "input-1", value: "hello" },
            { uid: "input-2", value: "world" },
          ],
        },
      },
      { name: "hover", arguments: { pageId: 2, uid: "button-1" } },
      { name: "drag", arguments: { pageId: 2, from_uid: "drag-source", to_uid: "drop-target" } },
      {
        name: "upload_file",
        arguments: { pageId: 2, uid: "file-input", filePath: "/tmp/openclaw/uploads/fixture.txt" },
      },
      { name: "press_key", arguments: { pageId: 2, key: "Enter" } },
      { name: "resize_page", arguments: { pageId: 2, width: 1024, height: 768 } },
    ]);
  });

  it("forwards text waits to Chrome MCP wait_for with page routing", async () => {
    const session = createFakeSession();
    const factory: ChromeMcpSessionFactory = async () => session;
    setChromeMcpSessionFactoryForTest(factory);

    await waitForChromeMcpText({
      profileName: "chrome-live",
      targetId: "2",
      text: ["Ready"],
      timeoutMs: 1234,
    });

    const calls = (session.client.callTool as unknown as ToolCallMock).mock.calls;
    expect(calls.at(-1)?.[0]).toEqual({
      name: "wait_for",
      arguments: { pageId: 2, text: ["Ready"], timeout: 1234 },
    });
  });

  it("forwards left coordinate clicks to Chrome MCP click_at with page routing", async () => {
    const session = createFakeSession();
    const factory: ChromeMcpSessionFactory = async () => session;
    setChromeMcpSessionFactoryForTest(factory);

    await clickChromeMcpCoords({
      profileName: "chrome-live",
      targetId: "2",
      x: 25,
      y: 32,
      doubleClick: true,
    });

    const calls = (session.client.callTool as unknown as ToolCallMock).mock.calls;
    expect(calls.at(-1)?.[0]).toEqual({
      name: "click_at",
      arguments: { pageId: 2, x: 25, y: 32, dblClick: true },
    });
  });

  it("preserves tracked Chrome MCP emulation state across partial updates", async () => {
    const session = createFakeSession();
    const factory: ChromeMcpSessionFactory = async () => session;
    setChromeMcpSessionFactoryForTest(factory);

    await emulateChromeMcpPage({
      profileName: "chrome-live",
      targetId: "2",
      offline: true,
    });
    await emulateChromeMcpPage({
      profileName: "chrome-live",
      targetId: "2",
      extraHttpHeaders: { "x-openclaw-test": "yes" },
    });
    await emulateChromeMcpPage({
      profileName: "chrome-live",
      targetId: "2",
      offline: false,
    });

    const emulateCalls = (session.client.callTool as unknown as ToolCallMock).mock.calls
      .map(([call]) => call)
      .filter((call) => call.name === "emulate");
    expect(emulateCalls).toEqual([
      {
        name: "emulate",
        arguments: { pageId: 2, networkConditions: "Offline" },
      },
      {
        name: "emulate",
        arguments: {
          pageId: 2,
          networkConditions: "Offline",
          extraHttpHeaders: JSON.stringify({ "x-openclaw-test": "yes" }),
        },
      },
      {
        name: "emulate",
        arguments: {
          pageId: 2,
          extraHttpHeaders: JSON.stringify({ "x-openclaw-test": "yes" }),
        },
      },
    ]);
  });

  it("forwards Chrome MCP performance trace start and stop calls", async () => {
    const session = createFakeSession();
    const factory: ChromeMcpSessionFactory = async () => session;
    setChromeMcpSessionFactoryForTest(factory);

    await expect(
      startChromeMcpPerformanceTrace({ profileName: "chrome-live", targetId: "2" }),
    ).resolves.toContain("being recorded");
    await expect(
      stopChromeMcpPerformanceTrace({
        profileName: "chrome-live",
        targetId: "2",
        filePath: "/tmp/openclaw/browser-trace.json.gz",
      }),
    ).resolves.toContain("stopped");

    const calls = (session.client.callTool as unknown as ToolCallMock).mock.calls;
    expect(calls.at(-2)?.[0]).toEqual({
      name: "performance_start_trace",
      arguments: { pageId: 2, reload: false, autoStop: false },
    });
    expect(calls.at(-1)?.[0]).toEqual({
      name: "performance_stop_trace",
      arguments: { pageId: 2, filePath: "/tmp/openclaw/browser-trace.json.gz" },
    });
  });

  it("forwards Chrome MCP performance insight analysis", async () => {
    const session = createFakeSession();
    const factory: ChromeMcpSessionFactory = async () => session;
    setChromeMcpSessionFactoryForTest(factory);

    await expect(
      analyzeChromeMcpPerformanceInsight({
        profileName: "chrome-live",
        targetId: "2",
        insightSetId: "navigation-1",
        insightName: "LCPBreakdown",
      }),
    ).resolves.toContain("LCPBreakdown");

    const calls = (session.client.callTool as unknown as ToolCallMock).mock.calls;
    expect(calls.at(-1)?.[0]).toEqual({
      name: "performance_analyze_insight",
      arguments: {
        pageId: 2,
        insightSetId: "navigation-1",
        insightName: "LCPBreakdown",
      },
    });
  });

  it("forwards Chrome MCP heap snapshot capture and inspection tools", async () => {
    const session = createFakeSession();
    const factory: ChromeMcpSessionFactory = async () => session;
    setChromeMcpSessionFactoryForTest(factory);

    await expect(
      takeChromeMcpHeapSnapshot({
        profileName: "chrome-live",
        targetId: "2",
        filePath: "/tmp/openclaw/page.heapsnapshot",
      }),
    ).resolves.toContain("page.heapsnapshot");
    await expect(
      getChromeMcpHeapSnapshotSummary({
        profileName: "chrome-live",
        filePath: "/tmp/openclaw/page.heapsnapshot",
      }),
    ).resolves.toEqual({
      output: "Heap snapshot summary.",
      structuredContent: { stats: { totalSize: 1024 } },
    });
    await getChromeMcpHeapSnapshotDetails({
      profileName: "chrome-live",
      filePath: "/tmp/openclaw/page.heapsnapshot",
      pageIdx: 1,
      pageSize: 25,
    });
    await getChromeMcpHeapSnapshotClassNodes({
      profileName: "chrome-live",
      filePath: "/tmp/openclaw/page.heapsnapshot",
      id: 42,
      pageIdx: 2,
      pageSize: 10,
    });
    await getChromeMcpHeapSnapshotRetainers({
      profileName: "chrome-live",
      filePath: "/tmp/openclaw/page.heapsnapshot",
      nodeId: 99,
      pageIdx: 3,
      pageSize: 5,
    });

    const calls = (session.client.callTool as unknown as ToolCallMock).mock.calls;
    expect(calls.slice(-5).map(([call]) => call)).toEqual([
      {
        name: "take_heapsnapshot",
        arguments: { pageId: 2, filePath: "/tmp/openclaw/page.heapsnapshot" },
      },
      {
        name: "get_heapsnapshot_summary",
        arguments: { filePath: "/tmp/openclaw/page.heapsnapshot" },
      },
      {
        name: "get_heapsnapshot_details",
        arguments: { filePath: "/tmp/openclaw/page.heapsnapshot", pageIdx: 1, pageSize: 25 },
      },
      {
        name: "get_heapsnapshot_class_nodes",
        arguments: {
          filePath: "/tmp/openclaw/page.heapsnapshot",
          id: 42,
          pageIdx: 2,
          pageSize: 10,
        },
      },
      {
        name: "get_heapsnapshot_retainers",
        arguments: {
          filePath: "/tmp/openclaw/page.heapsnapshot",
          nodeId: 99,
          pageIdx: 3,
          pageSize: 5,
        },
      },
    ]);
  });

  it("forwards Chrome MCP lighthouse audit and screencast tools", async () => {
    const session = createFakeSession();
    const factory: ChromeMcpSessionFactory = async () => session;
    setChromeMcpSessionFactoryForTest(factory);

    await expect(
      runChromeMcpLighthouseAudit({
        profileName: "chrome-live",
        targetId: "2",
        mode: "snapshot",
        device: "mobile",
        outputDirPath: "/tmp/openclaw/lighthouse",
      }),
    ).resolves.toEqual({
      output: "Lighthouse audit complete.",
      structuredContent: { summary: { device: "mobile", mode: "snapshot" } },
    });
    await expect(
      startChromeMcpScreencast({
        profileName: "chrome-live",
        targetId: "2",
        filePath: "/tmp/openclaw/screencast.webm",
      }),
    ).resolves.toContain("screencast.webm");
    await expect(
      stopChromeMcpScreencast({
        profileName: "chrome-live",
        targetId: "2",
      }),
    ).resolves.toContain("stopped");

    const calls = (session.client.callTool as unknown as ToolCallMock).mock.calls;
    expect(calls.slice(-3).map(([call]) => call)).toEqual([
      {
        name: "lighthouse_audit",
        arguments: {
          pageId: 2,
          mode: "snapshot",
          device: "mobile",
          outputDirPath: "/tmp/openclaw/lighthouse",
        },
      },
      {
        name: "screencast_start",
        arguments: { pageId: 2, filePath: "/tmp/openclaw/screencast.webm" },
      },
      {
        name: "screencast_stop",
        arguments: { pageId: 2 },
      },
    ]);
  });

  it("forwards Chrome MCP extension tools", async () => {
    const session = createFakeSession();
    const factory: ChromeMcpSessionFactory = async () => session;
    setChromeMcpSessionFactoryForTest(factory);

    await expect(listChromeMcpExtensions({ profileName: "chrome-live" })).resolves.toEqual([
      { id: "abc", name: "Fixture Extension", version: "1.0.0", enabled: true },
    ]);
    await expect(
      installChromeMcpExtension({
        profileName: "chrome-live",
        path: "/tmp/openclaw-extension",
      }),
    ).resolves.toContain("/tmp/openclaw-extension");
    await expect(
      uninstallChromeMcpExtension({ profileName: "chrome-live", id: "abc" }),
    ).resolves.toContain("abc");
    await expect(
      reloadChromeMcpExtension({ profileName: "chrome-live", id: "abc" }),
    ).resolves.toContain("reloaded");
    await expect(
      triggerChromeMcpExtensionAction({ profileName: "chrome-live", id: "abc" }),
    ).resolves.toContain("abc");

    const calls = (session.client.callTool as unknown as ToolCallMock).mock.calls;
    expect(calls.slice(-5).map(([call]) => call)).toEqual([
      { name: "list_extensions", arguments: {} },
      { name: "install_extension", arguments: { path: "/tmp/openclaw-extension" } },
      { name: "uninstall_extension", arguments: { id: "abc" } },
      { name: "reload_extension", arguments: { id: "abc" } },
      { name: "trigger_extension_action", arguments: { id: "abc" } },
    ]);
  });

  it("forwards Chrome MCP interop, third-party developer, and WebMCP tools", async () => {
    const session = createFakeSession();
    const factory: ChromeMcpSessionFactory = async () => session;
    setChromeMcpSessionFactoryForTest(factory);

    await expect(getChromeMcpTabId({ profileName: "chrome-live", targetId: "2" })).resolves.toBe(
      "12345",
    );
    await expect(
      listChromeMcpThirdPartyDeveloperTools({ profileName: "chrome-live", targetId: "2" }),
    ).resolves.toMatchObject({
      structuredContent: {
        thirdPartyDeveloperTools: { tools: [{ name: "inspectState" }] },
      },
    });
    await expect(
      executeChromeMcpThirdPartyDeveloperTool({
        profileName: "chrome-live",
        targetId: "2",
        toolName: "inspectState",
        toolParams: { verbose: true },
      }),
    ).resolves.toMatchObject({
      structuredContent: { result: { ok: true, toolName: "inspectState" } },
    });
    await expect(
      listChromeMcpWebMcpTools({ profileName: "chrome-live", targetId: "2" }),
    ).resolves.toMatchObject({
      structuredContent: { webmcpTools: [{ name: "fixture_web_tool" }] },
    });
    await expect(
      executeChromeMcpWebMcpTool({
        profileName: "chrome-live",
        targetId: "2",
        toolName: "fixture_web_tool",
        input: { query: "state" },
      }),
    ).resolves.toMatchObject({
      structuredContent: { status: "success", output: { toolName: "fixture_web_tool" } },
    });

    const calls = (session.client.callTool as unknown as ToolCallMock).mock.calls;
    expect(calls.slice(-5).map(([call]) => call)).toEqual([
      { name: "get_tab_id", arguments: { pageId: 2 } },
      { name: "list_3p_developer_tools", arguments: { pageId: 2 } },
      {
        name: "execute_3p_developer_tool",
        arguments: { pageId: 2, toolName: "inspectState", params: '{"verbose":true}' },
      },
      { name: "list_webmcp_tools", arguments: { pageId: 2 } },
      {
        name: "execute_webmcp_tool",
        arguments: { pageId: 2, toolName: "fixture_web_tool", input: '{"query":"state"}' },
      },
    ]);
  });

  it("keeps evaluated clickCoords fallback when Chrome MCP click_at cannot preserve options", async () => {
    const session = createFakeSession();
    const factory: ChromeMcpSessionFactory = async () => session;
    setChromeMcpSessionFactoryForTest(factory);

    await clickChromeMcpCoords({
      profileName: "chrome-live",
      targetId: "2",
      x: 25,
      y: 32,
      button: "right",
      delayMs: 5,
    });

    const calls = (session.client.callTool as unknown as ToolCallMock).mock.calls;
    expect(calls.at(-1)?.[0].name).toBe("evaluate_script");
    expect(calls.at(-1)?.[0].arguments?.pageId).toBe(2);
    expect(calls.at(-1)?.[0].arguments?.function).toContain(
      'dispatch("mousedown", pressedButtons, 1)',
    );
  });

  it("adds --userDataDir when an explicit Chromium profile path is configured", () => {
    expect(buildChromeMcpArgs("/tmp/brave-profile")).toEqual([
      "-y",
      "chrome-devtools-mcp@latest",
      "--autoConnect",
      "--no-usage-statistics",
      "--experimentalStructuredContent",
      "--experimental-page-id-routing",
      "--experimentalVision",
      "--experimentalMemory",
      "--experimentalScreencast",
      "--experimentalInteropTools",
      "--categoryExperimentalThirdParty",
      "--categoryExperimentalWebmcp",
      "--userDataDir",
      "/tmp/brave-profile",
    ]);
  });

  it("uses browserUrl for existing-session cdpUrl without also passing userDataDir", () => {
    expect(
      buildChromeMcpArgs({
        cdpUrl: "http://127.0.0.1:9222",
        userDataDir: "/tmp/brave-profile",
      }),
    ).toEqual([
      "-y",
      "chrome-devtools-mcp@latest",
      "--browserUrl",
      "http://127.0.0.1:9222",
      "--no-usage-statistics",
      "--experimentalStructuredContent",
      "--experimental-page-id-routing",
      "--experimentalVision",
      "--experimentalMemory",
      "--experimentalScreencast",
      "--experimentalInteropTools",
      "--categoryExperimentalThirdParty",
      "--categoryExperimentalWebmcp",
    ]);
  });

  it("uses wsEndpoint for direct existing-session websocket cdpUrl", () => {
    expect(
      buildChromeMcpArgs({
        cdpUrl: "ws://127.0.0.1:9222/devtools/browser/abc",
      }),
    ).toEqual([
      "-y",
      "chrome-devtools-mcp@latest",
      "--wsEndpoint",
      "ws://127.0.0.1:9222/devtools/browser/abc",
      "--no-usage-statistics",
      "--experimentalStructuredContent",
      "--experimental-page-id-routing",
      "--experimentalVision",
      "--experimentalMemory",
      "--experimentalScreencast",
      "--experimentalInteropTools",
      "--categoryExperimentalThirdParty",
      "--categoryExperimentalWebmcp",
    ]);
  });

  it("appends custom Chrome MCP args and lets explicit endpoint args override auto-connect", () => {
    expect(
      buildChromeMcpArgs({
        userDataDir: "/tmp/brave-profile",
        mcpArgs: ["--browserUrl", "http://127.0.0.1:9222", "--no-usage-statistics"],
      }),
    ).toEqual([
      "-y",
      "chrome-devtools-mcp@latest",
      "--experimentalStructuredContent",
      "--experimental-page-id-routing",
      "--experimentalVision",
      "--experimentalMemory",
      "--experimentalScreencast",
      "--experimentalInteropTools",
      "--categoryExperimentalThirdParty",
      "--categoryExperimentalWebmcp",
      "--browserUrl",
      "http://127.0.0.1:9222",
      "--no-usage-statistics",
    ]);
  });

  it("lets explicit Chrome MCP usage-statistics args override the default opt-out", () => {
    expect(
      buildChromeMcpArgs({
        mcpArgs: ["--usage-statistics"],
      }),
    ).toEqual([
      "-y",
      "chrome-devtools-mcp@latest",
      "--autoConnect",
      "--experimentalStructuredContent",
      "--experimental-page-id-routing",
      "--usage-statistics",
    ]);
  });

  it("does not duplicate an explicit Chrome MCP usage-statistics opt-out", () => {
    expect(
      buildChromeMcpArgs({
        mcpArgs: ["--no-usage-statistics"],
      }),
    ).toEqual([
      "-y",
      "chrome-devtools-mcp@latest",
      "--autoConnect",
      "--experimentalStructuredContent",
      "--experimental-page-id-routing",
      "--no-usage-statistics",
    ]);
  });

  it("omits the npx package prefix for a custom Chrome MCP command", () => {
    expect(
      buildChromeMcpArgs({
        mcpCommand: "/usr/local/bin/chrome-devtools-mcp",
        cdpUrl: "http://127.0.0.1:9222",
      }),
    ).toEqual([
      "--browserUrl",
      "http://127.0.0.1:9222",
      "--no-usage-statistics",
      "--experimentalStructuredContent",
      "--experimental-page-id-routing",
      "--experimentalVision",
      "--experimentalMemory",
      "--experimentalScreencast",
      "--experimentalInteropTools",
      "--categoryExperimentalThirdParty",
      "--categoryExperimentalWebmcp",
    ]);
  });

  it("terminates the owned Chrome MCP subprocess tree when closing temporary sessions", async () => {
    const session = createFakeSession();
    Object.assign(session, { ownsProcessTree: true });
    const closeMock = vi.fn().mockResolvedValue(undefined);
    session.client.close = closeMock as typeof session.client.close;
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    setChromeMcpProcessCleanupDepsForTest({
      platform: "linux",
      listProcesses: vi.fn().mockResolvedValue([
        { pid: 123, ppid: 1 },
        { pid: 124, ppid: 123 },
        { pid: 125, ppid: 124 },
        { pid: 126, ppid: 1 },
      ]),
      killProcess: (pid, signal) => {
        killCalls.push({ pid, signal });
      },
      sleep: vi.fn().mockResolvedValue(undefined),
    });
    setChromeMcpSessionFactoryForTest(async () => session);

    await ensureChromeMcpAvailable("chrome-live", undefined, { ephemeral: true });

    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(killCalls).toEqual([
      { pid: 125, signal: "SIGTERM" },
      { pid: 124, signal: "SIGTERM" },
      { pid: 123, signal: "SIGTERM" },
      { pid: 125, signal: "SIGKILL" },
      { pid: 124, signal: "SIGKILL" },
      { pid: 123, signal: "SIGKILL" },
    ]);
  });

  it("uses Windows taskkill tree cleanup without waiting for SDK stdio close timeout", async () => {
    const session = createFakeSession();
    Object.assign(session, { ownsProcessTree: true });
    const closeOrder: string[] = [];
    session.client.close = vi.fn(async () => {
      closeOrder.push("client.close");
    }) as typeof session.client.close;
    setChromeMcpProcessCleanupDepsForTest({
      platform: "win32",
      taskkillProcessTree: vi.fn(async (pid) => {
        closeOrder.push(`taskkill:${pid}`);
      }),
    });
    setChromeMcpSessionFactoryForTest(async () => session);

    await ensureChromeMcpAvailable("chrome-live", undefined, { ephemeral: true });

    expect(closeOrder).toEqual(["taskkill:123"]);
  });

  it("falls back to SDK stdio close when Windows taskkill cleanup fails", async () => {
    const session = createFakeSession();
    Object.assign(session, { ownsProcessTree: true });
    const closeMock = vi.fn().mockResolvedValue(undefined);
    session.client.close = closeMock as typeof session.client.close;
    setChromeMcpProcessCleanupDepsForTest({
      platform: "win32",
      taskkillProcessTree: vi.fn().mockRejectedValue(new Error("taskkill failed")),
    });
    setChromeMcpSessionFactoryForTest(async () => session);

    await ensureChromeMcpAvailable("chrome-live", undefined, { ephemeral: true });

    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("redacts remote CDP URL secrets from attach failures", async () => {
    const secretToken = "browserless-secret-token-1234567890"; // pragma: allowlist secret
    const user = "browser-user";
    const password = "browser-password-1234567890"; // pragma: allowlist secret
    const cdpUrl = `wss://${user}:${password}@browserless.example/chrome?token=${secretToken}`;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-chrome-mcp-test-"));
    const configPath = path.join(tempDir, "openclaw.json");
    await fs.writeFile(configPath, JSON.stringify({ logging: { redactSensitive: "off" } }));
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    const fakeMcpCommand = path.join(tempDir, "fake-mcp.mjs");
    await fs.writeFile(
      fakeMcpCommand,
      `#!/usr/bin/env node
      const cdpUrl = process.argv.find((arg) => arg.includes("browserless.example")) ?? "";
      let input = "";
      process.stdin.on("data", (chunk) => {
        input += chunk;
        const match = input.match(/"id"\\s*:\\s*(\\d+)/);
        if (!match) return;
        const body = JSON.stringify({
          jsonrpc: "2.0",
          id: Number(match[1]),
          error: { code: -32000, message: "attach failed for " + cdpUrl },
        });
        process.stdout.write(body + "\\n");
      });
    `,
    );
    await fs.chmod(fakeMcpCommand, 0o755);

    let message = "";
    try {
      await ensureChromeMcpAvailable(
        "remote-profile",
        {
          cdpUrl,
          mcpCommand: fakeMcpCommand,
        },
        { ephemeral: true },
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    expect(message).toContain("Chrome MCP existing-session attach failed");
    expect(message).toContain("attach failed");
    expect(message).toContain("browserless.example");
    expect(message).not.toContain(cdpUrl);
    expect(message).not.toContain(user);
    expect(message).not.toContain(password);
    expect(message).not.toContain(secretToken);
  });

  it("redacts home-relative user data dirs from attach failures", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-chrome-mcp-test-"));
    const homeDir = os.homedir();
    const userDataDir = path.join(
      homeDir,
      "Library",
      "Application Support",
      "Google",
      "Chrome",
      "Profile 1",
    );
    const attachFailureDetail = `attach failed for ${userDataDir}`;
    const fakeMcpCommand = path.join(tempDir, "fake-mcp.mjs");
    await fs.writeFile(
      fakeMcpCommand,
      `#!/usr/bin/env node
      let input = "";
      process.stdin.on("data", (chunk) => {
        input += chunk;
        const match = input.match(/"id"\\s*:\\s*(\\d+)/);
        if (!match) return;
        const body = JSON.stringify({
          jsonrpc: "2.0",
          id: Number(match[1]),
          error: { code: -32000, message: ${JSON.stringify(attachFailureDetail)} },
        });
        process.stdout.write(body + "\\n");
      });
    `,
    );
    await fs.chmod(fakeMcpCommand, 0o755);

    let message = "";
    try {
      await ensureChromeMcpAvailable(
        "home-profile",
        {
          userDataDir,
          mcpCommand: fakeMcpCommand,
        },
        { ephemeral: true },
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    expect(message).toContain("Chrome MCP existing-session attach failed");
    expect(message).toContain("~/Library/Application Support/Google/Chrome/Profile 1");
    expect(message).toContain(
      "attach failed for ~/Library/Application Support/Google/Chrome/Profile 1",
    );
    expect(message).not.toContain(homeDir);
    expect(message).not.toContain(userDataDir);
  });

  it("keeps Chrome MCP stderr tails within the byte cap without splitting UTF-8", () => {
    const output = decodeChromeMcpStderrTail(Buffer.from(`${"x".repeat(8191)}é`));

    expect(output).toMatch(/é$/);
    expect(output).not.toContain("�");
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(8192);
  });

  it("parses new_page text responses and returns the created tab", async () => {
    const factory: ChromeMcpSessionFactory = async () => createFakeSession();
    setChromeMcpSessionFactoryForTest(factory);

    const tab = await openChromeMcpTab("chrome-live", "https://example.com/");

    expect(tab).toEqual({
      targetId: "3",
      title: "",
      url: "https://example.com/",
      type: "page",
    });
  });

  it("opens about:blank directly without an extra navigate", async () => {
    const session = createFakeSession();
    const factory: ChromeMcpSessionFactory = async () => session;
    setChromeMcpSessionFactoryForTest(factory);

    const tab = await openChromeMcpTab("chrome-live", "about:blank");

    expect(tab).toEqual({
      targetId: "3",
      title: "",
      url: "about:blank",
      type: "page",
    });
    expect(session.client["callTool"]).toHaveBeenCalledWith({
      name: "new_page",
      arguments: { url: "about:blank", timeout: 5000 },
    });
    const callToolMock = session.client["callTool"] as unknown as ToolCallMock;
    const callNames = callToolMock.mock.calls.map(([call]) => call.name);
    expect(callNames).not.toContain("navigate_page");
  });

  it("parses evaluate_script text responses when structuredContent is missing", async () => {
    const factory: ChromeMcpSessionFactory = async () => createFakeSession();
    setChromeMcpSessionFactoryForTest(factory);

    const result = await evaluateChromeMcpScript({
      profileName: "chrome-live",
      targetId: "1",
      fn: "() => 123",
    });

    expect(result).toBe(123);
  });

  it("defaults non-finite coordinate click delays before injecting the browser script", async () => {
    const session = createFakeSession();
    const callTool = vi.fn(async ({ name }: ToolCall) => {
      if (name === "evaluate_script") {
        return { content: [{ type: "text", text: "```json\nnull\n```" }] };
      }
      throw new Error(`unexpected tool ${name}`);
    });
    session.client.callTool = callTool as typeof session.client.callTool;
    setChromeMcpSessionFactoryForTest(async () => session);

    await clickChromeMcpCoords({
      profileName: "chrome-live",
      targetId: "1",
      x: 10,
      y: 20,
      delayMs: Number.NaN,
    });

    const callToolMock = callTool as unknown as ToolCallMock;
    const evaluateCall = callToolMock.mock.calls.find(([call]) => call.name === "evaluate_script");
    const fn = evaluateCall?.[0].arguments?.function;
    expect(typeof fn === "string" ? fn : "").toContain("const delayMs = 0;");
  });

  it("does not cache an ephemeral availability probe before the next real attach", async () => {
    let factoryCalls = 0;
    const closeMocks: Array<ReturnType<typeof vi.fn>> = [];
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      const session = createFakeSession();
      const closeMock = vi.fn().mockResolvedValue(undefined);
      session.client.close = closeMock as typeof session.client.close;
      closeMocks.push(closeMock);
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    await ensureChromeMcpAvailable("chrome-live", undefined, { ephemeral: true });

    expect(factoryCalls).toBe(1);
    expect(closeMocks[0]).toHaveBeenCalledTimes(1);

    const tabs = await listChromeMcpTabs("chrome-live");

    expect(factoryCalls).toBe(2);
    expect(closeMocks[1]).not.toHaveBeenCalled();
    expect(tabs).toHaveLength(2);
  });

  it("does not poison the next real attach after an ephemeral no-page probe", async () => {
    let factoryCalls = 0;
    const closeMocks: Array<ReturnType<typeof vi.fn>> = [];
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      const session = createFakeSession();
      const closeMock = vi.fn().mockResolvedValue(undefined);
      session.client.close = closeMock as typeof session.client.close;
      closeMocks.push(closeMock);
      if (factoryCalls === 1) {
        const callTool = vi.fn(async ({ name }: ToolCall) => {
          if (name === "list_pages") {
            return {
              content: [{ type: "text", text: "No page selected" }],
              isError: true,
            };
          }
          throw new Error(`unexpected tool ${name}`);
        });
        session.client.callTool = callTool as typeof session.client.callTool;
      }
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    await expect(
      listChromeMcpTabs("chrome-live", undefined, {
        ephemeral: true,
      }),
    ).rejects.toThrow(/No page selected/);

    expect(factoryCalls).toBe(1);
    expect(closeMocks[0]).toHaveBeenCalledTimes(1);

    const tabs = await listChromeMcpTabs("chrome-live");

    expect(factoryCalls).toBe(2);
    expect(closeMocks[1]).not.toHaveBeenCalled();
    expect(tabs).toHaveLength(2);
  });

  it("surfaces MCP tool errors instead of JSON parse noise", async () => {
    const factory: ChromeMcpSessionFactory = async () => {
      const session = createFakeSession();
      const callTool = vi.fn(async ({ name }: ToolCall) => {
        if (name === "evaluate_script") {
          return {
            content: [
              {
                type: "text",
                text: "Cannot read properties of null (reading 'value')",
              },
            ],
            isError: true,
          };
        }
        throw new Error(`unexpected tool ${name}`);
      });
      session.client.callTool = callTool as typeof session.client.callTool;
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    await expect(
      evaluateChromeMcpScript({
        profileName: "chrome-live",
        targetId: "1",
        fn: "() => document.getElementById('missing').value",
      }),
    ).rejects.toThrow(/Cannot read properties of null/);
  });

  it("reuses a single pending session for concurrent requests", async () => {
    let factoryCalls = 0;
    let releaseFactory: (() => void) | undefined;
    const factoryGate = new Promise<void>((resolve) => {
      releaseFactory = resolve;
    });
    if (!releaseFactory) {
      throw new Error("Expected Chrome MCP factory release callback to be initialized");
    }

    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      await factoryGate;
      return createFakeSession();
    };
    setChromeMcpSessionFactoryForTest(factory);

    const tabsPromise = listChromeMcpTabs("chrome-live");
    const evalPromise = evaluateChromeMcpScript({
      profileName: "chrome-live",
      targetId: "1",
      fn: "() => 123",
    });

    releaseFactory();
    const [tabs, result] = await Promise.all([tabsPromise, evalPromise]);

    expect(factoryCalls).toBe(1);
    expect(tabs).toHaveLength(2);
    expect(result).toBe(123);
  });

  it("keeps a shared pending session alive when one waiter aborts", async () => {
    let factoryCalls = 0;
    let releaseFactory: (() => void) | undefined;
    const factoryGate = new Promise<void>((resolve) => {
      releaseFactory = resolve;
    });
    if (!releaseFactory) {
      throw new Error("Expected Chrome MCP factory release callback to be initialized");
    }

    const closeMock = vi.fn().mockResolvedValue(undefined);
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      await factoryGate;
      const session = createFakeSession();
      session.client.close = closeMock as typeof session.client.close;
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    const ctrl = new AbortController();
    const keptCtrl = new AbortController();
    const abortedTabsPromise = listChromeMcpTabs("chrome-live", undefined, {
      signal: ctrl.signal,
    });
    const tabsPromise = listChromeMcpTabs("chrome-live", undefined, {
      signal: keptCtrl.signal,
    });

    const abortedTabsExpectation =
      expect(abortedTabsPromise).rejects.toThrow(/first caller cancelled/);
    ctrl.abort(new Error("first caller cancelled"));
    releaseFactory();

    await abortedTabsExpectation;
    await expect(tabsPromise).resolves.toHaveLength(2);
    expect(factoryCalls).toBe(1);
    expect(closeMock).not.toHaveBeenCalled();
  });

  it("closes a shared pending session when every waiter aborts", async () => {
    let factoryCalls = 0;
    let releaseFactory: (() => void) | undefined;
    const factoryGate = new Promise<void>((resolve) => {
      releaseFactory = resolve;
    });
    if (!releaseFactory) {
      throw new Error("Expected Chrome MCP factory release callback to be initialized");
    }

    const closeMock = vi.fn().mockResolvedValue(undefined);
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      await factoryGate;
      const session = createFakeSession();
      session.client.close = closeMock as typeof session.client.close;
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    const ctrl = new AbortController();
    const tabsPromise = listChromeMcpTabs("chrome-live", undefined, {
      signal: ctrl.signal,
    });
    const tabsExpectation = expect(tabsPromise).rejects.toThrow(/caller cancelled/);

    await vi.waitFor(() => expect(factoryCalls).toBe(1));
    ctrl.abort(new Error("caller cancelled"));
    releaseFactory();

    await tabsExpectation;
    await vi.waitFor(() => expect(closeMock).toHaveBeenCalledTimes(1));
    expect(factoryCalls).toBe(1);
  });

  it("starts a fresh shared session after every waiter aborts a pending attach", async () => {
    let factoryCalls = 0;
    const releaseFactories: Array<() => void> = [];
    const closeMocks: Array<ReturnType<typeof vi.fn>> = [];
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      let releaseFactory: (() => void) | undefined;
      const factoryGate = new Promise<void>((resolve) => {
        releaseFactory = resolve;
      });
      if (!releaseFactory) {
        throw new Error("Expected Chrome MCP factory release callback to be initialized");
      }
      releaseFactories.push(releaseFactory);
      await factoryGate;
      const session = createFakeSession();
      const closeMock = vi.fn().mockResolvedValue(undefined);
      closeMocks.push(closeMock);
      session.client.close = closeMock as typeof session.client.close;
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    const ctrl = new AbortController();
    const abortedTabsPromise = listChromeMcpTabs("chrome-live", undefined, {
      signal: ctrl.signal,
    });
    const abortedTabsExpectation = expect(abortedTabsPromise).rejects.toThrow(/caller cancelled/);

    await vi.waitFor(() => expect(factoryCalls).toBe(1));
    ctrl.abort(new Error("caller cancelled"));
    await abortedTabsExpectation;

    const tabsPromise = listChromeMcpTabs("chrome-live");
    await vi.waitFor(() => expect(factoryCalls).toBe(2));
    releaseFactories[0]?.();
    releaseFactories[1]?.();

    await expect(tabsPromise).resolves.toHaveLength(2);
    await vi.waitFor(() => expect(closeMocks[0]).toHaveBeenCalledTimes(1));
    expect(closeMocks[1]).not.toHaveBeenCalled();
  });

  it("closes a shared pending session when every waiter aborts before ready", async () => {
    let factoryCalls = 0;
    let releaseReady: (() => void) | undefined;
    const readyGate = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    if (!releaseReady) {
      throw new Error("Expected Chrome MCP ready release callback to be initialized");
    }

    const closeMock = vi.fn().mockResolvedValue(undefined);
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      const session = createFakeSession();
      session.ready = readyGate;
      session.client.close = closeMock as typeof session.client.close;
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    const ctrl = new AbortController();
    const tabsPromise = listChromeMcpTabs("chrome-live", undefined, {
      signal: ctrl.signal,
    });
    const tabsExpectation = expect(tabsPromise).rejects.toThrow(/caller cancelled/);

    await vi.waitFor(() => expect(factoryCalls).toBe(1));
    ctrl.abort(new Error("caller cancelled"));
    releaseReady();

    await tabsExpectation;
    await vi.waitFor(() => expect(closeMock).toHaveBeenCalledTimes(1));
  });

  it("starts a fresh session while last-waiter abort cleanup is closing", async () => {
    let factoryCalls = 0;
    let releaseFirstClose: (() => void) | undefined;
    const firstCloseGate = new Promise<void>((resolve) => {
      releaseFirstClose = resolve;
    });
    if (!releaseFirstClose) {
      throw new Error("Expected Chrome MCP close release callback to be initialized");
    }

    const closeMocks: Array<ReturnType<typeof vi.fn>> = [];
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      const session = createFakeSession();
      const closeMock =
        factoryCalls === 1
          ? vi.fn(async () => {
              await firstCloseGate;
            })
          : vi.fn().mockResolvedValue(undefined);
      closeMocks.push(closeMock);
      session.client.close = closeMock as typeof session.client.close;
      if (factoryCalls === 1) {
        session.ready = new Promise<void>(() => {});
      }
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    const ctrl = new AbortController();
    const abortedTabsPromise = listChromeMcpTabs("chrome-live", undefined, {
      signal: ctrl.signal,
    });
    const abortedTabsExpectation = expect(abortedTabsPromise).rejects.toThrow(/caller cancelled/);

    await vi.waitFor(() => expect(factoryCalls).toBe(1));
    ctrl.abort(new Error("caller cancelled"));
    await vi.waitFor(() => expect(closeMocks[0]).toHaveBeenCalledTimes(1));

    const tabsPromise = listChromeMcpTabs("chrome-live");
    await vi.waitFor(() => expect(factoryCalls).toBe(2));
    await expect(tabsPromise).resolves.toHaveLength(2);
    expect(closeMocks[1]).not.toHaveBeenCalled();

    releaseFirstClose();
    await abortedTabsExpectation;
  });

  it("keeps a ready-pending shared session cached when another waiter remains", async () => {
    let factoryCalls = 0;
    let releaseReady: (() => void) | undefined;
    const readyGate = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    const readyThen = vi.spyOn(readyGate, "then");
    if (!releaseReady) {
      throw new Error("Expected Chrome MCP ready release callback to be initialized");
    }

    const closeMock = vi.fn().mockResolvedValue(undefined);
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      const session = createFakeSession();
      session.ready = readyGate;
      session.client.close = closeMock as typeof session.client.close;
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    const ctrl = new AbortController();
    const abortedTabsPromise = listChromeMcpTabs("chrome-live", undefined, {
      signal: ctrl.signal,
    });
    const abortedTabsExpectation =
      expect(abortedTabsPromise).rejects.toThrow(/first caller cancelled/);

    await vi.waitFor(() => expect(factoryCalls).toBe(1));
    await vi.waitFor(() => expect(readyThen).toHaveBeenCalledTimes(1));
    const keptCtrl = new AbortController();
    const tabsPromise = listChromeMcpTabs("chrome-live", undefined, {
      signal: keptCtrl.signal,
    });
    await vi.waitFor(() => expect(readyThen).toHaveBeenCalledTimes(2));
    ctrl.abort(new Error("first caller cancelled"));
    releaseReady();

    await abortedTabsExpectation;
    await expect(tabsPromise).resolves.toHaveLength(2);
    await expect(listChromeMcpTabs("chrome-live")).resolves.toHaveLength(2);
    expect(factoryCalls).toBe(1);
    expect(closeMock).not.toHaveBeenCalled();
  });

  it("starts a fresh shared session when a ready-pending session loses its transport", async () => {
    let factoryCalls = 0;
    let firstSession: ChromeMcpSession | undefined;
    let releaseFirstReady: (() => void) | undefined;
    const firstReadyGate = new Promise<void>((resolve) => {
      releaseFirstReady = resolve;
    });
    const firstReadyThen = vi.spyOn(firstReadyGate, "then");
    if (!releaseFirstReady) {
      throw new Error("Expected Chrome MCP ready release callback to be initialized");
    }

    const closeMocks: Array<ReturnType<typeof vi.fn>> = [];
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      const session = createFakeSession();
      const closeMock = vi.fn().mockResolvedValue(undefined);
      closeMocks.push(closeMock);
      session.client.close = closeMock as typeof session.client.close;
      if (factoryCalls === 1) {
        firstSession = session;
        session.ready = firstReadyGate;
      }
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    const ctrl = new AbortController();
    const firstTabsPromise = listChromeMcpTabs("chrome-live", undefined, {
      signal: ctrl.signal,
    });
    const firstTabsExpectation = expect(firstTabsPromise).rejects.toThrow(/first waiter cancelled/);

    await vi.waitFor(() => expect(factoryCalls).toBe(1));
    await vi.waitFor(() => expect(firstReadyThen).toHaveBeenCalledTimes(1));
    if (!firstSession) {
      throw new Error("Expected first Chrome MCP session to be created");
    }
    (firstSession.transport as { pid: number | null }).pid = null;

    const tabsPromise = listChromeMcpTabs("chrome-live");
    const siblingTabsPromise = listChromeMcpTabs("chrome-live");
    ctrl.abort(new Error("first waiter cancelled"));
    releaseFirstReady();
    await vi.waitFor(() => expect(factoryCalls).toBe(2));
    const [tabs, siblingTabs] = await Promise.all([tabsPromise, siblingTabsPromise]);
    expect(tabs).toHaveLength(2);
    expect(siblingTabs).toHaveLength(2);

    await firstTabsExpectation;
    await vi.waitFor(() => expect(closeMocks[0]).toHaveBeenCalledTimes(1));
    expect(closeMocks[1]).not.toHaveBeenCalled();
  });

  it("surfaces startup failures before treating null-pid pending sessions as stale", async () => {
    let factoryCalls = 0;
    const closeMock = vi.fn().mockResolvedValue(undefined);
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      if (factoryCalls > 1) {
        throw new Error("unexpected retry");
      }
      const session = createFakeSession();
      (session.transport as { pid: number | null }).pid = null;
      const readyFailure = Promise.reject(new Error("startup failed"));
      readyFailure.catch(() => {});
      session.ready = readyFailure;
      session.client.close = closeMock as typeof session.client.close;
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    await expect(listChromeMcpTabs("chrome-live")).rejects.toThrow(/startup failed/);

    expect(factoryCalls).toBe(1);
    await vi.waitFor(() => expect(closeMock).toHaveBeenCalledTimes(1));
  });

  it("bounds retries when ready sessions keep losing their transport", async () => {
    let factoryCalls = 0;
    const closeMocks: Array<ReturnType<typeof vi.fn>> = [];
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      const session = createFakeSession();
      (session.transport as { pid: number | null }).pid = null;
      const closeMock = vi.fn().mockResolvedValue(undefined);
      closeMocks.push(closeMock);
      session.client.close = closeMock as typeof session.client.close;
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    await expect(listChromeMcpTabs("chrome-live")).rejects.toThrow(
      /subprocess exited before it became usable/,
    );

    expect(factoryCalls).toBe(2);
    await vi.waitFor(() => expect(closeMocks[0]).toHaveBeenCalled());
    await vi.waitFor(() => expect(closeMocks[1]).toHaveBeenCalled());
  });

  it("does not reuse a stale ready-pending session for ephemeral probes", async () => {
    let factoryCalls = 0;
    let firstSession: ChromeMcpSession | undefined;
    let releaseFirstReady: (() => void) | undefined;
    const firstReadyGate = new Promise<void>((resolve) => {
      releaseFirstReady = resolve;
    });
    const firstReadyThen = vi.spyOn(firstReadyGate, "then");
    if (!releaseFirstReady) {
      throw new Error("Expected Chrome MCP ready release callback to be initialized");
    }

    const closeMocks: Array<ReturnType<typeof vi.fn>> = [];
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      const session = createFakeSession();
      const closeMock = vi.fn().mockResolvedValue(undefined);
      closeMocks.push(closeMock);
      session.client.close = closeMock as typeof session.client.close;
      if (factoryCalls === 1) {
        firstSession = session;
        session.ready = firstReadyGate;
      }
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    const ctrl = new AbortController();
    const firstAvailablePromise = ensureChromeMcpAvailable("chrome-live", undefined, {
      signal: ctrl.signal,
    });
    const firstAvailableExpectation =
      expect(firstAvailablePromise).rejects.toThrow(/first waiter cancelled/);

    await vi.waitFor(() => expect(factoryCalls).toBe(1));
    await vi.waitFor(() => expect(firstReadyThen).toHaveBeenCalledTimes(1));
    if (!firstSession) {
      throw new Error("Expected first Chrome MCP session to be created");
    }
    (firstSession.transport as { pid: number | null }).pid = null;

    const availablePromise = ensureChromeMcpAvailable("chrome-live", undefined, {
      ephemeral: true,
    });
    ctrl.abort(new Error("first waiter cancelled"));
    releaseFirstReady();
    await expect(availablePromise).resolves.toBeUndefined();
    expect(factoryCalls).toBe(2);
    await vi.waitFor(() => expect(closeMocks[1]).toHaveBeenCalledTimes(1));

    await firstAvailableExpectation;
    await vi.waitFor(() => expect(closeMocks[0]).toHaveBeenCalledTimes(1));
  });

  it("does not let ephemeral probes persist canceled pending attaches", async () => {
    let factoryCalls = 0;
    let releaseFirstReady: (() => void) | undefined;
    const firstReadyGate = new Promise<void>((resolve) => {
      releaseFirstReady = resolve;
    });
    const firstReadyThen = vi.spyOn(firstReadyGate, "then");
    if (!releaseFirstReady) {
      throw new Error("Expected Chrome MCP ready release callback to be initialized");
    }

    const closeMocks: Array<ReturnType<typeof vi.fn>> = [];
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      const session = createFakeSession();
      const closeMock = vi.fn().mockResolvedValue(undefined);
      closeMocks.push(closeMock);
      session.client.close = closeMock as typeof session.client.close;
      if (factoryCalls === 1) {
        session.ready = firstReadyGate;
      }
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    const ctrl = new AbortController();
    const firstAvailablePromise = ensureChromeMcpAvailable("chrome-live", undefined, {
      signal: ctrl.signal,
    });
    const firstAvailableExpectation =
      expect(firstAvailablePromise).rejects.toThrow(/first waiter cancelled/);

    await vi.waitFor(() => expect(factoryCalls).toBe(1));
    await vi.waitFor(() => expect(firstReadyThen).toHaveBeenCalledTimes(1));

    await expect(
      ensureChromeMcpAvailable("chrome-live", undefined, {
        ephemeral: true,
      }),
    ).resolves.toBeUndefined();
    expect(factoryCalls).toBe(2);
    expect(firstReadyThen).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(closeMocks[1]).toHaveBeenCalledTimes(1));

    ctrl.abort(new Error("first waiter cancelled"));
    releaseFirstReady();
    await firstAvailableExpectation;
    await vi.waitFor(() => expect(closeMocks[0]).toHaveBeenCalledTimes(1));

    await expect(listChromeMcpTabs("chrome-live")).resolves.toHaveLength(2);
    expect(factoryCalls).toBe(3);
  });

  it("keeps a shared session after a readiness timeout while another waiter remains", async () => {
    let factoryCalls = 0;
    let releaseFirstReady: (() => void) | undefined;
    const firstReadyGate = new Promise<void>((resolve) => {
      releaseFirstReady = resolve;
    });
    const firstReadyThen = vi.spyOn(firstReadyGate, "then");
    if (!releaseFirstReady) {
      throw new Error("Expected Chrome MCP ready release callback to be initialized");
    }

    const closeMocks: Array<ReturnType<typeof vi.fn>> = [];
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      const session = createFakeSession();
      const closeMock = vi.fn().mockResolvedValue(undefined);
      closeMocks.push(closeMock);
      session.client.close = closeMock as typeof session.client.close;
      if (factoryCalls === 1) {
        session.ready = firstReadyGate;
      }
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    const keptCtrl = new AbortController();
    const timedOutTabsPromise = listChromeMcpTabs("chrome-live", undefined, {
      timeoutMs: 1,
    });
    const timedOutTabsExpectation = expect(timedOutTabsPromise).rejects.toThrow(/timed out/);
    const keptTabsPromise = listChromeMcpTabs("chrome-live", undefined, {
      signal: keptCtrl.signal,
    });

    await vi.waitFor(() => expect(factoryCalls).toBe(1));
    await vi.waitFor(() => expect(firstReadyThen).toHaveBeenCalledTimes(2));
    await timedOutTabsExpectation;

    const laterTabsPromise = listChromeMcpTabs("chrome-live");
    releaseFirstReady();

    await expect(keptTabsPromise).resolves.toHaveLength(2);
    await expect(laterTabsPromise).resolves.toHaveLength(2);
    expect(factoryCalls).toBe(1);
    expect(closeMocks[0]).not.toHaveBeenCalled();
    keptCtrl.abort(new Error("kept waiter cancelled"));
  });

  it("closes a shared pending session after a readiness timeout with no other waiters", async () => {
    let factoryCalls = 0;
    const closeMocks: Array<ReturnType<typeof vi.fn>> = [];
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      const session = createFakeSession();
      const closeMock = vi.fn().mockResolvedValue(undefined);
      closeMocks.push(closeMock);
      session.client.close = closeMock as typeof session.client.close;
      if (factoryCalls === 1) {
        session.ready = new Promise<void>(() => {});
      }
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    await expect(
      listChromeMcpTabs("chrome-live", undefined, {
        timeoutMs: 1,
      }),
    ).rejects.toThrow(/timed out/);
    await vi.waitFor(() => expect(closeMocks[0]).toHaveBeenCalledTimes(1));

    await expect(listChromeMcpTabs("chrome-live")).resolves.toHaveLength(2);
    expect(factoryCalls).toBe(2);
    expect(closeMocks[1]).not.toHaveBeenCalled();
  });

  it("preserves session after tool-level errors (isError)", async () => {
    let factoryCalls = 0;
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      const session = createFakeSession();
      const callTool = vi.fn(async ({ name }: ToolCall) => {
        if (name === "evaluate_script") {
          return {
            content: [{ type: "text", text: "element not found" }],
            isError: true,
          };
        }
        if (name === "list_pages") {
          return {
            content: [{ type: "text", text: "## Pages\n1: https://example.com [selected]" }],
          };
        }
        throw new Error(`unexpected tool ${name}`);
      });
      session.client.callTool = callTool as typeof session.client.callTool;
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    // First call: tool error (isError: true) — should NOT destroy session
    await expect(
      evaluateChromeMcpScript({ profileName: "chrome-live", targetId: "1", fn: "() => null" }),
    ).rejects.toThrow(/element not found/);

    // Second call: should reuse the same session (factory called only once)
    const tabs = await listChromeMcpTabs("chrome-live");
    expect(factoryCalls).toBe(1);
    expect(tabs).toHaveLength(1);
  });

  it("destroys session on transport errors so next call reconnects", async () => {
    let factoryCalls = 0;
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      const session = createFakeSession();
      if (factoryCalls === 1) {
        // First session: transport error (callTool throws)
        const callTool = vi.fn(async () => {
          throw new Error("connection reset");
        });
        session.client.callTool = callTool as typeof session.client.callTool;
      }
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    // First call: transport error — should destroy session
    await expect(listChromeMcpTabs("chrome-live")).rejects.toThrow(/connection reset/);

    // Second call: should create a new session (factory called twice)
    const tabs = await listChromeMcpTabs("chrome-live");
    expect(factoryCalls).toBe(2);
    expect(tabs).toHaveLength(2);
  });

  it("times out a stuck click and recovers on the next call", async () => {
    let factoryCalls = 0;
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      const session = createFakeSession();
      const callTool = vi.fn(async ({ name }: ToolCall) => {
        if (name === "click") {
          return await new Promise(() => {});
        }
        if (name === "list_pages") {
          return {
            content: [{ type: "text", text: "## Pages\n1: https://example.com [selected]" }],
          };
        }
        throw new Error(`unexpected tool ${name}`);
      });
      session.client.callTool = callTool as typeof session.client.callTool;
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    await expect(
      clickChromeMcpElement({
        profileName: "chrome-live",
        targetId: "1",
        uid: "btn-1",
        timeoutMs: 25,
      }),
    ).rejects.toThrow(/timed out/i);

    const tabs = await listChromeMcpTabs("chrome-live");
    expect(factoryCalls).toBe(2);
    expect(tabs).toHaveLength(1);
  });

  it("does not dispatch a click when the signal is already aborted", async () => {
    const session = createFakeSession();
    const callTool = vi.fn(async (_call: ToolCall) => {
      throw new Error("callTool should not run");
    });
    session.client.callTool = callTool as typeof session.client.callTool;
    setChromeMcpSessionFactoryForTest(async () => session);
    const ctrl = new AbortController();
    ctrl.abort(new Error("aborted before click"));

    await expect(
      clickChromeMcpElement({
        profileName: "chrome-live",
        targetId: "1",
        uid: "btn-1",
        signal: ctrl.signal,
      }),
    ).rejects.toThrow(/aborted before click/i);

    expect(callTool).not.toHaveBeenCalled();
  });

  it("creates a fresh session when userDataDir changes for the same profile", async () => {
    const createdSessions: ChromeMcpSession[] = [];
    const closeMocks: Array<ReturnType<typeof vi.fn>> = [];
    const factoryCalls: Array<{ profileName: string; userDataDir?: string }> = [];
    const factory: ChromeMcpSessionFactory = async (profileName, options) => {
      factoryCalls.push({ profileName, userDataDir: options?.userDataDir });
      const session = createFakeSession();
      const closeMock = vi.fn().mockResolvedValue(undefined);
      session.client.close = closeMock as typeof session.client.close;
      createdSessions.push(session);
      closeMocks.push(closeMock);
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    await listChromeMcpTabs("chrome-live", "/tmp/brave-a");
    await listChromeMcpTabs("chrome-live", "/tmp/brave-b");

    expect(factoryCalls).toEqual([
      { profileName: "chrome-live", userDataDir: "/tmp/brave-a" },
      { profileName: "chrome-live", userDataDir: "/tmp/brave-b" },
    ]);
    expect(createdSessions).toHaveLength(2);
    expect(closeMocks[0]).toHaveBeenCalledTimes(1);
    expect(closeMocks[1]).not.toHaveBeenCalled();
  });

  it("clears failed pending sessions so the next call can retry", async () => {
    let factoryCalls = 0;
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      if (factoryCalls === 1) {
        throw new Error("attach failed");
      }
      return createFakeSession();
    };
    setChromeMcpSessionFactoryForTest(factory);

    await expect(listChromeMcpTabs("chrome-live")).rejects.toThrow(/attach failed/);

    const tabs = await listChromeMcpTabs("chrome-live");
    expect(factoryCalls).toBe(2);
    expect(tabs).toHaveLength(2);
  });
  it("reconnects and retries list_pages once when Chrome MCP reports a stale selected page", async () => {
    let factoryCalls = 0;
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      const session = createFakeSession();
      session.client.callTool = vi.fn(async ({ name }: ToolCall) => {
        if (name !== "list_pages") {
          throw new Error(`unexpected tool ${name}`);
        }
        if (factoryCalls === 1) {
          return {
            content: [
              {
                type: "text",
                text: "The selected page has been closed. Call list_pages to see open pages.",
              },
            ],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: "## Pages\n1: https://example.com [selected]" }],
        };
      }) as typeof session.client.callTool;
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    const tabs = await listChromeMcpTabs("chrome-live");

    expect(factoryCalls).toBe(2);
    expect(tabs).toEqual([
      {
        targetId: "1",
        title: "",
        url: "https://example.com",
        type: "page",
      },
    ]);
  });

  it("clears cached sessions after repeated stale selected-page failures", async () => {
    let factoryCalls = 0;
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      const session = createFakeSession();
      session.client.callTool = vi.fn(async ({ name }: ToolCall) => {
        if (name !== "list_pages") {
          throw new Error(`unexpected tool ${name}`);
        }
        if (factoryCalls <= 2) {
          return {
            content: [
              {
                type: "text",
                text: "The selected page has been closed. Call list_pages to see open pages.",
              },
            ],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: "## Pages\n1: https://example.com [selected]" }],
        };
      }) as typeof session.client.callTool;
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    await expect(listChromeMcpTabs("chrome-live")).rejects.toThrow(
      /The selected page has been closed/,
    );

    const tabs = await listChromeMcpTabs("chrome-live");

    expect(factoryCalls).toBe(3);
    expect(tabs).toHaveLength(1);
  });

  it("always passes a default timeout to navigate_page when none is specified", async () => {
    const session = createFakeSession();
    setChromeMcpSessionFactoryForTest(async () => session);

    await navigateChromeMcpPage({
      profileName: "chrome-live",
      targetId: "1",
      url: "https://example.com",
      // intentionally no timeoutMs
    });

    const callToolMock = session.client["callTool"] as unknown as ToolCallMock;
    const navigateCall = callToolMock.mock.calls.find(
      ([call]) => call.name === "navigate_page",
    )?.[0];
    expect(navigateCall?.arguments?.timeout).toBe(20_000);
  });

  it("caps the navigate_page safety-net timeout", () => {
    expect(resolveChromeMcpNavigateCallTimeoutMs(10_000)).toBe(15_000);
    expect(resolveChromeMcpNavigateCallTimeoutMs(Number.MAX_VALUE)).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("resets the Chrome MCP session when a navigate_page call hangs past the safety-net timeout", async () => {
    vi.useFakeTimers();
    let factoryCalls = 0;
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      const session = createFakeSession();
      if (factoryCalls === 1) {
        // First session: all tool calls hang — simulates a Chrome MCP subprocess that is
        // completely blocked (e.g., stuck waiting for a slow navigation to complete).
        session.client.callTool = vi.fn(
          async () => new Promise<never>(() => {}),
        ) as typeof session.client.callTool;
      }
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    // Start navigation — will hang.
    const navPromise = navigateChromeMcpPage({
      profileName: "chrome-live",
      targetId: "1",
      url: "https://slow-site.example",
    });
    // Suppress unhandled-rejection detection: navPromise rejects during timer
    // advancement, before the expect below attaches its handler.
    void navPromise.catch(() => {});

    // Advance past the 25 s safety-net (CHROME_MCP_NAVIGATE_TIMEOUT_MS 20 s + 5 s buffer).
    await vi.advanceTimersByTimeAsync(25_001);

    await expect(navPromise).rejects.toThrow(/Chrome MCP "navigate_page".*timed out/);

    // Switch back to real timers before testing reconnect behaviour.
    vi.useRealTimers();

    // Next call must use a fresh session — factory is called a second time.
    const tabs = await listChromeMcpTabs("chrome-live");
    expect(factoryCalls).toBe(2);
    expect(tabs).toHaveLength(2);
  });

  it("forwards an explicit timeoutMs to take_snapshot via the callTool race", async () => {
    vi.useFakeTimers();
    const session = createFakeSession();
    session.client.callTool = vi.fn(
      async () => new Promise<never>(() => {}),
    ) as typeof session.client.callTool;
    setChromeMcpSessionFactoryForTest(async () => session);

    const snapshotPromise = takeChromeMcpSnapshot({
      profileName: "chrome-live",
      targetId: "1",
      timeoutMs: 75,
    });
    void snapshotPromise.catch(() => {});

    await vi.advanceTimersByTimeAsync(75);

    await expect(snapshotPromise).rejects.toThrow(/Chrome MCP "take_snapshot".*timed out/);
    vi.useRealTimers();
  });

  it("honors timeoutMs for ephemeral availability probes", async () => {
    vi.useFakeTimers();
    const closeMock = vi.fn().mockResolvedValue(undefined);
    const factory: ChromeMcpSessionFactory = async () =>
      ({
        client: {
          callTool: vi.fn(),
          listTools: vi.fn(),
          close: closeMock,
          connect: vi.fn(),
        },
        transport: {
          pid: 123,
        },
        ready: new Promise<void>(() => {}),
      }) as unknown as ChromeMcpSession;
    setChromeMcpSessionFactoryForTest(factory);

    const promise = ensureChromeMcpAvailable("chrome-live", undefined, {
      ephemeral: true,
      timeoutMs: 50,
    });
    const expectation = expect(promise).rejects.toThrow(/timed out after 50ms/i);

    await vi.advanceTimersByTimeAsync(50);

    await expectation;
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("redacts home-relative profile labels from availability timeout diagnostics", async () => {
    vi.useFakeTimers();
    const closeMock = vi.fn().mockResolvedValue(undefined);
    const factory: ChromeMcpSessionFactory = async () =>
      ({
        client: {
          callTool: vi.fn(),
          listTools: vi.fn(),
          close: closeMock,
          connect: vi.fn(),
        },
        transport: {
          pid: 123,
        },
        ready: new Promise<void>(() => {}),
      }) as unknown as ChromeMcpSession;
    setChromeMcpSessionFactoryForTest(factory);

    const homeDir = os.homedir();
    const profileName = path.join(homeDir, "Library", "Application Support", "Google", "Chrome");
    const promise = ensureChromeMcpAvailable(profileName, undefined, {
      ephemeral: true,
      timeoutMs: 50,
    });
    void promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(50);

    await expect(promise).rejects.toThrow(/timed out after 50ms/i);
    await expect(promise).rejects.toThrow("~/Library/Application Support/Google/Chrome");
    await expect(promise).rejects.not.toThrow(homeDir);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("honors abort signals while waiting for ephemeral availability probes", async () => {
    const closeMock = vi.fn().mockResolvedValue(undefined);
    const factory: ChromeMcpSessionFactory = async () =>
      ({
        client: {
          callTool: vi.fn(),
          listTools: vi.fn(),
          close: closeMock,
          connect: vi.fn(),
        },
        transport: {
          pid: 123,
        },
        ready: new Promise<void>(() => {}),
      }) as unknown as ChromeMcpSession;
    setChromeMcpSessionFactoryForTest(factory);

    const ctrl = new AbortController();
    const promise = ensureChromeMcpAvailable("chrome-live", undefined, {
      ephemeral: true,
      signal: ctrl.signal,
    });
    ctrl.abort(new Error("status budget exhausted"));

    await expect(promise).rejects.toThrow(/status budget exhausted/);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});
