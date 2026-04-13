import {
  ACTION_APPROVAL_SCHEMA_VERSION,
  buildActionApprovalInteractiveData,
} from "openclaw/plugin-sdk/action-approval-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetTaskFlowRegistryForTests } from "../../../src/tasks/task-flow-registry.js";
import { createPluginRuntimeMock } from "../../../test/helpers/plugins/plugin-runtime-mock.js";
import { createRuntimeTaskFlow } from "../../../test/helpers/plugins/runtime-taskflow.js";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "../runtime-api.js";
import {
  MSTEAMS_THREAD_APPROVAL_NAMESPACE,
  registerMSTeamsThreadApproval,
} from "./thread-approval.js";

const threadSendMocks = vi.hoisted(() => ({
  sendThreadMessageMSTeams: vi.fn(async () => ({
    messageId: "msg-summary-1",
    conversationId: "19:channel@thread.tacv2",
  })),
  sendThreadPollMSTeams: vi.fn(async () => ({
    pollId: "poll-1",
    messageId: "msg-poll-1",
    conversationId: "19:channel@thread.tacv2",
  })),
  sendThreadArtifactMSTeams: vi.fn(async () => ({
    messageId: "msg-artifact-1",
    conversationId: "19:channel@thread.tacv2",
  })),
  pinMessageMSTeams: vi.fn(async () => ({ ok: true })),
  deliverTeamsActionApprovalCard: vi.fn(async () => ({ ok: true })),
}));

vi.mock("./thread-send.js", () => ({
  sendThreadMessageMSTeams: threadSendMocks.sendThreadMessageMSTeams,
  sendThreadPollMSTeams: threadSendMocks.sendThreadPollMSTeams,
  sendThreadArtifactMSTeams: threadSendMocks.sendThreadArtifactMSTeams,
}));

vi.mock("./graph-messages.js", () => ({
  pinMessageMSTeams: threadSendMocks.pinMessageMSTeams,
}));

vi.mock("openclaw/plugin-sdk/action-approval-runtime", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/action-approval-runtime")
  >("openclaw/plugin-sdk/action-approval-runtime");
  return {
    ...actual,
    deliverTeamsActionApprovalCard: threadSendMocks.deliverTeamsActionApprovalCard,
  };
});

type RegisteredInteractiveHandler = {
  namespace: string;
  handler: (ctx: unknown) => Promise<unknown>;
};

function createApi() {
  const taskFlow = createRuntimeTaskFlow();
  const runtime = createPluginRuntimeMock({
    taskFlow,
  });
  const factories: Array<(ctx: OpenClawPluginToolContext) => unknown> = [];
  const interactiveHandlers: RegisteredInteractiveHandler[] = [];
  const api = {
    config: {},
    pluginConfig: {},
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    runtime,
    registerTool(factory: (ctx: OpenClawPluginToolContext) => unknown) {
      factories.push(factory);
    },
    registerInteractiveHandler(registration: RegisteredInteractiveHandler) {
      interactiveHandlers.push(registration);
    },
  } as unknown as OpenClawPluginApi;
  return { api, taskFlow, factories, interactiveHandlers };
}

function createContext(
  overrides: Partial<OpenClawPluginToolContext> = {},
): OpenClawPluginToolContext {
  return {
    sessionKey: "agent:main:main",
    requesterSenderId: "requester-aad",
    workspaceDir: "/tmp",
    ...overrides,
  };
}

function buildApprovalPayload(params: {
  ownerSessionKey: string;
  flowId: string;
  expectedRevision: number;
  snapshotHash: string;
}) {
  const encoded = buildActionApprovalInteractiveData({
    namespace: MSTEAMS_THREAD_APPROVAL_NAMESPACE,
    payload: {
      version: ACTION_APPROVAL_SCHEMA_VERSION,
      ownerSessionKey: params.ownerSessionKey,
      flowId: params.flowId,
      expectedRevision: params.expectedRevision,
      snapshotHash: params.snapshotHash,
      decision: "approve",
      action: {
        kind: "msteams.thread.action",
        title: "Approve Teams thread summary post",
      },
    },
  });
  return encoded.split(":").slice(1).join(":");
}

afterEach(() => {
  vi.useRealTimers();
  resetTaskFlowRegistryForTests({ persist: false });
  for (const mock of Object.values(threadSendMocks)) {
    mock.mockClear();
  }
});

