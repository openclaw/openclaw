import { describe, expect, it } from "vitest";
import {
  readQaScenarioById,
  readQaScenarioExecutionConfig,
  validateQaScenarioExecutionConfig,
} from "./scenario-catalog.js";
import {
  agentRuntime,
  memory,
  requireFlowScenario,
} from "./scenario-catalog.test-support.js";

describe("qa scenario catalog", () => {
  it("adds a repo-instruction followthrough scenario to the parity pack", () => {
    const scenario = readQaScenarioById("instruction-followthrough-repo-contract");
    const config = readQaScenarioExecutionConfig("instruction-followthrough-repo-contract") as
      | {
          workspaceFiles?: Record<string, string>;
          prompt?: string;
          expectedReplyAll?: string[];
          expectedArtifactAll?: string[];
          expectedArtifactAny?: string[];
        }
      | undefined;

    expect(config?.workspaceFiles?.["AGENT.md"]).toContain("Step order:");
    expect(config?.workspaceFiles?.["SOUL.md"]).toContain("action-first");
    expect(config?.workspaceFiles?.["FOLLOWTHROUGH_INPUT.md"]).toContain(
      "Mission: prove you followed the repo contract.",
    );
    expect(config?.prompt).toContain("Repo contract followthrough check.");
    expect(scenario.execution.channel).toBe("qa-channel");
    expect(config?.expectedReplyAll).toEqual(["read:", "wrote:", "status:"]);
    expect(config?.expectedArtifactAll).toEqual(["repo contract"]);
    expect(config?.expectedArtifactAny).toContain("evidence path");
    expect(scenario.title).toBe("Instruction followthrough repo contract");
  });

  it("declares native QA-channel fixtures by channel", () => {
    const scenarioIds = [
      "instruction-followthrough-repo-contract",
      "subagent-forked-context",
      "subagent-handoff",
      "a2a-message-tool-mirror-dedupe",
      "group-message-tool-unavailable-fallback",
      "qa-channel-reconnect-dedupe",
      "reaction-edit-delete",
      "image-generation-roundtrip",
      "image-understanding-attachment",
      "native-image-generation",
      "goal-context-next-turn",
      "goal-context-survives-compaction",
      "goal-followthrough-live",
      "active-memory-preprompt-recall",
      "remember-across-conversations",
      "memory-recall",
      "session-memory-ranking",
      "thread-memory-isolation",
      "personal-channel-thread-reply",
      "personal-memory-preference-recall",
      "personal-reminder-roundtrip",
      "cron-condition-watcher",
      "cron-natural-fire-no-duplicate",
      "cron-one-minute-ping",
      "cron-single-run-no-duplicate",
      "control-ui-qa-channel-image-roundtrip",
      "control-ui-assistant-transcript-role-boundary",
      "config-apply-restart-wakeup",
    ];

    for (const scenarioId of scenarioIds) {
      expect(readQaScenarioById(scenarioId).execution.channel, scenarioId).toBe("qa-channel");
    }
  });

  it("keeps portable thread relation flows free of a channel requirement", () => {
    for (const scenarioId of ["thread-follow-up", "thread-isolation"]) {
      const scenario = readQaScenarioById(scenarioId);

      expect(scenario.execution.channel, scenarioId).toBeUndefined();
      expect(Object.keys(scenario.execution.profiles ?? {}), scenarioId).toEqual(
        expect.arrayContaining(["matrix:adapter", "slack:adapter"]),
      );
    }
  });

  it("keeps Matrix subagent thread spawn explicitly selectable", () => {
    const scenario = readQaScenarioById("subagent-thread-spawn");

    expect(scenario.execution.channel).toBe("matrix");
  });

  it("keeps the Control UI transcript role boundary in the mock lane", () => {
    const scenario = requireFlowScenario(
      readQaScenarioById("control-ui-assistant-transcript-role-boundary"),
    );

    expect(scenario.execution.providerMode).toBe("mock-openai");
  });

  it("keeps remember-across-conversations isolated and product-only", () => {
    const scenario = requireFlowScenario(readQaScenarioById("remember-across-conversations"));
    const config = readQaScenarioExecutionConfig("remember-across-conversations") as
      | { requiredChannelDriver?: string }
      | undefined;

    expect(scenario.execution.suiteIsolation).toBe("isolated");
    expect(config?.requiredChannelDriver).toBe("qa-channel");
    expect(scenario.gatewayConfigPatch).toMatchObject({
      session: { dmScope: "per-channel-peer" },
      memory: { search: { rememberAcrossConversations: true } },
      plugins: {
        entries: {
          "active-memory": {
            enabled: true,
            config: { enabled: true, agents: [] },
          },
        },
      },
    });
  });

  it("routes native command session targeting through Crabline Telegram", () => {
    const scenario = readQaScenarioById("native-command-session-target");
    const config = readQaScenarioExecutionConfig("native-command-session-target") as
      | {
          requiredProviderMode?: string;
        }
      | undefined;

    expect(scenario.execution.channel).toBe("telegram");
    expect(config?.requiredProviderMode).toBe("mock-openai");
  });

  it("keeps channel-owned scenarios independent from the driver implementation", () => {
    const channelByScenarioId = new Map([
      ["slack-restart-resume", "slack"],
      ["whatsapp-restart-resume", "whatsapp"],
      ["whatsapp-access-control-dm-disabled", "whatsapp"],
      ["whatsapp-access-control-dm-open", "whatsapp"],
      ["whatsapp-access-control-group-disabled", "whatsapp"],
      ["whatsapp-access-control-group-open", "whatsapp"],
      ["whatsapp-pairing-block", "whatsapp"],
      ["matrix-allowlist-hot-reload", "matrix"],
    ]);

    for (const [scenarioId, channel] of channelByScenarioId) {
      expect(readQaScenarioById(scenarioId).execution.channel, scenarioId).toBe(channel);
    }
  });

  it("isolates scenarios that own asynchronous transport state", () => {
    const channelBaseline = requireFlowScenario(readQaScenarioById("channel-chat-baseline"));
    const subagentFanout = requireFlowScenario(readQaScenarioById("subagent-fanout-synthesis"));

    expect(channelBaseline.execution.suiteIsolation).toBe("isolated");
    expect(subagentFanout.execution.suiteIsolation).toBe("isolated");
  });

  it("settles subagent completions before reading the SQLite session store", () => {
    const scenario = requireFlowScenario(readQaScenarioById("subagent-fanout-synthesis"));
    const flow = JSON.stringify(scenario.execution.flow);
    const completionWaits = [...flow.matchAll(/expectedChildCompletionMarkers/gu)].map(
      (match) => match.index,
    );
    const storeReads = [...flow.matchAll(/readRawQaSessionStore/gu)].map((match) => match.index);

    expect(completionWaits).toHaveLength(2);
    expect(storeReads).toHaveLength(2);
    expect(completionWaits.every((wait, index) => wait < (storeReads[index] ?? -1))).toBe(true);
  });

  it("adds a dreaming shadow trial report scenario", () => {
    const scenario = readQaScenarioById("dreaming-shadow-trial-report");
    const config = readQaScenarioExecutionConfig("dreaming-shadow-trial-report") as
      | {
          prompt?: string;
          reportName?: string;
          expectedReportAll?: string[];
          forbiddenReplyNeedles?: string[];
          seededMemory?: string;
        }
      | undefined;
    const flow = JSON.stringify(scenario.execution.flow);

    expect(scenario.coverage?.primary).toEqual([`${memory}.memory-files-dreaming`]);
    expect(scenario.coverage?.secondary).toEqual([
      `${memory}.memory-files-promotion`,
      `${memory}.memory-files-artifact-safety`,
    ]);
    expect(config?.expectedReportAll).toContain("verdict: helpful");
    expect(config?.expectedReportAll).toContain("exact verification commands and remaining risk");
    expect(config?.expectedReportAll).toContain("omits the exact command and remaining risk");
    expect(config?.expectedReportAll).toContain("calls out the remaining review risk");
    expect(config?.forbiddenReplyNeedles).toContain("candidate was promoted to MEMORY.md");
    expect(flow).toContain("plannedToolName === 'write'");
    expect(flow).toContain("readIndices[1] < firstWrite");
    expect(flow).toContain("String(memoryAfter) === config.seededMemory");
  });

  it("enables Telegram previews for channel streaming evidence", () => {
    const scenario = readQaScenarioById("channel-message-flows");

    expect(scenario.coverage?.primary).toEqual([`${agentRuntime}.streaming-replies`]);
    expect(scenario.coverage?.secondary).toEqual([`${agentRuntime}.streaming-replies-delivery`]);
    expect(scenario.gatewayConfigPatch).toMatchObject({
      channels: { telegram: { streaming: { mode: "partial" } } },
    });
  });

  it("rejects malformed string matcher lists before running a flow", () => {
    expect(() =>
      validateQaScenarioExecutionConfig({
        gracefulFallbackAny: [{ confirmed: "the hidden fact is present" }],
      }),
    ).toThrow(/gracefulFallbackAny entries must be strings/);
  });

  it("returns undefined execution config for an unknown scenario id", () => {
    expect(readQaScenarioExecutionConfig("missing-scenario-id")).toBeUndefined();
  });
});
