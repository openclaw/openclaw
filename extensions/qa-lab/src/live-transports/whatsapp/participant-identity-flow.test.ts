import { describe, expect, it } from "vitest";
import { createQaBusState } from "../../bus-state.js";
import { readQaScenarioById } from "../../scenario-catalog.js";
import { runLoadedScenarioFlow } from "../../scenario-flow-runner.test-support.js";

const scenarioId = "whatsapp-participant-identity-inspection";
const driverPhone = "+15550000001";
const groupJid = "120363000000000000@g.us";

type Failure =
  | "missing-group"
  | "extra-run"
  | "unknown-person"
  | "room-principal"
  | "wrong-run"
  | "wrong-execution"
  | "raw-phone"
  | "raw-group"
  | "verified-generic"
  | "different-person"
  | "missing-human"
  | "changed-after-restart";

async function runIdentityFlow(failure?: Failure) {
  const state = createQaBusState();
  const admittedRuns: string[] = ["previous-run"];
  const inspectedExecutions = new Set<string>();
  let restarted = false;
  const result = await runLoadedScenarioFlow(scenarioId, {
    state,
    api: {
      transport: {
        id: "whatsapp",
        reset: async () => state.reset(),
        sendInbound: async (input: Parameters<typeof state.addInboundMessage>[0]) =>
          state.addInboundMessage({ ...input, senderId: driverPhone }),
        waitForOutbound: async () => {
          const inbound = state.getSnapshot().messages.at(-1);
          if (!inbound || inbound.direction !== "inbound") {
            throw new Error("identity proof must send a transport turn before inspecting it");
          }
          const isGroup = inbound.conversation.kind === "group";
          expect(inbound.text.startsWith("openclawqa ")).toBe(isGroup);
          admittedRuns.push(isGroup ? "group-run" : "dm-run");
          if (failure === "extra-run") {
            admittedRuns.push("unrelated-new-run");
          }
          const marker = inbound.text.split("Reply exactly: ")[1];
          if (!marker) {
            throw new Error("identity proof must request an exact reply marker");
          }
          return state.addOutboundMessage({
            accountId: "sut",
            to: `${isGroup ? "group" : "dm"}:${inbound.conversation.id}`,
            text: marker,
          });
        },
      },
      env: {
        providerMode: "mock-openai",
        gateway: {
          restartAfterStateMutation: async (mutate: () => Promise<void>) => {
            await mutate();
            restarted = true;
          },
        },
      },
      // The real adapter prepares this from its lease; support tests never acquire one.
      whatsappScenarioContext: {
        runtimeEnv: {
          driverPhoneE164: driverPhone,
          sutPhoneE164: "+15550000002",
          ...(failure === "missing-group" ? {} : { groupJid }),
        },
      },
      runQaCli: async (_env: unknown, args: string[], options?: { json?: boolean }) => {
        if (args.includes("--kind")) {
          return { events: admittedRuns.map((runId) => ({ runId })) };
        }
        const exact = args.includes("--execution");
        const selector = args[args.indexOf(exact ? "--execution" : "--run") + 1];
        if (!selector) {
          throw new Error("identity proof must select a run or execution");
        }
        const runId = exact ? selector.replace("execution-", "") : selector;
        expect(admittedRuns).toContain(runId);
        expect(runId).not.toBe("previous-run");
        if (exact) {
          inspectedExecutions.add(selector);
        }
        if (!options?.json) {
          return failure === "missing-human"
            ? "Identity unavailable"
            : "Invoker [present]\nDecisions";
        }
        const isGroup = runId === "group-run";
        return {
          identity: {
            state: "present",
            context: {
              contextId: `context-${runId}`,
              executionId:
                failure === "wrong-execution" && exact
                  ? "unrelated-execution"
                  : `execution-${runId}`,
              runId: failure === "wrong-run" ? "unrelated-run" : runId,
              invoker: {
                state: failure === "unknown-person" ? "unknown" : "present",
                principal: {
                  kind: failure === "room-principal" ? "service" : "person",
                  principalRef:
                    (failure === "different-person" && isGroup) ||
                    (failure === "changed-after-restart" && restarted)
                      ? "principal:other-person"
                      : "principal:driver",
                },
              },
              ingress: { kind: "channel", state: "present" },
            },
          },
          decisionDisplays: [
            {
              action: { family: "decision", operation: "record" },
              provenance: {
                state: failure === "verified-generic" ? "verified" : "unverified",
              },
            },
          ],
          ...(failure === "raw-phone" ? { leakedReference: driverPhone.slice(1) } : {}),
          ...(failure === "raw-group" ? { leakedReference: groupJid } : {}),
        };
      },
    },
  });
  return { result, inspectedExecutions, restarted };
}

describe("WhatsApp participant identity executable flow", () => {
  it("selects the real transport lane and inspects both executions across restart", async () => {
    const scenario = readQaScenarioById(scenarioId);
    expect(scenario.execution).toMatchObject({
      kind: "flow",
      channel: "whatsapp",
      suiteIsolation: "isolated",
      config: { requiredChannelDriver: "live", requiredProviderMode: "mock-openai" },
    });
    expect(scenario.gatewayConfigPatch).toMatchObject({
      logging: { audit: { executionIdentity: true } },
    });
    const proof = await runIdentityFlow();
    expect(proof.result.status).toBe("pass");
    expect(proof.inspectedExecutions).toEqual(new Set(["execution-dm-run", "execution-group-run"]));
    expect(proof.restarted).toBe(true);
  });

  it.each([
    ["missing-group", "requires groupJid"],
    ["extra-run", "exactly one newly admitted run"],
    ["unknown-person", "retain the admitted person"],
    ["room-principal", "retain the admitted person"],
    ["wrong-run", "retain the admitted person"],
    ["wrong-execution", "must agree with run discovery"],
    ["raw-phone", "exclude raw route and participant references"],
    ["raw-group", "exclude raw route and participant references"],
    ["verified-generic", "keep generic decisions unverified"],
    ["different-person", "same participant"],
    ["missing-human", "must agree with run discovery"],
    ["changed-after-restart", "changed or exposed private references after restart"],
  ] satisfies Array<[Failure, string]>)("rejects %s evidence", async (failure, error) => {
    await expect(runIdentityFlow(failure)).rejects.toThrow(error);
  });
});
