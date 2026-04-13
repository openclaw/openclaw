import { ACTION_APPROVAL_INTERACTIVE_DATA_KEY } from "openclaw/plugin-sdk/action-approval-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetTaskFlowRegistryForTests } from "../../../src/tasks/task-flow-registry.js";
import { createPluginRuntimeMock } from "../../../test/helpers/plugins/plugin-runtime-mock.js";
import { createRuntimeTaskFlow } from "../../../test/helpers/plugins/runtime-taskflow.js";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "../api.js";
import {
  queueM365MailReplyApproval,
  registerM365ApprovalInteractiveHandler,
} from "./approval-actions.js";
import type { M365GraphJsonClient } from "./graph-client.js";

type InteractiveRegistration = {
  channel: string;
  namespace: string;
  handler: (ctx: unknown) => Promise<unknown>;
};

let contextCounter = 0;

function createApi() {
  const taskFlow = createRuntimeTaskFlow();
  const runtime = createPluginRuntimeMock({
    taskFlow,
  });
  let interactiveRegistration: InteractiveRegistration | null = null;
  const api = {
    config: {},
    pluginConfig: {
      accounts: {
        default: {
          mailboxUserId: "assistant@example.com",
          authMode: "delegated",
          identityId: "assistant@example.com",
        },
      },
      approval: {
        teamsUserIds: ["approver-aad"],
      },
      triage: {
        limit: 10,
        sinceMinutes: 60,
        unreadOnly: true,
      },
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    runtime,
    registerInteractiveHandler(registration: InteractiveRegistration) {
      interactiveRegistration = registration;
    },
  } as unknown as OpenClawPluginApi;
  return {
    api,
    taskFlow,
    getInteractiveRegistration: () => interactiveRegistration,
  };
}

function createToolContext(
  overrides: Partial<OpenClawPluginToolContext> = {},
): OpenClawPluginToolContext {
  return {
    sessionKey: `agent:main:approval-${++contextCounter}`,
    requesterSenderId: "requester-aad",
    ...overrides,
  };
}

function extractInteractivePayload(card: Record<string, unknown>, actionIndex: number): string {
  const action = (card.actions as Array<{ data?: Record<string, unknown> }>)[actionIndex];
  const encoded = action?.data?.[ACTION_APPROVAL_INTERACTIVE_DATA_KEY];
  if (typeof encoded !== "string") {
    throw new Error("approval card did not contain interactive payload");
  }
  return encoded.split(":").slice(1).join(":");
}

afterEach(() => {
  resetTaskFlowRegistryForTests({ persist: false });
});

describe("m365 approval actions", () => {
  beforeEach(() => {
    resetTaskFlowRegistryForTests({ persist: false });
  });

  it("dedupes the same reply snapshot instead of creating multiple approval flows", async () => {
    const { api } = createApi();
    const deliverApprovalCard = vi.fn(async () => ({ ok: true }));
    const toolContext = createToolContext();

    const first = await queueM365MailReplyApproval({
      api,
      deps: { deliverApprovalCard },
      toolContext,
      identityId: "assistant@example.com",
      message: {
        id: "msg-1",
        conversationId: "conv-1",
        subject: "Question",
        from: { address: "alex@example.com" },
        to: [{ address: "assistant@example.com" }],
        cc: [],
        receivedAt: "2026-04-13T12:00:00Z",
        bodyText: "Can you reply?",
        externalContentWarning: "untrusted",
        hasAttachments: false,
        categories: [],
      },
      bodyMarkdown: "Sure thing.",
      replyMode: "reply",
    });
    const second = await queueM365MailReplyApproval({
      api,
      deps: { deliverApprovalCard },
      toolContext,
      identityId: "assistant@example.com",
      message: {
        id: "msg-1",
        conversationId: "conv-1",
        subject: "Question",
        from: { address: "alex@example.com" },
        to: [{ address: "assistant@example.com" }],
        cc: [],
        receivedAt: "2026-04-13T12:00:00Z",
        bodyText: "Can you reply?",
        externalContentWarning: "untrusted",
        hasAttachments: false,
        categories: [],
      },
      bodyMarkdown: "Sure thing.",
      replyMode: "reply",
    });

    expect(first.details).toMatchObject({ queued: true });
    expect(first.details).not.toHaveProperty("deduped");
    expect(second.details).toMatchObject({ queued: true, deduped: true });
    expect(second.details).toMatchObject({
      flowId: (first.details as { flowId: string }).flowId,
      snapshotHash: (first.details as { snapshotHash: string }).snapshotHash,
    });
    expect(deliverApprovalCard).toHaveBeenCalledTimes(1);
  });

  it("approves exactly once and blocks duplicate submit replays", async () => {
    const { api, getInteractiveRegistration } = createApi();
    const deliverApprovalCard = vi.fn(async () => ({ ok: true }));
    const requestJson = vi
      .fn()
      .mockResolvedValueOnce({ value: [] })
      .mockResolvedValueOnce(undefined);
    registerM365ApprovalInteractiveHandler(api, {
      graphClientFactory: () => ({
        requestJson: requestJson as unknown as M365GraphJsonClient["requestJson"],
      }),
    });
    const registration = getInteractiveRegistration();
    if (!registration) {
      throw new Error("interactive handler not registered");
    }

    await queueM365MailReplyApproval({
      api,
      deps: { deliverApprovalCard },
      toolContext: createToolContext(),
      identityId: "assistant@example.com",
      message: {
        id: "msg-1",
        conversationId: "conv-1",
        subject: "Question",
        from: { address: "alex@example.com" },
        to: [{ address: "assistant@example.com" }],
        cc: [],
        receivedAt: "2026-04-13T12:00:00Z",
        bodyText: "Can you reply?",
        externalContentWarning: "untrusted",
        hasAttachments: false,
        categories: [],
      },
      bodyMarkdown: "Sure thing.",
      replyMode: "reply",
    });

    const deliveredCalls = deliverApprovalCard.mock.calls as unknown as Array<
      [{ card?: Record<string, unknown> }]
    >;
    const card = deliveredCalls[0]?.[0]?.card;
    if (!card) {
      throw new Error("approval card was not delivered");
    }
    const approvePayload = extractInteractivePayload(card, 0);
    const editMessage = vi.fn(async () => undefined);

    await registration.handler({
      senderId: "approver-aad",
      interaction: { payload: approvePayload },
      respond: {
        reply: vi.fn(async () => undefined),
        editMessage,
      },
    });
    await registration.handler({
      senderId: "approver-aad",
      interaction: { payload: approvePayload },
      respond: {
        reply: vi.fn(async () => undefined),
        editMessage,
      },
    });

    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(editMessage).toHaveBeenNthCalledWith(1, { text: "Approved and executed." });
    expect(editMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        text: expect.stringContaining("Approval could not be applied"),
      }),
    );
  });

  it("denies without sending the reply", async () => {
    const { api, getInteractiveRegistration } = createApi();
    const deliverApprovalCard = vi.fn(async () => ({ ok: true }));
    const requestJson = vi.fn();
    registerM365ApprovalInteractiveHandler(api, {
      graphClientFactory: () => ({
        requestJson: requestJson as unknown as M365GraphJsonClient["requestJson"],
      }),
    });
    const registration = getInteractiveRegistration();
    if (!registration) {
      throw new Error("interactive handler not registered");
    }

    await queueM365MailReplyApproval({
      api,
      deps: { deliverApprovalCard },
      toolContext: createToolContext(),
      identityId: "assistant@example.com",
      message: {
        id: "msg-2",
        conversationId: "conv-2",
        subject: "Question",
        from: { address: "alex@example.com" },
        to: [{ address: "assistant@example.com" }],
        cc: [],
        receivedAt: "2026-04-13T12:00:00Z",
        bodyText: "Can you reply?",
        externalContentWarning: "untrusted",
        hasAttachments: false,
        categories: [],
      },
      bodyMarkdown: "No problem.",
      replyMode: "reply",
    });

    const deliveredCalls = deliverApprovalCard.mock.calls as unknown as Array<
      [{ card?: Record<string, unknown> }]
    >;
    const card = deliveredCalls[0]?.[0]?.card;
    if (!card) {
      throw new Error("approval card was not delivered");
    }
    const denyPayload = extractInteractivePayload(card, 2);
    const editMessage = vi.fn(async () => undefined);

    await registration.handler({
      senderId: "approver-aad",
      interaction: { payload: denyPayload },
      respond: {
        reply: vi.fn(async () => undefined),
        editMessage,
      },
    });

    expect(requestJson).not.toHaveBeenCalled();
    expect(editMessage).toHaveBeenCalledWith({ text: "Denied." });
  });
});
