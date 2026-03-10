import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import { resetGlobalPluginRegistry } from "../../plugins/registry.js";
import { default as contextPruningExtension } from "./context-pruning/extension.js";

const EMPTY_PLUGIN_SCHEMA = { type: "object", additionalProperties: false, properties: {} };

function writeTempPlugin(params: { dir: string; id: string; body: string }): string {
  const pluginDir = path.join(params.dir, params.id);
  fs.mkdirSync(pluginDir, { recursive: true });
  const file = path.join(pluginDir, `${params.id}.mjs`);
  fs.writeFileSync(file, params.body, "utf-8");
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: params.id,
        configSchema: EMPTY_PLUGIN_SCHEMA,
      },
      null,
      2,
    ),
    "utf-8",
  );
  return file;
}

function makeUser(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() };
}

function makeAssistant(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "fake",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

afterEach(() => {
  resetGlobalPluginRegistry();
});

describe("before_context_send hook", () => {
  it("does not modify messages when no hook is registered", () => {
    let handler:
      | ((
          event: { messages: AgentMessage[] },
          ctx: ExtensionContext,
        ) => { messages: AgentMessage[] } | undefined)
      | undefined;

    const api = {
      on: (name: string, fn: unknown) => {
        if (name === "context") {
          handler = fn as typeof handler;
        }
      },
      appendEntry: (_type: string, _data?: unknown) => {},
    } as unknown as ExtensionAPI;

    contextPruningExtension(api);

    if (!handler) {
      throw new Error("missing context handler");
    }

    const messages: AgentMessage[] = [makeUser("hello"), makeAssistant("hi")];

    // No pruning runtime set, no hooks registered → should return undefined
    const result = handler({ messages }, {
      model: undefined,
      sessionManager: {},
    } as unknown as ExtensionContext);

    expect(result).toBeUndefined();
  });

  it("filters messages via before_context_send hook", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-test-"));

    try {
      writeTempPlugin({
        dir: tmpDir,
        id: "test-filter",
        body: `
          export default function(api) {
            api.on("before_context_send", (event) => {
              const filtered = event.messages.filter(m => {
                if (m.role === "user" && m.content === "secret") {
                  return false;
                }
                return true;
              });
              return { messages: filtered };
            });
          }
        `,
      });

      await loadOpenClawPlugins({
        pluginPaths: [tmpDir],
        config: {},
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      });

      let handler:
        | ((
            event: { messages: AgentMessage[] },
            ctx: ExtensionContext,
          ) => { messages: AgentMessage[] } | undefined)
        | undefined;

      const api = {
        on: (name: string, fn: unknown) => {
          if (name === "context") {
            handler = fn as typeof handler;
          }
        },
        appendEntry: (_type: string, _data?: unknown) => {},
      } as unknown as ExtensionAPI;

      contextPruningExtension(api);

      if (!handler) {
        throw new Error("missing context handler");
      }

      const messages: AgentMessage[] = [
        makeUser("hello"),
        makeAssistant("hi"),
        makeUser("secret"),
        makeAssistant("ok"),
      ];

      const result = handler({ messages }, {
        model: undefined,
        sessionManager: {},
      } as unknown as ExtensionContext);

      expect(result).toBeDefined();
      expect(result?.messages).toHaveLength(3);
      expect(result?.messages[0]).toEqual(messages[0]);
      expect(result?.messages[1]).toEqual(messages[1]);
      expect(result?.messages[2]).toEqual(messages[3]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("applies multiple hooks in priority order", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-test-"));

    try {
      writeTempPlugin({
        dir: tmpDir,
        id: "test-filter-a",
        body: `
          export default function(api) {
            api.on("before_context_send", (event) => {
              const modified = event.messages.map(m => {
                if (m.role === "user") {
                  return { ...m, content: m.content + "[A]" };
                }
                return m;
              });
              return { messages: modified };
            }, { priority: 10 });
          }
        `,
      });

      writeTempPlugin({
        dir: tmpDir,
        id: "test-filter-b",
        body: `
          export default function(api) {
            api.on("before_context_send", (event) => {
              const modified = event.messages.map(m => {
                if (m.role === "user") {
                  return { ...m, content: m.content + "[B]" };
                }
                return m;
              });
              return { messages: modified };
            }, { priority: 5 });
          }
        `,
      });

      await loadOpenClawPlugins({
        pluginPaths: [tmpDir],
        config: {},
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      });

      let handler:
        | ((
            event: { messages: AgentMessage[] },
            ctx: ExtensionContext,
          ) => { messages: AgentMessage[] } | undefined)
        | undefined;

      const api = {
        on: (name: string, fn: unknown) => {
          if (name === "context") {
            handler = fn as typeof handler;
          }
        },
        appendEntry: (_type: string, _data?: unknown) => {},
      } as unknown as ExtensionAPI;

      contextPruningExtension(api);

      if (!handler) {
        throw new Error("missing context handler");
      }

      const messages: AgentMessage[] = [makeUser("hello"), makeAssistant("hi")];

      const result = handler({ messages }, {
        model: undefined,
        sessionManager: {},
      } as unknown as ExtensionContext);

      expect(result).toBeDefined();
      expect(result?.messages).toHaveLength(2);
      // Priority 10 runs first (A), then priority 5 (B)
      expect(result?.messages[0].content).toBe("hello[A][B]");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
