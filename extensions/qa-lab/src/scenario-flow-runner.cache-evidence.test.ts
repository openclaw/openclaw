import { describe, expect, it } from "vitest";
import { readQaScenarioById, type QaScenarioFlow } from "./scenario-catalog.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

const scenarioId = "runtime-long-context-cache-stability";
const evidenceLine =
  "CACHE-FIXTURE-0050: stable tool-result evidence for prompt-cache reuse across long sessions.";

async function checkCacheEvidence(
  marker: string,
  options: {
    callId?: string;
    toolName?: string;
    path?: string;
    inputMarker?: string;
    readEvidence?: string;
    followupEvidence?: string;
  } = {},
) {
  const scenario = readQaScenarioById(scenarioId);
  const actions = scenario.execution.flow?.steps[0]?.actions;
  const start =
    actions?.findIndex(
      (action) =>
        typeof action === "object" &&
        action !== null &&
        "set" in action &&
        action.set === "cappedReadOutputIndex",
    ) ?? -1;
  if (!actions || start < 0) {
    throw new Error("cache scenario has no evidence assertion");
  }
  const output = [options.readEvidence ?? evidenceLine, marker, "fixture tail"].join("\n");
  const flow: QaScenarioFlow = {
    steps: [
      {
        name: "checks actual capped read and follow-up evidence",
        actions: [
          {
            set: "debugRequests",
            value: [
              {
                plannedToolCallId: "read-1",
                plannedToolName: options.toolName ?? "read",
                plannedToolArgs: { path: options.path ?? "large-cache-fixture.txt" },
              },
              {
                toolOutputCallId: options.callId ?? "read-1",
                toolOutput: output,
                allInputText: [output, options.inputMarker ?? ""].join("\n"),
              },
              {
                prompt: "Using the already-read large-cache-fixture.txt",
                allInputText: options.followupEvidence ?? evidenceLine,
              },
            ],
          },
          ...actions.slice(start),
        ],
      },
    ],
  };
  return await runLoadedScenarioFlow(scenarioId, { flow, api: { env: { mock: {} } } });
}

describe("large read cache evidence", () => {
  it.each([
    "…12345 tokens truncated…",
    "…12345 chars truncated…",
    "Warning: truncated output (original token count: 20000)\n…12345 tokens truncated…",
    "[Read output capped at 50KB]",
    "...(OpenClaw truncated dynamic tool result: original 100000 chars)",
    "...(truncated)...",
  ])("accepts a capped result with native marker %s", async (marker) => {
    await expect(checkCacheEvidence(marker)).resolves.toMatchObject({ status: "pass" });
  });

  it.each(["", "tokens truncated", "…0 tokens truncated…", "…many tokens truncated…"])(
    "rejects absent or malformed truncation evidence %s",
    async (marker) => {
      await expect(checkCacheEvidence(marker)).rejects.toThrow(
        "large capped read cache evidence was not observed",
      );
    },
  );

  it("rejects a native marker found only in surrounding prompt text", async () => {
    await expect(
      checkCacheEvidence("", { inputMarker: "…12345 tokens truncated…" }),
    ).rejects.toThrow("large capped read cache evidence was not observed");
  });

  it.each([
    { callId: "another-read" },
    { toolName: "exec" },
    { path: "another-fixture.txt" },
    { readEvidence: "unrelated output" },
    { followupEvidence: "no retained tool result" },
  ])("retains read correlation and follow-up requirements: %j", async (options) => {
    await expect(checkCacheEvidence("…12345 tokens truncated…", options)).rejects.toThrow(
      "large capped read cache evidence was not observed",
    );
  });
});
