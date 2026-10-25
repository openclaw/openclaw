import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/approval-reply-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildApprovalPollOptions, mapSentPollOptionsToDecisions } from "./approval-polls.js";
import type { IMessagePayload } from "./monitor/types.js";
import { pollVote } from "./test-support/approval.js";

let iMessageApprovalPollTargets: typeof import("./approval-polls.js").iMessageApprovalPollTargets;
let maybeResolveIMessageApprovalPollVote: typeof import("./approval-polls.js").maybeResolveIMessageApprovalPollVote;

const resolverMocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  isApprovalNotFoundError: vi.fn(() => false),
}));

// mock-isolation: exercise approval handling without a live gateway.
vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: resolverMocks.resolve,
}));
vi.mock("openclaw/plugin-sdk/error-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/error-runtime")>(
    "openclaw/plugin-sdk/error-runtime",
  );
  return { ...actual, isApprovalNotFoundError: resolverMocks.isApprovalNotFoundError };
});

const APPROVER = "+15551230000";
const POLL_GUID = "poll-guid-1";
const cfg = { channels: { imessage: { allowFrom: [APPROVER] } } };

const ALLOW_ONCE_OPTION = "opt-allow-once";
const DENY_OPTION = "opt-deny";
const GROUP_CHAT_GUID = "iMessage;+;chat0000";

type PollTarget = Parameters<typeof iMessageApprovalPollTargets.register>[0];
const optionDecisions: ReadonlyArray<readonly [string, ExecApprovalReplyDecision]> = [
  [ALLOW_ONCE_OPTION, "allow-once"],
  [DENY_OPTION, "deny"],
];
function bind(overrides: Partial<PollTarget> = {}): Promise<boolean> {
  return iMessageApprovalPollTargets.register({
    accountId: "default",
    conversation: { handle: APPROVER },
    pollGuid: POLL_GUID,
    approvalId: "exec-1",
    approvalKind: "exec",
    optionDecisions,
    expiresAtMs: Date.now() + 60_000,
    ...overrides,
  });
}

function voteRecord(participant: string, option_id = ALLOW_ONCE_OPTION, event_type = "selected") {
  return { option_id, participant, event_type };
}
function buildVote(overrides?: {
  sender?: string;
  participant?: string;
  optionId?: string;
  eventType?: string;
  pollGuid?: string;
  isFromMe?: boolean;
  destinationCallerId?: string;
}): IMessagePayload {
  return {
    sender: overrides?.sender ?? APPROVER,
    is_from_me: overrides?.isFromMe,
    destination_caller_id: overrides?.destinationCallerId,
    poll: {
      kind: "vote",
      original_guid: overrides?.pollGuid ?? POLL_GUID,
      poll_guid: overrides?.pollGuid ?? POLL_GUID,
      vote: {
        option_id: overrides?.optionId ?? ALLOW_ONCE_OPTION,
        option_text: "👍 Allow Once",
        participant: overrides?.participant ?? APPROVER,
        event_type: overrides?.eventType ?? "selected",
      },
    },
  } as IMessagePayload;
}

type VoteParams = Parameters<typeof maybeResolveIMessageApprovalPollVote>[0];

function resolveVote(
  message: IMessagePayload,
  overrides: Partial<Omit<VoteParams, "message">> = {},
) {
  return maybeResolveIMessageApprovalPollVote({ cfg, accountId: "default", message, ...overrides });
}
async function expectUnresolved(
  message: IMessagePayload,
  handled = true,
  overrides: Partial<Omit<VoteParams, "message">> = {},
) {
  expect(await resolveVote(message, overrides)).toBe(handled);
  expect(resolverMocks.resolve).not.toHaveBeenCalled();
}

beforeEach(async () => {
  vi.resetModules();
  ({ iMessageApprovalPollTargets, maybeResolveIMessageApprovalPollVote } =
    await import("./approval-polls.js"));
  resolverMocks.resolve.mockReset().mockResolvedValue({ applied: true, approval: {} });
  resolverMocks.isApprovalNotFoundError.mockReset().mockReturnValue(false);
});

describe("mapSentPollOptionsToDecisions", () => {
  const requested = buildApprovalPollOptions({ allowedDecisions: ["allow-once", "deny"] });

  it.each([
    ["the bridge normalizes option text", ["id-a", "Allow Once"], ["id-b", "Deny"]],
    ["option ids are duplicated", ["same-id", "👍 Allow Once"], ["same-id", "👎 Deny"]],
  ] as const)("fails closed when %s", (_reason, first, second) => {
    const sent = [first, second].map(([id, text]) => ({ id, text }));
    expect(mapSentPollOptionsToDecisions({ requested, sent })).toEqual([]);
  });
});

