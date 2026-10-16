import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "../../bus-state.js";
import { readQaScenarioById } from "../../scenario-catalog.js";
import { runLoadedScenarioFlow } from "../../scenario-flow-runner.test-support.js";
import { selectQaFlowSuiteScenarios } from "../../suite-planning.js";
import { resolveTelegramQaScenarioIds } from "./scenario-selection.js";

const scenarioId = "telegram-participant-identity-inspection";
const primaryUserId = "710000001";
const additionalUserId = "710000002";
const botId = 710000003;
const forumGroupId = -100710000004;
const forumTopicId = 42;
const hmac = (digit: string) => `hmac-sha256:v1:${"a".repeat(32)}:${digit.repeat(64)}`;

type Fault =
  | "raw-principal"
  | "raw-room"
  | "prompt-leak"
  | "verified-generic"
  | "same-person"
  | "changed-primary"
  | "reused-context"
  | "restart-leak";

function runIdentityFlow(fault?: Fault) {
  const state = createQaBusState();
  const admittedRuns = ["previous-run"];
  const turns: Array<ReturnType<typeof state.addInboundMessage>> = [];
  const nativeReplies: Array<{
    text: string;
    chatId: number;
    senderId: number;
    forumTopicId?: number;
  }> = [];
  let restarted = false;
  const inspect = (selector: { runId?: string; executionId?: string }) => {
    const runId = selector.runId ?? selector.executionId?.replace("execution-", "");
    const index = admittedRuns.indexOf(runId ?? "") - 1;
    const turn = turns[index];
    if (!turn || !runId) {
      throw new Error("identity proof must inspect only a newly admitted transport turn");
    }
    const additional = turn.senderId === additionalUserId;
    const principalRef =
      fault === "raw-principal"
        ? turn.senderId
        : hmac(
            fault === "same-person"
              ? "b"
              : fault === "changed-primary" && index === 1
                ? "e"
                : additional
                  ? "c"
                  : "b",
          );
    return {
      run: { runId, executionId: `execution-${runId}` },
      identity: {
        state: "present",
        context: {
          contextId: fault === "reused-context" ? "context-first" : `context-${runId}`,
          executionId: `execution-${runId}`,
          runId,
          invoker: {
            state: "present",
            principal: {
              kind: "person",
              principalRef,
              domainRef: hmac("a"),
            },
          },
          // Channel admission supplies no rawSourceRef; do not invent one in proof support.
          ingress: { kind: "channel", state: "present" },
          runtimeInstance: { runtimeRef: hmac("e") },
          assurance: [
            {
              kind: "channel-admission",
              strength: "boundary-verified",
              evidenceRef: hmac("d"),
            },
          ],
          applicableGrants: [],
        },
      },
      decisionDisplays: [
        {
          action: { family: "decision", operation: "record" },
          provenance: { state: fault === "verified-generic" ? "verified" : "unverified" },
        },
      ],
      ...(fault === "raw-room" || (restarted && fault === "restart-leak")
        ? { leakedReference: String(botId) }
        : {}),
      ...(fault === "prompt-leak" ? { leakedText: turn.text } : {}),
    };
  };
  const call = vi.fn(
    async (
      method: string,
      selector: { runId?: string; executionId?: string; decisionLimit: number },
    ) => {
      expect(method).toBe("audit.run.inspect");
      // audit.run.inspect has a closed request schema, distinct from audit CLI --limit.
      expect(Object.keys(selector).toSorted()).toEqual([
        "decisionLimit",
        selector.runId === undefined ? "executionId" : "runId",
      ]);
      expect(selector.decisionLimit).toBe(100);
      return inspect(selector);
    },
  );
  const restart = vi.fn(async (mutate: () => Promise<void>) => {
    await mutate();
    restarted = true;
  });
  const runQaCli = vi.fn(async (_env: unknown, args: string[], options?: { json?: boolean }) => {
    expect(args[0]).toBe("audit");
    if (args.includes("--kind")) {
      return { events: admittedRuns.map((runId) => ({ runId })) };
    }
    expect(args.slice(0, 2)).toEqual(["audit", "--execution"]);
    const executionId = args[2];
    if (!executionId) {
      throw new Error("identity CLI proof requires an exact execution selector");
    }
    const inspection = inspect({ executionId });
    if (!options?.json) {
      return `Invoker [present] ${inspection.identity.context.invoker.principal.principalRef}\nDecisions`;
    }
    return inspection;
  });
  return {
    call,
    restart,
    runQaCli,
    turns,
    result: runLoadedScenarioFlow(scenarioId, {
      state,
      api: {
        env: {
          providerMode: "mock-openai",
          gateway: { call, restartAfterStateMutation: restart },
        },
        // Only the adapter's prepared, noncredential surface is supplied here.
        telegramIdentityFixture: { participantAliases: ["primary", "guest"], forumTopicId },
        readTelegramMessages: () => nativeReplies,
        transport: {
          id: "telegram",
          reset: async () => state.reset(),
          sendInbound: async (input: Parameters<typeof state.addInboundMessage>[0]) => {
            expect(["primary", "guest"]).toContain(input.senderId);
            const inbound = state.addInboundMessage({
              ...input,
              senderId: input.senderId === "primary" ? primaryUserId : additionalUserId,
            });
            turns.push(inbound);
            return inbound;
          },
          waitForOutbound: async (input: {
            conversation: { id: string; kind: string };
            threadId?: string;
            textIncludes: string;
          }) => {
            const inbound = turns.at(-1);
            if (!inbound) {
              throw new Error("identity proof must send a transport turn before inspecting it");
            }
            expect(input.conversation).toEqual(inbound.conversation);
            expect(input.threadId).toBe(inbound.threadId);
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
        },
        runQaCli,
      },
    }),
  };
}

describe("Telegram participant identity executable flow", () => {
  it("selects live identity proof explicitly and excludes it from crabline", () => {
    expect(
      resolveTelegramQaScenarioIds({ providerMode: "mock-openai", scenarioIds: [scenarioId] }),
    ).toEqual([scenarioId]);
    expect(
      selectQaFlowSuiteScenarios({
        scenarios: [readQaScenarioById(scenarioId)],
        channel: "telegram",
        channelDriver: "crabline",
        providerMode: "mock-openai",
        primaryModel: "mock-openai/fixture",
      }),
    ).toEqual([]);
  });

  it("executes both participant aliases through DM/forum, exact RPC/CLI inspection, and one restart", async () => {
    const proof = runIdentityFlow();
    await expect(proof.result).resolves.toMatchObject({ status: "pass" });
    expect(proof.turns.map((turn) => [turn.senderId, turn.conversation.kind])).toEqual([
      [primaryUserId, "direct"],
      [primaryUserId, "group"],
      [additionalUserId, "group"],
    ]);
    expect(proof.restart).toHaveBeenCalledOnce();
    expect(proof.call).toHaveBeenCalledTimes(9);
    expect(
      proof.runQaCli.mock.calls.filter(([, args]) => args.includes("--execution")),
    ).toHaveLength(12);
  });

  it.each([
    ["raw-principal", "bounded redacted identity"],
    ["raw-room", "bounded redacted identity"],
    ["prompt-leak", "bounded redacted identity"],
    ["verified-generic", "bounded redacted identity"],
    ["same-person", "distinguish the additional participant"],
    ["changed-primary", "preserve the same primary person"],
    ["reused-context", "three distinct execution contexts"],
    ["restart-leak", "changed or exposed private references after restart"],
  ] satisfies Array<[Fault, string]>)("rejects %s evidence", async (fault, message) => {
    await expect(runIdentityFlow(fault).result).rejects.toThrow(message);
  });
});
