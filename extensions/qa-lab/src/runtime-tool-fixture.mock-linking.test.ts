import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupRuntimeToolFixtureTempRoots,
  mockToolRequests,
  runMockRuntimeToolFixture,
  runtimePatchAddInput,
  runtimePatchUpdateInput,
  simulateRuntimePatchHappyTurn,
} from "../test/runtime-tool-fixture-helpers.js";

afterEach(cleanupRuntimeToolFixtureTempRoots);

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
    const requests = [
      {
        allInputText: "target=read",
        plannedToolCallId: "call-read-happy",
        plannedToolName: "read",
        plannedToolArgs: { path: "README.md" },
        toolOutputCallId: "call-write-previous",
        toolOutput: "previous write output",
      },
      {
        allInputText: "failure target=read",
        plannedToolCallId: "call-read-failure",
        plannedToolName: "read",
        plannedToolArgs: { path: "/missing" },
      },
      {
        allInputText: "failure target=read",
        toolOutputCallId: "call-read-failure",
        toolOutput: "ENOENT: no such file or directory",
      },
    ];

    await expect(runMockRuntimeToolFixture({ requests })).rejects.toThrow(
      "expected mock happy-path tool output for read",
    );
  });
});
