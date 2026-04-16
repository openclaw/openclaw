import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, SessionManager, ToolResultEvent } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ExtensionRunner } from "../../../node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/runner.js";
import type { OpenClawConfig } from "../../config/config.js";
import { getCompactionSafeguardRuntime } from "../pi-hooks/compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "../pi-hooks/compaction-safeguard.js";
import contextPruningExtension from "../pi-hooks/context-pruning.js";
import { buildEmbeddedExtensionFactories, buildEmbeddedExtensionsOverride } from "./extensions.js";

vi.mock("../../plugins/provider-runtime.js", () => ({
  resolveProviderCacheTtlEligibility: () => undefined,
  resolveProviderRuntimePlugin: () => undefined,
}));

type ToolResultHandler = (event: ToolResultEvent) => unknown;
type ToolResultBridgeHookRunner = NonNullable<
  Parameters<typeof buildEmbeddedExtensionFactories>[0]["hookRunner"]
>;

function buildSafeguardFactories(cfg: OpenClawConfig) {
  const sessionManager = {} as SessionManager;
  const model = {
    id: "claude-sonnet-4-20250514",
    contextWindow: 200_000,
  } as Model<Api>;

  const factories = buildEmbeddedExtensionFactories({
    cfg,
    sessionManager,
    provider: "anthropic",
    modelId: "claude-sonnet-4-20250514",
    model,
  });

  return { factories, sessionManager };
}

function createToolResultBridgeHandlers(params: {
  hookRunner: ToolResultBridgeHookRunner;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
}): ToolResultHandler[] {
  const factories = buildEmbeddedExtensionFactories({
    cfg: undefined,
    sessionManager: {} as SessionManager,
    provider: "openai",
    modelId: "gpt-5.4",
    model: undefined,
    hookRunner: params.hookRunner,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    runId: params.runId,
  });
  expect(factories).toHaveLength(1);

  const handlers: ToolResultHandler[] = [];
  for (const factory of factories) {
    expect(factory).toBeTypeOf("function");
    const on = vi.fn();
    const api = {
      on,
    } as unknown as ExtensionAPI;
    void factory?.(api);

    const toolResultHandler = on.mock.calls.find(
      ([eventName]) => eventName === "tool_result",
    )?.[1] as ToolResultHandler | undefined;
    expect(toolResultHandler).toBeTypeOf("function");
    handlers.push(toolResultHandler as ToolResultHandler);
  }

  expect(handlers).toHaveLength(1);
  return handlers;
}

async function emitToolResultThroughRunner(
  event: ToolResultEvent,
  handlers: ToolResultHandler[],
): Promise<ToolResultEvent> {
  const extensions = handlers.map((handler, index) => ({
    path: `<test:${index + 1}>`,
    handlers: new Map([["tool_result", [handler]]]),
    tools: new Map(),
    commands: new Map(),
  }));
  const runner = new ExtensionRunner(
    extensions as never,
    {} as never,
    process.cwd(),
    {} as SessionManager,
    {} as never,
  );
  const emitted = await runner.emitToolResult(event);
  return {
    ...event,
    ...emitted,
  } as ToolResultEvent;
}

function createToolResultEvent(overrides: Partial<ToolResultEvent> = {}): ToolResultEvent {
  return {
    type: "tool_result",
    toolName: "read",
    toolCallId: "call_1",
    input: { path: "README.md" },
    content: [{ type: "text", text: "raw text" }],
    details: { big: "x".repeat(100) },
    isError: false,
    ...overrides,
  } as ToolResultEvent;
}

