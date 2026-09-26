import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  nestedToolActivityFixture,
  nestedToolHistoryFixture,
} from "../test/nested-tool-activity-fixture.js";
import {
  cleanupRuntimeToolFixtureTempRoots,
  makeEnv,
  runtimeToolFixtureConfig,
  runtimeToolFixtureDeps,
  writeRuntimeToolTranscripts,
} from "../test/runtime-tool-fixture-helpers.js";
import { runRuntimeToolFixture } from "./runtime-tool-fixture.js";

afterEach(async () => {
  // The session store keeps the state database open under the temporary root, so
  // Windows fails the removal with EBUSY unless the cached handle is released first.
  closeOpenClawAgentDatabasesForTest();
  resetPluginStateStoreForTests();
  await cleanupRuntimeToolFixtureTempRoots();
});

describe("nested runtime tool fixture", () => {
  it.each([
    {
      label: "correlated success and error",
      happyError: false,
      customType: "openclaw.nested-tool.v1",
      missingResult: false,
      missingRun: false,
    },
    {
      label: "failed happy receipt",
      happyError: true,
      customType: "openclaw.nested-tool.v1",
      missingResult: false,
      missingRun: false,
    },
    {
      label: "unrelated custom row",
      happyError: false,
      customType: "unrelated",
      missingResult: false,
      missingRun: false,
    },
    {
      label: "missing nested result",
      happyError: false,
      customType: "openclaw.nested-tool.v1",
      missingResult: true,
      missingRun: false,
    },
    {
      label: "missing nested run correlation",
      happyError: false,
      customType: "openclaw.nested-tool.v1",
      missingResult: false,
      missingRun: true,
    },
  ])("validates nested runtime evidence: $label", async (testCase) => {
    const { happyError, customType, missingResult, missingRun } = testCase;
    const env = await makeEnv();
    const receipt = (phase: "happy" | "failure") => {
      const params = {
        toolName: "web_fetch",
        toolCallId: `nested-${phase}`,
        input: { url: phase === "happy" ? "https://example.com/" : "file:///denied" },
        text: "completed",
        isError: phase === "failure" || happyError,
      };
      const activity = nestedToolActivityFixture(params);
      return {
        ...activity,
        customType,
        content:
          customType === "unrelated" ? nestedToolHistoryFixture(params).content : activity.content,
        details: {
          ...activity.details,
          runId: missingRun ? undefined : activity.details.runId,
          result: missingResult ? undefined : activity.details.result,
        },
      };
    };
    await writeRuntimeToolTranscripts(
      env,
      "web_fetch",
      [
        ...(!happyError && customType !== "unrelated" && !missingResult && !missingRun
          ? [
              {
                role: "toolResult",
                toolName: "unrelated",
                toolCallId: "nested-happy",
                isError: true,
                content: "failed unrelated tool",
              },
            ]
          : []),
        receipt("happy"),
      ],
      [receipt("failure")],
    );
    const result = runRuntimeToolFixture(
      env,
      runtimeToolFixtureConfig("web_fetch"),
      runtimeToolFixtureDeps({ tools: ["web_fetch"] }),
    );
    if (customType === "unrelated" || missingResult || missingRun) {
      await expect(result).rejects.toThrow("expected live happy-path tool call for web_fetch");
    } else if (happyError) {
      await expect(result).rejects.toThrow(
        "expected live happy-path successful tool output for web_fetch",
      );
    } else {
      await expect(result).resolves.toContain('"url":"https://example.com/"');
    }
  });
});
