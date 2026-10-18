import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  createSubagentSpawnTestConfig,
  loadSubagentSpawnModuleForTest,
} from "./subagents/spawn/subagent-spawn.test-helpers.js";

type GatewayRequest = { method?: string; params?: Record<string, unknown> };
type TestBindingRequest = {
  targetSessionKey: string;
  targetKind?: string;
  conversation: {
    channel: string;
    accountId?: string;
    conversationId: string;
    parentConversationId?: string;
  };
  placement: "current" | "child";
  metadata?: Record<string, unknown>;
};

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  configOverride: {} as Record<string, unknown>,
  updateSessionStoreMock: vi.fn(),
}));

const hookRunnerMocks = vi.hoisted(() => ({
  hasSubagentEndedHook: true,
  runSubagentSpawned: vi.fn(async () => {}),
  runSubagentProgress: vi.fn(async () => {}),
  runSubagentEnded: vi.fn(async () => {}),
}));

const bindingMocks = vi.hoisted(() => {
  const bind = async (request: TestBindingRequest) => ({
    targetSessionKey: request.targetSessionKey,
    targetKind: request.targetKind,
    status: "active",
    conversation: {
      channel: request.conversation.channel,
      accountId: request.conversation.accountId ?? "default",
      conversationId: "456",
      parentConversationId: request.conversation.conversationId,
    },
  });
  return {
    bindDefault: bind,
    getCapabilities: vi.fn(() => ({
      adapterAvailable: true,
      bindSupported: true,
      placements: ["child"] as Array<"current" | "child">,
    })),
    bind: vi.fn(bind),
    listBySession: vi.fn(() => []),
  };
});

let resetSubagentRegistryForTests: typeof import("./subagents/registry/subagent-registry.test-helpers.js").resetSubagentRegistryForTests;
let spawnSubagentDirect: typeof import("./subagents/spawn/subagent-spawn.js").spawnSubagentDirect;

function getGatewayRequests(): GatewayRequest[] {
  return hoisted.callGatewayMock.mock.calls.map((call) => call[0] as GatewayRequest);
}

function getGatewayMethods() {
  return getGatewayRequests().map((request) => request.method);
}

function findGatewayRequest(method: string): GatewayRequest | undefined {
  return getGatewayRequests().find((request) => request.method === method);
}

const requireRecord = createRequireRecord("object", "expected-label");

async function spawn(
  params: Partial<Parameters<typeof spawnSubagentDirect>[0]> &
    Partial<Parameters<typeof spawnSubagentDirect>[1]> = {},
) {
  const {
    task = "do thing",
    context = "isolated",
    label,
    model,
    runTimeoutSeconds,
    thread,
    mode,
    ...requester
  } = params;
  return await spawnSubagentDirect(
    { task, context, label, model, runTimeoutSeconds, thread, mode },
    { agentSessionKey: "main", agentChannel: "discord", ...requester },
  );
}
const threadRequest = {
  thread: true,
  mode: "session",
  agentAccountId: "work",
  agentTo: "channel:123",
  context: "isolated",
} as const;

function expectSessionsDeleteWithoutAgentStart() {
  const methods = getGatewayMethods();
  expect(methods).toContain("sessions.delete");
  expect(methods).not.toContain("agent");
}

function mockAgentStartFailure() {
  hoisted.callGatewayMock.mockImplementation(async (opts: unknown) => {
    const request = opts as { method?: string };
    if (request.method === "agent") {
      throw new Error("spawn failed");
    }
    return {};
  });
}

function hookArg(mock: { mock: { calls: readonly (readonly unknown[])[] } }, index = 0) {
  return requireRecord(mock.mock.calls[0]?.[index], "hook argument");
}

function expectErrorResultMessage(
  result: { error?: string; status: string },
  pattern: RegExp,
): void {
  expect(result.status).toBe("error");
  expect(result.error).toMatch(pattern);
}

function expectThreadBindFailureCleanup(
  result: { childSessionKey?: string; error?: string },
  pattern: RegExp,
): void {
  // Failed child-thread binding must delete the child before agent startup.
  expect(result.error).toMatch(pattern);
  expect(hookRunnerMocks.runSubagentSpawned).not.toHaveBeenCalled();
  expectSessionsDeleteWithoutAgentStart();
  const deleteCall = findGatewayRequest("sessions.delete");
  expect(deleteCall?.params).toMatchObject({
    key: result.childSessionKey,
    emitLifecycleHooks: false,
  });
}

