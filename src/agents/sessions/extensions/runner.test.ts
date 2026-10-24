import { describe, expect, it, vi } from "vitest";
import {
  IncognitoSessionEndedError,
  IncognitoSessionSyncAccessError,
} from "../../../state/incognito-session-error.js";
import type { AgentMessage } from "../../runtime/index.js";
import { createEventBus } from "../event-bus.js";
import type { ModelRegistry } from "../model-registry.js";
import { SessionMetadataCommittedError } from "../session-manager-metadata-error.js";
import type { SessionManager } from "../session-manager.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "./loader.js";
import { ExtensionRunner } from "./runner.js";
import type {
  Extension,
  ExtensionAPI,
  ExtensionActions,
  ExtensionContext,
  ExtensionContextActions,
} from "./types.js";

type TestHandler = (...args: unknown[]) => Promise<unknown>;
type TestHandlers = Record<string, TestHandler[]>;
type Invoke = (runner: ExtensionRunner) => Promise<unknown>;
type Spy = ReturnType<typeof vi.fn>;
const toolCall = { toolName: "custom", toolCallId: "call-1", input: {} };

function buildContextActions(
  getModel: ExtensionContextActions["getModel"] = () => undefined,
  idle = true,
): ExtensionContextActions {
  return {
    getModel,
    isIdle: () => idle,
    getSignal: () => undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => "system",
  };
}

function buildExtension(handlers?: TestHandlers, path = "/tmp/test-extension.ts"): Extension {
  return {
    path,
    handlers: new Map(Object.entries(handlers ?? {})),
  } as Extension;
}

function buildRunner(extensions: Extension[]): ExtensionRunner {
  return new ExtensionRunner(
    extensions,
    createExtensionRuntime(),
    "/tmp",
    {} as SessionManager,
    {} as ModelRegistry,
  );
}

function buildHandlerRunner(event: string, ...groups: TestHandler[][]) {
  return buildRunner(
    groups.map((handlers, i) => buildExtension({ [event]: handlers }, `/tmp/${i}.ts`)),
  );
}

async function reject(error: Error): Promise<never> {
  throw error;
}

function buildFailureRunner(event: string, failure: Error, next: TestHandler[]) {
  const runner = buildRunner([
    buildExtension({ [event]: [() => reject(failure)] }, "/tmp/failing.ts"),
    buildExtension({ [event]: next }, "/tmp/next.ts"),
  ]);
  const errors: unknown[] = [];
  runner.onError((error) => errors.push(error));
  return { runner, errors };
}

async function expectFatal(runner: ExtensionRunner, invoke: Invoke, failure: Error, later: Spy) {
  const report = vi.fn();
  runner.onError(report);
  await expect(invoke(runner)).rejects.toBe(failure);
  expect(later).not.toHaveBeenCalled();
  expect(report).not.toHaveBeenCalled();
}

function buildMessages(): [AgentMessage, AgentMessage] {
  return [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
  ] as [AgentMessage, AgentMessage];
}

it("ExtensionRunner warns once for legacy binding; async binding stays silent", () => {
  const runner = buildRunner([]);
  const actions = {
    ...createExtensionRuntime(),
    appendEntryAsync: async () => "entry-fixture",
    setSessionNameAsync: async () => {},
    setLabelAsync: async () => {},
  };
  const contextActions = buildContextActions();
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  try {
    runner.bindCoreAsync(actions, contextActions);
    expect(warning).not.toHaveBeenCalled();
    runner.bindCore(actions, contextActions);
    runner.bindCore(actions, contextActions);
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(
        "ExtensionRunner.bindCore is deprecated; use bindCoreAsync with ExtensionActionsV2",
      ),
      expect.objectContaining({ type: "DeprecationWarning" }),
    );
    expect(warning.mock.calls[0]?.[0]).toContain("first January 2027 stable release");
  } finally {
    warning.mockRestore();
  }
});

describe("ExtensionRunner.emitContext", () => {
  it("keeps handler mutations isolated from the caller's messages", async () => {
    const messages = buildMessages();
    const runner = buildHandlerRunner("context", [
      async (event) => {
        (event as { messages: AgentMessage[] }).messages.push(buildMessages()[0]);
      },
    ]);
    const result = await runner.emitContext(messages);
    expect(result).toHaveLength(3);
    expect(messages).toHaveLength(2);
  });

  it("chains replacement messages through later context handlers", async () => {
    const [user, assistant] = buildMessages();
    const replacement = [user];
    const final = [assistant];
    const runner = buildHandlerRunner("context", [
      async () => ({ messages: replacement }),
      async (event) => {
        expect((event as { messages: AgentMessage[] }).messages).toBe(replacement);
        return { messages: final };
      },
    ]);
    expect(await runner.emitContext(buildMessages())).toBe(final);
  });
});

