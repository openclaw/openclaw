import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

type AppWindow = Window &
  typeof globalThis & {
    loadDetail?: (id: string, options: { background: boolean }) => Promise<void>;
  };
type JsdomInstance = {
  window: AppWindow;
};
type RpcMessage = {
  error?: unknown;
  id?: unknown;
  jsonrpc?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
};

const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (
    html?: string,
    options?: {
      beforeParse?: (window: AppWindow) => void;
      runScripts?: "dangerously";
      url?: string;
    },
  ) => JsdomInstance;
};
const appHtml = fs.readFileSync(
  path.join(import.meta.dirname, "assets/openclaw-session-app.html"),
  "utf8",
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the MCP Apps message exchange");
    }
    await sleep(10);
  }
}

describe("OpenClaw Codex session app runtime", () => {
  it("loads the mixed session collection once and renders configured agents", async () => {
    const host = new JSDOM("", { url: "https://codex.test/" });
    const outbound: Array<RpcMessage> = [];
    const postToApp = (message: RpcMessage) => {
      if (!app) {
        throw new Error("Session app is not ready");
      }
      app.window.dispatchEvent(
        new app.window.MessageEvent("message", {
          data: message,
          source: host.window,
        }),
      );
    };

    host.window.addEventListener("message", (event) => {
      if (!isRecord(event.data)) {
        return;
      }
      const message: RpcMessage = event.data;
      outbound.push(message);
      if (message.method === "ui/initialize" && typeof message.id === "number") {
        postToApp({ jsonrpc: "2.0", id: message.id, result: {} });
      } else if (message.method === "tools/call" && typeof message.id === "number") {
        postToApp({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            structuredContent: {
              items: [],
              agents: [{ id: "ops", title: "Operations" }],
              capabilities: { list: true, create: true },
            },
          },
        });
      }
    });

    const app = new JSDOM(appHtml, {
      url: "https://openclaw.test/",
      runScripts: "dangerously",
      beforeParse(window) {
        Object.defineProperty(window, "parent", { value: host.window });
      },
    });

    try {
      await waitFor(() => outbound.some((message) => message.method === "tools/call"));
      await waitFor(
        () => app?.window.document.querySelectorAll("#agent-select option").length === 2,
      );

      const calls = outbound.filter((message) => message.method === "tools/call");
      expect(calls).toEqual([
        expect.objectContaining({
          params: {
            name: "openclaw_sessions_list",
            arguments: { limit: 100 },
          },
        }),
      ]);
      expect(
        app.window.document.querySelector("#agent-select option[value='ops']")?.textContent,
      ).toBe("Operations");
    } finally {
      app.window.close();
      host.window.close();
    }
  });

  it("acknowledges resource teardown and cancels deferred tool calls", async () => {
    const host = new JSDOM("", { url: "https://codex.test/" });
    const outbound: Array<RpcMessage> = [];
    const teardownId = "teardown-1";
    const postToApp = (message: RpcMessage) => {
      if (!app) {
        throw new Error("Session app is not ready");
      }
      app.window.dispatchEvent(
        new app.window.MessageEvent("message", {
          data: message,
          source: host.window,
        }),
      );
    };

    host.window.addEventListener("message", (event) => {
      if (!isRecord(event.data)) {
        return;
      }
      const message: RpcMessage = event.data;
      outbound.push(message);
      if (message.method === "ui/initialize" && typeof message.id === "number") {
        postToApp({
          jsonrpc: "2.0",
          id: message.id,
          result: { hostContext: { theme: "light" } },
        });
      } else if (message.method === "ui/notifications/initialized") {
        postToApp({
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: { structuredContent: { capabilities: { list: true } } },
        });
        postToApp({
          jsonrpc: "2.0",
          id: teardownId,
          method: "ui/resource-teardown",
        });
      }
    });

    const app = new JSDOM(appHtml, {
      url: "https://openclaw.test/",
      runScripts: "dangerously",
      beforeParse(window) {
        Object.defineProperty(window, "parent", { value: host.window });
      },
    });

    try {
      await waitFor(() => outbound.some((message) => message.id === teardownId));
      await sleep(400);

      expect(outbound).toContainEqual({ jsonrpc: "2.0", id: teardownId, result: {} });
      expect(outbound.some((message) => message.method === "tools/call")).toBe(false);
    } finally {
      app.window.close();
      host.window.close();
    }
  });

  it("ignores stale detail responses and preserves unchanged transcript nodes", async () => {
    const host = new JSDOM("", { url: "https://codex.test/" });
    const outbound: Array<RpcMessage> = [];
    const postToApp = (message: RpcMessage) => {
      if (!app) {
        throw new Error("Session app is not ready");
      }
      app.window.dispatchEvent(
        new app.window.MessageEvent("message", {
          data: message,
          source: host.window,
        }),
      );
    };
    const sessions = [
      {
        id: "session-a",
        agentId: "main",
        title: "Alpha",
        status: "idle",
        archived: false,
      },
      {
        id: "session-b",
        agentId: "research",
        title: "Beta",
        status: "idle",
        archived: false,
      },
    ];

    host.window.addEventListener("message", (event) => {
      if (!isRecord(event.data)) {
        return;
      }
      const message: RpcMessage = event.data;
      outbound.push(message);
      if (message.method === "ui/initialize" && typeof message.id === "number") {
        postToApp({ jsonrpc: "2.0", id: message.id, result: {} });
      } else if (
        message.method === "tools/call" &&
        typeof message.id === "number" &&
        isRecord(message.params) &&
        message.params.name === "openclaw_sessions_list"
      ) {
        postToApp({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            structuredContent: {
              items: sessions,
              agents: [{ id: "research", title: "Research" }],
              capabilities: { list: true, read: true, send: true, abort: true, update: true },
            },
          },
        });
      }
    });

    const app = new JSDOM(appHtml, {
      url: "https://openclaw.test/",
      runScripts: "dangerously",
      beforeParse(window) {
        Object.defineProperty(window, "parent", { value: host.window });
      },
    });

    try {
      await waitFor(() => app?.window.document.querySelectorAll(".session-row").length === 2);

      postToApp({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-input",
        params: { arguments: { session_id: "session-a", chrome: "detail" } },
      });
      const rowFor = (title: string) =>
        [...app!.window.document.querySelectorAll<HTMLButtonElement>(".session-row")].find(
          (row) => row.querySelector(".session-title")?.textContent === title,
        );
      rowFor("Alpha")?.click();
      rowFor("Beta")?.click();

      await waitFor(
        () =>
          outbound.filter(
            (message) =>
              message.method === "tools/call" &&
              isRecord(message.params) &&
              message.params.name === "openclaw_session_detail",
          ).length === 2,
      );
      const detailCalls = outbound.filter(
        (message) =>
          message.method === "tools/call" &&
          isRecord(message.params) &&
          message.params.name === "openclaw_session_detail",
      );
      const callFor = (id: string) =>
        detailCalls.find(
          (message) =>
            isRecord(message.params) &&
            isRecord(message.params.arguments) &&
            message.params.arguments.session_id === id,
        );
      const betaMessages = [{ id: "beta-user", role: "user", text: "Keep Beta selected" }];
      postToApp({
        jsonrpc: "2.0",
        id: callFor("session-b")?.id,
        result: {
          structuredContent: {
            session: sessions[1],
            messages: betaMessages,
            capabilities: { list: true, read: true, send: true, abort: true, update: true },
          },
        },
      });
      await waitFor(
        () => app?.window.document.querySelector("#conversation-title")?.textContent === "Beta",
      );
      const originalMessage = app.window.document.querySelector(".message");
      expect(originalMessage?.getAttribute("aria-label")).toBe("Message from You");

      postToApp({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: {
          structuredContent: {
            session: sessions[0],
            messages: [{ id: "late-host-alpha", role: "assistant", text: "Late host Alpha" }],
            capabilities: { list: true, read: true, send: true, abort: true, update: true },
          },
        },
      });
      expect(app.window.document.querySelector("#conversation-title")?.textContent).toBe("Beta");
      expect(app.window.document.querySelector(".message")).toBe(originalMessage);

      postToApp({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-input",
        params: { arguments: { session_id: "session-b", chrome: "detail" } },
      });
      postToApp({
        jsonrpc: "2.0",
        id: callFor("session-a")?.id,
        result: {
          structuredContent: {
            session: sessions[0],
            messages: [{ id: "alpha-user", role: "user", text: "Stale Alpha" }],
            capabilities: { list: true, read: true, send: true, abort: true, update: true },
          },
        },
      });
      await sleep(20);

      expect(app.window.document.querySelector("#conversation-title")?.textContent).toBe("Beta");
      expect(app.window.document.querySelector(".message")).toBe(originalMessage);

      postToApp({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: {
          structuredContent: {
            session: sessions[1],
            messages: betaMessages,
            capabilities: { list: true, read: true, send: true, abort: true, update: true },
          },
        },
      });
      expect(app.window.document.querySelector(".message")).toBe(originalMessage);

      const confirmedMessages = [
        ...betaMessages,
        { id: "beta-assistant", role: "assistant", text: "Still on Beta" },
      ];
      postToApp({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: {
          structuredContent: {
            session: sessions[1],
            messages: confirmedMessages,
            capabilities: { list: true, read: true, send: true, abort: true, update: true },
          },
        },
      });
      expect(app.window.document.querySelector(".message")).toBe(originalMessage);
      expect(
        [...app.window.document.querySelectorAll(".message")].map((message) => ({
          label: message.getAttribute("aria-label"),
          text: message.querySelector(".message-content")?.textContent,
        })),
      ).toEqual([
        { label: "Message from You", text: "Keep Beta selected" },
        { label: "Message from Research", text: "Still on Beta" },
      ]);

      const message = app.window.document.querySelector<HTMLTextAreaElement>("#message");
      const composer = app.window.document.querySelector<HTMLFormElement>("#composer");
      if (!message || !composer) {
        throw new Error("Session composer did not render");
      }
      message.value = "This optimistic message will fail";
      composer.dispatchEvent(new app.window.Event("submit", { bubbles: true, cancelable: true }));
      await waitFor(() =>
        outbound.some(
          (entry) =>
            entry.method === "tools/call" &&
            isRecord(entry.params) &&
            entry.params.name === "openclaw_session_send",
        ),
      );
      expect(app.window.document.querySelector<HTMLButtonElement>("#stop")?.hidden).toBe(false);
      const sendCall = outbound.find(
        (entry) =>
          entry.method === "tools/call" &&
          isRecord(entry.params) &&
          entry.params.name === "openclaw_session_send",
      );
      expect(sendCall?.params).toMatchObject({
        arguments: {
          session_id: "session-b",
          text: "This optimistic message will fail",
          operation_id: expect.any(String),
        },
      });
      message.value = "A newer draft";
      message.dispatchEvent(new app.window.Event("input", { bubbles: true }));
      postToApp({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: {
          structuredContent: {
            session: sessions[1],
            messages: [
              ...confirmedMessages,
              {
                id: "beta-confirmed",
                role: "assistant",
                text: "A server-confirmed update",
              },
            ],
            capabilities: { list: true, read: true, send: true, abort: true },
          },
        },
      });
      postToApp({
        jsonrpc: "2.0",
        id: sendCall?.id,
        error: { code: -32000, message: "Gateway unavailable" },
      });
      await waitFor(
        () =>
          app?.window.document.querySelector("#stale-copy")?.textContent?.includes("offline") ===
          true,
      );

      expect(
        [...app.window.document.querySelectorAll(".message-content")].map(
          (content) => content.textContent,
        ),
      ).toEqual(["Keep Beta selected", "Still on Beta", "A server-confirmed update"]);
      expect(app.window.document.querySelector<HTMLButtonElement>("#stop")?.hidden).toBe(true);
      expect(message.value).toBe("A newer draft");

      const callsFor = (name: string) =>
        outbound.filter(
          (entry) =>
            entry.method === "tools/call" && isRecord(entry.params) && entry.params.name === name,
        );
      const listCallsBeforeUpdate = callsFor("openclaw_sessions_list").length;
      const archive = app.window.document.querySelector<HTMLButtonElement>("#archive");
      archive?.click();
      await waitFor(() => callsFor("openclaw_session_update").length === 1);
      rowFor("Alpha")?.click();
      await waitFor(() => callsFor("openclaw_session_detail").length === 3);
      const latestAlphaDetail = callsFor("openclaw_session_detail").at(-1);
      postToApp({
        jsonrpc: "2.0",
        id: latestAlphaDetail?.id,
        result: {
          structuredContent: {
            session: sessions[0],
            messages: [{ id: "fresh-alpha", role: "assistant", text: "Fresh Alpha" }],
            capabilities: { list: true, read: true, send: true, abort: true, update: true },
          },
        },
      });
      await waitFor(
        () => app?.window.document.querySelector("#conversation-title")?.textContent === "Alpha",
      );
      postToApp({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-input",
        params: { arguments: { session_id: sessions[0].id, chrome: "detail" } },
      });
      postToApp({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: {
          structuredContent: {
            error: { code: "rejected" },
          },
        },
      });
      expect(app.window.document.querySelector("#stale-copy")?.textContent).toBe(
        "OpenClaw rejected that action.",
      );
      postToApp({
        jsonrpc: "2.0",
        id: callsFor("openclaw_session_update")[0]?.id,
        error: { code: -32000, message: "Gateway unavailable" },
      });
      await waitFor(() => archive?.disabled === false);

      expect(app.window.document.querySelector("#conversation-title")?.textContent).toBe("Alpha");
      expect(app.window.document.querySelector(".message-content")?.textContent).toBe(
        "Fresh Alpha",
      );
      expect(app.window.document.querySelector("#stale-copy")?.textContent).toBe(
        "OpenClaw rejected that action.",
      );
      expect(callsFor("openclaw_sessions_list")).toHaveLength(listCallsBeforeUpdate);

      rowFor("Beta")?.click();
      await waitFor(() => callsFor("openclaw_session_detail").length === 4);
      const foregroundBetaDetail = callsFor("openclaw_session_detail").at(-1);
      if (!app.window.loadDetail) {
        throw new Error("Session detail loader did not initialize");
      }
      void app.window.loadDetail("session-b", { background: true });
      await sleep(10);

      expect(callsFor("openclaw_session_detail")).toHaveLength(4);
      postToApp({
        jsonrpc: "2.0",
        id: foregroundBetaDetail?.id,
        result: {
          structuredContent: {
            session: sessions[1],
            messages: [{ id: "beta-unlocked", role: "assistant", text: "Beta unlocked" }],
            capabilities: { list: true, read: true, send: true, abort: true, update: true },
          },
        },
      });
      await waitFor(
        () => app?.window.document.querySelector<HTMLButtonElement>("#send")?.disabled === false,
      );
    } finally {
      app.window.close();
      host.window.close();
    }
  });

  it("renders configured agents and safely handles failed mutations", async () => {
    const host = new JSDOM("", { url: "https://codex.test/" });
    const outbound: Array<RpcMessage> = [];
    const icon = "data:image/png;base64,AA==";
    const partialSession = {
      id: "partial-session",
      agentId: "ops",
      title: "Created after failed first message",
      status: "idle",
      archived: false,
    };
    const delayedSession = {
      id: "delayed-session",
      agentId: "ops",
      title: "Delayed created session",
      status: "idle",
      archived: false,
    };
    const controlSession = {
      id: "control-session",
      agentId: "ops",
      title: "Control session",
      status: "working",
      archived: false,
    };
    const lostSession = {
      id: "lost-session",
      agentId: "ops",
      title: "Recovered lost create",
      status: "idle",
      archived: false,
    };
    const writableCapabilities = {
      list: true,
      read: true,
      create: true,
      send: true,
      abort: true,
      update: true,
    };
    let includePartialSession = false;
    let includeLostSession = false;
    let lostCreateAttempts = 0;
    const postToApp = (message: RpcMessage) => {
      if (!app) {
        throw new Error("Session app is not ready");
      }
      app.window.dispatchEvent(
        new app.window.MessageEvent("message", {
          data: message,
          source: host.window,
        }),
      );
    };

    host.window.addEventListener("message", (event) => {
      if (!isRecord(event.data)) {
        return;
      }
      const message: RpcMessage = event.data;
      outbound.push(message);
      if (message.method === "ui/initialize" && typeof message.id === "number") {
        postToApp({ jsonrpc: "2.0", id: message.id, result: {} });
      } else if (
        message.method === "tools/call" &&
        typeof message.id === "number" &&
        isRecord(message.params)
      ) {
        if (message.params.name === "openclaw_sessions_list") {
          postToApp({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              structuredContent: {
                items: [
                  ...(includePartialSession ? [partialSession] : []),
                  ...(includeLostSession ? [lostSession] : []),
                ],
                agents: [{ id: "ops", title: "Operations", icon: { src: icon, fallback: "O" } }],
                capabilities: writableCapabilities,
              },
            },
          });
        } else if (message.params.name === "openclaw_session_create") {
          const initialMessage = isRecord(message.params.arguments)
            ? message.params.arguments.message
            : null;
          if (initialMessage === "Delayed create") {
            return;
          }
          if (initialMessage === "Lost create") {
            lostCreateAttempts += 1;
            if (lostCreateAttempts < 3) {
              return;
            }
            includeLostSession = true;
            postToApp({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                structuredContent: {
                  session: lostSession,
                  capabilities: writableCapabilities,
                },
              },
            });
            return;
          }
          if (initialMessage === "Retry the first message") {
            includePartialSession = true;
            postToApp({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                structuredContent: {
                  session: partialSession,
                  capabilities: writableCapabilities,
                  initial_message_status: "failed",
                  runError: "private gateway failure details",
                },
              },
            });
          } else {
            postToApp({
              jsonrpc: "2.0",
              id: message.id,
              result: { structuredContent: { error: { code: "rejected" } }, isError: true },
            });
          }
        } else if (message.params.name === "openclaw_session_detail") {
          const sessionId = isRecord(message.params.arguments)
            ? message.params.arguments.session_id
            : null;
          postToApp({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              structuredContent: {
                session: sessionId === lostSession.id ? lostSession : partialSession,
                messages: [],
                capabilities: writableCapabilities,
              },
            },
          });
        } else if (message.params.name === "openclaw_session_send") {
          postToApp({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              structuredContent: {
                session: partialSession,
                capabilities: writableCapabilities,
              },
            },
          });
        }
      }
    });

    const app = new JSDOM(appHtml, {
      url: "https://openclaw.test/",
      runScripts: "dangerously",
      beforeParse(window) {
        const realSetTimeout = window.setTimeout.bind(window);
        Object.defineProperty(window, "setTimeout", {
          configurable: true,
          value: (handler: () => void, delay?: number) =>
            realSetTimeout(handler, delay === 20_000 ? 20 : delay === 190_000 ? 100 : delay),
        });
        Object.defineProperty(window, "parent", { value: host.window });
      },
    });

    try {
      await waitFor(
        () => app?.window.document.querySelectorAll("#agent-select option").length === 2,
      );
      const select = app.window.document.querySelector<HTMLSelectElement>("#agent-select");
      if (!select) {
        throw new Error("Agent selector did not render");
      }
      select.value = "ops";
      select.dispatchEvent(new app.window.Event("change", { bubbles: true }));

      expect(
        app.window.document.querySelector<HTMLImageElement>("#agent-picker-avatar img")?.src,
      ).toBe(icon);
      app.window.document.querySelector<HTMLButtonElement>("#new-session")?.click();
      const message = app.window.document.querySelector<HTMLTextAreaElement>("#message");
      const composer = app.window.document.querySelector<HTMLFormElement>("#composer");
      if (!message || !composer) {
        throw new Error("Session composer did not render");
      }
      const toolCalls = (name: string) =>
        outbound.filter(
          (entry) =>
            entry.method === "tools/call" && isRecord(entry.params) && entry.params.name === name,
        );
      const operationIdForCall = (entry: RpcMessage | undefined) =>
        isRecord(entry?.params) &&
        isRecord(entry.params.arguments) &&
        typeof entry.params.arguments.operation_id === "string"
          ? entry.params.arguments.operation_id
          : null;
      message.value = "Recover the preview";
      composer.dispatchEvent(new app.window.Event("submit", { bubbles: true, cancelable: true }));

      await waitFor(() =>
        outbound.some(
          (entry) =>
            entry.method === "tools/call" &&
            isRecord(entry.params) &&
            entry.params.name === "openclaw_session_create",
        ),
      );
      const createCall = outbound.find(
        (entry) =>
          entry.method === "tools/call" &&
          isRecord(entry.params) &&
          entry.params.name === "openclaw_session_create",
      );
      expect(createCall?.params).toMatchObject({
        arguments: {
          agent_id: "ops",
          message: "Recover the preview",
          operation_id: expect.any(String),
        },
      });
      await waitFor(
        () => app?.window.document.querySelector("#stale-banner")?.hasAttribute("hidden") === false,
      );
      expect(app.window.document.querySelector("#stale-copy")?.textContent).toBe(
        "OpenClaw rejected that action.",
      );
      expect(message.value).toBe("Recover the preview");

      const controlCapabilities = writableCapabilities;
      app.window.document.querySelector<HTMLButtonElement>("#new-session")?.click();
      message.value = "Delayed create";
      composer.dispatchEvent(new app.window.Event("submit", { bubbles: true, cancelable: true }));
      await waitFor(() => toolCalls("openclaw_session_create").length === 2);
      await sleep(40);

      expect(message.value).toBe("");
      expect(app.window.document.querySelector<HTMLButtonElement>("#send")?.disabled).toBe(true);
      expect(
        [...app.window.document.querySelectorAll(".session-title")].filter(
          (title) => title.textContent === delayedSession.title,
        ),
      ).toHaveLength(0);
      postToApp({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-input",
        params: { arguments: { session_id: controlSession.id, chrome: "detail" } },
      });
      postToApp({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: {
          structuredContent: {
            session: controlSession,
            messages: [{ id: "control-message", role: "assistant", text: "Control transcript" }],
            capabilities: controlCapabilities,
          },
        },
      });
      await waitFor(
        () =>
          app?.window.document.querySelector("#conversation-title")?.textContent ===
          "Control session",
      );
      const delayedCreateCall = toolCalls("openclaw_session_create").find(
        (entry) =>
          isRecord(entry.params) &&
          isRecord(entry.params.arguments) &&
          entry.params.arguments.message === "Delayed create",
      );
      postToApp({
        jsonrpc: "2.0",
        id: delayedCreateCall?.id,
        result: {
          structuredContent: {
            session: delayedSession,
            capabilities: writableCapabilities,
            initial_message_status: "failed",
            runError: "private delayed failure",
          },
        },
      });
      await waitFor(
        () => app?.window.document.querySelector<HTMLButtonElement>("#send")?.disabled === false,
      );
      expect(app.window.document.querySelector("#conversation-title")?.textContent).toBe(
        "Control session",
      );
      expect(app.window.document.querySelector(".message-content")?.textContent).toBe(
        "Control transcript",
      );
      expect(app.window.document.querySelector("#stale-copy")?.textContent).toBe(
        "OpenClaw rejected that action.",
      );
      expect(app.window.document.body.textContent).not.toContain("private delayed failure");
      expect(
        [...app.window.document.querySelectorAll(".session-title")].filter(
          (title) => title.textContent === delayedSession.title,
        ),
      ).toHaveLength(1);
      const initialListCalls = toolCalls("openclaw_sessions_list").length;

      const stop = app.window.document.querySelector<HTMLButtonElement>("#stop");
      stop?.click();
      await waitFor(() => toolCalls("openclaw_session_abort").length === 1);
      expect(stop?.disabled).toBe(true);
      postToApp({
        jsonrpc: "2.0",
        id: toolCalls("openclaw_session_abort")[0]?.id,
        result: { structuredContent: { error: { code: "rejected" } }, isError: true },
      });
      await waitFor(() => stop?.disabled === false);
      expect(toolCalls("openclaw_session_detail")).toHaveLength(0);

      const archive = app.window.document.querySelector<HTMLButtonElement>("#archive");
      archive?.click();
      await waitFor(() =>
        toolCalls("openclaw_session_update").some(
          (entry) =>
            isRecord(entry.params) &&
            isRecord(entry.params.arguments) &&
            entry.params.arguments.archived === true,
        ),
      );
      expect(archive?.disabled).toBe(true);
      const archiveCall = toolCalls("openclaw_session_update").find(
        (entry) =>
          isRecord(entry.params) &&
          isRecord(entry.params.arguments) &&
          entry.params.arguments.archived === true,
      );
      postToApp({
        jsonrpc: "2.0",
        id: archiveCall?.id,
        error: { code: -32000, message: "Gateway unavailable" },
      });
      await waitFor(() => archive?.disabled === false);
      expect(app.window.document.querySelector("#stale-copy")?.textContent).toContain("offline");
      expect(toolCalls("openclaw_sessions_list")).toHaveLength(initialListCalls);

      app.window.document.querySelector<HTMLButtonElement>("#new-session")?.click();
      message.value = "Retry the first message";
      composer.dispatchEvent(new app.window.Event("submit", { bubbles: true, cancelable: true }));
      await waitFor(() => toolCalls("openclaw_session_create").length === 3);
      await waitFor(
        () =>
          app?.window.document.querySelector("#conversation-title")?.textContent ===
          "Created after failed first message",
      );
      await waitFor(() => message.value === "Retry the first message");

      expect(message.value).toBe("Retry the first message");
      expect(app.window.document.querySelector("#stale-copy")?.textContent).toBe(
        "The session was created, but OpenClaw could not start the first message. Edit and retry it below.",
      );
      expect(app.window.document.querySelector(".message")).toBeNull();
      expect(app.window.document.body.textContent).not.toContain("private gateway failure details");
      const partialCreateCall = toolCalls("openclaw_session_create").find(
        (entry) =>
          isRecord(entry.params) &&
          isRecord(entry.params.arguments) &&
          entry.params.arguments.message === "Retry the first message",
      );
      composer.dispatchEvent(new app.window.Event("submit", { bubbles: true, cancelable: true }));
      await waitFor(() => toolCalls("openclaw_session_send").length === 1);
      expect(operationIdForCall(toolCalls("openclaw_session_send")[0])).toBe(
        operationIdForCall(partialCreateCall),
      );
      await waitFor(
        () => app?.window.document.querySelector<HTMLButtonElement>("#send")?.disabled === false,
      );
      expect(message.value).toBe("");
      const listCallsBeforeRestore = toolCalls("openclaw_sessions_list").length;

      postToApp({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-input",
        params: { arguments: { session_id: controlSession.id, chrome: "detail" } },
      });
      postToApp({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: {
          structuredContent: {
            session: { ...controlSession, status: "idle", archived: true },
            messages: [],
            capabilities: controlCapabilities,
          },
        },
      });
      const restore = app.window.document.querySelector<HTMLButtonElement>("#restore");
      await waitFor(() => restore?.closest("#restore-bar")?.hasAttribute("hidden") === false);
      restore?.click();
      await waitFor(() =>
        toolCalls("openclaw_session_update").some(
          (entry) =>
            isRecord(entry.params) &&
            isRecord(entry.params.arguments) &&
            entry.params.arguments.archived === false,
        ),
      );
      expect(restore?.disabled).toBe(true);
      const restoreCall = toolCalls("openclaw_session_update").find(
        (entry) =>
          isRecord(entry.params) &&
          isRecord(entry.params.arguments) &&
          entry.params.arguments.archived === false,
      );
      postToApp({
        jsonrpc: "2.0",
        id: restoreCall?.id,
        result: { structuredContent: { error: { code: "conflict" } }, isError: true },
      });
      await waitFor(() => restore?.disabled === false);
      expect(app.window.document.querySelector("#stale-copy")?.textContent).toBe(
        "The session changed. Refresh and try again.",
      );
      expect(toolCalls("openclaw_sessions_list")).toHaveLength(listCallsBeforeRestore);

      app.window.document.querySelector<HTMLButtonElement>("#new-session")?.click();
      message.value = "Lost create";
      composer.dispatchEvent(new app.window.Event("submit", { bubbles: true, cancelable: true }));
      const lostCreateCalls = () =>
        toolCalls("openclaw_session_create").filter(
          (entry) =>
            isRecord(entry.params) &&
            isRecord(entry.params.arguments) &&
            entry.params.arguments.message === "Lost create",
        );
      await waitFor(() => lostCreateCalls().length === 1);
      await waitFor(() => message.value === "Lost create");

      composer.dispatchEvent(new app.window.Event("submit", { bubbles: true, cancelable: true }));
      await waitFor(() => lostCreateCalls().length === 2);
      await waitFor(() => message.value === "Lost create");
      const firstOperationId = operationIdForCall(lostCreateCalls()[0]);
      const secondOperationId = operationIdForCall(lostCreateCalls()[1]);
      expect(firstOperationId).toEqual(expect.any(String));
      expect(secondOperationId).toBe(firstOperationId);

      message.value = "Lost create with edit";
      message.dispatchEvent(new app.window.Event("input", { bubbles: true }));
      message.value = "Lost create";
      message.dispatchEvent(new app.window.Event("input", { bubbles: true }));
      composer.dispatchEvent(new app.window.Event("submit", { bubbles: true, cancelable: true }));
      await waitFor(() => lostCreateCalls().length === 3);
      const thirdOperationId = operationIdForCall(lostCreateCalls()[2]);
      expect(thirdOperationId).toEqual(expect.any(String));
      expect(thirdOperationId).not.toBe(firstOperationId);
      await waitFor(
        () =>
          app?.window.document.querySelector("#conversation-title")?.textContent ===
          lostSession.title,
      );
      expect(message.value).toBe("");
      expect(
        [...app.window.document.querySelectorAll(".session-title")].filter(
          (title) => title.textContent === lostSession.title,
        ),
      ).toHaveLength(1);
    } finally {
      app.window.close();
      host.window.close();
    }
  });
});
