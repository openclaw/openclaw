import fs from "node:fs/promises";
import "./dynamic-tool-build.test-support.js";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";

const { buildDynamicToolsForTest, createCodexRuntimePlanFixture, createParams, hoisted } =
  await import("./dynamic-tool-build.test-support.js");
type OpenClawCodingToolsOptionsForTest = NonNullable<
  Parameters<Parameters<typeof setCodexTestToolFactory>[1]>[0]
>;

describe("Codex app-server dynamic tool question prompts", () => {
  let tempDir: string;

  beforeEach(async () => {
    hoisted.loadNodeExecAvailability.mockResolvedValue({
      cacheKey: "eligible",
      isAvailable: () => true,
    });
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-prompts-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it.each<[string, string | undefined, string | undefined, string | undefined, boolean]>([
    ["provider-only Telegram", undefined, "telegram", "telegram", true],
    ["explicit Telegram", "telegram", undefined, "telegram", true],
    ["explicit Telegram before another provider", "telegram", "discord", "telegram", true],
    ["explicit webchat before Telegram provider", "webchat", "telegram", "webchat", true],
    ["both channels absent", undefined, undefined, undefined, true],
    ["callback absent", undefined, "telegram", "telegram", false],
  ])(
    "hands the question tools this run's own way to show a prompt: %s",
    async (_name, messageChannel, messageProvider, expectedChannel, hasCallback) => {
      // Codex dispatches dynamic tools itself, so no tool-start handler reserves the
      // prompt for a blocking question. Without this the question is never shown and
      // the turn waits out its full timeout.
      const workspaceDir = path.join(tempDir, "question-prompt-workspace");
      const params = createParams(
        path.join(tempDir, "question-prompt-session.jsonl"),
        workspaceDir,
      );
      params.disableTools = false;
      params.runtimePlan = createCodexRuntimePlanFixture();
      params.messageChannel = messageChannel;
      params.messageProvider = messageProvider;
      const onToolResult = vi.fn();
      params.onToolResult = hasCallback ? onToolResult : undefined;
      let capturedQuestionPrompt: OpenClawCodingToolsOptionsForTest["questionPrompt"];
      setCodexTestToolFactory(params, (options) => {
        capturedQuestionPrompt = options?.questionPrompt;
        return [];
      });

      await buildDynamicToolsForTest(params, workspaceDir);

      if (!hasCallback) {
        expect(capturedQuestionPrompt).toBeUndefined();
        return;
      }
      expect(capturedQuestionPrompt?.send).toBe(onToolResult);
      expect(capturedQuestionPrompt?.messageChannel).toBe(expectedChannel);
      await expectDefined(capturedQuestionPrompt, "captured question prompt").send({
        text: "Question for you:",
      });
      expect(onToolResult).toHaveBeenCalledExactlyOnceWith({ text: "Question for you:" });
    },
  );
});
