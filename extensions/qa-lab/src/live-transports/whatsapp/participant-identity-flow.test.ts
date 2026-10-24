import assert from "node:assert/strict";
import { expect, it } from "vitest";
import { createQaBusState } from "../../bus-state.js";
import { readQaScenarioById } from "../../scenario-catalog.js";
import { runLoadedScenarioFlow } from "../../scenario-flow-runner.test-support.js";
import { groupJid, phones } from "./runtime.test-support.js";

const scenarioId = "whatsapp-participant-identity-inspection";
const driverPhone = phones.driverPhoneE164;

const invalidEvidence = [
  ["missing-group", "requires groupJid"],
  ["extra-run", "exactly one newly admitted run"],
  ["unknown-person", "retain the admitted person"],
  ["room-principal", "retain the admitted person"],
  ["wrong-run", "retain the admitted person"],
  ["wrong-dm-execution", "must agree with run discovery"],
  ["wrong-group-execution", "must agree with run discovery"],
  ["raw-phone", "exclude raw route and participant references"],
  ["raw-group", "exclude raw route and participant references"],
  ["verified-generic", "keep generic decisions unverified"],
  ["different-person", "same participant"],
  ["missing-human", "must agree with run discovery"],
  ["changed-after-restart", "changed or exposed private references after restart"],
] as const;
type Failure = (typeof invalidEvidence)[number][0];

async function runIdentityFlow(failure?: Failure) {
  const state = createQaBusState();
  const admittedRuns: string[] = ["previous-run"];
  let restarted = false;
  const gateway = {
    restartAfterStateMutation: async (mutate: () => Promise<void>) => {
      await mutate();
      restarted = true;
    },
  };
  const runtimeEnv = { ...phones, ...(failure === "missing-group" ? {} : { groupJid }) };
  return runLoadedScenarioFlow(scenarioId, {
    state,
    api: {
      transport: {
        id: "whatsapp",
        reset: async () => state.reset(),
        sendInbound: async (input: Parameters<typeof state.addInboundMessage>[0]) =>
          state.addInboundMessage({ ...input, senderId: driverPhone }),
        waitForOutbound: async () => {
          const inbound = state.getSnapshot().messages.at(-1);
          assert(inbound?.direction === "inbound", "Expected an inbound turn before inspection");
          const isGroup = inbound.conversation.kind === "group";
          expect(inbound.text.startsWith("openclawqa ")).toBe(isGroup);
          admittedRuns.push(isGroup ? "group-run" : "dm-run");
          admittedRuns.push(...(failure === "extra-run" ? ["unrelated-new-run"] : []));
          const marker = inbound.text.split("Reply exactly: ")[1];
          assert(marker, "Missing exact reply marker");
          return state.addOutboundMessage({
            accountId: "sut",
            to: `${isGroup ? "group" : "dm"}:${inbound.conversation.id}`,
            text: marker,
          });
        },
      },
      env: { providerMode: "mock-openai", gateway },
      whatsappScenarioContext: { runtimeEnv },
      runQaCli: async (_env: unknown, args: string[], options?: { json?: boolean }) => {
        if (args.includes("--kind")) {
          return { events: admittedRuns.map((runId) => ({ runId })) };
        }
        const exact = args.includes("--execution");
        const selector = args[args.indexOf(exact ? "--execution" : "--run") + 1];
        assert(selector, "Missing run or execution selector");
        const runId = exact ? selector.replace("execution-", "") : selector;
        expect(admittedRuns.slice(1)).toContain(runId);
        if (!options?.json) {
          return failure === "missing-human" ? "" : "Invoker [present]\nDecisions";
        }
        const otherPerson =
          (failure === "different-person" && runId === "group-run") ||
          (failure === "changed-after-restart" && restarted);
        const principal = {
          kind: failure === "room-principal" ? "service" : "person",
          principalRef: otherPerson ? "principal:other-person" : "principal:driver",
        };
        const provenance = { state: failure === "verified-generic" ? "verified" : "unverified" };
        const context = {
          contextId: `context-${runId}`,
          executionId:
            exact &&
            failure === (runId === "dm-run" ? "wrong-dm-execution" : "wrong-group-execution")
              ? "other"
              : `execution-${runId}`,
          runId: failure === "wrong-run" ? "unrelated-run" : runId,
          invoker: { state: failure === "unknown-person" ? "unknown" : "present", principal },
          ingress: { kind: "channel", state: "present" },
        };
        return {
          identity: { state: "present", context },
          decisionDisplays: [{ action: { family: "decision" }, provenance }],
          ...(failure === "raw-phone" ? { leakedReference: driverPhone.slice(1) } : {}),
          ...(failure === "raw-group" ? { leakedReference: groupJid } : {}),
        };
      },
    },
  });
}

it("selects the real transport lane and inspects both executions across restart", async () => {
  expect(readQaScenarioById(scenarioId)).toMatchObject({
    execution: {
      channel: "whatsapp",
      suiteIsolation: "isolated",
      config: { requiredChannelDriver: "live", requiredProviderMode: "mock-openai" },
    },
    gatewayConfigPatch: { logging: { audit: { executionIdentity: true } } },
  });
  await expect(runIdentityFlow()).resolves.toMatchObject({ status: "pass" });
});

it.each(invalidEvidence)("rejects %s evidence", async (failure, error) => {
  await expect(runIdentityFlow(failure)).rejects.toThrow(error);
});
