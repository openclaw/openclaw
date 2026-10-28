import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { createQaBusState } from "../../bus-state.js";
import { readQaScenarioById } from "../../scenario-catalog.js";
import { runLoadedScenarioFlow } from "../../scenario-flow-runner.test-support.js";
import type { TelegramUserbotUpdate } from "./userbot-driver.runtime.js";

const scenarioId = "telegram-participant-identity-inspection";
const primaryUserId = "710000001";
const additionalUserId = "710000002";
const botId = 710000003;
const forumGroupId = -100710000004;
const forumTopicId = 42;
const hmac = (digit: string) => `hmac-sha256:v1:${"a".repeat(32)}:${digit.repeat(64)}`;

const faults = [
  ["raw-principal", "bounded redacted identity"],
  ["raw-room", "bounded redacted identity"],
  ["prompt-leak", "bounded redacted identity"],
  ["verified-generic", "bounded redacted identity"],
  ["same-person", "distinguish the additional participant"],
  ["changed-primary", "preserve the same primary person"],
  ["reused-context", "three distinct execution contexts"],
  ["restart-leak", "changed or exposed private references after restart"],
] as const;
type Fault = (typeof faults)[number][0];
type Selector = { runId?: string; executionId?: string };
type Inbound = Parameters<ReturnType<typeof createQaBusState>["addInboundMessage"]>[0];
type NativeReply = Pick<TelegramUserbotUpdate, "text" | "chatId" | "senderId" | "forumTopicId">;

function runIdentityFlow(fault?: Fault) {
  const state = createQaBusState();
  const admittedRuns = ["previous-run"];
  const turns: Array<ReturnType<typeof state.addInboundMessage>> = [];
  const nativeReplies: NativeReply[] = [];
  let restarted = false;
  const inspect = (selector: Selector) => {
    const runId = selector.runId ?? selector.executionId?.replace("execution-", "");
    const index = admittedRuns.indexOf(runId ?? "") - 1;
    const turn = turns[index];
    assert(turn && runId, "identity proof must inspect only a newly admitted transport turn");
    const additional = turn.senderId === additionalUserId;
    const person = fault === "changed-primary" && index === 1 ? "e" : additional ? "c" : "b";
    const principalRef =
      fault === "raw-principal" ? turn.senderId : hmac(fault === "same-person" ? "b" : person);
    const run = { runId, executionId: `execution-${runId}` };
    const principal = { kind: "person", principalRef, domainRef: hmac("a") };
    const context = {
      contextId: fault === "reused-context" ? "context-first" : `context-${runId}`,
      ...run,
      invoker: { state: "present", principal },
      ingress: { kind: "channel", state: "present" },
      runtimeInstance: { runtimeRef: hmac("e") },
      assurance: [
        { kind: "channel-admission", strength: "boundary-verified", evidenceRef: hmac("d") },
      ],
      applicableGrants: [],
    };
    const provenance = { state: fault === "verified-generic" ? "verified" : "unverified" };
    return {
      run,
      identity: { state: "present", context },
      decisionDisplays: [{ action: { family: "decision" }, provenance }],
      ...(fault === "raw-room" || (restarted && fault === "restart-leak")
        ? { leakedReference: String(botId) }
        : {}),
      ...(fault === "prompt-leak" ? { leakedText: turn.text } : {}),
    };
  };
  const call = async (method: string, selector: Selector) => {
    expect(method).toBe("audit.run.inspect");
    return inspect(selector);
  };
  const restart = vi.fn(async (mutate: () => Promise<void>) => {
    await mutate();
    restarted = true;
  });
  const runQaCli = async (_env: unknown, args: string[], options?: { json?: boolean }) => {
    expect(args[0]).toBe("audit");
    if (args.includes("--kind")) {
      return { events: admittedRuns.map((runId) => ({ runId })) };
    }
    expect(args.slice(0, 2)).toEqual(["audit", "--execution"]);
    const executionId = args[2];
    assert(executionId, "identity CLI proof requires an exact execution selector");
    const inspection = inspect({ executionId });
    const principal = inspection.identity.context.invoker.principal.principalRef;
    return options?.json ? inspection : `Invoker [present] ${principal}\nDecisions`;
  };
  const transport = {
    id: "telegram",
    reset: async () => state.reset(),
    sendInbound: async (input: Inbound) => {
      expect(["primary", "guest"]).toContain(input.senderId);
      const inbound = state.addInboundMessage({
        ...input,
        senderId: input.senderId === "primary" ? primaryUserId : additionalUserId,
      });
      turns.push(inbound);
      return inbound;
    },
    waitForOutbound: async (
      input: Pick<Inbound, "conversation" | "threadId"> & { textIncludes: string },
    ) => {
      const inbound = turns.at(-1);
      assert(inbound, "identity proof must send a transport turn before inspecting it");
      expect([input.conversation, input.threadId]).toEqual([
        inbound.conversation,
        inbound.threadId,
      ]);
      const forum = inbound.conversation.kind === "group";
      expect(inbound.threadId).toBe(forum ? String(forumTopicId) : undefined);
      expect(inbound.text.startsWith("@openclaw ")).toBe(forum);
      expect(inbound.text).toContain(`Reply exactly: ${input.textIncludes}`);
      admittedRuns.push(`run-${turns.length}`);
      nativeReplies.push({
        text: input.textIncludes,
        chatId: forum ? forumGroupId : botId,
        senderId: botId,
        ...(forum ? { forumTopicId } : {}),
      });
      return state.addOutboundMessage({
        accountId: "sut",
        to: `${forum ? "group" : "dm"}:${inbound.conversation.id}`,
        threadId: inbound.threadId,
        text: input.textIncludes,
      });
    },
  };
  const result = runLoadedScenarioFlow(scenarioId, {
    state,
    api: {
      env: { providerMode: "mock-openai", gateway: { call, restartAfterStateMutation: restart } },
      telegramIdentityFixture: { participantAliases: ["primary", "guest"], forumTopicId },
      readTelegramMessages: () => nativeReplies,
      transport,
      runQaCli,
    },
  });
  return { restart, turns, result };
}

it("executes both participant aliases through DM/forum, exact RPC/CLI inspection, and one restart", async () => {
  expect(readQaScenarioById(scenarioId).execution.config?.requiredChannelDriver).toBe("live");
  const proof = runIdentityFlow();
  await expect(proof.result).resolves.toMatchObject({ status: "pass" });
  expect(proof.turns.map((turn) => [turn.senderId, turn.conversation.kind])).toEqual([
    [primaryUserId, "direct"],
    [primaryUserId, "group"],
    [additionalUserId, "group"],
  ]);
  expect(proof.restart).toHaveBeenCalledOnce();
});

it.each(faults)("rejects %s evidence", async (fault, message) => {
  await expect(runIdentityFlow(fault).result).rejects.toThrow(message);
});
