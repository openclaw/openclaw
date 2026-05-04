import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildChromeMcpArgs,
  clickChromeMcpElement,
  decideStartGate,
  ensureChromeMcpAvailable,
  evaluateChromeMcpScript,
  formatStartGateBlockedMessage,
  listChromeMcpTabs,
  navigateChromeMcpPage,
  openChromeMcpTab,
  probeChromeMcpHealth,
  probeChromeRemoteDebuggingViaFiles,
  resetChromeMcpSessionsForTest,
  setBrowserAuthSignalProbesForTest,
  setBrowserAuthVisualVerifier,
  setChromeMcpSessionFactoryForTest,
  setChromeRemoteDebuggingProberForTest,
  type ChromeBrowserAuthHealth,
  type ChromePortOwnerSignal,
} from "./chrome-mcp.js";

type ToolCall = {
  name: string;
  arguments?: Record<string, unknown>;
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

  it("adds --userDataDir when an explicit Chromium profile path is configured", () => {
    expect(buildChromeMcpArgs("/tmp/brave-profile")).toEqual([
      "-y",
      "chrome-devtools-mcp@latest",
      "--autoConnect",
      "--experimentalStructuredContent",
      "--experimental-page-id-routing",
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
      "--experimentalStructuredContent",
      "--experimental-page-id-routing",
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
      "--experimentalStructuredContent",
      "--experimental-page-id-routing",
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
      "--browserUrl",
      "http://127.0.0.1:9222",
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
      "--experimentalStructuredContent",
      "--experimental-page-id-routing",
    ]);
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
    expect(session.client.callTool).toHaveBeenCalledWith({
      name: "new_page",
      arguments: { url: "about:blank", timeout: 5000 },
    });
    expect(session.client.callTool).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "navigate_page" }),
    );
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
    let releaseFactory!: () => void;
    const factoryGate = new Promise<void>((resolve) => {
      releaseFactory = resolve;
    });

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

    expect(session.client.callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "navigate_page",
        arguments: expect.objectContaining({ timeout: 20_000 }),
      }),
    );
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

  it("probeChromeMcpHealth returns attached:false without invoking the session factory when cache is empty", async () => {
    const factory = vi.fn(async () => createFakeSession());
    setChromeMcpSessionFactoryForTest(factory as unknown as ChromeMcpSessionFactory);

    const result = await probeChromeMcpHealth("chrome-live");

    expect(result.attached).toBe(false);
    expect(result.mcpPid).toBeNull();
    expect(result.cacheAttached).toBe(false);
    expect(factory).not.toHaveBeenCalled();
  });

  it("probeChromeMcpHealth reports attached when a ready session exists in the cache", async () => {
    const factory: ChromeMcpSessionFactory = async () => createFakeSession();
    setChromeMcpSessionFactoryForTest(factory);

    await listChromeMcpTabs("chrome-live");

    const result = await probeChromeMcpHealth("chrome-live");
    expect(result.attached).toBe(true);
    expect(result.mcpPid).toBe(123);
    expect(result.cacheAttached).toBe(true);
    expect(result.level).toBe("high");
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
});

