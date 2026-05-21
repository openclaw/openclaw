import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { testing, runSlackQaLive } from "./slack-live.runtime.js";

describe("Slack live QA runtime helpers", () => {
  it("resolves env credential payloads", () => {
    expect(
      testing.resolveSlackQaRuntimeEnv({
        OPENCLAW_QA_SLACK_CHANNEL_ID: "C123456789",
        OPENCLAW_QA_SLACK_DRIVER_BOT_TOKEN: "xoxb-driver",
        OPENCLAW_QA_SLACK_SUT_BOT_TOKEN: "xoxb-sut",
        OPENCLAW_QA_SLACK_SUT_APP_TOKEN: "xapp-sut",
      }),
    ).toEqual({
      channelId: "C123456789",
      driverBotToken: "xoxb-driver",
      sutBotToken: "xoxb-sut",
      sutAppToken: "xapp-sut",
    });
  });

  it("rejects malformed Slack channel ids", () => {
    expect(() =>
      testing.resolveSlackQaRuntimeEnv({
        OPENCLAW_QA_SLACK_CHANNEL_ID: "qa-channel",
        OPENCLAW_QA_SLACK_DRIVER_BOT_TOKEN: "xoxb-driver",
        OPENCLAW_QA_SLACK_SUT_BOT_TOKEN: "xoxb-sut",
        OPENCLAW_QA_SLACK_SUT_APP_TOKEN: "xapp-sut",
      }),
    ).toThrow("OPENCLAW_QA_SLACK channelId must be a Slack id like C123 or U123.");
  });

  it("parses Convex credential payloads", () => {
    expect(
      testing.parseSlackQaCredentialPayload({
        channelId: "C123456789",
        driverBotToken: "xoxb-driver",
        sutBotToken: "xoxb-sut",
        sutAppToken: "xapp-sut",
      }),
    ).toEqual({
      channelId: "C123456789",
      driverBotToken: "xoxb-driver",
      sutBotToken: "xoxb-sut",
      sutAppToken: "xapp-sut",
    });
  });

  it("reports standard live transport scenario coverage", () => {
    expect(testing.SLACK_QA_STANDARD_SCENARIO_IDS).toEqual([
      "canary",
      "mention-gating",
      "allowlist-block",
      "top-level-reply-shape",
      "restart-resume",
      "thread-follow-up",
      "thread-isolation",
    ]);
  });

  it("selects Slack scenarios by id", () => {
    expect(testing.findScenario(["slack-canary"]).map((scenario) => scenario.id)).toEqual([
      "slack-canary",
    ]);
  });

  it("formats the canary as a ping/pong marker exchange", () => {
    const scenario = testing.findScenario(["slack-canary"])[0];
    const run = scenario?.buildRun("U999999999");
    expect(run?.input).toContain("ping SLACK_QA_PING_");
    expect(run?.input).not.toContain("<@U999999999>");
    expect(run?.input).toContain("PONG_SLACK_QA_PING_");
    expect(run?.matchText).toContain("PONG_SLACK_QA_PING_");
    expect(run?.beforeRun).toBeTypeOf("function");
    expect(run?.replySearchMode).toBe("channel");
    expect(scenario?.configOverrides?.requireMention).toBe(false);
  });

  it("injects low-noise Slack RTT config", () => {
    const baseCfg: OpenClawConfig = {
      plugins: {
        allow: ["memory-core"],
        entries: {
          "memory-core": { enabled: true },
        },
      },
      messages: {
        inbound: {
          debounceMs: 5_000,
          byChannel: {
            discord: 750,
          },
        },
        statusReactions: { enabled: true },
      },
    };

    const next = testing.buildSlackQaConfig(baseCfg, {
      channelId: "C123456789",
      driverBotUserId: "U123456789",
      overrides: { requireMention: false },
      sutAccountId: "sut",
      sutAppToken: "xapp-sut",
      sutBotToken: "xoxb-sut",
    });

    expect(next.plugins?.allow).toContain("slack");
    expect(next.messages?.ackReactionScope).toBe("off");
    expect(next.messages?.inbound?.debounceMs).toBe(5_000);
    expect(next.messages?.inbound?.byChannel).toEqual({
      discord: 750,
      slack: 0,
    });
    expect(next.messages?.statusReactions?.enabled).toBe(false);
    expect(next.messages?.groupChat?.visibleReplies).toBe("automatic");
    expect(next.channels?.slack?.accounts?.sut?.channels?.C123456789?.requireMention).toBe(false);
  });

  it("parses gateway phase trace lines from sanitized logs", () => {
    expect(
      testing.parseSlackQaGatewayPhaseTrace(
        [
          "noise",
          'openclaw:slack-qa-trace {"at":"2026-05-18T00:00:00.000Z","phase":"dispatch.model.end","durationMs":1234,"streaming":false}',
          "openclaw:slack-qa-trace not-json",
        ].join("\n"),
      ),
    ).toEqual([
      {
        at: "2026-05-18T00:00:00.000Z",
        durationMs: 1234,
        phase: "dispatch.model.end",
        streaming: false,
      },
    ]);
  });

  it("records gateway heap checkpoint metadata without preserving raw dumps", async () => {
    const tempRoot = await fs.mkdtemp(path.join(tmpdir(), "openclaw-slack-heap-"));
    const snapshotPath = path.join(tempRoot, "Heap.123.heapsnapshot");
    const snapshotBody = '{"token":"xoxb-secret"}';
    let rssBytes = 10_000;

    try {
      const snapshot = await testing.captureSlackGatewayHeapSnapshotCheckpoint({
        gateway: {
          tempRoot,
          signalProcess: () => {
            writeFileSync(snapshotPath, snapshotBody);
          },
          getProcessRssBytes: () => {
            const next = rssBytes;
            rssBytes += 512;
            return next;
          },
        } as never,
        label: "slack-canary:ready",
      });

      expect(snapshot).toEqual({
        label: "slack-canary:ready",
        at: expect.any(String),
        bytes: Buffer.byteLength(snapshotBody),
        durationMs: expect.any(Number),
        gatewayProcessRssBeforeBytes: 10_000,
        gatewayProcessRssAfterBytes: 10_512,
        gatewayProcessRssDeltaBytes: 512,
      });
      expect(snapshot).not.toHaveProperty("path");
      await expect(fs.stat(snapshotPath)).rejects.toThrow();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("stops every scenario gateway with distinct RTT debug artifact dirs", async () => {
    const stops: unknown[] = [];
    const gatewayDebugDirPath = path.join(tmpdir(), "openclaw-slack-debug");
    let preservedGatewayDebugArtifacts = false;
    const createGatewayHarness = (label: string) =>
      ({
        stop: async (options?: unknown) => {
          stops.push({ label, options });
        },
      }) as never;
    const cleanupIssues: string[] = [];

    const first = await testing.stopSlackQaScenarioGateway({
      cleanupIssues,
      gatewayDebugArtifactDirPath: path.join(gatewayDebugDirPath, "slack-canary-attempt-1"),
      gatewayHarness: createGatewayHarness("first"),
      issueLabel: "gateway debug preservation failed",
      preserveDebugArtifacts: true,
    });
    preservedGatewayDebugArtifacts ||= first.preservedDebugArtifacts;
    const second = await testing.stopSlackQaScenarioGateway({
      cleanupIssues,
      gatewayDebugArtifactDirPath: path.join(gatewayDebugDirPath, "slack-canary-attempt-2"),
      gatewayHarness: createGatewayHarness("second"),
      issueLabel: "gateway debug preservation failed",
      preserveDebugArtifacts: true,
    });

    expect(first).toEqual({ preservedDebugArtifacts: true, stopped: true });
    expect(preservedGatewayDebugArtifacts).toBe(true);
    expect(second).toEqual({ preservedDebugArtifacts: true, stopped: true });
    expect(cleanupIssues).toEqual([]);
    expect(stops).toEqual([
      {
        label: "first",
        options: { preserveToDir: path.join(gatewayDebugDirPath, "slack-canary-attempt-1") },
      },
      {
        label: "second",
        options: { preserveToDir: path.join(gatewayDebugDirPath, "slack-canary-attempt-2") },
      },
    ]);
  });

  it("records Slack accepted timestamps without thread polling for top-level replies", async () => {
    let historyCalls = 0;
    let threadCalls = 0;
    const observedMessages: Array<unknown> = [];
    const reply = await testing.waitForSlackScenarioReply({
      channelId: "C123456789",
      client: {
        conversations: {
          history: async () => {
            historyCalls += 1;
            return {
              messages: [
                {
                  text: "PONG_SLACK_QA_PING_TEST",
                  ts: "1001.234000",
                  user: "U999999999",
                },
              ],
            };
          },
          replies: async () => {
            threadCalls += 1;
            return { messages: [] };
          },
        },
      } as never,
      matchText: "PONG_SLACK_QA_PING_TEST",
      observedMessages: observedMessages as never,
      observationScenarioId: "slack-canary",
      observationScenarioTitle: "Slack canary echo",
      pollIntervalMs: 50,
      replySearchMode: "channel",
      sentTs: "1000.000000",
      threadTs: "1000.000000",
      sutIdentity: { userId: "U999999999" },
      timeoutMs: 1_000,
    });

    expect(historyCalls).toBe(1);
    expect(threadCalls).toBe(0);
    expect(reply.channelHistoryCalls).toBe(1);
    expect(reply.threadHistoryCalls).toBe(0);
    expect(reply.responseSlackAcceptedAtMs).toBe(1_001_234);
    expect(reply.responseSlackAcceptedAt).toBe("1970-01-01T00:16:41.234Z");
    expect(reply.observerLagMs).toBeGreaterThanOrEqual(0);
  });

  it("ignores delayed unrelated SUT replies during mention-gating", async () => {
    const observedMessages: Array<unknown> = [];
    await expect(
      testing.waitForSlackNoReply({
        channelId: "C123456789",
        client: {
          conversations: {
            history: async () => ({
              messages: [
                {
                  text: "I should not have replied",
                  ts: "2.000000",
                  user: "U999999999",
                },
              ],
            }),
          },
        } as never,
        matchText: "SLACK_QA_NOMENTION_MARKER",
        observedMessages: observedMessages as never,
        observationScenarioId: "slack-mention-gating",
        observationScenarioTitle: "Slack unmentioned bot message does not trigger",
        sentTs: "1.000000",
        sutIdentity: { userId: "U999999999" },
        timeoutMs: 10,
      }),
    ).resolves.toBeUndefined();
    const typedObservedMessages = observedMessages as Array<{
      matchedScenario?: boolean;
      text?: string;
      ts?: string;
      userId?: string;
    }>;
    expect(typedObservedMessages).toHaveLength(1);
    expect(typedObservedMessages[0]?.matchedScenario).toBe(false);
    expect(typedObservedMessages[0]?.text).toBe("I should not have replied");
    expect(typedObservedMessages[0]?.ts).toBe("2.000000");
    expect(typedObservedMessages[0]?.userId).toBe("U999999999");
  });

  it("fails mention-gating when the SUT replies with the marker", async () => {
    await expect(
      testing.waitForSlackNoReply({
        channelId: "C123456789",
        client: {
          conversations: {
            history: async () => ({
              messages: [
                {
                  text: "SLACK_QA_NOMENTION_MARKER",
                  ts: "2.000000",
                  user: "U999999999",
                },
              ],
            }),
          },
        } as never,
        matchText: "SLACK_QA_NOMENTION_MARKER",
        observedMessages: [],
        observationScenarioId: "slack-mention-gating",
        observationScenarioTitle: "Slack unmentioned bot message does not trigger",
        sentTs: "1.000000",
        sutIdentity: { userId: "U999999999" },
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("unexpected Slack SUT reply observed");
  });

  it("writes artifacts when Convex credential acquisition fails", async () => {
    const outputDir = await fs.mkdtemp(path.join(tmpdir(), "openclaw-slack-qa-"));
    const result = await runSlackQaLive({
      credentialRole: "ci",
      credentialSource: "convex",
      outputDir,
    });

    expect(result.scenarios).toHaveLength(1);
    expect(result.scenarios[0]?.id).toBe("slack-canary");
    expect(result.scenarios[0]?.status).toBe("fail");
    expect(result.scenarios[0]?.details).toContain("Missing OPENCLAW_QA_CONVEX_SITE_URL");
    await expect(fs.stat(result.reportPath).then((stats) => stats.isFile())).resolves.toBe(true);
    const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8")) as {
      channelId: string;
      credentials: { kind: string; role?: string; source: string };
    };
    expect(summary.channelId).toBe("<unavailable>");
    expect(summary.credentials).toEqual({
      kind: "slack",
      role: "ci",
      source: "convex",
    });
  });
});
