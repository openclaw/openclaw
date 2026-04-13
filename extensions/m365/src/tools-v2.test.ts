import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetTaskFlowRegistryForTests } from "../../../src/tasks/task-flow-registry.js";
import { createPluginRuntimeMock } from "../../../test/helpers/plugins/plugin-runtime-mock.js";
import { createRuntimeTaskFlow } from "../../../test/helpers/plugins/runtime-taskflow.js";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "../api.js";
import type { M365GraphJsonClient } from "./graph-client.js";
import { registerM365Tools } from "./tools-v2.js";

let contextCounter = 0;

function createApi() {
  const taskFlow = createRuntimeTaskFlow();
  const runtime = createPluginRuntimeMock({
    taskFlow,
  });
  const factories: OpenClawPluginToolFactory[] = [];
  const api = {
    config: {},
    pluginConfig: {
      accounts: {
        default: {
          mailboxUserId: "assistant@example.com",
          authMode: "delegated",
          identityId: "assistant@example.com",
          allowedReplyDomains: ["outside.example"],
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
    registerTool(entry: OpenClawPluginToolFactory) {
      factories.push(entry);
    },
  } as unknown as OpenClawPluginApi;
  return { api, factories, taskFlow };
}

function createContext(
  overrides: Partial<OpenClawPluginToolContext> = {},
): OpenClawPluginToolContext {
  return {
    sessionKey: `agent:main:mail-tools-${++contextCounter}`,
    requesterSenderId: "requester-aad",
    ...overrides,
  };
}

function resolveTools(
  factories: OpenClawPluginToolFactory[],
  context: OpenClawPluginToolContext,
): Map<string, AnyAgentTool> {
  const tools = new Map<string, AnyAgentTool>();
  for (const factory of factories) {
    const created = factory(context);
    const list = Array.isArray(created) ? created : created ? [created] : [];
    for (const tool of list) {
      tools.set(tool.name, tool);
    }
  }
  return tools;
}

describe("m365 tools", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    resetTaskFlowRegistryForTests({ persist: false });
  });

  it("registers the Outlook and calendar tool surface", () => {
    const { api, factories } = createApi();
    registerM365Tools(api);

    const tools = resolveTools(factories, createContext());

    expect(Array.from(tools.keys()).toSorted()).toEqual([
      "m365_calendar_agenda",
      "m365_calendar_free_busy",
      "m365_calendar_queue_change",
      "m365_mail_get_thread",
      "m365_mail_queue_reply",
      "m365_mail_triage",
    ]);
    expect(tools.has("m365_outlook_send_queued_reply")).toBe(false);
  });

  it("triages mailbox messages into reply, action, and fyi groups", async () => {
    const { api, factories } = createApi();
    registerM365Tools(api, {
      graphClientFactory: () => ({
        requestJson: vi.fn(async () => ({
          value: [
            {
              id: "msg-reply",
              subject: "Can you respond?",
              bodyPreview: "Please reply by noon",
              from: { emailAddress: { address: "alex@example.com" } },
              hasAttachments: false,
            },
            {
              id: "msg-action",
              subject: "Action required",
              bodyPreview: "Please review the draft",
              from: { emailAddress: { address: "jamie@example.com" } },
              hasAttachments: false,
            },
            {
              id: "msg-fyi",
              subject: "Weekly digest",
              bodyPreview: "No action needed",
              from: { emailAddress: { address: "digest@example.com" } },
              hasAttachments: false,
            },
          ],
        })) as unknown as M365GraphJsonClient["requestJson"],
      }),
    });

    const tools = resolveTools(factories, createContext());
    const result = await tools.get("m365_mail_triage")!.execute!("call-1", {});

    expect(result.details).toMatchObject({
      identityId: "assistant@example.com",
      mailboxUserId: "assistant@example.com",
      groups: {
        needs_reply: [expect.objectContaining({ id: "msg-reply" })],
        needs_action: [expect.objectContaining({ id: "msg-action" })],
        fyi: [expect.objectContaining({ id: "msg-fyi" })],
      },
    });
  });

  it("queues reply approvals only to explicit configured approvers", async () => {
    const { api, factories, taskFlow } = createApi();
    const deliverApprovalCard = vi.fn(async () => ({ ok: true }));
    const requestJson = vi
      .fn()
      .mockResolvedValueOnce({
        id: "msg-1",
        conversationId: "conv-1",
        subject: "Question",
        from: { emailAddress: { address: "alex@example.com" } },
        toRecipients: [{ emailAddress: { address: "assistant@example.com" } }],
        ccRecipients: [],
        receivedDateTime: "2026-04-13T12:00:00Z",
        body: { contentType: "text", content: "Can you reply?" },
        hasAttachments: false,
      })
      .mockResolvedValueOnce({
        value: [
          {
            id: "msg-1",
            conversationId: "conv-1",
            subject: "Question",
            from: { emailAddress: { address: "alex@example.com" } },
            toRecipients: [{ emailAddress: { address: "assistant@example.com" } }],
            ccRecipients: [],
            receivedDateTime: "2026-04-13T12:00:00Z",
            body: { contentType: "text", content: "Can you reply?" },
            hasAttachments: false,
          },
        ],
      });
    registerM365Tools(api, {
      graphClientFactory: () => ({
        requestJson: requestJson as unknown as M365GraphJsonClient["requestJson"],
      }),
      deliverApprovalCard,
    });

    const context = createContext();
    const tools = resolveTools(factories, context);
    const result = await tools.get("m365_mail_queue_reply")!.execute!("call-1", {
      messageId: "msg-1",
      bodyMarkdown: "Sure thing.",
    });

    expect(result.details).toMatchObject({
      identityId: "assistant@example.com",
      mailboxUserId: "assistant@example.com",
      messageId: "msg-1",
      queued: true,
      approverTeamsUserIds: ["approver-aad"],
    });
    expect(deliverApprovalCard).toHaveBeenCalledTimes(1);
    expect(deliverApprovalCard).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user:approver-aad",
        requesterSenderId: "requester-aad",
        sessionKey: context.sessionKey,
      }),
    );
    expect(
      taskFlow.fromToolContext(context).get((result.details as { flowId: string }).flowId),
    ).toBeTruthy();
  });

  it("marks reply-all to an external domain as high risk even when that domain is allowlisted", async () => {
    const { api, factories } = createApi();
    const deliverApprovalCard = vi.fn(async () => ({ ok: true }));
    const requestJson = vi
      .fn()
      .mockResolvedValueOnce({
        id: "msg-2",
        conversationId: "conv-2",
        subject: "Need everyone aligned",
        from: { emailAddress: { address: "vendor@outside.example" } },
        toRecipients: [
          { emailAddress: { address: "assistant@example.com" } },
          { emailAddress: { address: "ally@example.com" } },
        ],
        ccRecipients: [{ emailAddress: { address: "pm@outside.example" } }],
        receivedDateTime: "2026-04-13T12:00:00Z",
        body: { contentType: "text", content: "Reply all please." },
        hasAttachments: false,
      })
      .mockResolvedValueOnce({
        value: [
          {
            id: "msg-2",
            conversationId: "conv-2",
            subject: "Need everyone aligned",
            from: { emailAddress: { address: "vendor@outside.example" } },
            toRecipients: [
              { emailAddress: { address: "assistant@example.com" } },
              { emailAddress: { address: "ally@example.com" } },
            ],
            ccRecipients: [{ emailAddress: { address: "pm@outside.example" } }],
            receivedDateTime: "2026-04-13T12:00:00Z",
            body: { contentType: "text", content: "Reply all please." },
            hasAttachments: false,
          },
        ],
      });
    registerM365Tools(api, {
      graphClientFactory: () => ({
        requestJson: requestJson as unknown as M365GraphJsonClient["requestJson"],
      }),
      deliverApprovalCard,
    });

    const tools = resolveTools(factories, createContext());
    const result = await tools.get("m365_mail_queue_reply")!.execute!("call-1", {
      messageId: "msg-2",
      bodyMarkdown: "Looping back with the answer.",
      replyMode: "reply_all",
    });

    expect(result.details).toMatchObject({
      riskFlags: expect.arrayContaining(["reply_all", "external_recipient"]),
    });
  });

  it("queues calendar reschedules with the current change key and approval flow", async () => {
    const { api, factories, taskFlow } = createApi();
    const deliverApprovalCard = vi.fn(async () => ({ ok: true }));
    const requestJson = vi
      .fn()
      .mockResolvedValueOnce({
        id: "event-1",
        changeKey: "ck-1",
        subject: "Planning",
        start: { dateTime: "2026-04-14T10:00:00", timeZone: "UTC" },
        end: { dateTime: "2026-04-14T10:30:00", timeZone: "UTC" },
        attendees: [{ emailAddress: { address: "alice@example.com" } }],
      })
      .mockResolvedValueOnce({
        value: [
          {
            scheduleId: "alice@example.com",
            availabilityView: "0",
            scheduleItems: [],
          },
        ],
      });
    registerM365Tools(api, {
      graphClientFactory: () => ({
        requestJson: requestJson as unknown as M365GraphJsonClient["requestJson"],
      }),
      deliverApprovalCard,
    });

    const context = createContext();
    const tools = resolveTools(factories, context);
    const result = await tools.get("m365_calendar_queue_change")!.execute!("call-1", {
      operation: "reschedule",
      eventId: "event-1",
      startIso: "2026-04-14T11:00:00",
      endIso: "2026-04-14T11:30:00",
      timezone: "UTC",
    });

    expect(result.details).toMatchObject({
      identityId: "assistant@example.com",
      calendarUser: "assistant@example.com",
      operation: "reschedule",
      queued: true,
      approverTeamsUserIds: ["approver-aad"],
    });
    const flow = taskFlow
      .fromToolContext(context)
      .get((result.details as { flowId: string }).flowId);
    expect(flow?.stateJson).toMatchObject({
      snapshot: {
        kind: "m365.calendar.change",
        requestedOperation: "reschedule",
        plan: {
          changeKey: "ck-1",
          eventId: "event-1",
          start: { dateTime: "2026-04-14T11:00:00", timeZone: "UTC" },
          end: { dateTime: "2026-04-14T11:30:00", timeZone: "UTC" },
        },
      },
    });
    expect(deliverApprovalCard).toHaveBeenCalledTimes(1);
  });
});