beforeAll(async () => {
  ({ resetSubagentRegistryForTests, spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
    callGatewayMock: hoisted.callGatewayMock,
    getRuntimeConfig: () => hoisted.configOverride,
    updateSessionStoreMock: hoisted.updateSessionStoreMock,
    hookRunner: {
      hasHooks: (hookName: string) =>
        hookName === "subagent_spawned" ||
        hookName === "subagent_progress" ||
        (hookName === "subagent_ended" && hookRunnerMocks.hasSubagentEndedHook),
      runSubagentSpawned: hookRunnerMocks.runSubagentSpawned,
      runSubagentProgress: hookRunnerMocks.runSubagentProgress,
      runSubagentEnded: hookRunnerMocks.runSubagentEnded,
    },
    getSessionBindingService: () => bindingMocks,
    resetModules: false,
    sessionStorePath: "/tmp/subagent-spawn-hooks-session-store.json",
  }));
});

beforeEach(async () => {
  await resetSubagentRegistryForTests();
  hoisted.callGatewayMock.mockReset();
  hoisted.updateSessionStoreMock.mockReset();
  hookRunnerMocks.hasSubagentEndedHook = true;
  hookRunnerMocks.runSubagentSpawned.mockClear();
  hookRunnerMocks.runSubagentProgress.mockClear();
  hookRunnerMocks.runSubagentEnded.mockClear();
  bindingMocks.getCapabilities.mockClear();
  bindingMocks.getCapabilities.mockReturnValue({
    adapterAvailable: true,
    bindSupported: true,
    placements: ["child"],
  });
  bindingMocks.bind.mockClear();
  bindingMocks.bind.mockImplementation(bindingMocks.bindDefault);
  bindingMocks.listBySession.mockClear();
  hoisted.configOverride = createSubagentSpawnTestConfig(undefined, {
    session: {
      mainKey: "main",
      scope: "per-sender",
      threadBindings: {
        defaultSpawnContext: "isolated",
      },
    },
  });
  const store: Record<string, Record<string, unknown>> = {};
  hoisted.updateSessionStoreMock.mockImplementation(
    async (_storePath: unknown, mutator: unknown) => {
      if (typeof mutator !== "function") {
        throw new Error("missing session store mutator");
      }
      await mutator(store);
      return store;
    },
  );
  hoisted.callGatewayMock.mockImplementation(async (opts: unknown) => {
    const request = opts as { method?: string };
    if (request.method === "sessions.patch") {
      return { ok: true };
    }
    if (request.method === "sessions.delete") {
      return { ok: true };
    }
    if (request.method === "agent") {
      return { runId: "run-1", status: "accepted", acceptedAt: 1_001 };
    }
    return {};
  });
});

afterEach(() => resetSubagentRegistryForTests());

it("binds the subagent thread in core and emits subagent_spawned with requester metadata", async () => {
  const result = await spawn({
    label: "research",
    model: "openai/gpt-5.4",
    runTimeoutSeconds: 1,
    thread: true,
    agentAccountId: "work",
    agentTo: "channel:123",
    agentThreadId: 456,
    currentMessagingTarget: "channel:source",
    currentChannelId: "source-native",
    currentMessageId: "message-789",
    context: "isolated",
  });

  expect(result).toMatchObject({
    status: "accepted",
    runId: "run-1",
    resolvedModel: "openai/gpt-5.4",
    resolvedProvider: "openai",
  });
  expect(bindingMocks.getCapabilities).toHaveBeenCalledWith({
    channel: "discord",
    accountId: "work",
  });
  expect(bindingMocks.bind).toHaveBeenCalledTimes(1);
  const bindingRequest = requireRecord(bindingMocks.bind.mock.calls[0]?.[0], "binding request");
  expect(bindingRequest.targetSessionKey).toEqual(expect.stringMatching(/^agent:main:subagent:/));
  expect(bindingRequest).toMatchObject({
    targetKind: "subagent",
    placement: "child",
  });
  expect(bindingRequest.conversation).toMatchObject({
    channel: "discord",
    accountId: "work",
    conversationId: "456",
    parentConversationId: "123",
  });

  expect(hookRunnerMocks.runSubagentSpawned).toHaveBeenCalledTimes(1);
  const event = hookArg(hookRunnerMocks.runSubagentSpawned);
  const ctx = hookArg(hookRunnerMocks.runSubagentSpawned, 1);
  expect(event).toMatchObject({
    runId: "run-1",
    agentId: "main",
    label: "research",
    mode: "session",
    threadRequested: true,
    resolvedModel: "openai/gpt-5.4",
    resolvedProvider: "openai",
  });
  expect(event.requester).toMatchObject({
    channel: "discord",
    accountId: "work",
    to: "channel:123",
    threadId: 456,
  });
  expect(event.childSessionKey).toEqual(expect.stringMatching(/^agent:main:subagent:/));
  expect(ctx).toMatchObject({
    runId: "run-1",
    requesterSessionKey: "main",
    childSessionKey: event.childSessionKey,
  });
  expect(hookRunnerMocks.runSubagentProgress).toHaveBeenCalledWith(
    {
      phase: "started",
      runId: "run-1",
      childSessionKey: event.childSessionKey,
      requester: {
        channel: "discord",
        accountId: "work",
        to: "channel:source",
        threadId: 456,
        channelId: "source-native",
        messageId: "message-789",
      },
    },
    ctx,
  );
  expect(
    hookRunnerMocks.runSubagentProgress.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
  ).toBeLessThan(
    hookRunnerMocks.runSubagentSpawned.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
  );
});

