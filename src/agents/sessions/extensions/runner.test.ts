import { expect, it, vi } from "vitest";
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
  ExtensionContext,
  ExtensionContextActions,
  ExtensionError,
} from "./types.js";

type TestHandler = (...args: unknown[]) => Promise<unknown>;
type TestHandlers = Record<string, TestHandler[]>;
type Invoke = (runner: ExtensionRunner) => Promise<unknown>;
type Spy = ReturnType<typeof vi.fn>;
const toolCall = { toolName: "custom", toolCallId: "call-1", input: {} };
const coreActions = {
  ...createExtensionRuntime(),
  appendEntryAsync: async () => "entry-fixture",
  setSessionNameAsync: async () => {},
  setLabelAsync: async () => {},
};

const contextActions: ExtensionContextActions = {
  getModel: () => undefined,
  isIdle: () => true,
  getSignal: () => undefined,
  abort: () => {},
  hasPendingMessages: () => false,
  shutdown: () => {},
  getContextUsage: () => undefined,
  compact: () => {},
  getSystemPrompt: () => "system",
};

function buildExtension(handlers: TestHandlers, path = "/tmp/test-extension.ts"): Extension {
  return { path, handlers: new Map(Object.entries(handlers)) } as Extension;
}

function buildRunner(...extensions: Extension[]): ExtensionRunner {
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
    ...groups.map((handlers, i) => buildExtension({ [event]: handlers }, `/tmp/${i}.ts`)),
  );
}

async function reject(error: Error): Promise<never> {
  throw error;
}

async function expectFatal(runner: ExtensionRunner, invoke: Invoke, failure: Error, later: Spy) {
  const report = vi.fn();
  runner.onError(report);
  await expect(invoke(runner)).rejects.toBe(failure);
  expect(later).not.toHaveBeenCalled();
  expect(report).not.toHaveBeenCalled();
}

const buildMessages = (): [AgentMessage, AgentMessage] =>
  [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
  ] as [AgentMessage, AgentMessage];

it("ExtensionRunner warns once for legacy binding; async binding stays silent", () => {
  const runner = buildRunner();
  using warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  runner.bindCoreAsync(coreActions, contextActions);
  expect(warning).not.toHaveBeenCalled();
  runner.bindCore(coreActions, contextActions);
  runner.bindCore(coreActions, contextActions);
  expect(warning).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("bindCoreAsync"),
    expect.objectContaining({ type: "DeprecationWarning" }),
  );
});

it("isolates caller messages while chaining replacements through a shared handler context", async () => {
  const messages = buildMessages();
  const replacement = [messages[0]];
  const final = [messages[1]];
  const contexts: unknown[] = [];
  const record: TestHandler = async (event, context) => {
    contexts.push(context);
    const current = (event as { messages: AgentMessage[] }).messages;
    if (contexts.length === 1) {
      current.push(messages[0]);
      expect(messages).toHaveLength(2);
      return undefined;
    }
    if (contexts.length === 2) {
      expect(current).toHaveLength(3);
      return { messages: replacement };
    }
    expect(current).toBe(replacement);
    return { messages: final };
  };
  const runner = buildHandlerRunner("context", [record], [record, record]);
  expect(await runner.emitContext(messages)).toBe(final);
  expect(contexts[0]).toBe(contexts[1]);
});

// Other adapters share dispatchHandlers; retain each distinct stop/continue path here.
const emitters = {
  tool_call: (runner) => runner.emitToolCall({ type: "tool_call", ...toolCall }),
  session_before_switch: (runner) => runner.emit({ type: "session_before_switch", reason: "new" }),
  message_end: (runner) =>
    runner.emitMessageEnd({ type: "message_end", message: buildMessages()[0] }),
  input: (runner) => runner.emitInput("hello", undefined, "interactive"),
} satisfies Record<string, Invoke>;

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
    const runner = buildRunner(extension, buildExtension({ session_before_switch: [later] }));
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