describe("msteams thread approval", () => {
  it("queues thread actions for explicit approvers only", async () => {
    const { api, taskFlow, factories } = createApi();
    registerMSTeamsThreadApproval(api);

    const context = createContext({ sessionKey: "agent:main:expiry" });
    const tool = factories
      .map((factory) => factory(context))
      .find(
        (entry): entry is { name: string; execute: (...args: unknown[]) => Promise<unknown> } =>
          Boolean(entry) && typeof entry === "object" && "name" in entry && "execute" in entry,
      );
    if (!tool) {
      throw new Error("expected thread queue tool to be registered");
    }

    const result = (await tool.execute("call-1", {
      operation: "post_summary",
      teamId: "team-1",
      channelId: "channel-1",
      rootMessageId: "root-1",
      conversationId: "19:channel@thread.tacv2",
      approverIds: ["approver-aad"],
      text: "Summary text",
    })) as { details?: Record<string, unknown> };

    const details = result.details as { flowId: string };
    const flow = taskFlow.fromToolContext(context).get(details.flowId);
    const snapshot = (flow?.stateJson as { snapshot?: { approverIds?: string[] } } | undefined)
      ?.snapshot;

    expect(snapshot?.approverIds).toEqual(["approver-aad"]);
    expect(threadSendMocks.deliverTeamsActionApprovalCard).toHaveBeenCalledTimes(1);
    expect(threadSendMocks.deliverTeamsActionApprovalCard).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user:approver-aad",
      }),
    );
  });

  it("denies non-approver approval clicks", async () => {
    const { api, factories, interactiveHandlers } = createApi();
    registerMSTeamsThreadApproval(api);

    const context = createContext();
    const tool = factories
      .map((factory) => factory(context))
      .find(
        (entry): entry is { name: string; execute: (...args: unknown[]) => Promise<unknown> } =>
          Boolean(entry) && typeof entry === "object" && "name" in entry && "execute" in entry,
      );
    if (!tool) {
      throw new Error("expected thread queue tool to be registered");
    }

    const result = (await tool.execute("call-1", {
      operation: "post_summary",
      teamId: "team-1",
      channelId: "channel-1",
      rootMessageId: "root-1",
      conversationId: "19:channel@thread.tacv2",
      approverIds: ["approver-aad"],
      text: "Summary text",
    })) as { details?: Record<string, unknown> };

    const details = result.details as {
      flowId: string;
      expectedRevision: number;
      snapshotHash: string;
    };
    const handler = interactiveHandlers[0]?.handler;
    if (!handler) {
      throw new Error("expected thread interactive handler");
    }
    const reply = vi.fn(async () => undefined);

    await handler({
      senderId: "intruder-aad",
      respond: {
        reply,
        editMessage: vi.fn(async () => undefined),
      },
      interaction: {
        payload: buildApprovalPayload({
          ownerSessionKey: "agent:main:main",
          flowId: details.flowId,
          expectedRevision: details.expectedRevision,
          snapshotHash: details.snapshotHash,
        }),
      },
    });

    expect(reply).toHaveBeenCalledWith({
      text: "You are not allowed to approve this action.",
    });
    expect(threadSendMocks.sendThreadMessageMSTeams).not.toHaveBeenCalled();
  });

  it("dedupes identical queue requests before delivery", async () => {
    const { api, factories } = createApi();
    registerMSTeamsThreadApproval(api);

    const context = createContext();
    const tool = factories
      .map((factory) => factory(context))
      .find(
        (entry): entry is { name: string; execute: (...args: unknown[]) => Promise<unknown> } =>
          Boolean(entry) && typeof entry === "object" && "name" in entry && "execute" in entry,
      );
    if (!tool) {
      throw new Error("expected thread queue tool to be registered");
    }

    const params = {
      operation: "create_poll",
      teamId: "team-1",
      channelId: "channel-1",
      rootMessageId: "root-1",
      conversationId: "19:channel@thread.tacv2",
      approverIds: ["approver-aad"],
      question: "Which option?",
      options: ["A", "B"],
    };
    const first = (await tool.execute("call-1", params)) as { details?: Record<string, unknown> };
    const second = (await tool.execute("call-2", params)) as { details?: Record<string, unknown> };

    expect(first.details?.flowId).toBe(second.details?.flowId);
    expect(second.details?.deduped).toBe(true);
    expect(threadSendMocks.deliverTeamsActionApprovalCard).toHaveBeenCalledTimes(1);
  });

  it("executes the approved side effect exactly once", async () => {
    const { api, factories, interactiveHandlers } = createApi();
    registerMSTeamsThreadApproval(api);

    const context = createContext();
    const tool = factories
      .map((factory) => factory(context))
      .find(
        (entry): entry is { name: string; execute: (...args: unknown[]) => Promise<unknown> } =>
          Boolean(entry) && typeof entry === "object" && "name" in entry && "execute" in entry,
      );
    if (!tool) {
      throw new Error("expected thread queue tool to be registered");
    }

    const result = (await tool.execute("call-1", {
      operation: "post_summary",
      teamId: "team-1",
      channelId: "channel-1",
      rootMessageId: "root-1",
      conversationId: "19:channel@thread.tacv2",
      approverIds: ["approver-aad"],
      text: "Summary text",
    })) as { details?: Record<string, unknown> };

    const details = result.details as {
      flowId: string;
      expectedRevision: number;
      snapshotHash: string;
    };
    const handler = interactiveHandlers[0]?.handler;
    if (!handler) {
      throw new Error("expected thread interactive handler");
    }
    const editMessage = vi.fn(async () => undefined);
    const payload = buildApprovalPayload({
      ownerSessionKey: "agent:main:main",
      flowId: details.flowId,
      expectedRevision: details.expectedRevision,
      snapshotHash: details.snapshotHash,
    });

    await handler({
      senderId: "approver-aad",
      respond: {
        reply: vi.fn(async () => undefined),
        editMessage,
      },
      interaction: { payload },
    });

    await handler({
      senderId: "approver-aad",
      respond: {
        reply: vi.fn(async () => undefined),
        editMessage,
      },
      interaction: { payload },
    });

    expect(threadSendMocks.sendThreadMessageMSTeams).toHaveBeenCalledTimes(1);
    expect(editMessage).toHaveBeenNthCalledWith(1, { text: "Approved and executed." });
    expect(editMessage).toHaveBeenNthCalledWith(2, {
      text: "Approval could not be applied (revision_conflict).",
    });
  });

  it("expires stale approvals before execution", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-13T10:00:00Z"));

    const { api, taskFlow, factories, interactiveHandlers } = createApi();
    registerMSTeamsThreadApproval(api);

    const context = createContext({ sessionKey: "agent:main:expiry" });
    const tool = factories
      .map((factory) => factory(context))
      .find(
        (entry): entry is { name: string; execute: (...args: unknown[]) => Promise<unknown> } =>
          Boolean(entry) && typeof entry === "object" && "name" in entry && "execute" in entry,
      );
    if (!tool) {
      throw new Error("expected thread queue tool to be registered");
    }

    const result = (await tool.execute("call-1", {
      operation: "post_summary",
      teamId: "team-1",
      channelId: "channel-1",
      rootMessageId: "root-1",
      conversationId: "19:channel@thread.tacv2",
      approverIds: ["approver-aad"],
      text: "Expiry summary text",
    })) as { details?: Record<string, unknown> };

    const details = result.details as {
      flowId: string;
      expectedRevision: number;
      snapshotHash: string;
    };
    const flow = taskFlow.fromToolContext(context).get(details.flowId);
    const expiresAt = (flow?.stateJson as { expiresAt?: number } | undefined)?.expiresAt;
    expect(expiresAt).toBeTypeOf("number");
    expect(expiresAt).toBeGreaterThan(new Date("2026-04-13T10:00:00Z").getTime());
    const handler = interactiveHandlers[0]?.handler;
    if (!handler) {
      throw new Error("expected thread interactive handler");
    }
    const editMessage = vi.fn(async () => undefined);

    vi.setSystemTime(new Date("2026-04-13T10:06:00Z"));

    await handler({
      senderId: "approver-aad",
      respond: {
        reply: vi.fn(async () => undefined),
        editMessage,
      },
      interaction: {
        payload: buildApprovalPayload({
          ownerSessionKey: "agent:main:expiry",
          flowId: details.flowId,
          expectedRevision: details.expectedRevision,
          snapshotHash: details.snapshotHash,
        }),
      },
    });

    expect(threadSendMocks.sendThreadMessageMSTeams).not.toHaveBeenCalled();
    expect(editMessage).toHaveBeenCalledWith({ text: "Approval expired." });
  });
});
