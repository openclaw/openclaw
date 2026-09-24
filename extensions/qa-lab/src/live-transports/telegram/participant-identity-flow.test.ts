import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "../../bus-state.js";
import { readQaScenarioById, readQaScenarioPack } from "../../scenario-catalog.js";
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
  | "wrong-transport"
  | "wrong-provider"
  | "missing-fixture"
  | "missing-participant"
  | "duplicate-alias"
  | "missing-topic"
  | "wrong-topic"
  | "extra-run"
  | "unknown-person"
  | "room-principal"
  | "wrong-run"
  | "raw-principal"
  | "missing-assurance"
  | "raw-room"
  | "prompt-leak"
  | "oversized-context"
  | "verified-generic"
  | "wrong-cli-execution"
  | "missing-human"
  | "same-person"
  | "changed-primary"
  | "reused-context"
  | "restart-drift"
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
          contextId:
            fault === "reused-context"
              ? "context-first"
              : restarted && fault === "restart-drift"
                ? "context-replacement"
                : `context-${runId}`,
          executionId: `execution-${runId}`,
          runId: fault === "wrong-run" ? "unrelated-run" : runId,
          invoker: {
            state: fault === "unknown-person" ? "unknown" : "present",
            principal: {
              kind: fault === "room-principal" ? "service" : "person",
              principalRef,
              domainRef: hmac("a"),
            },
          },
          // Channel admission supplies no rawSourceRef; do not invent one in proof support.
          ingress: { kind: "channel", state: "present" },
          runtimeInstance: { runtimeRef: hmac("e") },
          assurance:
            fault === "missing-assurance"
              ? []
              : [
                  {
                    kind: "channel-admission",
                    strength: "boundary-verified",
                    evidenceRef: hmac("d"),
                  },
                ],
          applicableGrants: [],
          ...(fault === "oversized-context" ? { padding: "x".repeat(16384) } : {}),
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
      return fault === "missing-human"
        ? "Identity unavailable"
        : `Invoker [present] ${inspection.identity.context.invoker.principal.principalRef}\nDecisions`;
    }
    return fault === "wrong-cli-execution"
      ? { ...inspection, run: { ...inspection.run, executionId: "foreign-execution" } }
      : inspection;
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
          providerMode: fault === "wrong-provider" ? "live-frontier" : "mock-openai",
          gateway: { call, restartAfterStateMutation: restart },
        },
        // Only the adapter's prepared, noncredential surface is supplied here.
        telegramIdentityFixture:
          fault === "missing-fixture"
            ? undefined
            : {
                participantAliases:
                  fault === "missing-participant"
                    ? ["primary"]
                    : ["primary", fault === "duplicate-alias" ? "primary" : "guest"],
                forumTopicId: fault === "missing-topic" ? undefined : forumTopicId,
              },
        readTelegramMessages: () => nativeReplies,
        transport: {
          id: fault === "wrong-transport" ? "qa-channel" : "telegram",
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
            if (fault === "extra-run") {
              admittedRuns.push("unrelated-new-run");
            }
            nativeReplies.push({
              text: input.textIncludes,
              chatId: forum ? forumGroupId : botId,
              senderId: botId,
              ...(forum
                ? { forumTopicId: fault === "wrong-topic" ? forumTopicId + 1 : forumTopicId }
                : {}),
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
  it("catalogs live participant identity qualification with the fixture gate", () => {
    const scenarios = readQaScenarioPack().scenarios.filter(
      (scenario) =>
        scenario.execution.kind === "flow" &&
        scenario.execution.channels?.includes("telegram") &&
        scenario.execution.config?.requiredChannelDriver === "live" &&
        scenario.execution.config.requireParticipantIdentityFixture === true,
    );
    expect(scenarios.map((scenario) => scenario.id)).toContain(scenarioId);
    expect(
      resolveTelegramQaScenarioIds({ providerMode: "mock-openai", scenarioIds: [scenarioId] }),
    ).toEqual([scenarioId]);
    const scenario = readQaScenarioById(scenarioId);
    expect(scenario.execution).toMatchObject({ suiteIsolation: "isolated", retryCount: 0 });
    expect(scenario.gatewayConfigPatch).toMatchObject({
      logging: { audit: { enabled: true, executionIdentity: true } },
    });
    expect(
      selectQaFlowSuiteScenarios({
        scenarios: [scenario],
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
    expect(proof.call.mock.calls.map(([, selector]) => selector)).toEqual([
      { runId: "run-1", decisionLimit: 100 },
      { executionId: "execution-run-1", decisionLimit: 100 },
      { runId: "run-2", decisionLimit: 100 },
      { executionId: "execution-run-2", decisionLimit: 100 },
      { runId: "run-3", decisionLimit: 100 },
      { executionId: "execution-run-3", decisionLimit: 100 },
      { executionId: "execution-run-1", decisionLimit: 100 },
      { executionId: "execution-run-2", decisionLimit: 100 },
      { executionId: "execution-run-3", decisionLimit: 100 },
    ]);
    expect(
      proof.runQaCli.mock.calls.filter(([, args]) => args.includes("--execution")),
    ).toHaveLength(12);
  });

  it.each([
    ["wrong-transport", "requires the live Telegram adapter"],
    ["wrong-provider", "requires the live Telegram adapter"],
    ["missing-fixture", "requires distinct participant aliases"],
    ["missing-participant", "requires distinct participant aliases"],
    ["duplicate-alias", "requires distinct participant aliases"],
    ["missing-topic", "requires distinct participant aliases"],
    ["wrong-topic", "requested DM or leased forum topic"],
    ["extra-run", "exactly one newly admitted run"],
    ["unknown-person", "retain the admitted person"],
    ["room-principal", "retain the admitted person"],
    ["wrong-run", "retain the admitted person"],
    ["raw-principal", "bounded redacted identity"],
    ["missing-assurance", "bounded redacted identity"],
    ["raw-room", "bounded redacted identity"],
    ["prompt-leak", "bounded redacted identity"],
    ["oversized-context", "bounded redacted identity"],
    ["verified-generic", "bounded redacted identity"],
    ["wrong-cli-execution", "must agree with run discovery"],
    ["missing-human", "must agree with run discovery"],
    ["same-person", "distinguish the additional participant"],
    ["changed-primary", "preserve the same primary person"],
    ["reused-context", "three distinct execution contexts"],
    ["restart-drift", "changed or exposed private references after restart"],
    ["restart-leak", "changed or exposed private references after restart"],
  ] satisfies Array<[Fault, string]>)("rejects %s evidence", async (fault, message) => {
    await expect(runIdentityFlow(fault).result).rejects.toThrow(message);
  });
});
