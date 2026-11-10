import assert from "node:assert/strict";
import { wrapToolWithBeforeToolCallHook } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  createTerminalPresentationContractTool,
  textToolResult,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import {
  AuthStorage,
  createEventBus,
  createExtensionRuntime,
  ExtensionRunner,
  loadExtensionFromFactory,
  ModelRegistry,
  SessionManager,
} from "openclaw/plugin-sdk/agent-sessions";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentToolResultMiddleware,
  AgentToolResultMiddlewareEvent,
} from "../plugins/agent-tool-result-middleware-types.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import {
  consumeAdjustedParamsForToolCall,
  recordAdjustedParamsForToolCall,
} from "./agent-tools.before-tool-call.js";
import { wrapReadToolWithSkillContent } from "./agent-tools.read.js";
import { buildEmbeddedExtensionFactories } from "./embedded-agent-runner/extensions.js";
import { consumeEmbeddedToolReceipt } from "./embedded-agent-runner/tool-send-receipts.js";
import { reparentSkillInstructionDelivery } from "./skill-instruction-result.js";
import { cleanupTempPluginTestEnvironment } from "./test-helpers/temp-plugin-extension-fixtures.js";
import { jsonResult } from "./tools/common.js";

const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const skillInstructionPath = "/skills/pond/SKILL.md";
const skillInstructionText = "# Pond\ncomplete instructions";

afterEach(() => {
  cleanupTempPluginTestEnvironment([], originalBundledPluginsDir);
});

function installMiddleware(handler: AgentToolResultMiddleware) {
  const registry = createEmptyPluginRegistry();
  registry.agentToolResultMiddlewares.push({
    pluginId: "test",
    pluginName: "test",
    rawHandler: handler,
    handler,
    runtimes: ["openclaw"],
    source: "test",
  });
  setActivePluginRegistry(registry);
}

type FactoryOverrides = Partial<Parameters<typeof buildEmbeddedExtensionFactories>[0]>;
function createFactory(overrides: FactoryOverrides = {}) {
  return buildEmbeddedExtensionFactories({
    cfg: undefined,
    workspaceDir: "/workspace",
    sessionManager: overrides.sessionManager ?? SessionManager.inMemory(),
    model: undefined,
    ...overrides,
  })[0];
}

async function createToolResultRunner(overrides: FactoryOverrides = {}) {
  const sessionManager = SessionManager.inMemory();
  const factory = createFactory({ sessionManager, ...overrides });
  assert(factory, "Expected embedded tool-result extension factory");
  const runtime = createExtensionRuntime();
  const extension = await loadExtensionFromFactory(factory, "/tmp", createEventBus(), runtime);
  const models = ModelRegistry.inMemory(AuthStorage.inMemory());
  return new ExtensionRunner([extension], runtime, "/tmp", sessionManager, models);
}

async function createToolResultHandler(overrides: FactoryOverrides = {}) {
  const factory = createFactory(overrides);
  const handlers = new Map<string, Function>();
  await factory?.({
    on(event: string, handler: Function) {
      handlers.set(event, handler);
    },
  } as never);
  return (event: unknown) => handlers.get("tool_result")?.(event, { cwd: "/tmp" });
}

async function createTerminalRun(
  suffix: string,
  format: Parameters<typeof createTerminalPresentationContractTool>[0]["format"],
) {
  const runId = `run-terminal-${suffix}`;
  const toolCallId = `call-terminal-${suffix}`;
  const input = { url: "https://private.example" };
  const onToolOutcome = vi.fn();
  const tool = wrapToolWithBeforeToolCallHook(
    createTerminalPresentationContractTool({
      name: "web_fetch",
      result: textToolResult("raw output", { origin: "private.example", status: 200 }),
      format,
    }),
    { runId, sessionId: `session-terminal-${suffix}`, onToolOutcome },
  );
  const rawResult = await tool.execute(toolCallId, input, undefined, undefined);
  const handler = await createToolResultHandler({ runId });
  return {
    runId,
    toolCallId,
    expectPresentation: (terminalPresentation: string | undefined) =>
      expect(onToolOutcome).toHaveBeenLastCalledWith(
        expect.objectContaining({ presentationOnly: true, terminalPresentation }),
      ),
    emit: () =>
      handler({
        toolName: "web_fetch",
        toolCallId,
        input: { url: "https://private.example" },
        content: rawResult.content,
        details: rawResult.details,
      }),
  };
}

