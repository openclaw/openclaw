import type {
  ApprovalActionView,
  ChannelApprovalKind,
  ApprovalMetadataView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import { describe, expect, it, vi } from "vitest";
import { decodeSlackApprovalAction } from "./approval-actions.js";
import { slackApprovalNativeRuntime } from "./approval-handler.runtime.js";
import { countSlackTextUtf8Bytes } from "./truncate.js";

const sendMessageSlackMock = vi.hoisted(() => vi.fn());

// mock-isolation: approval rendering and routing use the controlled transport fixture.
vi.mock("./send.js", () => ({ sendMessageSlack: sendMessageSlackMock }));

const { presentation, transport } = slackApprovalNativeRuntime;

type SlackPayload = {
  text: string;
  blocks?: Array<{
    type?: string;
    text?: { type?: string; text?: string };
    elements?: Array<{ type?: string; text?: string | { text?: string }; value?: unknown }>;
  }>;
};
type ChatUpdatePayload = {
  channel?: string;
  ts?: string;
  text?: string;
  blocks?: unknown;
};
type SlackUpdateEntryParams = Parameters<NonNullable<typeof transport.updateEntry>>[0];
const SLACK_CHAT_UPDATE_TEXT_MAX_BYTES = 4000;
const APPROVAL_TIMING = { createdAtMs: 0, expiresAtMs: 60_000 };
const APPROVAL_CONTEXT = {
  cfg: {} as never,
  accountId: "default",
  context: { app: {} as never, config: {} as never },
};
const APPROVAL_ENTRY = { channelId: "D123APPROVER", messageTs: "1712345678.999999" };
const SCREEN_SHARE_APPROVAL = {
  approvalKind: "plugin" as const,
  approvalId: "plugin:req-1",
  title: "Share screen with Computer Use",
  description: "Computer Use wants to inspect the desktop.",
  severity: "warning" as const,
  pluginId: "computer-use",
  toolName: "screenshot",
  metadata: [{ label: "Plugin", value: "computer-use" }],
};
const SCREEN_SHARE_REQUEST = {
  id: SCREEN_SHARE_APPROVAL.approvalId,
  request: {
    title: SCREEN_SHARE_APPROVAL.title,
    description: SCREEN_SHARE_APPROVAL.description,
  },
  ...APPROVAL_TIMING,
};

type ApprovalDecision = ApprovalActionView["decision"];

const ACTION_PRESENTATION = {
  "allow-once": { label: "Allow Once", style: "success" },
  "allow-always": { label: "Allow Always", style: "success" },
  deny: { label: "Deny", style: "danger" },
} as const satisfies Record<ApprovalDecision, Pick<ApprovalActionView, "label" | "style">>;

function buildApprovalAction(
  approvalKind: ChannelApprovalKind,
  approvalId: string,
  decision: ApprovalDecision,
): ApprovalActionView {
  return {
    decision,
    ...ACTION_PRESENTATION[decision],
    action: { type: "approval", approvalId, approvalKind, decision },
    command: `/approve ${approvalId} ${decision}`,
  };
}

type PendingInput = (
  | { approvalKind: "exec"; approvalId: string; commandText: string }
  | {
      approvalKind: "plugin";
      approvalId: string;
      title: string;
      description: string;
      severity: "info" | "warning" | "critical";
      pluginId: string;
      toolName: string;
    }
) & { metadata?: ApprovalMetadataView[]; decisions?: ApprovalDecision[] };

async function buildPendingPayload(input: PendingInput): Promise<SlackPayload> {
  const {
    decisions = input.approvalKind === "exec" ? ["allow-once"] : ["deny"],
    metadata = [],
    ...fields
  } = input;
  return (await presentation.buildPendingPayload({
    ...APPROVAL_CONTEXT,
    approvalKind: input.approvalKind,
    request:
      input.approvalKind === "exec"
        ? { id: input.approvalId, request: { command: input.commandText }, ...APPROVAL_TIMING }
        : {
            id: input.approvalId,
            request: { title: input.title, description: input.description },
            ...APPROVAL_TIMING,
          },
    nowMs: 0,
    view: {
      ...fields,
      title: input.approvalKind === "exec" ? "Exec approval" : input.title,
      phase: "pending",
      metadata,
      actions: decisions.map((decision) =>
        buildApprovalAction(input.approvalKind, input.approvalId, decision),
      ),
      expiresAtMs: APPROVAL_TIMING.expiresAtMs,
    },
  })) as SlackPayload;
}

function buildPluginResolvedResult() {
  return presentation.buildResolvedResult({
    ...APPROVAL_CONTEXT,
    request: SCREEN_SHARE_REQUEST,
    resolved: {
      id: SCREEN_SHARE_APPROVAL.approvalId,
      decision: "allow-once",
      resolvedBy: "U123APPROVER",
      ts: 0,
    } as never,
    view: {
      ...SCREEN_SHARE_APPROVAL,
      phase: "resolved",
      decision: "allow-once",
      resolvedBy: "U123APPROVER",
    },
    entry: APPROVAL_ENTRY,
  });
}

function buildPluginExpiredResult() {
  return presentation.buildExpiredResult({
    ...APPROVAL_CONTEXT,
    request: SCREEN_SHARE_REQUEST,
    view: { ...SCREEN_SHARE_APPROVAL, phase: "expired" },
    entry: APPROVAL_ENTRY,
  });
}

function findSlackActionsBlock(blocks: Array<{ type?: string; elements?: unknown[] }>) {
  return blocks.find((block) => block.type === "actions");
}

function readSlackActionLabels(block: { elements?: unknown[] } | undefined): string[] {
  return (block?.elements ?? []).map((element) => {
    const text = (element as { text?: { text?: unknown } } | null)?.text?.text;
    return typeof text === "string" ? text : "";
  });
}

function decodeSlackApprovalElements(block: { elements?: unknown[] } | undefined) {
  return (block?.elements ?? []).map((element) =>
    decodeSlackApprovalAction(
      element && typeof element === "object" ? (element as { value?: unknown }).value : undefined,
    ),
  );
}

function expectPendingActions(
  payload: SlackPayload,
  kind: "exec" | "plugin",
  labels: string[],
  decisions: ApprovalDecision[],
) {
  expect(payload.text).toContain(`*${kind === "exec" ? "Exec" : "Plugin"} approval required*`);
  expect(payload.blocks?.[0]).toMatchObject({ block_id: "openclaw_approval_header" });
  const actions = findSlackActionsBlock(payload.blocks ?? []);
  expect(readSlackActionLabels(actions)).toEqual(labels);
  expect(JSON.stringify(payload.blocks)).not.toContain("/approve");
  expect(decodeSlackApprovalElements(actions)).toEqual(
    decisions.map((decision) => expect.objectContaining({ approvalKind: kind, decision })),
  );
}

async function updateSlackApprovalEntry(
  context: SlackUpdateEntryParams["context"],
  payload: SlackUpdateEntryParams["payload"],
): Promise<void> {
  await transport.updateEntry?.({
    ...APPROVAL_CONTEXT,
    context,
    entry: { channelId: "C123", messageTs: "1712345678.999999" },
    request: {
      id: "approval-1",
      request: { command: "echo hi" },
      createdAtMs: 0,
      expiresAtMs: 60_000,
    },
    approvalKind: "exec",
    payload,
    phase: "resolved",
  });
}

const UNPAIRED_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function readMrkdwnTexts(blocks: SlackPayload["blocks"]): string[] {
  return (blocks ?? [])
    .flatMap((block) => {
      const texts: Array<{ type?: string; text?: string | { text?: string } }> = block.text
        ? [block.text]
        : [];
      return texts.concat(block.elements ?? []);
    })
    .filter(
      (text): text is { type: string; text: string } =>
        text?.type === "mrkdwn" && typeof text.text === "string",
    )
    .map(({ text }) => text);
}

function findApprovalMrkdwn(payload: SlackPayload, prefix: string): string {
  const text = readMrkdwnTexts(payload.blocks).find((entry) => entry.startsWith(prefix));
  if (!text) {
    throw new Error(`Expected Slack mrkdwn block starting with ${prefix}`);
  }
  return text;
}

describe("slackApprovalNativeRuntime", () => {
  it.each([
    { phase: "resolved", status: "processing", threadTs: "1712345678.000001" },
    { phase: "expired", status: "active", threadTs: "1712345678.000001" },
  ] as const)(
    "tracks $phase approval session status with thread $threadTs",
    async ({ phase, status, threadTs }) => {
      const calls: string[] = [];
      sendMessageSlackMock.mockReset().mockImplementation(async () => {
        calls.push("deliver");
        return { channelId: "C123", messageId: "1712345678.999999" };
      });
      const apiCall = vi.fn(async (_method: string, args: { status: string }) => {
        calls.push(args.status);
        return { ok: true };
      });
      const context = {
        app: {
          client: {
            apiCall,
            chat: {
              update: vi.fn(async () => {
                calls.push("update");
                return { ok: true };
              }),
            },
          },
        },
        config: {},
      };
      const request = { id: "approval-1", request: { command: "echo hi" }, ...APPROVAL_TIMING };
      const entry = await transport.deliverPending({
        ...APPROVAL_CONTEXT,
        context,
        request,
        approvalKind: "exec",
        plannedTarget: {
          surface: "origin",
          reason: "preferred",
          target: { to: "channel:C123", threadId: threadTs },
        },
        preparedTarget: { to: "channel:C123", threadTs },
        pendingPayload: { text: "Waiting", blocks: [] },
        view: {
          approvalKind: "exec",
          phase: "pending",
          approvalId: request.id,
          title: "Exec approval",
          commandText: "echo hi",
          metadata: [],
          actions: [],
          expiresAtMs: APPROVAL_TIMING.expiresAtMs,
        },
      });
      if (!entry) {
        throw new Error("Expected delivered Slack approval entry");
      }
      await transport.updateEntry?.({
        ...APPROVAL_CONTEXT,
        context,
        request,
        approvalKind: "exec",
        entry,
        payload: { text: "Finished", blocks: [] },
        phase,
      });

      expect(calls).toEqual(
        threadTs ? ["deliver", "suspended", "update", status] : ["deliver", "update"],
      );
      expect(apiCall.mock.calls).toEqual(
        threadTs
          ? ["suspended", status].map((sessionStatus) => [
              "agents.sessions.setStatus",
              { channel_id: "C123", thread_ts: threadTs, status: sessionStatus },
            ])
          : [],
      );
    },
  );

  it("does not leave dangling surrogates when truncating exec approval command mrkdwn", async () => {
    const commandText = `${"a".repeat(2598)}😀tail`;
    const payload = await buildPendingPayload({
      approvalKind: "exec",
      approvalId: "req-surrogate",
      commandText,
    });

    const commandMrkdwn = findApprovalMrkdwn(payload, "*Command*");
    expect(commandMrkdwn).toMatch(/…\n```$/);
    expect(UNPAIRED_SURROGATE_RE.test(commandMrkdwn)).toBe(false);
  });

  it("renders only the allowed pending actions", async () => {
    const payload = await buildPendingPayload({
      approvalKind: "exec",
      approvalId: "req-1",
      commandText: "echo hi",
      decisions: ["allow-once", "deny"],
    });

    expectPendingActions(payload, "exec", ["Allow Once", "Deny"], ["allow-once", "deny"]);
    expect(JSON.stringify(payload.blocks)).not.toContain("Allow Always");
    expect(JSON.stringify(payload.blocks)).toContain("openclaw:approval_button");
  });

  it("renders plugin pending approvals with plugin approval actions", async () => {
    const payload = await buildPendingPayload({
      ...SCREEN_SHARE_APPROVAL,
      metadata: [
        { label: "Severity", value: "Warning" },
        { label: "Plugin", value: "computer-use" },
        {
          label: "Scope",
          value: "Send to 3 recipients via email (external): alice@example.com, +2 more",
        },
      ],
      decisions: ["allow-once", "allow-always", "deny"],
    });

    expectPendingActions(
      payload,
      "plugin",
      ["Allow Once", "Allow Always", "Deny"],
      ["allow-once", "allow-always", "deny"],
    );
    expect(payload.text).toContain("Share screen with Computer Use");
    expect(payload.text).toContain("*Approval ID:* plugin:req-1");
    expect(payload.text).toContain(
      "*Scope:* Send to 3 recipients via email (external): alice@example.com, +2 more",
    );
    expect(readMrkdwnTexts(payload.blocks)).toContain(
      "*Scope:* Send to 3 recipients via email (external): alice@example.com, +2 more",
    );
    expect(payload.text).not.toContain("*Command*");
    expect(JSON.stringify(payload.blocks)).toContain("plugin:req-1");
  });

  it("preserves the Denied system-agent heading after denial", async () => {
    const result = await presentation.buildResolvedResult({
      ...APPROVAL_CONTEXT,
      request: {
        approvalKind: "system-agent",
        id: "system-agent:change-1",
        request: {
          title: "OpenClaw change",
          description: "restart the Gateway",
          command: "restart the Gateway",
          proposalHash: "a".repeat(64),
          allowedDecisions: ["allow-once", "deny"],
          sessionId: "delegation-1",
        },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      },
      resolved: {
        id: "system-agent:change-1",
        decision: "deny",
        applicationStatus: "not-applied",
        terminalStatus: undefined,
        ts: 1,
      },
      view: {
        approvalKind: "system-agent",
        approvalId: "system-agent:change-1",
        phase: "resolved",
        title: "OpenClaw change",
        metadata: [],
        commandText: "restart the Gateway",
        operationSummary: "restart the Gateway",
        decision: "deny",
        applicationStatus: "not-applied",
        terminalStatus: undefined,
      },
      entry: null,
    });

    expect(result).toMatchObject({
      kind: "update",
      payload: {
        text: "*OpenClaw change approval: Denied*\nResolved.\n\n*Change*\n```\nrestart the Gateway\n```",
        blocks: [
          { text: { text: "*OpenClaw change approval: Denied*\nResolved." } },
          { text: { text: "*Change*\n```\nrestart the Gateway\n```" } },
        ],
      },
    });
  });

  it("renders plugin resolved and expired updates without command text", async () => {
    const resolved = await buildPluginResolvedResult();
    const expired = await buildPluginExpiredResult();

    expect(resolved.kind).toBe("update");
    expect(expired.kind).toBe("update");
    if (resolved.kind !== "update" || expired.kind !== "update") {
      throw new Error("expected Slack update payloads");
    }
    const resolvedPayload = resolved.payload as SlackPayload;
    const expiredPayload = expired.payload as SlackPayload;
    expect(resolvedPayload.text).toContain("*Plugin approval: Allowed once*");
    expect(resolvedPayload.text).toContain("Resolved by <@U123APPROVER>.");
    expect(resolvedPayload.text).toContain("Share screen with Computer Use");
    expect(resolvedPayload.text).not.toContain("*Command*");
    expect(expiredPayload.text).toContain("*Plugin approval expired*");
    expect(expiredPayload.text).toContain("Share screen with Computer Use");
    expect(expiredPayload.text).not.toContain("*Command*");
    expect(
      (resolvedPayload.blocks as Array<{ type?: string }>).some(
        (block) => block.type === "actions",
      ),
    ).toBe(false);
  });

  it("caps resolved update fallback text to Slack chat.update limits while preserving blocks", async () => {
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: "*Command*\n```short preview```" } },
    ];
    const chatUpdate = vi.fn(async (_payload: ChatUpdatePayload) => ({}));
    const context = { app: { client: { chat: { update: chatUpdate } } }, config: {} } as never;

    await updateSlackApprovalEntry(context, {
      text: "a".repeat(SLACK_CHAT_UPDATE_TEXT_MAX_BYTES),
      blocks,
    });

    await updateSlackApprovalEntry(context, { text: "a".repeat(5000), blocks });

    const firstUpdate = chatUpdate.mock.calls[0]![0];
    const secondUpdate = chatUpdate.mock.calls[1]![0];
    expect(firstUpdate).toMatchObject({
      channel: "C123",
      ts: "1712345678.999999",
      text: "a".repeat(SLACK_CHAT_UPDATE_TEXT_MAX_BYTES),
    });
    expect(firstUpdate.blocks).toBe(blocks);
    expect(secondUpdate).toMatchObject({ channel: "C123", ts: "1712345678.999999" });
    expect(secondUpdate.text).toMatch(/…$/);
    expect(secondUpdate.blocks).toBe(blocks);
    expect(countSlackTextUtf8Bytes(secondUpdate.text ?? "")).toBe(SLACK_CHAT_UPDATE_TEXT_MAX_BYTES);
  });

  it("keeps pending metadata context within Slack Block Kit limits", async () => {
    const payload = await buildPendingPayload({
      approvalKind: "exec",
      approvalId: "req-1",
      commandText: "echo hi",
      metadata: Array.from({ length: 12 }, (_entry, index) => ({
        label: `Metadata ${index + 1}`,
        value: index === 0 ? "x".repeat(3100) : `value-${index + 1}`,
      })),
    });

    const contextBlock = (payload.blocks as Array<{ type?: string; elements?: unknown[] }>).find(
      (block) => block.type === "context",
    );
    const elements = contextBlock?.elements as Array<{ text?: string }> | undefined;

    expect(elements).toHaveLength(10);
    expect(elements?.[0]?.text).toHaveLength(3000);
    expect(elements?.[0]?.text?.endsWith("…")).toBe(true);
    expect(elements?.at(-1)?.text).toBe("…+3 more");
  });
});