const metadataFailure = new SessionMetadataCommittedError(
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
it.each(
  Object.entries(emitters).flatMap(([event, invoke]) =>
    (event === "tool_call" ? [true] : [false, true]).map((fatal) => ({ event, invoke, fatal })),
  ),
)("$event fault dispatch (fatal=$fatal)", async ({ event, invoke, fatal }) => {
  const failure = fatal && event !== "tool_call" ? metadataFailure : new Error(`${event} failed`);
  const results = new Map<string, unknown>([
    ["session_before_switch", { cancel: true }],
    ["input", { action: "transform", text: "transformed" }],
    ["message_end", { message: buildMessages()[1] }],
  ]);
  const next = vi
    .fn()
    .mockImplementationOnce(async () => results.get(event))
    .mockImplementation(async (value: unknown) => {
      expect(value).toMatchObject(
        event === "input" ? { text: "transformed" } : { message: { role: "user" } },
      );
      return event === "input" ? { action: "handled" } : undefined;
    });
  const hasTail = event === "input" || event === "message_end";
  const nextHandlers: TestHandler[] = hasTail ? [next, next] : [next];
  if (event === "input" || event === "session_before_switch") {
    nextHandlers.push(() => reject(new Error("handler ran after cancellation")));
  }
  const runner = buildHandlerRunner(event, [() => reject(failure)], nextHandlers);
  const errors: ExtensionError[] = [];
  runner.onError((error) => errors.push(error));
  if (fatal) {
    await expectFatal(runner, invoke, failure, next);
    return;
  }
  await invoke(runner);
  expect(next).toHaveBeenCalledTimes(hasTail ? 2 : 1);
  expect(errors.map((error) => [error.extensionPath, error.event, error.error])).toEqual([
    ["/tmp/0.ts", event, failure.message],
    ...(event === "message_end"
      ? [["/tmp/1.ts", event, "message_end handlers must return a message with the same role"]]
      : []),
  ]);
});
const messageUpdate = {
  type: "message_update",
  message: buildMessages()[1],
  assistantMessageEvent: { type: "text_delta", delta: "hi", contentIndex: 0 },
} satisfies Parameters<ExtensionRunner["emit"]>[0];

it.each([false, true])("constructs context only for matching handlers=%s", async (matching) => {
  const failure = new Error("context construction failed");
  const runner = buildHandlerRunner(matching ? "message_update" : "user_bash", [
    async () => undefined,
  ]);
  vi.spyOn(runner, "createContext").mockImplementation(() => {
    throw failure;
  });
  const errors: unknown[] = [];
  runner.onError((error) => errors.push(error));
  const messages = buildMessages();
  expect(await runner.emitContext(messages)).toBe(messages);
  await runner.emitToolCall({ type: "tool_call", ...toolCall });
  if (matching) {
    await expect(runner.emit(messageUpdate)).rejects.toBe(failure);
  } else {
    await runner.emit(messageUpdate);
  }
  expect(errors).toEqual([]);
});

it("preserves supplied context identity and its evolving system prompt", async () => {
  const contexts: unknown[] = [];
  const prompts: string[] = [];
  const record: TestHandler = async (_event, value) => {
    const context = value as ExtensionContext;
    contexts.push(context);
    prompts.push(context.getSystemPrompt());
    return contexts.length === 1 ? { systemPrompt: "updated" } : undefined;
  };
  const runner = buildHandlerRunner("before_agent_start", [record, record]);
  await expect(
    runner.emitBeforeAgentStart("hello", undefined, "original", { cwd: "/tmp" }),
  ).resolves.toMatchObject({ systemPrompt: "updated" });

  expect(contexts[0]).toBe(contexts[1]);
  expect(prompts).toEqual(["original", "updated"]);
});

it("keeps lazy live context guards while retaining its captured model getter", () => {
  const runner = buildRunner();
  const secondGetModel = vi.fn(() => undefined);
  const context = runner.createContext();
  const commandContext = runner.createCommandContext();

  const updatedUi = { ...runner.getUIContext() };
  runner.setUIContext(updatedUi);
  runner.bindCore(coreActions, {
    ...contextActions,
    getModel: secondGetModel,
    isIdle: () => false,
  });

  expect(context.ui).toBe(updatedUi);
  expect(context).toMatchObject({ hasUI: true, model: undefined });
  expect(context.isIdle()).toBe(false);
  expect(secondGetModel).not.toHaveBeenCalled();

  runner.invalidate("session replaced");
  expect(() => context.ui).toThrow("session replaced");
  expect(() => context.isIdle()).toThrow("session replaced");
  expect(() => commandContext.cwd).toThrow("session replaced");
});
