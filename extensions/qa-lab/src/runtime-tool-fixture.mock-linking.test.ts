import { afterAll, describe, expect, it, vi } from "vitest";
import {
  cleanupRuntimeToolFixtureTempRoots,
  mockToolRequests,
  runMockRuntimeToolFixture,
  runtimePatchAddInput,
  runtimePatchUpdateInput,
  simulateRuntimePatchHappyTurn,
} from "../test/runtime-tool-fixture-helpers.js";

afterAll(cleanupRuntimeToolFixtureTempRoots);

describe("runtime tool fixture mock request linking", () => {
  it("rejects unrelated tool output after a planned mock runtime tool call", async () => {
    await expect(
      runMockRuntimeToolFixture({
        requests: mockToolRequests({
          happyOutputCallId: "call-write-happy",
          happyOutput: "README contents from some other tool",
        }),
      }),
    ).rejects.toThrow("expected mock happy-path tool output for read");
  });

  it.each([false, true])(
    "validates the linked mock patch after an unlinked plan (combined request: %s)",
    async (combinedRequest) => {
      const requests = mockToolRequests({
        toolName: "apply_patch",
        happyArgs: { input: runtimePatchAddInput() },
        failureArgs: { input: runtimePatchUpdateInput() },
        happyOutput: "Successfully applied patch",
        failureOutput: "Error: Path escapes sandbox root",
      });
      await expect(
        runMockRuntimeToolFixture({
          toolName: "apply_patch",
          requests: [
            {
              allInputText: "target=apply_patch",
              plannedToolCallId: "unlinked-decoy",
              plannedToolName: "apply_patch",
              plannedToolArgs: { input: runtimePatchAddInput("runtime-tool-fixture-wrong.txt") },
            },
            ...(combinedRequest
              ? [{ ...requests[0], ...requests[1] }, ...requests.slice(2)]
              : requests),
          ],
          runAgentPrompt: vi.fn(simulateRuntimePatchHappyTurn),
        }),
      ).resolves.toContain("apply_patch mock provider happy planned args");
    },
  );

  it("rejects mismatched planned and output call ids on the same mock request", async () => {
    const requests = mockToolRequests({});
    await expect(
      runMockRuntimeToolFixture({
        requests: [
          {
            ...requests[0],
            toolOutputCallId: "call-write-previous",
            toolOutput: "previous write output",
          },
          ...requests.slice(2),
        ],
      }),
    ).rejects.toThrow("expected mock happy-path tool output for read");
  });
  it.each([
    ["happy-path file", runtimePatchAddInput("runtime-tool-fixture-wrong.txt"), undefined],
    ["failure-path file", undefined, runtimePatchUpdateInput("../runtime-tool-fixture-wrong.txt")],
    [
      "failure-path context",
      undefined,
      runtimePatchUpdateInput("../runtime-tool-fixture-denied.txt", "context-that-does-not-exist"),
    ],
    [
      "failure-path operation",
      undefined,
      runtimePatchUpdateInput().replace("*** Update File:", "*** Add File:"),
    ],
    [
      "failure-path replacement",
      undefined,
      runtimePatchUpdateInput().replace(
        "+runtime patch outside the workspace",
        "+incorrect replacement",
      ),
    ],
  ])(
    "rejects linked mock patch evidence for the wrong %s",
    async (_label, happyInput, failureInput) => {
      await expect(
        runMockRuntimeToolFixture({
          toolName: "apply_patch",
          requests: mockToolRequests({
            toolName: "apply_patch",
            happyArgs: { input: happyInput ?? runtimePatchAddInput() },
            failureArgs: { input: failureInput ?? runtimePatchUpdateInput() },
            happyOutput: "Successfully applied patch",
            failureOutput: "Error: Path escapes sandbox root",
          }),
          runAgentPrompt: vi.fn(simulateRuntimePatchHappyTurn),
        }),
      ).rejects.toThrow(
        happyInput
          ? "expected linked mock apply_patch to add runtime-tool-fixture-patch.txt"
          : "expected linked mock apply_patch to update ../runtime-tool-fixture-denied.txt",
      );
    },
  );
});