describe("maybeResolveIMessageApprovalPollVote", () => {
  it.each([
    [
      "selects the transport actor from a multi-participant complete vote set",
      [voteRecord("+15559999999"), voteRecord(APPROVER, DENY_OPTION)],
      "deny",
      voteRecord("+15559999999"),
    ],
    [
      "fails closed when a multi-participant set does not identify the transport actor",
      [voteRecord("+15559999998"), voteRecord("+15559999999", DENY_OPTION)],
      null,
    ],
    [
      "accepts a complete multi-record set for one participant alias",
      [
        voteRecord("e:active-account-alias@example.com"),
        voteRecord("e:active-account-alias@example.com", DENY_OPTION, "removed"),
      ],
      "allow-once",
    ],
    [
      "fails closed when the actor selected multiple approval decisions",
      [voteRecord(APPROVER), voteRecord(APPROVER, DENY_OPTION)],
      null,
    ],
  ] as const)("%s", async (_name, votes, decision, vote) => {
    expect(await bind()).toBe(true);
    const gatewayRuntime = { request: vi.fn() } as never;
    expect(await resolveVote(pollVote(POLL_GUID, [...votes], {}, vote), { gatewayRuntime })).toBe(
      true,
    );
    if (decision) {
      expect(resolverMocks.resolve).toHaveBeenCalledWith(
        expect.objectContaining({
          approvalId: "exec-1",
          decision,
          senderId: APPROVER,
          gatewayRuntime,
        }),
      );
    } else {
      expect(resolverMocks.resolve).not.toHaveBeenCalled();
    }
  });

  it("authenticates paired-device self votes with destination_caller_id", async () => {
    expect(await bind()).toBe(true);
    const message = buildVote({ sender: "", isFromMe: true, destinationCallerId: APPROVER });
    expect(await resolveVote(message)).toBe(true);
    expect(resolverMocks.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "allow-once", senderId: APPROVER }),
    );
  });

  it.each([
    ["does not trust destination_caller_id on received rows", ""],
    ["rejects imsg's local-identity sender fallback on received rows", APPROVER],
  ])("%s", async (_name, sender) => {
    expect(await bind()).toBe(true);
    await expectUnresolved(
      buildVote({ sender, participant: APPROVER, isFromMe: false, destinationCallerId: APPROVER }),
      false,
    );
  });

  it("authorizes the transport sender, not the payload participant", async () => {
    // Group lookup matches every member; only allowFrom authenticates the actor.
    await bind({
      conversation: { chatGuid: GROUP_CHAT_GUID },
      approvalId: "exec-group",
      optionDecisions: [[ALLOW_ONCE_OPTION, "allow-once"]],
    });
    await expectUnresolved({
      ...buildVote({ sender: "+15559999999", participant: APPROVER }),
      chat_guid: GROUP_CHAT_GUID,
      is_group: true,
    });
  });

  it.each([
    ["requires explicit approvers", {}, { cfg: { channels: { imessage: {} } } }],
    ["owns an un-vote without resolving it", { eventType: "removed" }, {}],
    ["ignores an option id that is not bound to a decision", { optionId: "opt-unknown" }, {}],
  ] as const)("%s", async (_name, vote, options) => {
    await bind();
    await expectUnresolved(buildVote(vote), true, options);
  });

  it.each([
    ["a non-vote poll", { kind: "created", options: [] }],
    ["a vote without a poll identity", { kind: "vote", vote: null }],
  ])("falls through on %s", async (_label, poll) => {
    await bind();

    await expectUnresolved({ sender: APPROVER, poll } as unknown as IMessagePayload, false);
  });

  it("fails closed on a malformed complete vote set for an owned poll", async () => {
    await bind();

    await expectUnresolved({
      sender: APPROVER,
      poll: {
        kind: "vote",
        original_guid: POLL_GUID,
        votes: [{ option_id: 7, participant: APPROVER }],
      },
    } as unknown as IMessagePayload);
  });

  it("retains a tombstone after the live target expires", async () => {
    vi.useFakeTimers({ now: 1_000 });
    try {
      const expiringPollGuid = "poll-guid-natural-expiry";
      expect(
        await bind({
          pollGuid: expiringPollGuid,
          approvalId: "exec-expiring",
          optionDecisions: [[ALLOW_ONCE_OPTION, "allow-once"]],
          expiresAtMs: 1_001,
        }),
      ).toBe(true);
      vi.setSystemTime(1_002);

      await expectUnresolved(buildVote({ pollGuid: expiringPollGuid }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("swallows votes for a created poll that could not be bound", async () => {
    const orphanPollGuid = "poll-guid-orphaned";
    expect(
      await iMessageApprovalPollTargets.registerTombstone({
        accountId: "default",
        conversation: { handle: APPROVER },
        pollGuid: orphanPollGuid,
        approvalId: "exec-orphaned",
      }),
    ).toBe(true);

    await expectUnresolved(buildVote({ pollGuid: orphanPollGuid }));
  });

  it("clears the binding when the approval is already gone", async () => {
    await bind();
    resolverMocks.isApprovalNotFoundError.mockReturnValue(true);
    resolverMocks.resolve.mockRejectedValue(new Error("not found"));

    await resolveVote(buildVote());

    resolverMocks.resolve.mockClear();
    resolverMocks.isApprovalNotFoundError.mockReturnValue(false);
    resolverMocks.resolve.mockResolvedValue({ applied: true, approval: {} });

    await resolveVote(buildVote());
    expect(resolverMocks.resolve).not.toHaveBeenCalled();
  });

  it("retains the binding on a transient resolver error so a retry can land", async () => {
    await bind();
    resolverMocks.resolve.mockRejectedValueOnce(new Error("gateway 503"));

    await expect(resolveVote(buildVote())).rejects.toThrow("gateway 503");

    resolverMocks.resolve.mockResolvedValue({ applied: true, approval: {} });
    await resolveVote(buildVote());

    expect(resolverMocks.resolve).toHaveBeenLastCalledWith(
      expect.objectContaining({ approvalId: "exec-1", decision: "allow-once" }),
    );
  });

  it("does not resolve once the binding expired", async () => {
    // The persistent store survives module reload; avoid sibling tombstones.
    const expiredPollGuid = "poll-guid-expired";
    expect(
      await bind({
        pollGuid: expiredPollGuid,
        approvalId: "exec-expired",
        optionDecisions: [[ALLOW_ONCE_OPTION, "allow-once"]],
        expiresAtMs: Date.now() - 1,
      }),
    ).toBe(false);

    await expectUnresolved(buildVote({ pollGuid: expiredPollGuid }), false);
  });
});