const emitters = {
  session_before_switch: (runner) => runner.emit({ type: "session_before_switch", reason: "new" }),
  message_end: (runner) =>
    runner.emitMessageEnd({ type: "message_end", message: buildMessages()[0] }),
  tool_result: (runner) =>
    runner.emitToolResult({
      type: "tool_result",
      ...toolCall,
      content: [],
      details: undefined,
      isError: false,
    }),
  user_bash: (runner) =>
    runner.emitUserBash({
      type: "user_bash",
      command: "pwd",
      cwd: "/tmp",
      excludeFromContext: false,
    }),
  context: (runner) => runner.emitContext(buildMessages()),
  before_provider_request: (runner) => runner.emitBeforeProviderRequest({}),
  before_agent_start: (runner) =>
    runner.emitBeforeAgentStart("hello", undefined, "system", { cwd: "/tmp" }),
  resources_discover: (runner) => runner.emitResourcesDiscover("/tmp", "startup"),
  input: (runner) => runner.emitInput("hello", undefined, "interactive"),
} satisfies Record<string, Invoke>;

describe("ExtensionRunner handler dispatch", () => {
  it.each([
    { method: "appendEntry", invoke: (api: ExtensionAPI) => api.appendEntry("fixture", {}) },
    { method: "setSessionName", invoke: (api: ExtensionAPI) => api.setSessionName("fixture") },
    { method: "setLabel", invoke: (api: ExtensionAPI) => api.setLabel("fixture", "label") },
  ] as const)("stops dispatch on legacy $method incognito errors", async ({ method, invoke }) => {
    for (const failure of [
      new IncognitoSessionSyncAccessError(method, `${method}Async`),
      new IncognitoSessionEndedError(),
    ]) {
      const runtime = createExtensionRuntime();
      runtime[method] = () => {
        throw failure;
      };
      const extension = await loadExtensionFromFactory(
        (api) => api.on("session_before_switch", () => invoke(api)),
        "/tmp",
        createEventBus(),
        runtime,
      );
      const later = vi.fn(async () => undefined);
      const runner = buildRunner([
        extension,
        buildExtension({ session_before_switch: [later] }, "/tmp/later.ts"),
      ]);
      await expectFatal(runner, emitters.session_before_switch, failure, later);
    }
  });

  it("preserves discovery order and source ownership across partial resource contributions", async () => {
    const runner = buildHandlerRunner(
      "resources_discover",
      [async () => ({ skillPaths: ["one", "two"], themePaths: [] })],
      [
        async () => undefined,
        async () => ({ skillPaths: ["three"], promptPaths: ["prompt"], themePaths: ["theme"] }),
      ],
    );
    expect(await runner.emitResourcesDiscover("/tmp", "reload")).toEqual({
      skillPaths: [
        { path: "one", extensionPath: "/tmp/0.ts" },
        { path: "two", extensionPath: "/tmp/0.ts" },
        { path: "three", extensionPath: "/tmp/1.ts" },
      ],
      promptPaths: [{ path: "prompt", extensionPath: "/tmp/1.ts" }],
      themePaths: [{ path: "theme", extensionPath: "/tmp/1.ts" }],
    });
  });

  it.each(Object.entries(emitters))("metadata faults stop %s dispatch", async (event, invoke) => {
    const failure = new SessionMetadataCommittedError(
      {
        type: "thinking_level_change",
        id: "committed-thinking",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        thinkingLevel: "high",
      },
      { generation: "fixture", rawSeq: 1, updatedAt: 1 },
      new Error("view read failed"),
    );
    const later = vi.fn(async () => undefined);
    const { runner } = buildFailureRunner(event, failure, [later]);
    await expectFatal(runner, invoke, failure, later);
  });

  it.each(Object.entries(emitters))(
    "isolates %s faults with source attribution",
    async (event, invoke) => {
      const failure = new Error(`${event} failed`);
      const results = new Map<string, unknown>([
        ["session_before_switch", { cancel: true }],
        ["input", { action: "transform", text: "transformed" }],
        ["message_end", { message: buildMessages()[1] }],
      ]);
      const next = vi.fn(async () => results.get(event));
      const tail = vi.fn(async (value: unknown) => {
        expect(value).toMatchObject(
          event === "input" ? { text: "transformed" } : { message: { role: "user" } },
        );
        return event === "input" ? { action: "handled" } : undefined;
      });
      const unreachable = vi.fn(async () => undefined);
      const hasTail = event === "input" || event === "message_end";
      const nextHandlers = [next, ...(hasTail ? [tail] : [])];
      if (event === "input" || event === "session_before_switch") {
        nextHandlers.push(unreachable);
      }
      const { runner, errors } = buildFailureRunner(event, failure, nextHandlers);
      await invoke(runner);
      expect(next).toHaveBeenCalledOnce();
      expect(tail).toHaveBeenCalledTimes(Number(hasTail));
      expect(unreachable).not.toHaveBeenCalled();
      const expectedErrors: unknown[] = [
        {
          extensionPath: "/tmp/failing.ts",
          event,
          error: failure.message,
          stack: failure.stack,
        },
      ];
      if (event === "message_end") {
        expectedErrors.push({
          extensionPath: "/tmp/next.ts",
          event,
          error: "message_end handlers must return a message with the same role",
        });
      }
      expect(errors).toEqual(expectedErrors);
    },
  );

  it("lets tool_call handler failures escape and blocks later handlers", async () => {
    const failure = new Error("block tool execution");
    const laterHandler = vi.fn(async () => undefined);
    const runner = buildHandlerRunner("tool_call", [() => reject(failure), laterHandler]);
    await expect(runner.emitToolCall({ type: "tool_call", ...toolCall })).rejects.toBe(failure);
    expect(laterHandler).not.toHaveBeenCalled();
  });
});