describe("buildEmbeddedExtensionFactories", () => {
  it("passes the prepared run identity to installed result middleware", async () => {
    const identity = {
      agentId: "main",
      sessionId: "session-normal",
      sessionKey: "agent:main:discord:channel:normal",
      runId: "run-normal",
    };
    const middleware = vi.fn((event: AgentToolResultMiddlewareEvent) => ({
      result: {
        ...textToolResult("middleware-observed", { observedTool: event.toolName }),
        terminate: true,
      },
    }));
    installMiddleware(middleware);

    const runner = await createToolResultRunner(identity);
    const result = await runner.emitToolResult({
      type: "tool_result",
      toolName: "read",
      toolCallId: `${identity.runId}-read`,
      input: { path: "README.md" },
      ...textToolResult("original tool output", {}),
      isError: false,
    });

    expect(middleware).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        toolName: "read",
        toolCallId: `${identity.runId}-read`,
        args: { path: "README.md" },
      }),
      { runtime: "openclaw", ...identity },
    );
    expect(result).toMatchObject({
      ...textToolResult("middleware-observed", { observedTool: "read" }),
      terminate: true,
    });
  });

  it("bridges middleware mutations with unique fallback tool call ids", async () => {
    const seenToolCallIds: string[] = [];
    installMiddleware((event) => {
      seenToolCallIds.push(event.toolCallId);
      event.result.content = textToolResult(`compacted ${seenToolCallIds.length}`, {}).content;
      return undefined;
    });

    const handler = await createToolResultHandler();

    const first = await handler({ toolName: "exec", ...textToolResult("raw 1") });
    const second = await handler({ toolName: "exec", ...textToolResult("raw 2") });

    expect(first).toEqual(textToolResult("compacted 1", {}));
    expect(second).toEqual(textToolResult("compacted 2", {}));
    const generatedId = expect.stringMatching(/^openclaw-/);
    expect(seenToolCallIds).toEqual([generatedId, generatedId]);
    expect(seenToolCallIds[0]).not.toBe(seenToolCallIds[1]);
  });

  it("finalizes terminal presentation from the post-middleware result", async () => {
    const seenMiddlewareArgs: unknown[] = [];
    installMiddleware((event) => {
      seenMiddlewareArgs.push(structuredClone(event.args));
      (event.args as { url?: string }).url = "https://mutated.example";
      return {
        result: textToolResult("redacted output", { origin: "redacted.example", status: 200 }),
      };
    });
    const terminal = await createTerminalRun("middleware", (params, result) => {
      const input = params as { url?: string };
      const details = result.details as { origin?: string; status?: number };
      return `URL: ${String(input.url)}\nOrigin: ${String(details.origin)}\nStatus: ${String(details.status)}`;
    });
    recordAdjustedParamsForToolCall(
      terminal.toolCallId,
      { url: "https://approved.example" },
      terminal.runId,
    );
    await terminal.emit();

    terminal.expectPresentation(
      "URL: https://private.example\nOrigin: redacted.example\nStatus: 200",
    );
    expect(seenMiddlewareArgs).toEqual([{ url: "https://approved.example" }]);
    expect(
      consumeAdjustedParamsForToolCall("call-terminal-middleware", "run-terminal-middleware"),
    ).toEqual({ url: "https://approved.example" });
  });

  it("clears terminal presentation when middleware blocks the result", async () => {
    installMiddleware(() => ({
      result: textToolResult("blocked by middleware", {
        status: "blocked",
        reason: "policy denied",
      }),
    }));
    const terminal = await createTerminalRun("blocked", () => "Origin: private.example");
    const result = await terminal.emit();

    expect(result).toMatchObject({ isError: true });
    terminal.expectPresentation(undefined);
  });

  it.each([false, true])(
    "preserves private delivery receipts when middleware fails=%s",
    async (fails) => {
      installMiddleware((event) => {
        if (fails) {
          throw new Error("redaction failed");
        }
        return { result: { content: event.result.content, details: { redacted: true } } };
      });
      const receipt = {
        toolSend: { to: "channel:resolved-id", threadId: "root-1" },
        messageDelivery: {
          status: "settled",
          primaryPlatformMessageId: "message-1",
          partialDelivery: false,
          createdThreadIds: ["root-1"],
        },
      };
      const sessionManager = SessionManager.inMemory();
      const handler = await createToolResultHandler({ sessionManager });

      const result = await handler({
        toolName: "message",
        toolCallId: "call-message",
        input: { action: "send", target: "C123" },
        ...textToolResult(
          fails ? "raw result must stay private" : "Sent.",
          structuredClone(receipt),
        ),
      });

      expect(result).toEqual(
        fails
          ? textToolResult("Message delivered, but result post-processing failed.", {
              ok: true,
              deliveryStatus: "sent",
              middlewareWarning: "post-processing failed",
            })
          : textToolResult("Sent.", { redacted: true }),
      );
      expect(consumeEmbeddedToolReceipt(sessionManager, "call-message")).toEqual({
        details: receipt,
      });
      expect(consumeEmbeddedToolReceipt(sessionManager, "call-message")).toBeUndefined();
    },
  );

  it.each([false, true])(
    "clears a spawn error only with the full acceptance contract: complete=%s",
    async (complete) => {
      setActivePluginRegistry(createEmptyPluginRegistry());
      const runner = await createToolResultRunner();
      const payload = jsonResult({
        status: "accepted",
        ...(complete ? { childSessionKey: "agent:watcher:subagent:abc", runId: "run-123" } : {}),
      });
      const result = await runner.emitToolResult({
        type: "tool_result",
        toolName: "sessions_spawn",
        toolCallId: "call-spawn",
        input: {},
        ...payload,
        isError: true,
      });
      expect(result).toEqual(complete ? { ...payload, isError: false } : undefined);
    },
  );

  function createSkillRead(deliveryCache: Map<string, Promise<boolean>>, runId: string) {
    return wrapReadToolWithSkillContent(
      {
        name: "read",
        label: "read",
        description: "read a file",
        parameters: Type.Object({ path: Type.String() }),
        execute: async () => ({
          content: [{ type: "text" as const, text: skillInstructionText }],
          details: { kind: "text" as const, content: skillInstructionText },
        }),
      },
      [{ filePath: skillInstructionPath }],
      { instructionDeliveryCache: deliveryCache, runId },
    );
  }

  it.each([
    ["shortened", "# Pond"],
    ["intact", "# Pond\ncomplete instructions"],
  ])(
    "drops the whole-read skill cache only when middleware shortened the copy: %s",
    async (label, deliveredText) => {
      const shortened = deliveredText !== skillInstructionText;
      installMiddleware(() => ({
        result: textToolResult(deliveredText, { kind: "text" as const, content: deliveredText }),
      }));
      const deliveryCache = new Map<string, Promise<boolean>>();
      const runId = `run-skill-${label}`;
      const cachedRead = createSkillRead(deliveryCache, runId);
      const toolCallId = `call-skill-${label}`;
      const served = await cachedRead.execute(toolCallId, { path: skillInstructionPath });
      expect(deliveryCache.size).toBe(1);

      const handler = await createToolResultHandler({ runId });
      await handler({
        toolName: "read",
        toolCallId,
        input: { path: skillInstructionPath },
        content: served.content,
        details: served.details,
      });

      expect(deliveryCache.size).toBe(shortened ? 0 : 1);
      // The reconciliation only matters through the next read: a shortened copy is
      // served whole again, an intact one keeps deduping.
      const reread = await cachedRead.execute(`call-skill-reread-${label}`, {
        path: skillInstructionPath,
      });
      const rereadText = reread.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
      if (shortened) {
        expect(rereadText).toBe(skillInstructionText);
      } else {
        expect(rereadText).toContain("already served whole");
      }
    },
  );

  it("keeps delivery records scoped to the attempt that served them", async () => {
    const shortenedText = "# Pond";
    installMiddleware(() => ({
      result: textToolResult(shortenedText, { kind: "text" as const, content: shortenedText }),
    }));
    // Provider tool-call ids are only unique per response: both attempts may use call_1.
    const cacheA = new Map<string, Promise<boolean>>();
    const cacheB = new Map<string, Promise<boolean>>();
    const readA = createSkillRead(cacheA, "run-scope-a");
    const readB = createSkillRead(cacheB, "run-scope-b");
    await readA.execute("call_1", { path: skillInstructionPath });
    await readB.execute("call_1", { path: skillInstructionPath });

    const handler = await createToolResultHandler({ runId: "run-scope-a" });
    await handler({
      toolName: "read",
      toolCallId: "call_1",
      input: { path: skillInstructionPath },
      content: [{ type: "text" as const, text: skillInstructionText }],
      details: { kind: "text" as const, content: skillInstructionText },
    });

    // Only the attempt whose copy was shortened loses its cache entry.
    expect(cacheA.size).toBe(0);
    expect(cacheB.size).toBe(1);
  });

  // A Code Mode script prints the copy it read, so the exec output carries it verbatim.
  it.each([
    ["shortened", 'console.log("# Pond")', 0],
    ["intact", `console.log(${skillInstructionText})`, 1],
  ])(
    "reconciles a nested read against the exec result that carried it: %s",
    async (label, deliveredText, expectedSize) => {
      installMiddleware(() => ({
        result: textToolResult(deliveredText, { kind: "text" as const, content: deliveredText }),
      }));
      const deliveryCache = new Map<string, Promise<boolean>>();
      const runId = `run-code-mode-${label}`;
      const nestedRead = createSkillRead(deliveryCache, runId);
      await nestedRead.execute("call-nested", { path: skillInstructionPath });
      expect(deliveryCache.size).toBe(1);

      // Code Mode reports the read under the outer exec call, so the delivery moves there.
      reparentSkillInstructionDelivery({
        runId,
        nestedToolCallId: "call-nested",
        parentToolCallId: "call-exec",
      });
      const handler = await createToolResultHandler({ runId });
      await handler({
        toolName: "exec",
        toolCallId: "call-exec",
        input: {},
        content: [{ type: "text" as const, text: skillInstructionText }],
        details: { kind: "text" as const, content: skillInstructionText },
      });

      expect(deliveryCache.size).toBe(expectedSize);
    },
  );
});