async function withListeningPort<T>(fn: (port: number) => Promise<T>): Promise<T> {
  const server = net.createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("expected listening port");
  }
  try {
    return await fn(address.port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function pickFreeLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("expected listening port");
  }
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("probeChromeRemoteDebuggingViaFiles", () => {
  let dir: string;

  beforeEach(async () => {
    await resetChromeMcpSessionsForTest();
    setChromeRemoteDebuggingProberForTest(null);
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-chrome-userdata-"));
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("reports enabled when Local State toggle is true and DevToolsActivePort is bound", async () => {
    await withListeningPort(async (port) => {
      await fsp.writeFile(
        path.join(dir, "Local State"),
        JSON.stringify({ devtools: { remote_debugging: { "user-enabled": true } } }),
      );
      const uuid = "c2e9313d-e7ab-452e-962d-ad7465c4764f";
      await fsp.writeFile(
        path.join(dir, "DevToolsActivePort"),
        `${port}\n/devtools/browser/${uuid}\n`,
      );

      const signal = await probeChromeRemoteDebuggingViaFiles({ userDataDir: dir });

      expect(signal).toMatchObject({
        enabled: true,
        toggleEnabled: true,
        port,
        browserUuid: uuid,
        portListening: true,
        reason: "devtools-active-port-detected",
      });
      expect(typeof signal.portFileMtimeMs).toBe("number");
    });
  });

  it("reports disabled when Local State is missing", async () => {
    const signal = await probeChromeRemoteDebuggingViaFiles({ userDataDir: dir });
    expect(signal.enabled).toBe(false);
    expect(signal.toggleEnabled).toBe(false);
    expect(signal.reason).toBe("local-state-unreadable");
  });

  it("reports toggle-off + port-file-present as a contradiction reason", async () => {
    await fsp.writeFile(
      path.join(dir, "Local State"),
      JSON.stringify({ devtools: { remote_debugging: { "user-enabled": false } } }),
    );
    await fsp.writeFile(path.join(dir, "DevToolsActivePort"), `9999\n/devtools/browser/x\n`);

    const signal = await probeChromeRemoteDebuggingViaFiles({ userDataDir: dir });
    expect(signal.enabled).toBe(false);
    expect(signal.toggleEnabled).toBe(false);
    expect(signal.port).toBe(9999);
    expect(signal.reason).toBe("toggle-off-port-file-present");
  });

  it("reports user-enabled-false when both toggle and port file are absent", async () => {
    await fsp.writeFile(
      path.join(dir, "Local State"),
      JSON.stringify({ devtools: { remote_debugging: { "user-enabled": false } } }),
    );

    const signal = await probeChromeRemoteDebuggingViaFiles({ userDataDir: dir });
    expect(signal.enabled).toBe(false);
    expect(signal.toggleEnabled).toBe(false);
    expect(signal.port).toBeNull();
    expect(signal.reason).toBe("user-enabled-false");
  });

  it("reports devtools-active-port-unreadable when toggle is true but port file is missing", async () => {
    await fsp.writeFile(
      path.join(dir, "Local State"),
      JSON.stringify({ devtools: { remote_debugging: { "user-enabled": true } } }),
    );

    const signal = await probeChromeRemoteDebuggingViaFiles({ userDataDir: dir });
    expect(signal.enabled).toBe(false);
    expect(signal.toggleEnabled).toBe(true);
    expect(signal.reason).toBe("devtools-active-port-unreadable");
  });

  it("reports disabled when the DevToolsActivePort port is not listening", async () => {
    const port = await pickFreeLoopbackPort();
    await fsp.writeFile(
      path.join(dir, "Local State"),
      JSON.stringify({ devtools: { remote_debugging: { "user-enabled": true } } }),
    );
    await fsp.writeFile(path.join(dir, "DevToolsActivePort"), `${port}\n/devtools/browser/abc\n`);

    const signal = await probeChromeRemoteDebuggingViaFiles({ userDataDir: dir });
    expect(signal.enabled).toBe(false);
    expect(signal.toggleEnabled).toBe(true);
    expect(signal.portListening).toBe(false);
    expect(signal.reason).toBe("devtools-active-port-not-listening");
    expect(signal.port).toBe(port);
  });

  it("skips file checks when an explicit cdpUrl is configured", async () => {
    await fsp.writeFile(
      path.join(dir, "Local State"),
      JSON.stringify({ devtools: { remote_debugging: { "user-enabled": true } } }),
    );
    await fsp.writeFile(path.join(dir, "DevToolsActivePort"), `9999\n/devtools/browser/x\n`);

    const signal = await probeChromeRemoteDebuggingViaFiles({
      userDataDir: dir,
      cdpUrl: "http://192.0.2.10:9222",
    });
    expect(signal.enabled).toBe(false);
    expect(signal.reason).toBe("cdp-url-configured");
  });

  it("ignores malformed JSON in Local State without throwing", async () => {
    await fsp.writeFile(path.join(dir, "Local State"), "{not json");
    const signal = await probeChromeRemoteDebuggingViaFiles({ userDataDir: dir });
    expect(signal.enabled).toBe(false);
    expect(signal.reason).toBe("local-state-unreadable");
  });
});

describe("probeChromeMcpHealth confidence levels", () => {
  beforeEach(async () => {
    await resetChromeMcpSessionsForTest();
  });

  afterEach(() => {
    setBrowserAuthSignalProbesForTest(null);
  });

  it("returns HIGH attached when toggle, port, owner, and HTTP all agree", async () => {
    setBrowserAuthSignalProbesForTest({
      fileProbe: async () => ({
        enabled: true,
        toggleEnabled: true,
        port: 50211,
        browserUuid: "c2e9313d-e7ab-452e-962d-ad7465c4764f",
        portListening: true,
        portFileMtimeMs: Date.now(),
        reason: "devtools-active-port-detected",
      }),
      portOwnerProbe: async () => ({
        kind: "chrome",
        process: "Google Chrome",
        pid: 37121,
        reason: "lsof-chrome-listener",
      }),
      jsonVersionProbe: async () => ({
        ok: true,
        reason: "chrome-json-version",
        product: "Chrome/144.0.0.0",
      }),
    });

    const result = await probeChromeMcpHealth("chrome-live", { userDataDir: "/tmp/chrome-fake" });
    expect(result.level).toBe("high");
    expect(result.attached).toBe(true);
    expect(result.mcpPid).toBeNull();
    expect(result.cacheAttached).toBe(false);
    expect(result.port).toBe(50211);
    expect(result.browserUuid).toBe("c2e9313d-e7ab-452e-962d-ad7465c4764f");
    expect(result.emptyState).toBe(false);
    expect(result.reasons[0]).toBe("file:devtools-active-port-detected");
  });

  it("holds MEDIUM when chrome owner is reported but /json/version times out", async () => {
    setBrowserAuthSignalProbesForTest({
      fileProbe: async () => ({
        enabled: true,
        toggleEnabled: true,
        port: 50211,
        browserUuid: "abcdef01-2345-6789-abcd-ef0123456789",
        portListening: true,
        portFileMtimeMs: Date.now(),
        reason: "devtools-active-port-detected",
      }),
      portOwnerProbe: async () => ({
        kind: "chrome",
        process: "Google Chrome",
        pid: 37121,
        reason: "lsof-chrome-listener",
      }),
      jsonVersionProbe: async () => ({ ok: false, reason: "http-timeout" }),
    });
    const result = await probeChromeMcpHealth("chrome-live", { userDataDir: "/tmp/chrome-fake" });
    expect(result.level).toBe("medium");
    expect(result.attached).toBe(false);
  });

  it("holds MEDIUM when chrome owner is reported but /json/version errors", async () => {
    setBrowserAuthSignalProbesForTest({
      fileProbe: async () => ({
        enabled: true,
        toggleEnabled: true,
        port: 50211,
        browserUuid: "abcdef01-2345-6789-abcd-ef0123456789",
        portListening: true,
        portFileMtimeMs: Date.now(),
        reason: "devtools-active-port-detected",
      }),
      portOwnerProbe: async () => ({
        kind: "chrome",
        process: "Google Chrome",
        pid: 37121,
        reason: "lsof-chrome-listener",
      }),
      jsonVersionProbe: async () => ({ ok: false, reason: "http-error" }),
    });
    const result = await probeChromeMcpHealth("chrome-live", { userDataDir: "/tmp/chrome-fake" });
    expect(result.level).toBe("medium");
    expect(result.attached).toBe(false);
  });

  it("returns MEDIUM when toggle+port listen but lsof can't identify the owner", async () => {
    setBrowserAuthSignalProbesForTest({
      fileProbe: async () => ({
        enabled: true,
        toggleEnabled: true,
        port: 50211,
        browserUuid: "abc",
        portListening: true,
        portFileMtimeMs: Date.now(),
        reason: "devtools-active-port-detected",
      }),
      portOwnerProbe: async () => ({ kind: "unknown", reason: "lsof-timeout" }),
    });

    const result = await probeChromeMcpHealth("chrome-live", { userDataDir: "/tmp/chrome-fake" });
    expect(result.level).toBe("medium");
    expect(result.attached).toBe(false);
    expect(result.emptyState).toBe(false);
    expect(result.reasons).toContain("owner:lsof-timeout");
  });

  it("returns MEDIUM when toggle is on but port file is missing (Chrome restarting)", async () => {
    setBrowserAuthSignalProbesForTest({
      fileProbe: async () => ({
        enabled: false,
        toggleEnabled: true,
        port: null,
        browserUuid: null,
        portListening: false,
        portFileMtimeMs: null,
        reason: "devtools-active-port-unreadable",
      }),
    });

    const result = await probeChromeMcpHealth("chrome-live", { userDataDir: "/tmp/chrome-fake" });
    expect(result.level).toBe("medium");
    expect(result.attached).toBe(false);
    expect(result.emptyState).toBe(false);
  });

  it("returns MEDIUM when toggle+listener+chrome-owner agree but the HTTP endpoint is non-Chrome", async () => {
    setBrowserAuthSignalProbesForTest({
      fileProbe: async () => ({
        enabled: true,
        toggleEnabled: true,
        port: 50211,
        browserUuid: "abc",
        portListening: true,
        portFileMtimeMs: Date.now(),
        reason: "devtools-active-port-detected",
      }),
      portOwnerProbe: async () => ({
        kind: "chrome",
        process: "Google Chrome",
        pid: 37121,
        reason: "lsof-chrome-listener",
      }),
      jsonVersionProbe: async () => ({ ok: false, reason: "non-chrome-product" }),
    });

    const result = await probeChromeMcpHealth("chrome-live", { userDataDir: "/tmp/chrome-fake" });
    expect(result.level).toBe("medium");
    expect(result.attached).toBe(false);
    expect(result.reasons).toContain("http:non-chrome-product");
  });

  it("returns LOW (emptyState) when nothing is running", async () => {
    setBrowserAuthSignalProbesForTest({
      fileProbe: async () => ({
        enabled: false,
        toggleEnabled: false,
        port: null,
        browserUuid: null,
        portListening: false,
        portFileMtimeMs: null,
        reason: "user-enabled-false",
      }),
    });

    const result = await probeChromeMcpHealth("chrome-live", { userDataDir: "/tmp/chrome-fake" });
    expect(result.level).toBe("low");
    expect(result.attached).toBe(false);
    expect(result.emptyState).toBe(true);
  });

  it("returns LOW (conflict) when port is listening but owned by a non-Chrome process", async () => {
    setBrowserAuthSignalProbesForTest({
      fileProbe: async () => ({
        enabled: true,
        toggleEnabled: true,
        port: 50211,
        browserUuid: "abc",
        portListening: true,
        portFileMtimeMs: Date.now(),
        reason: "devtools-active-port-detected",
      }),
      portOwnerProbe: async () => ({
        kind: "other",
        process: "node",
        pid: 999,
        reason: "lsof-non-chrome-listener",
      }),
    });

    const result = await probeChromeMcpHealth("chrome-live", { userDataDir: "/tmp/chrome-fake" });
    expect(result.level).toBe("low");
    expect(result.attached).toBe(false);
    expect(result.emptyState).toBe(false);
  });

  it("returns LOW with mayStart=false when toggle is on but port file is stale (port not listening)", async () => {
    setBrowserAuthSignalProbesForTest({
      fileProbe: async () => ({
        enabled: false,
        toggleEnabled: true,
        port: 50211,
        browserUuid: "abc",
        portListening: false,
        portFileMtimeMs: Date.now() - 60_000,
        reason: "devtools-active-port-not-listening",
      }),
      portOwnerProbe: async () => ({ kind: "none", reason: "lsof-no-listener" }),
    });

    const result = await probeChromeMcpHealth("chrome-live", { userDataDir: "/tmp/chrome-fake" });
    expect(result.level).toBe("low");
    expect(result.attached).toBe(false);
    expect(result.emptyState).toBe(false);
    expect(decideStartGate(result).mayStart).toBe(false);
  });

  it("prefers the live MCP cache (HIGH cacheAttached) over file probes", async () => {
    setBrowserAuthSignalProbesForTest({
      fileProbe: async () => ({
        enabled: true,
        toggleEnabled: true,
        port: 50211,
        browserUuid: "abc",
        portListening: true,
        portFileMtimeMs: Date.now(),
        reason: "devtools-active-port-detected",
      }),
      portOwnerProbe: async () => ({
        kind: "chrome",
        process: "Google Chrome",
        pid: 37121,
        reason: "lsof-chrome-listener",
      }),
      jsonVersionProbe: async () => ({ ok: true, reason: "chrome-json-version" }),
    });
    const factory: ChromeMcpSessionFactory = async () => createFakeSession();
    setChromeMcpSessionFactoryForTest(factory);

    await listChromeMcpTabs("chrome-live");

    const result = await probeChromeMcpHealth("chrome-live");
    expect(result.level).toBe("high");
    expect(result.attached).toBe(true);
    expect(result.cacheAttached).toBe(true);
    expect(result.mcpPid).toBe(123);
  });
});

describe("decideStartGate", () => {
  function makeHealth(overrides: Partial<ChromeBrowserAuthHealth>): ChromeBrowserAuthHealth {
    return {
      level: "low",
      attached: false,
      mcpPid: null,
      port: null,
      browserUuid: null,
      reasons: [],
      emptyState: false,
      cacheAttached: false,
      ...overrides,
    };
  }

  it("HIGH: mayStart=false (already attached, do not respawn)", () => {
    const gate = decideStartGate(
      makeHealth({ level: "high", attached: true, cacheAttached: true }),
    );
    expect(gate).toEqual({
      mayStart: false,
      reason: "browser-already-attached",
      level: "high",
    });
  });

  it("MEDIUM: mayStart=false until visual verification", () => {
    const gate = decideStartGate(makeHealth({ level: "medium" }));
    expect(gate.mayStart).toBe(false);
    if (!gate.mayStart) {
      expect(gate.level).toBe("medium");
      expect(gate.reason).toBe("browser-auth-visual-verification-required");
    }
  });

  it("LOW with emptyState: mayStart=true", () => {
    const gate = decideStartGate(makeHealth({ level: "low", emptyState: true }));
    expect(gate).toEqual({ mayStart: true, reason: "browser-not-running" });
  });

  it("LOW without emptyState: mayStart=false (conflicting signals)", () => {
    const gate = decideStartGate(makeHealth({ level: "low", emptyState: false }));
    expect(gate.mayStart).toBe(false);
    if (!gate.mayStart) {
      expect(gate.level).toBe("low");
      expect(gate.reason).toBe("browser-auth-conflict");
    }
  });
});

describe("ensureChromeMcpAvailable spawn gate", () => {
  beforeEach(async () => {
    await resetChromeMcpSessionsForTest();
  });

  afterEach(() => {
    setBrowserAuthSignalProbesForTest(null);
  });

  it("refuses to spawn when confidence is HIGH (browser already attached)", async () => {
    let spawned = false;
    const factory: ChromeMcpSessionFactory = async () => {
      spawned = true;
      return createFakeSession();
    };
    setChromeMcpSessionFactoryForTest(factory);
    setBrowserAuthSignalProbesForTest({
      fileProbe: async () => ({
        enabled: true,
        toggleEnabled: true,
        port: 50211,
        browserUuid: "abc",
        portListening: true,
        portFileMtimeMs: Date.now(),
        reason: "devtools-active-port-detected",
      }),
      portOwnerProbe: async () => ({
        kind: "chrome",
        process: "Google Chrome",
        pid: 37121,
        reason: "lsof-chrome-listener",
      }),
      jsonVersionProbe: async () => ({ ok: true, reason: "chrome-json-version" }),
    });

    await expect(
      ensureChromeMcpAvailable("chrome-live", { userDataDir: "/tmp/chrome-fake" }),
    ).rejects.toThrow(/already attached/);
    expect(spawned).toBe(false);
  });

  it("refuses to spawn when confidence is MEDIUM (visual verifier required)", async () => {
    let spawned = false;
    const factory: ChromeMcpSessionFactory = async () => {
      spawned = true;
      return createFakeSession();
    };
    setChromeMcpSessionFactoryForTest(factory);
    setBrowserAuthSignalProbesForTest({
      fileProbe: async () => ({
        enabled: true,
        toggleEnabled: true,
        port: 50211,
        browserUuid: "abc",
        portListening: true,
        portFileMtimeMs: Date.now(),
        reason: "devtools-active-port-detected",
      }),
      portOwnerProbe: async () => ({ kind: "unknown", reason: "lsof-timeout" }),
    });

    await expect(
      ensureChromeMcpAvailable("chrome-live", { userDataDir: "/tmp/chrome-fake" }),
    ).rejects.toThrow(/uncertain|visual confirmation/i);
    expect(spawned).toBe(false);
  });

  it("refuses to spawn when LOW signals conflict (e.g. non-chrome process owns the port)", async () => {
    let spawned = false;
    const factory: ChromeMcpSessionFactory = async () => {
      spawned = true;
      return createFakeSession();
    };
    setChromeMcpSessionFactoryForTest(factory);
    setBrowserAuthSignalProbesForTest({
      fileProbe: async () => ({
        enabled: true,
        toggleEnabled: true,
        port: 50211,
        browserUuid: "abc",
        portListening: true,
        portFileMtimeMs: Date.now(),
        reason: "devtools-active-port-detected",
      }),
      portOwnerProbe: async (): Promise<ChromePortOwnerSignal> => ({
        kind: "other",
        process: "node",
        pid: 999,
        reason: "lsof-non-chrome-listener",
      }),
    });

    await expect(
      ensureChromeMcpAvailable("chrome-live", { userDataDir: "/tmp/chrome-fake" }),
    ).rejects.toThrow(/conflict|signals conflict/i);
    expect(spawned).toBe(false);
  });

  it("permits spawn when LOW with emptyState (Chrome not running)", async () => {
    let spawned = 0;
    const factory: ChromeMcpSessionFactory = async () => {
      spawned += 1;
      return createFakeSession();
    };
    setChromeMcpSessionFactoryForTest(factory);
    setBrowserAuthSignalProbesForTest({
      fileProbe: async () => ({
        enabled: false,
        toggleEnabled: false,
        port: null,
        browserUuid: null,
        portListening: false,
        portFileMtimeMs: null,
        reason: "user-enabled-false",
      }),
      portOwnerProbe: async () => ({ kind: "none", reason: "lsof-no-listener" }),
    });

    await ensureChromeMcpAvailable("chrome-live", { userDataDir: "/tmp/chrome-fake" });
    expect(spawned).toBe(1);
  });
});

describe("BrowserAuthVisualVerifier extension point", () => {
  afterEach(() => {
    setBrowserAuthVisualVerifier(null);
  });

  it("accepts a typed verifier registration without affecting decideStartGate", () => {
    setBrowserAuthVisualVerifier({
      checkConsentModal: async () => ({ present: false, reason: "stub" }),
      checkAutomationBanner: async () => ({ present: false, reason: "stub" }),
    });
    // The verifier is a plumbing point; decideStartGate remains synchronous
    // and conservative until the verifier is consulted by a future caller.
    const gate = decideStartGate({
      level: "medium",
      attached: false,
      mcpPid: null,
      port: 50211,
      browserUuid: null,
      reasons: [],
      emptyState: false,
      cacheAttached: false,
    });
    expect(gate.mayStart).toBe(false);
  });
});

describe("formatStartGateBlockedMessage", () => {
  it("includes the per-signal reasons when present", () => {
    const message = formatStartGateBlockedMessage(
      "chrome-live",
      {
        level: "medium",
        attached: false,
        mcpPid: null,
        port: 50211,
        browserUuid: null,
        reasons: ["file:devtools-active-port-detected", "owner:lsof-timeout"],
        emptyState: false,
        cacheAttached: false,
      },
      {
        mayStart: false,
        reason: "browser-auth-visual-verification-required",
        level: "medium",
      },
    );
    expect(message).toContain("chrome-live");
    expect(message).toContain("Visual confirmation");
    expect(message).toContain("file:devtools-active-port-detected");
    expect(message).toContain("owner:lsof-timeout");
  });
});