function getToolResultText(content: ToolResultEvent["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const [first] = content;
  return first &&
    typeof first === "object" &&
    (first as { type?: unknown }).type === "text" &&
    typeof (first as { text?: unknown }).text === "string"
    ? ((first as { text: string }).text ?? "")
    : "";
}

function expectSafeguardRuntime(
  cfg: OpenClawConfig,
  expectedRuntime: { qualityGuardEnabled: boolean; qualityGuardMaxRetries?: number },
) {
  const { factories, sessionManager } = buildSafeguardFactories(cfg);

  expect(factories).toContain(compactionSafeguardExtension);
  expect(getCompactionSafeguardRuntime(sessionManager)).toMatchObject(expectedRuntime);
}

describe("buildEmbeddedExtensionFactories", () => {
  it("does not opt safeguard mode into quality-guard retries", () => {
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            mode: "safeguard",
          },
        },
      },
    } as OpenClawConfig;
    expectSafeguardRuntime(cfg, {
      qualityGuardEnabled: false,
    });
  });

  it("wires explicit safeguard quality-guard runtime flags", () => {
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            mode: "safeguard",
            qualityGuard: {
              enabled: true,
              maxRetries: 2,
            },
          },
        },
      },
    } as OpenClawConfig;
    expectSafeguardRuntime(cfg, {
      qualityGuardEnabled: true,
      qualityGuardMaxRetries: 2,
    });
  });

  it("enables cache-ttl pruning for custom anthropic-messages providers", () => {
    const factories = buildEmbeddedExtensionFactories({
      cfg: {
        agents: {
          defaults: {
            contextPruning: {
              mode: "cache-ttl",
            },
          },
        },
      } as OpenClawConfig,
      sessionManager: {} as SessionManager,
      provider: "litellm",
      modelId: "claude-sonnet-4-6",
      model: { api: "anthropic-messages", contextWindow: 200_000 } as Model<Api>,
    });

    expect(factories).toContain(contextPruningExtension);
  });

  it("omits the canonical tool-result bridge when no hook is registered", () => {
    const factories = buildEmbeddedExtensionFactories({
      cfg: undefined,
      sessionManager: {} as SessionManager,
      provider: "openai",
      modelId: "gpt-5.4",
      model: undefined,
      hookRunner: {
        hasHooks: () => false,
        runToolResultBeforeModel: () => undefined,
      },
    });

    expect(factories).toEqual([]);
  });

  it("does not add an extensions override when the canonical bridge is absent", () => {
    const override = buildEmbeddedExtensionsOverride({
      hasToolResultBeforeModelBridge: false,
    });

    expect(override).toBeUndefined();
  });

  it("prioritizes the canonical tool-result bridge ahead of loaded extensions", () => {
    const override = buildEmbeddedExtensionsOverride({
      hasToolResultBeforeModelBridge: true,
    });

    const base = {
      extensions: [
        { path: "/tmp/ext-a", handlers: new Map(), tools: new Map(), commands: new Map() },
        { path: "<inline:1>", handlers: new Map(), tools: new Map(), commands: new Map() },
        { path: "<inline:2>", handlers: new Map(), tools: new Map(), commands: new Map() },
        { path: "<inline:3>", handlers: new Map(), tools: new Map(), commands: new Map() },
      ],
      runtime: {} as never,
      errors: [],
    } as never;

    const reordered = override?.(base);

    expect(reordered?.extensions.map((extension: { path: string }) => extension.path)).toEqual([
      "<inline:1>",
      "/tmp/ext-a",
      "<inline:2>",
      "<inline:3>",
    ]);
  });

  it("registers a tool_result bridge that canonicalizes same-turn results", () => {
    const hookRunner = {
      hasHooks: (hookName: string) => hookName === "tool_result_before_model",
      runToolResultBeforeModel: vi.fn(() => ({
        text: "canonical text",
      })),
    };
    const [captureToolResultHandler] = createToolResultBridgeHandlers({
      hookRunner,
      agentId: "main",
      sessionKey: "session-1",
      sessionId: "session-1-id",
      runId: "run-1",
    });
    const event = createToolResultEvent();
    const patch = captureToolResultHandler(event);

    expect(hookRunner.runToolResultBeforeModel).toHaveBeenCalledWith(
      {
        toolName: "read",
        toolCallId: "call_1",
        text: "raw text",
      },
      {
        agentId: "main",
        sessionKey: "session-1",
        sessionId: "session-1-id",
        runId: "run-1",
        toolName: "read",
        toolCallId: "call_1",
      },
    );
    expect(patch).toEqual({
      content: [{ type: "text", text: "canonical text" }],
    });
  });

  it("does not emit a tool_result patch for no-op canonical hooks", () => {
    const hookRunner = {
      hasHooks: (hookName: string) => hookName === "tool_result_before_model",
      runToolResultBeforeModel: vi.fn(() => undefined),
    };
    const [captureToolResultHandler] = createToolResultBridgeHandlers({
      hookRunner,
    });
    const event = createToolResultEvent({
      details: undefined,
    });
    const patch = captureToolResultHandler(event);

    expect(patch).toBeUndefined();
  });

  it("skips multi-block tool results", () => {
    const hookRunner = {
      hasHooks: (hookName: string) => hookName === "tool_result_before_model",
      runToolResultBeforeModel: vi.fn(),
    };
    const [captureToolResultHandler] = createToolResultBridgeHandlers({
      hookRunner,
    });

    const event = createToolResultEvent({
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    });
    expect(captureToolResultHandler(event)).toBeUndefined();
    expect(hookRunner.runToolResultBeforeModel).not.toHaveBeenCalled();
  });

  it("skips mixed text and non-text tool results", () => {
    const hookRunner = {
      hasHooks: (hookName: string) => hookName === "tool_result_before_model",
      runToolResultBeforeModel: vi.fn(),
    };
    const [captureToolResultHandler] = createToolResultBridgeHandlers({
      hookRunner,
    });

    const event = createToolResultEvent({
      content: [
        { type: "text", text: "raw text" },
        { type: "image", data: "abc", mimeType: "image/png" },
      ] as ToolResultEvent["content"],
    });
    expect(captureToolResultHandler(event)).toBeUndefined();
    expect(hookRunner.runToolResultBeforeModel).not.toHaveBeenCalled();
  });

  it("skips non-text tool results", () => {
    const hookRunner = {
      hasHooks: (hookName: string) => hookName === "tool_result_before_model",
      runToolResultBeforeModel: vi.fn(),
    };
    const [captureToolResultHandler] = createToolResultBridgeHandlers({
      hookRunner,
    });

    const event = createToolResultEvent({
      content: [
        { type: "image", data: "abc", mimeType: "image/png" },
      ] as ToolResultEvent["content"],
    });
    expect(captureToolResultHandler(event)).toBeUndefined();
    expect(hookRunner.runToolResultBeforeModel).not.toHaveBeenCalled();
  });

  it("normalizes string content returned by canonical hooks", () => {
    const hookRunner = {
      hasHooks: (hookName: string) => hookName === "tool_result_before_model",
      runToolResultBeforeModel: vi.fn(() => ({
        text: "canonical string",
      })),
    };
    const [captureToolResultHandler] = createToolResultBridgeHandlers({
      hookRunner,
    });

    const event = createToolResultEvent({
      details: undefined,
    });
    const patch = captureToolResultHandler(event);

    expect(patch).toEqual({
      content: [{ type: "text", text: "canonical string" }],
    });
  });

  it("ignores errored tool results at the canonicalization seam", () => {
    const hookRunner = {
      hasHooks: (hookName: string) => hookName === "tool_result_before_model",
      runToolResultBeforeModel: vi.fn(),
    };
    const [captureToolResultHandler] = createToolResultBridgeHandlers({
      hookRunner,
    });
    const event = createToolResultEvent({
      details: { error: "boom" },
      isError: true,
    });
    const patch = captureToolResultHandler(event);

    expect(patch).toBeUndefined();
    expect(hookRunner.runToolResultBeforeModel).not.toHaveBeenCalled();
  });

  it("later ordinary tool_result handlers observe canonical content before rewriting", async () => {
    const hookRunner = {
      hasHooks: (hookName: string) => hookName === "tool_result_before_model",
      runToolResultBeforeModel: vi.fn(() => ({
        text: "canonical text",
      })),
    };
    const bridgeHandlers = createToolResultBridgeHandlers({
      hookRunner,
    });
    let observedContent = "";
    const ordinaryHandler: ToolResultHandler = (event) => {
      observedContent = getToolResultText(event.content);
      return {
        content: [{ type: "text", text: "late overwrite" }],
      };
    };

    const finalEvent = await emitToolResultThroughRunner(createToolResultEvent(), [
      ...bridgeHandlers,
      ordinaryHandler,
    ]);

    expect(observedContent).toBe("canonical text");
    expect(finalEvent.content).toEqual([{ type: "text", text: "late overwrite" }]);
    expect(finalEvent.details).toEqual({ big: "x".repeat(100) });
  });

  it("preserves later ordinary tool_result content rewrites over canonical content", async () => {
    const hookRunner = {
      hasHooks: (hookName: string) => hookName === "tool_result_before_model",
      runToolResultBeforeModel: vi.fn(() => ({
        text: "canonical text",
      })),
    };
    const bridgeHandlers = createToolResultBridgeHandlers({
      hookRunner,
    });
    const ordinaryHandler: ToolResultHandler = () => ({
      content: [{ type: "text", text: "late overwrite" }],
      details: { summary: "late overwrite" },
    });

    const finalEvent = await emitToolResultThroughRunner(createToolResultEvent(), [
      ...bridgeHandlers,
      ordinaryHandler,
    ]);

    expect(finalEvent.content).toEqual([{ type: "text", text: "late overwrite" }]);
    expect(finalEvent.details).toEqual({ summary: "late overwrite" });
  });

  it("later ordinary tool_result handlers may still rewrite details", async () => {
    const hookRunner = {
      hasHooks: (hookName: string) => hookName === "tool_result_before_model",
      runToolResultBeforeModel: vi.fn(() => ({
        text: "canonical text",
      })),
    };
    const bridgeHandlers = createToolResultBridgeHandlers({
      hookRunner,
    });
    const ordinaryHandler: ToolResultHandler = () => ({
      details: { summary: "late overwrite" },
    });

    const finalEvent = await emitToolResultThroughRunner(createToolResultEvent(), [
      ...bridgeHandlers,
      ordinaryHandler,
    ]);

    expect(finalEvent.content).toEqual([{ type: "text", text: "canonical text" }]);
    expect(finalEvent.details).toEqual({ summary: "late overwrite" });
  });

  it("documents that later content reassignment without a returned patch is unsupported", async () => {
    const hookRunner = {
      hasHooks: (hookName: string) => hookName === "tool_result_before_model",
      runToolResultBeforeModel: vi.fn(() => undefined),
    };
    const bridgeHandlers = createToolResultBridgeHandlers({
      hookRunner,
    });
    const ordinaryHandler: ToolResultHandler = (event) => {
      event.content = [{ type: "text", text: "late reassignment" }];
      return undefined;
    };

    const finalEvent = await emitToolResultThroughRunner(createToolResultEvent(), [
      ...bridgeHandlers,
      ordinaryHandler,
    ]);

    // Without an explicit returned patch, ordinary tool_result content
    // reassignment is not a supported override path and the raw result wins.
    expect(finalEvent.content).toEqual([{ type: "text", text: "raw text" }]);
  });

  it("fails open when the canonical hook throws", async () => {
    const hookRunner = {
      hasHooks: (hookName: string) => hookName === "tool_result_before_model",
      runToolResultBeforeModel: vi.fn(() => {
        throw new Error("boom");
      }),
    };
    const bridgeHandlers = createToolResultBridgeHandlers({
      hookRunner,
    });

    const finalEvent = await emitToolResultThroughRunner(createToolResultEvent(), bridgeHandlers);

    expect(finalEvent.content).toEqual([{ type: "text", text: "raw text" }]);
    expect(finalEvent.details).toEqual({ big: "x".repeat(100) });
  });

  it("skips legacy string-backed tool results", async () => {
    const hookRunner = {
      hasHooks: (hookName: string) => hookName === "tool_result_before_model",
      runToolResultBeforeModel: vi.fn(({ text }) => ({
        text: `${text} [canonical]`,
      })),
    };
    const bridgeHandlers = createToolResultBridgeHandlers({
      hookRunner,
    });

    const finalEvent = await emitToolResultThroughRunner(
      createToolResultEvent({
        content: "raw string" as unknown as ToolResultEvent["content"],
        details: { big: "x".repeat(100) },
      }),
      bridgeHandlers,
    );

    expect(hookRunner.runToolResultBeforeModel).not.toHaveBeenCalled();
    expect(finalEvent.content).toBe("raw string");
    expect(finalEvent.details).toEqual({ big: "x".repeat(100) });
  });
});
