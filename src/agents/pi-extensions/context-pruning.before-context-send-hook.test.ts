import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
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

function makeToolResult(params: {
  toolCallId: string;
  toolName: string;
  text: string;
}): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: params.toolCallId,
    toolName: params.toolName,
    content: [{ type: "text", text: params.text }],
    isError: false,
    timestamp: Date.now(),
  };
}

afterEach(() => {
  resetGlobalHookRunner();
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

  it("allows plugin to filter messages via before_context_send hook", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ctx-send-"));
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";

    // Plugin that removes all toolResult messages (simulating dedup/purge)
    const pluginFile = writeTempPlugin({
      dir: tmp,
      id: "ctx-filter",
      body: `export default { id: "ctx-filter", register(api) {
  api.on("before_context_send", (event) => {
    const filtered = event.messages.filter(m => m.role !== "toolResult");
    return { messages: filtered };
  });
} };`,
    });

    loadOpenClawPlugins({
      cache: false,
      workspaceDir: tmp,
      config: {
        plugins: {
          load: { paths: [pluginFile] },
          allow: ["ctx-filter"],
        },
      },
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
      makeAssistant("calling tool"),
      makeToolResult({ toolCallId: "t1", toolName: "read", text: "file content" }),
      makeUser("thanks"),
      makeAssistant("done"),
    ];

    // No pruning runtime → pruner is skipped, but hook should still fire
    const result = handler({ messages }, {
      model: undefined,
      sessionManager: {},
    } as unknown as ExtensionContext);

    expect(result).toBeTruthy();
    expect(result!.messages).toHaveLength(4); // toolResult removed
    expect(result!.messages.every((m) => m.role !== "toolResult")).toBe(true);
  });

  it("composes multiple before_context_send handlers in priority order", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ctx-compose-"));
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";

    // Plugin A (priority 10): adds a marker user message at the end
    const pluginA = writeTempPlugin({
      dir: tmp,
      id: "ctx-a",
      body: `export default { id: "ctx-a", register(api) {
  api.on("before_context_send", (event) => {
    return { messages: [...event.messages, { role: "user", content: "marker-a", timestamp: Date.now() }] };
  }, { priority: 10 });
} };`,
    });

    // Plugin B (priority 5): adds another marker
    const pluginB = writeTempPlugin({
      dir: tmp,
      id: "ctx-b",
      body: `export default { id: "ctx-b", register(api) {
  api.on("before_context_send", (event) => {
    return { messages: [...event.messages, { role: "user", content: "marker-b", timestamp: Date.now() }] };
  }, { priority: 5 });
} };`,
    });

    loadOpenClawPlugins({
      cache: false,
      workspaceDir: tmp,
      config: {
        plugins: {
          load: { paths: [pluginA, pluginB] },
          allow: ["ctx-a", "ctx-b"],
        },
      },
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

    const messages: AgentMessage[] = [makeUser("hello")];

    const result = handler({ messages }, {
      model: undefined,
      sessionManager: {},
    } as unknown as ExtensionContext);

    expect(result).toBeTruthy();
    // Original + marker-a (priority 10 first) + marker-b (priority 5 second)
    expect(result!.messages).toHaveLength(3);
    expect((result!.messages[1] as { content: string }).content).toBe("marker-a");
    expect((result!.messages[2] as { content: string }).content).toBe("marker-b");
  });
});
