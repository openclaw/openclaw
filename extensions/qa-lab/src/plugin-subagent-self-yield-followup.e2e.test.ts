import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { startSubagentFixture } from "./plugin-subagent.e2e.test-support.ts";
import { QA_SUBAGENT_SELF_YIELD_MARKER } from "./providers/mock-openai/mock-openai-contracts.js";

const REQUESTER_CONVERSATION = { id: "requester-user", kind: "direct" as const };
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const VERDICT_PATH = path.join(
  REPO_ROOT,
  ".artifacts/qa-e2e/handoff-adoption/channel-handoff-verdict.json",
);

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

it("announces to the original requester only after the follow-up run ends", async () => {
  const {
    state,
    transport,
    mock,
    gateway,
    outbound: outboundMessages,
  } = await startSubagentFixture("self-yield-followup", cleanups, true);
  const completionCount = () =>
    outboundMessages().filter((message) => message.text.includes(QA_SUBAGENT_SELF_YIELD_MARKER))
      .length;
  const outboundStartIndex = outboundMessages().length;
  const waitForReply = (textIncludes: string, timeoutMs: number) =>
    transport.waitForOutbound({
      conversation: REQUESTER_CONVERSATION,
      sinceIndex: outboundStartIndex,
      textIncludes,
      timeoutMs,
    });
  const post = async (route: string, expectedStatus: number) => {
    const response = await fetch(`${gateway.baseUrl}/qa/self-yield/${route}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${gateway.token}`,
        ...(route === "follow-up" ? { "Content-Type": "application/json" } : {}),
      },
      ...(route === "follow-up" ? { body: JSON.stringify({}) } : {}),
    });
    expect(response.status).toBe(expectedStatus);
    return response.json();
  };
  await transport.sendInbound({
    accountId: "default",
    conversation: REQUESTER_CONVERSATION,
    senderId: REQUESTER_CONVERSATION.id,
    text: "qa self yield follow-up",
  });

  let distinctFollowupRun: boolean;

  try {
    await waitForReply("QA-SELF-YIELD-SPAWNED", 30_000);
    const followUp = (await post("follow-up", 202)) as { runId: string };
    expect(followUp.runId).toBeTruthy();
    const release = (await post("release", 200)) as {
      finalReply?: string;
      kickoffRunId?: string;
      runId?: string;
      status?: string;
    };
    expect(release).toMatchObject({
      finalReply: QA_SUBAGENT_SELF_YIELD_MARKER,
      status: "ok",
      runId: followUp.runId,
    });
    expect(release.kickoffRunId).toBeTruthy();
    distinctFollowupRun = release.runId !== release.kickoffRunId;

    await expect(waitForReply(QA_SUBAGENT_SELF_YIELD_MARKER, 90_000)).resolves.toMatchObject({
      accountId: "default",
    });
  } catch (error) {
    throw new Error(
      [
        error instanceof Error ? error.message : String(error),
        `bus=${JSON.stringify(state.getSnapshot())}`,
        `gateway=${gateway.logs()}`,
      ].join("\n"),
      { cause: error },
    );
  }

  const outbound = outboundMessages();
  expect(outbound).toHaveLength(outboundStartIndex + 2);
  const visibleRepliesBeforeQuiet = completionCount();
  const waitForQuiet = () =>
    transport.waitForNoOutbound({ sinceIndex: outbound.length, quietMs: 1_000 });
  await waitForQuiet();
  const visibleRepliesAfterQuiet = completionCount();
  await gateway.restartAfterStateMutation(async () => {});
  await transport.waitReady({ gateway });
  await waitForQuiet();
  const visibleRepliesAfterRestart = completionCount();
  const requests = (await fetch(`${mock.baseUrl}/debug/requests`).then((response) =>
    response.json(),
  )) as Array<{ allInputText?: string; plannedToolName?: string; prompt?: string }>;
  const count = (matches: (request: (typeof requests)[number]) => boolean | undefined) =>
    requests.filter(matches).length;
  expect(requests).toHaveLength(3);
  const facts = {
    sessionsYieldCalls: count((request) => request.plannedToolName === "sessions_yield"),
    childModelRequests: count(
      (request) =>
        request.prompt?.includes("Subagent self yield qa worker") ||
        request.prompt?.includes("Subagent self yield qa remote job finished"),
    ),
    requesterCompletionTurns: count((request) =>
      request.allInputText?.includes("A background task completed."),
    ),
    pauseNoticeRequests: count((request) =>
      request.prompt?.includes("A child is paused awaiting a continuation"),
    ),
    visibleReplies: visibleRepliesBeforeQuiet,
    duplicateRepliesAfterQuietWindow: visibleRepliesAfterQuiet - visibleRepliesBeforeQuiet,
    duplicateRepliesAfterGatewayRestart: visibleRepliesAfterRestart - visibleRepliesAfterQuiet,
    distinctFollowupRun,
  };
  expect(facts).toEqual({
    sessionsYieldCalls: 1,
    childModelRequests: 2,
    requesterCompletionTurns: 1,
    pauseNoticeRequests: 0,
    visibleReplies: 1,
    duplicateRepliesAfterQuietWindow: 0,
    duplicateRepliesAfterGatewayRestart: 0,
    distinctFollowupRun: true,
  });
  const verdict = {
    schemaVersion: 1,
    scenario: "channel-handoff-adoption",
    status: "pass",
    channel: "qa-channel",
    provider: "mock-openai",
    gateway: "ephemeral",
    facts,
  };
  await mkdir(path.dirname(VERDICT_PATH), { recursive: true });
  await writeFile(VERDICT_PATH, `${JSON.stringify(verdict, null, 2)}\n`, "utf8");
}, 180_000);
