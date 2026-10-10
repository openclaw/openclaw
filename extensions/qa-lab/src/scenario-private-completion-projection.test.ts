import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it } from "vitest";
import { readQaScenarioById } from "./scenario-catalog.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

function projectionActions() {
  const scenario = readQaScenarioById("subagent-completion-direct-fallback");
  const guarded = scenario.execution.flow?.steps[0]?.actions
    .map((action) => (isRecord(action) ? action.try : undefined))
    .find(isRecord);
  if (!Array.isArray(guarded?.actions)) {
    throw new Error("missing terminal scenario body");
  }
  const start = guarded.actions.findIndex(
    (action) => isRecord(action) && action.set === "privateCompletionProjection",
  );
  if (start < 0) {
    throw new Error("missing private completion projection");
  }
  return guarded.actions.slice(start, start + 2);
}

async function replay(fault?: string) {
  const generic = "Continue the OpenClaw runtime event.";
  const runtime =
    "OpenClaw runtime context:\n[Internal task completion event]\nQA-PARENT-PRIVATE-CHILD1-0123456789ABCDEF0123456789ABCDEF\nMEDIA:qa-private-result.png";
  return runLoadedScenarioFlow("subagent-completion-direct-fallback", {
    flow: {
      steps: [{ name: "compatible Responses private completion", actions: projectionActions() }],
    },
    api: {
      privateRuns: [{ childSessionKey: "child" }],
      privateSpawns: [
        {},
        {
          body: {
            input: [
              { role: "developer", content: "Ordinary system instructions." },
              {
                role: "user",
                content: fault === "leak" ? generic + " MEDIA:private.png" : generic,
              },
              ...(fault === "missing"
                ? []
                : [
                    {
                      role: fault === "promotion" ? "developer" : "user",
                      content: [
                        {
                          type: "input_text",
                          text:
                            fault === "media"
                              ? runtime.replace("MEDIA:qa-private-result.png", "")
                              : runtime,
                        },
                      ],
                    },
                  ]),
            ],
          },
        },
      ],
    },
  });
}

describe("private completion projection on compatible Responses endpoints", () => {
  it("accepts a separate user-role runtime carrier without exposing it as the user turn", async () => {
    await expect(replay()).resolves.toMatchObject({ status: "pass" });
  });

  it.each(["promotion", "leak", "missing", "media"])("rejects %s drift", async (fault) => {
    await expect(replay(fault)).rejects.toThrow("The private completion was not split");
  });
});