it("emits subagent_spawned with threadRequested=false when not requested", async () => {
  const result = await spawn({
    runTimeoutSeconds: 1,
    agentTo: "channel:123",
  });

  expect(result).toMatchObject({ status: "accepted", runId: "run-1" });
  expect(hookRunnerMocks.runSubagentSpawned).toHaveBeenCalledTimes(1);
  const event = hookArg(hookRunnerMocks.runSubagentSpawned);
  expect(event).toMatchObject({
    mode: "run",
    threadRequested: false,
  });
  expect(event.requester).toMatchObject({
    channel: "discord",
    to: "channel:123",
  });
});

it("returns error when thread binding cannot be created", async () => {
  bindingMocks.bind.mockRejectedValueOnce(
    new Error("Unable to create or bind a Discord thread for this subagent session."),
  );
  const result = await spawn({ ...threadRequest, runTimeoutSeconds: 1 });

  expectThreadBindFailureCleanup(result, /thread/i);
});

it("returns error when thread binding does not produce a conversation", async () => {
  bindingMocks.bind.mockResolvedValueOnce({
    targetSessionKey: "agent:main:subagent:test",
    targetKind: "subagent",
    status: "active",
    conversation: {
      channel: "discord",
      accountId: "work",
      conversationId: "",
      parentConversationId: "123",
    },
  });
  const result = await spawn({ ...threadRequest, runTimeoutSeconds: 1 });

  expectThreadBindFailureCleanup(result, /unable to create or bind a thread/i);
});

it("rejects mode=session when thread=true is not requested", async () => {
  const result = await spawn({
    mode: "session",
    agentTo: "channel:123",
  });

  expectErrorResultMessage(result, /requires thread=true/i);
  expect(hookRunnerMocks.runSubagentSpawned).not.toHaveBeenCalled();
  expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
});

it("rejects thread=true on channels without thread support", async () => {
  bindingMocks.getCapabilities.mockReturnValueOnce({
    adapterAvailable: false,
    bindSupported: false,
    placements: [],
  });
  const result = await spawn({
    thread: true,
    mode: "session",
    agentChannel: "signal",
    agentTo: "+123",
    context: "isolated",
  });

  expectErrorResultMessage(
    result,
    /only available on channels that open a separate thread for the worker/i,
  );
  expect(hookRunnerMocks.runSubagentSpawned).not.toHaveBeenCalled();
  expectSessionsDeleteWithoutAgentStart();
});

it.each([true, false])(
  "cleans up a failed bound spawn (ended hook available: %s)",
  async (hasEndedHook) => {
    hookRunnerMocks.hasSubagentEndedHook = hasEndedHook;
    mockAgentStartFailure();
    const result = await spawn({ ...threadRequest, agentThreadId: "456" });
    expect(result.status).toBe("error");
    expect(hookRunnerMocks.runSubagentEnded).toHaveBeenCalledTimes(hasEndedHook ? 1 : 0);
    expect(getGatewayMethods()).toContain("sessions.delete");
    const deleteParams = findGatewayRequest("sessions.delete")?.params;
    expect(deleteParams).toMatchObject({
      deleteTranscript: true,
      emitLifecycleHooks: !hasEndedHook,
    });
    if (hasEndedHook) {
      const event = hookArg(hookRunnerMocks.runSubagentEnded);
      expect(event).toMatchObject({
        targetSessionKey: expect.stringMatching(/^agent:main:subagent:/),
        accountId: "work",
        targetKind: "subagent",
        reason: "spawn-failed",
        sendFarewell: true,
        outcome: "error",
        error: "Session failed to start",
      });
      expect(deleteParams).toMatchObject({ key: event.targetSessionKey });
    }
  },
);