describe("ExtensionRunner context construction", () => {
  const messageUpdate = {
    type: "message_update",
    message: buildMessages()[1],
    assistantMessageEvent: { type: "text_delta", delta: "hi", contentIndex: 0 },
  } satisfies Parameters<ExtensionRunner["emit"]>[0];

  it.each([false, true])("skips context work with unrelated handlers=%s", async (unrelated) => {
    const runner = buildRunner(
      unrelated ? [buildExtension({ user_bash: [async () => undefined] })] : [],
    );
    const createContext = vi.spyOn(runner, "createContext");
    const messages = buildMessages();
    expect(await runner.emitContext(messages)).toBe(messages);
    await runner.emitToolCall({ type: "tool_call", ...toolCall });
    await runner.emit(messageUpdate);
    await runner.emit({
      type: "tool_execution_update",
      toolCallId: "call-1",
      toolName: "custom",
      args: {},
      partialResult: {},
    });
    expect(createContext).not.toHaveBeenCalled();
  });

  it("shares one context across matching streaming handlers", async () => {
    const contexts: unknown[] = [];
    const record: TestHandler = async (_event, context) => void contexts.push(context);
    const runner = buildHandlerRunner("message_update", [record], [record]);
    const createContext = vi.spyOn(runner, "createContext");
    await runner.emit(messageUpdate);
    expect(createContext).toHaveBeenCalledOnce();
    expect(contexts).toHaveLength(2);
    expect(contexts[0]).toBe(contexts[1]);
  });

  it("propagates context construction failures outside extension handler isolation", async () => {
    const failure = new Error("context construction failed");
    const runner = buildHandlerRunner("message_update", [async () => undefined]);
    vi.spyOn(runner, "createContext").mockImplementation(() => {
      throw failure;
    });
    const errors: unknown[] = [];
    runner.onError((error) => errors.push(error));
    await expect(runner.emit(messageUpdate)).rejects.toBe(failure);
    expect(errors).toEqual([]);
  });

  it("preserves supplied context identity and its evolving system prompt", async () => {
    const contexts: ExtensionContext[] = [];
    const prompts: string[] = [];
    const record: TestHandler = async (_event, value) => {
      const context = value as ExtensionContext;
      contexts.push(context);
      prompts.push(context.getSystemPrompt());
      return contexts.length === 1 ? { systemPrompt: "updated" } : undefined;
    };
    const runner = buildHandlerRunner("before_agent_start", [record, record]);
    const createContext = vi.spyOn(runner, "createContext");
    await expect(
      runner.emitBeforeAgentStart("hello", undefined, "original", { cwd: "/tmp" }),
    ).resolves.toMatchObject({ systemPrompt: "updated" });

    expect(createContext).toHaveBeenCalledOnce();
    expect(contexts[0]).toBe(contexts[1]);
    expect(prompts).toEqual(["original", "updated"]);
  });

  it("keeps lazy live context guards while retaining its captured model getter", () => {
    const runner = buildRunner([]);
    const firstGetModel = vi.fn(() => undefined);
    const secondGetModel = vi.fn(() => undefined);
    runner.bindCore({} as ExtensionActions, buildContextActions(firstGetModel));
    const context = runner.createContext();
    const commandContext = runner.createCommandContext();
    expect(typeof Object.getOwnPropertyDescriptor(context, "ui")?.get).toBe("function");
    expect(typeof Object.getOwnPropertyDescriptor(commandContext, "ui")?.get).toBe("function");

    const updatedUi = { ...runner.getUIContext() };
    runner.setUIContext(updatedUi);
    runner.bindCore({} as ExtensionActions, buildContextActions(secondGetModel, false));

    expect(context.ui).toBe(updatedUi);
    const { hasUI, model } = context;
    expect({ hasUI, model }).toEqual({ hasUI: true, model: undefined });
    expect(context.isIdle()).toBe(false);
    expect(firstGetModel).toHaveBeenCalledOnce();
    expect(secondGetModel).not.toHaveBeenCalled();

    runner.invalidate("session replaced");
    expect(() => context.ui).toThrow("session replaced");
    expect(() => context.isIdle()).toThrow("session replaced");
    expect(() => commandContext.cwd).toThrow("session replaced");
  });
});
