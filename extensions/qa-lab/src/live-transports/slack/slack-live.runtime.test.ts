// Qa Lab tests cover slack live plugin behavior.
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readQaScenarioById } from "../../scenario-catalog.js";
import { requireFlowScenario } from "../../scenario-catalog.test-utils.js";
import { testing as adapterTesting } from "./adapter.runtime.js";
import { resolveApprovalDecision } from "./slack-live.approvals.js";
import { quiesceCodexApprovalAgentRun, waitForSlackReaction } from "./slack-live.codex-approval.js";
import {
  buildSlackQaConfig,
  parseSlackQaCredentialPayload,
  resolveSlackQaRuntimeEnv,
} from "./slack-live.config.js";
import { assertSlackCodexApprovalModelSupported } from "./slack-live.contracts.js";
import { buildSlackInvalidBlocksTableProbe } from "./slack-live.invalid-blocks.js";
import {
  observeSlackScenarioMessages,
  waitForSlackNoReply,
} from "./slack-live.message-observations.js";
import {
  buildSlackApprovalCheckpointMessage,
  extractSlackNativeApprovalId,
  runSlackTableInvalidBlocksFallbackScenario,
} from "./slack-live.observations.js";
import { findScenario } from "./slack-live.scenario.test-helpers.js";
import { loadSlackQaRuntime } from "./slack-plugin.runtime.js";

// Keep real Slack operations in Vitest's graph instead of recompiling them through Jiti.
// The separate facade tests own plugin loading; this suite owns delivery behavior.
vi.mock("./slack-plugin.runtime.js", async () => {
  const runtime = await import("@openclaw/slack/test-api.js");
  return { loadSlackQaRuntime: () => runtime };
});

const testing = {
  assertSlackCodexApprovalModelSupported,
  buildSlackApprovalCheckpointMessage,
  buildSlackInvalidBlocksTableProbe,
  extractSlackNativeApprovalId,
  findScenario,
  observeSlackScenarioMessages,
  parseSlackQaCredentialPayload,
  quiesceCodexApprovalAgentRun,
  resolveApprovalDecision,
  resolveSlackRateLimitDelayMs: adapterTesting.resolveSlackRateLimitDelayMs,
  resolveSlackQaRuntimeEnv,
  runSlackTableInvalidBlocksFallbackScenario,
  waitForSlackNoReply,
  waitForSlackReaction,
};

function buildSlackConfigFixture(
  base: Parameters<typeof buildSlackQaConfig>[0],
  params: Partial<Parameters<typeof buildSlackQaConfig>[1]> = {},
) {
  return buildSlackQaConfig(base, {
    channelId: "C123456789",
    driverBotUserId: "U999999999",
    sutAccountId: "sut",
    sutAppToken: "xapp-sut",
    sutBotToken: "xoxb-sut",
    ...params,
  });
}

function buildSlackMessageRun(id: string, sutUserId = "U999999999") {
  const run = testing.findScenario([id])[0]?.buildRun(sutUserId);
  if (!run || !("input" in run)) {
    throw new Error(`expected Slack message scenario: ${id}`);
  }
  return run;
}

function buildSlackReplyRun(id: string, sutUserId = "U999999999") {
  const run = buildSlackMessageRun(id, sutUserId);
  if (!run.afterReply) {
    throw new Error(`missing Slack reply verifier: ${id}`);
  }
  return { ...run, afterReply: run.afterReply };
}

function buildSlackProgressFixture(id: string, sutUserId = "U999999999") {
  const run = buildSlackMessageRun(id, sutUserId);
  const commentaryMarker = run.input.match(/SLACK-QA-COMMENTARY-[0-9A-F]{8}/u)?.[0];
  const toolMarker = run.input.match(/SLACK-QA-TOOL-[0-9A-F]{8}/u)?.[0];
  const outputMarker = run.input.match(/SLACK-QA-OUTPUT-[0-9A-F]{8}/u)?.[0];
  const finalMarker = run.input.match(/SLACK-QA-COMMENTARY-DONE-[0-9A-F]{8}/u)?.[0];
  const verifyObserved = run.verifyObserved;
  if (!commentaryMarker || !toolMarker || !outputMarker || !finalMarker || !verifyObserved) {
    throw new Error(`missing Slack progress verifier: ${id}`);
  }
  return {
    run: { ...run, verifyObserved },
    input: run.input,
    commentaryMarker,
    toolMarker,
    outputMarker,
    finalMarker,
    verifyObserved,
  };
}

function slackMessage(text: string, ts: string, blockText?: string[]) {
  return { channelId: "C123456789", text, ts, ...(blockText ? { blockText } : {}) };
}

describe("Slack live QA runtime helpers", () => {
  beforeAll(async () => {
    // Load the real Slack action graph as suite preparation, outside scenario
    // deadlines: the first send otherwise pays that cold import inside its
    // 120s test budget and times out on contended CI shards.
    await loadSlackQaRuntime().preloadSlackActions();
  });

  it("converts Slack rate-limit retry seconds for the observer backoff", () => {
    expect(testing.resolveSlackRateLimitDelayMs({ retryAfter: 10 })).toBe(10_000);
    expect(testing.resolveSlackRateLimitDelayMs({ retryAfter: 0 })).toBeUndefined();
    expect(testing.resolveSlackRateLimitDelayMs(new Error("network failed"))).toBeUndefined();
  });

  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("enables group DMs and threaded replies for the MPIM app-mention scenario", () => {
    const scenario = testing.findScenario(["slack-mpim-app-mention-dedupe"])[0];
    if (!scenario) {
      throw new Error("missing Slack MPIM app-mention scenario");
    }
    const cfg = buildSlackConfigFixture({}, { overrides: scenario.configOverrides });

    expect(cfg.channels?.slack?.accounts?.sut?.dm).toEqual({
      enabled: true,
      groupEnabled: true,
    });
    expect(cfg.channels?.slack?.accounts?.sut?.replyToMode).toBe("all");
  });

  it("surfaces MPIM cleanup failures and retains ownership for a retry", async () => {
    const run = testing.findScenario(["slack-mpim-app-mention-dedupe"])[0]?.buildRun("U_SUT");
    if (
      !run ||
      run.kind === "approval" ||
      run.kind === "codex-approval" ||
      run.kind === "direct-transport"
    ) {
      throw new Error("expected Slack MPIM message scenario");
    }
    const close = vi
      .fn()
      .mockRejectedValueOnce(new Error("close failed"))
      .mockRejectedValueOnce(new Error("close failed again"))
      .mockResolvedValueOnce({});
    const context = {
      channelId: "C_QA",
      driverClient: { auth: { test: vi.fn(async () => ({ user_id: "U_DRIVER" })) } },
      sutIdentity: { userId: "U_SUT" },
      sutReadClient: {
        conversations: {
          close,
          info: vi.fn(async () => {
            throw new Error("metadata unavailable");
          }),
          members: vi.fn(async () => ({ members: ["U_DRIVER", "U_SUT", "U_HUMAN"] })),
          open: vi.fn(async () => ({ channel: { id: "C_MPIM" } })),
        },
        users: { info: vi.fn(async () => ({ user: { id: "U_HUMAN" } })) },
      },
    } as never;

    await expect(run.beforeRun?.(context)).rejects.toThrow("metadata unavailable");
    await expect(run.cleanup?.(context)).rejects.toThrow("close failed again");
    await expect(run.cleanup?.(context)).resolves.toBeUndefined();

    expect(close).toHaveBeenCalledTimes(3);
    expect(close).toHaveBeenNthCalledWith(1, { channel: "C_MPIM" });
    expect(close).toHaveBeenNthCalledWith(2, { channel: "C_MPIM" });
    expect(close).toHaveBeenNthCalledWith(3, { channel: "C_MPIM" });
  });

  it("keeps the MPIM recall turn in the native thread", async () => {
    const run = buildSlackReplyRun("slack-mpim-app-mention-dedupe", "U_SUT");
    const seedMarker = /SLACK_QA_MPIM_SEED_[A-Z0-9]+/u.exec(run.input)?.[0];
    if (!seedMarker) {
      throw new Error("missing Slack MPIM seed marker");
    }
    expect(run.input).toContain(
      `Reply with only a marker in this exact format: ${seedMarker}_BOT_<NONCE>.`,
    );
    expect(run.input).toContain("Replace <NONCE> with 8 to 32 new uppercase letters or digits.");
    const botReplyMarker = `${seedMarker}_BOT_TESTNONCE`;
    const recallMarker = seedMarker.replace("SEED", "RECALL");
    const expectedRecallMarker = `${recallMarker}_TESTNONCE`;
    const postMessage = vi.fn(async (_request: { text?: string }) => ({
      channel: "C_MPIM",
      ts: "2.000000",
    }));
    const history = vi.fn(async () => ({ messages: [] }));
    const replies = vi.fn(async () => ({
      messages: [
        {
          bot_id: "B_SUT",
          text: expectedRecallMarker,
          thread_ts: "1.000000",
          ts: "3.000000",
          user: "U_SUT",
        },
      ],
    }));

    await expect(
      run.afterReply(
        {
          text: botReplyMarker,
          thread_ts: "1.000000",
          ts: "1.500000",
          user: "U_SUT",
        },
        {
          channelId: "C_MPIM",
          driverClient: { chat: { postMessage } },
          sentTs: "1.000000",
          sutIdentity: { botId: "B_SUT", userId: "U_SUT" },
          sutReadClient: { conversations: { history, replies } },
        } as never,
      ),
    ).resolves.toContain("recovered the prior bot reply");

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C_MPIM",
        thread_ts: "1.000000",
      }),
    );
    const recallText = postMessage.mock.calls[0]?.[0]?.text;
    expect(recallText).toContain(`previous reply beginning with ${seedMarker}_BOT_`);
    expect(recallText).toContain(`exact format: ${recallMarker}_<NONCE>`);
    expect(recallText).not.toContain(botReplyMarker);
    expect(recallText).not.toContain("TESTNONCE");
  });

  it("rejects an MPIM seed reply without text before sending the recall turn", async () => {
    const run = buildSlackReplyRun("slack-mpim-app-mention-dedupe", "U_SUT");
    const postMessage = vi.fn();

    await expect(
      run.afterReply(
        {
          thread_ts: "1.000000",
          ts: "1.500000",
          user: "U_SUT",
        },
        {
          channelId: "C_MPIM",
          driverClient: { chat: { postMessage } },
          sentTs: "1.000000",
          sutIdentity: { botId: "B_SUT", userId: "U_SUT" },
          sutReadClient: { conversations: {} },
        } as never,
      ),
    ).rejects.toThrow("MPIM seed reply did not contain the provider-generated bot nonce");
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("rejects an MPIM seed reply outside the native thread", async () => {
    const run = buildSlackReplyRun("slack-mpim-app-mention-dedupe", "U_SUT");
    const seedMarker = /SLACK_QA_MPIM_SEED_[A-Z0-9]+/u.exec(run.input)?.[0];
    if (!seedMarker) {
      throw new Error("missing Slack MPIM seed marker");
    }
    const postMessage = vi.fn();

    await expect(
      run.afterReply(
        {
          text: `${seedMarker}_BOT_TESTNONCE`,
          ts: "1.500000",
          user: "U_SUT",
        },
        {
          channelId: "C_MPIM",
          driverClient: { chat: { postMessage } },
          sentTs: "1.000000",
          sutIdentity: { botId: "B_SUT", userId: "U_SUT" },
          sutReadClient: { conversations: {} },
        } as never,
      ),
    ).rejects.toThrow("MPIM seed reply escaped the native Slack thread");
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("selects the Codex runtime only for Codex approval scenarios", () => {
    expect(
      requireFlowScenario(readQaScenarioById("slack-codex-approval-exec-native")).execution.runtime,
    ).toBe("codex");
    expect(
      requireFlowScenario(readQaScenarioById("slack-canary")).execution.runtime,
    ).toBeUndefined();
  });

  it.each(["slack-allowlist-block", "slack-channel-disabled-warning", "slack-mention-gating"])(
    "keeps the %s negative observation inside its flow deadline",
    (scenarioId) => {
      const scenario = testing.findScenario([scenarioId])[0];
      const run = scenario?.buildRun("U999999999");
      if (!scenario || !run || !("expectReply" in run)) {
        throw new Error(`missing Slack message scenario ${scenarioId}`);
      }
      expect(run.expectReply).toBe(false);
      expect(run.noReplyObservationMs).toBe(8_000);
      expect(scenario.timeoutMs).toBeGreaterThan(
        run.noReplyObservationMs ?? Number.POSITIVE_INFINITY,
      );
    },
  );

  it("accepts only Codex harness providers for Codex approval scenarios", () => {
    expect(() =>
      testing.assertSlackCodexApprovalModelSupported("openai/gpt-5.6-luna"),
    ).not.toThrow();
    expect(() =>
      testing.assertSlackCodexApprovalModelSupported("codex/gpt-5.6-luna"),
    ).not.toThrow();
    expect(() =>
      testing.assertSlackCodexApprovalModelSupported("anthropic/claude-sonnet-4-6"),
    ).toThrow(
      'Slack Codex approval scenarios require an openai/* or codex/* model; received "anthropic/claude-sonnet-4-6".',
    );
  });

  it("enables Slack native exec and plugin approval delivery for approval scenarios", () => {
    const cfg = buildSlackConfigFixture(
      {},
      {
        overrides: {
          approvals: {
            exec: true,
            plugin: true,
            target: "channel",
          },
        },
      },
    );

    expect(cfg.approvals?.exec).toEqual({ enabled: true, mode: "session" });
    expect(cfg.approvals?.plugin).toEqual({ enabled: true, mode: "session" });
    const account = cfg.channels?.slack?.accounts?.sut;
    expect(account?.allowFrom).toEqual(["U999999999"]);
    expect(account?.execApprovals).toEqual({
      enabled: true,
      approvers: ["U999999999"],
      target: "channel",
    });
    expect(account?.channels?.C123456789?.users).toEqual(["U999999999"]);
  });

  it("enables Codex guardian runtime and native plugin approval delivery for Codex approval scenarios", () => {
    const cfg = buildSlackConfigFixture(
      {
        agents: {
          defaults: {},
          list: [
            {
              id: "qa",
              model: { primary: "openai/gpt-5.6-luna" },
            },
          ],
        },
      },
      {
        overrides: {
          approvals: {
            exec: true,
            plugin: true,
            target: "channel",
          },
          codexApproval: true,
        },
        primaryModel: "openai/gpt-5.6-luna",
      },
    );

    expect(cfg.plugins?.allow).toEqual(["slack", "codex"]);
    expect(cfg.plugins?.entries?.codex).toEqual({
      enabled: true,
      config: {
        appServer: {
          mode: "guardian",
        },
      },
    });
    expect(cfg.tools?.exec?.mode).toBe("ask");
    expect(cfg.agents?.defaults?.models?.["openai/gpt-5.6-luna"]?.agentRuntime).toEqual({
      id: "codex",
    });
    expect(cfg.approvals?.plugin).toEqual({ enabled: true, mode: "session" });
    expect(cfg.channels?.slack?.accounts?.sut?.execApprovals).toEqual({
      enabled: true,
      approvers: ["U999999999"],
      target: "channel",
    });
  });

  it("overrides both owner and channel allowlists for block scenarios", () => {
    const cfg = buildSlackConfigFixture(
      {},
      {
        overrides: {
          allowFrom: ["U_NEVER_ALLOWED"],
          channelEnabled: false,
          users: ["U_NEVER_ALLOWED"],
        },
      },
    );

    const account = cfg.channels?.slack?.accounts?.sut;
    expect(account?.allowFrom).toEqual(["U_NEVER_ALLOWED"]);
    expect(account?.channels?.C123456789?.enabled).toBe(false);
    expect(account?.channels?.C123456789?.users).toEqual(["U_NEVER_ALLOWED"]);
  });

  it("configures and verifies the disabled-channel warning scenario", async () => {
    const scenario = testing.findScenario(["slack-channel-disabled-warning"])[0];
    expect(scenario?.configOverrides?.channelEnabled).toBe(false);

    const run = scenario?.buildRun("U999999999");
    const beforeRun = run && "beforeRun" in run ? run.beforeRun : undefined;
    const afterNoReply = run && "afterNoReply" in run ? run.afterNoReply : undefined;
    expect(beforeRun).toBeTypeOf("function");
    expect(afterNoReply).toBeTypeOf("function");
    const call = vi
      .fn()
      .mockResolvedValueOnce({ cursor: 12 })
      .mockResolvedValueOnce({
        lines: ["Slack channel denied by configuration channel_not_allowed channel_disabled"],
      });
    await beforeRun?.({
      gateway: {
        call,
      },
    } as never);
    await expect(
      afterNoReply?.({
        gateway: {
          call,
        },
      } as never),
    ).resolves.toBe("structured disabled-channel warning observed");
    expect(call).toHaveBeenNthCalledWith(
      1,
      "logs.tail",
      { limit: 1, maxBytes: 32_000 },
      { timeoutMs: 20_000 },
    );
    expect(call).toHaveBeenCalledWith(
      "logs.tail",
      { cursor: 12, limit: 200, maxBytes: 256_000 },
      { timeoutMs: 20_000 },
    );
    await expect(
      afterNoReply?.({
        gateway: {
          call: vi.fn(async () => ({
            lines: [
              "Slack channel denied by configuration channel_not_allowed",
              "channel_disabled",
            ],
          })),
        },
      } as never),
    ).rejects.toThrow("did not emit the structured warning");
  });

  it("builds the Slack progress commentary true, false, omitted, and dedupe configs", () => {
    const buildScenarioConfig = (scenarioId: string) => {
      const scenario = testing.findScenario([scenarioId])[0];
      if (!scenario) {
        throw new Error(`missing Slack QA scenario: ${scenarioId}`);
      }
      return buildSlackConfigFixture(
        {
          agents: {
            defaults: { verboseDefault: "off" },
            list: [{ id: "qa", identity: { name: "C-3PO QA" } }],
          },
        },
        { overrides: scenario.configOverrides },
      );
    };
    const progressConfig = (scenarioId: string) =>
      buildScenarioConfig(scenarioId).channels?.slack?.accounts?.sut?.streaming?.progress;

    expect(progressConfig("slack-progress-commentary-true")).toMatchObject({
      commentary: true,
      commandText: "raw",
      toolProgress: false,
    });
    expect(progressConfig("slack-progress-commentary-false")).toMatchObject({
      commentary: false,
      commandText: "raw",
      toolProgress: false,
    });
    expect(
      buildScenarioConfig("slack-progress-commentary-true").channels?.slack?.accounts?.sut
        ?.streaming?.nativeTransport,
    ).toBe(false);
    expect(
      buildScenarioConfig("slack-progress-commentary-false").agents?.defaults?.verboseDefault,
    ).toBe("off");
    expect(
      buildScenarioConfig("slack-mpim-app-mention-dedupe").channels?.slack?.accounts?.sut
        ?.streaming,
    ).toEqual({ mode: "off" });
    const omitted = progressConfig("slack-progress-commentary-omitted");
    expect(omitted).toMatchObject({ style: "compact", toolProgress: true });
    expect(Object.hasOwn(omitted ?? {}, "commentary")).toBe(false);
    expect(
      buildScenarioConfig("slack-progress-commentary-verbose-dedupe").agents?.defaults
        ?.verboseDefault,
    ).toBe("on");
    expect(
      buildScenarioConfig("slack-progress-commentary-verbose-full").agents?.defaults
        ?.verboseDefault,
    ).toBe("full");
    expect(buildScenarioConfig("slack-progress-commentary-true").agents?.list?.[0]?.identity).toBe(
      undefined,
    );
  });

  it("verifies progress commentary from history or successful captured message writes", () => {
    const cases = [
      {
        id: "slack-progress-commentary-true",
        commentaryTs: "1.500000",
        commentaryStyle: "lane",
        toolProgress: "absent",
      },
      {
        id: "slack-progress-commentary-false",
        commentaryTs: "1.500000",
        commentaryStyle: "headline",
        toolProgress: "absent",
      },
      {
        id: "slack-progress-commentary-omitted",
        commentaryTs: "1.500000",
        commentaryStyle: "headline",
        toolProgress: "draft",
      },
      {
        id: "slack-progress-commentary-verbose-dedupe",
        commentaryTs: "1.500000",
        commentaryStyle: "standalone",
        toolProgress: "standalone-redacted",
      },
      {
        id: "slack-progress-commentary-verbose-full",
        commentaryTs: "1.500000",
        commentaryStyle: "standalone",
        toolProgress: "standalone",
      },
    ] as const;

    for (const testCase of cases) {
      const { input, commentaryMarker, toolMarker, outputMarker, finalMarker, verifyObserved } =
        buildSlackProgressFixture(testCase.id);
      // Compact progress cards retain the leading command segment, so keep the
      // QA marker there instead of in a trailing shell comment that Slack drops.
      expect(input).toContain(
        `printf '%s' '${toolMarker}' >/dev/null; sleep 5; printf '%s\\n' '${outputMarker}'`,
      );
      const messages = [
        slackMessage(finalMarker, "2.000000"),
        ...(testCase.commentaryTs
          ? [
              {
                channelId: "C123456789",
                text: testCase.commentaryStyle === "lane" ? "Working…" : commentaryMarker,
                ...(testCase.commentaryStyle === "lane"
                  ? { blockText: [`• *Commentary* — _${commentaryMarker}_`] }
                  : {}),
                ts: testCase.commentaryTs,
              },
            ]
          : []),
        ...(testCase.toolProgress === "absent"
          ? []
          : [
              slackMessage(
                testCase.toolProgress === "standalone-redacted"
                  ? "🛠️ Exec"
                  : testCase.toolProgress === "standalone"
                    ? `🛠️ Exec\n\`\`\`\n${outputMarker}\n\`\`\``
                    : testCase.id === "slack-progress-commentary-omitted"
                      ? commentaryMarker
                      : `🛠️ Exec ${toolMarker}`,
                testCase.toolProgress === "draft" ? "1.500000" : "1.750000",
                testCase.id === "slack-progress-commentary-omitted"
                  ? [`🛠️ *Exec* — sleep 5`]
                  : undefined,
              ),
            ]),
      ];
      expect(
        verifyObserved({
          finalMessage: { text: finalMarker, ts: "2.000000" },
          messages,
        }),
      ).toContain("verified");

      if (testCase.id === "slack-progress-commentary-omitted") {
        expect(
          verifyObserved({
            finalMessage: { text: finalMarker, ts: "2.000000" },
            messages: messages.map((message) => {
              if (message.ts !== "1.500000") {
                return message;
              }
              return Object.assign({}, message, { blockText: ["Exec — sleep 5"] });
            }),
          }),
        ).toContain("verified");
        expect(
          verifyObserved({
            finalMessage: { text: finalMarker, ts: "2.000000" },
            messages: messages.map((message) => {
              if (message.ts !== "1.500000") {
                return message;
              }
              return Object.assign({}, message, { blockText: ["Run — `sleep 5`"] });
            }),
          }),
        ).toContain("verified");
      }
    }
  });

  it("recognizes exact commentary rows within Slack progress cards", () => {
    const { commentaryMarker, finalMarker, verifyObserved } = buildSlackProgressFixture(
      "slack-progress-commentary-true",
    );
    const verifyCommentaryMessage = (message: { blockText?: string[]; text: string }) =>
      verifyObserved({
        finalMessage: { text: finalMarker, ts: "2.000000" },
        messages: [
          {
            channelId: "C123456789",
            ...message,
            ts: "1.500000",
          },
          slackMessage(finalMarker, "2.000000"),
        ],
      });

    for (const message of [
      { text: `_${commentaryMarker}_` },
      { text: ` \n_${commentaryMarker}_\t` },
      { text: `💬 ${commentaryMarker}` },
      { text: `:speech_balloon: ${commentaryMarker}` },
      { text: `_${commentaryMarker}_\n_more commentary_` },
      {
        blockText: [
          `✅ *Working*`,
          `• *Commentary* — _${commentaryMarker}_\n• *Commentary* — _another note_`,
        ],
        text: "Working…",
      },
      {
        blockText: [
          `• *Commentary* — _${commentaryMarker}_\n• *Commentary* — _${commentaryMarker}_`,
        ],
        text: "Working…",
      },
    ]) {
      expect(() => verifyCommentaryMessage(message)).not.toThrow();
    }
    for (const message of [
      { text: commentaryMarker },
      { text: `prefix _${commentaryMarker}_ suffix` },
      { text: `💬 ${commentaryMarker} extra prose` },
      { text: "Working…", blockText: [`• *Exec* — _${commentaryMarker}_`] },
      { text: "Working…", blockText: [`• *Commentary* — _${commentaryMarker} extra prose_`] },
      { text: "Working…", blockText: [`• *Update* — ${commentaryMarker}`] },
    ]) {
      expect(() => verifyCommentaryMessage(message)).toThrow(
        "expected commentary in the Slack progress commentary lane",
      );
    }
  });

  it("rejects commentary when false and mismatched tool progress", () => {
    const verify = (
      scenarioId: string,
      mutate: (markers: [string, string, string]) => string[],
      finalText: "echo" | "exact" = "exact",
    ) => {
      const { commentaryMarker, toolMarker, finalMarker, verifyObserved } =
        buildSlackProgressFixture(scenarioId);
      const completeMarkers: [string, string, string] = [commentaryMarker, toolMarker, finalMarker];
      return () =>
        verifyObserved({
          finalMessage: {
            text:
              finalText === "exact"
                ? completeMarkers[2]
                : `${completeMarkers[0]} ${completeMarkers[2]}`,
            ts: "2.000000",
          },
          messages: mutate(completeMarkers).map((text) => ({
            channelId: "C123456789",
            text,
            ts: text.includes(completeMarkers[2]) ? "2.000000" : "1.500000",
          })),
        });
    };

    expect(
      verify("slack-progress-commentary-false", ([commentary, , final]) => [
        `💬 ${commentary}`,
        final,
      ]),
    ).toThrow("status headline");
    for (const toolPresentation of ["command", "output", "safe-summary"]) {
      expect(
        verify("slack-progress-commentary-true", ([commentary, tool, final]) => [
          `💬 ${commentary}`,
          toolPresentation === "command"
            ? tool
            : toolPresentation === "output"
              ? tool.replace("-TOOL-", "-OUTPUT-")
              : "🛠️ Exec",
          final,
        ]),
      ).toThrow("tool progress to stay out");
    }
    expect(
      verify("slack-progress-commentary-omitted", ([commentary, , final]) => [commentary, final]),
    ).toThrow("tool progress on the draft");
    expect(
      verify(
        "slack-progress-commentary-true",
        ([commentary, , final]) => [`💬 ${commentary} ${final}`],
        "echo",
      ),
    ).toThrow("only the final marker");
  });

  it("rejects duplicate durable and draft commentary identities", () => {
    const {
      commentaryMarker: marker,
      finalMarker,
      verifyObserved,
    } = buildSlackProgressFixture("slack-progress-commentary-verbose-dedupe");

    expect(() =>
      verifyObserved({
        finalMessage: { text: finalMarker, ts: "2.000000" },
        messages: [
          slackMessage(`💬 ${marker}`, "1.500000"),
          slackMessage(`• ${marker}`, "2.000000"),
        ],
      }),
    ).toThrow("exactly one Slack message identity containing commentary");
  });

  it.each([":hammer_and_wrench: Exec"])(
    "accepts standalone commentary and the safe verbose tool summary %s",
    (toolText) => {
      const { run, commentaryMarker, finalMarker } = buildSlackProgressFixture(
        "slack-progress-commentary-verbose-dedupe",
        "U_SUT",
      );

      expect(() =>
        run.verifyObserved?.({
          finalMessage: { text: finalMarker, ts: "3.000000" },
          messages: [
            slackMessage(`💬 ${commentaryMarker}`, "1.000000"),
            slackMessage(toolText, "2.000000"),
            slackMessage(finalMarker, "3.000000"),
          ],
        }),
      ).not.toThrow();
    },
  );

  it.each([
    { finalEdit: false, markerKind: "TOOL" },
    { finalEdit: true, markerKind: "OUTPUT" },
  ])(
    "rejects $markerKind disclosure in verbose-on progress (final edit: $finalEdit)",
    ({ finalEdit, markerKind }) => {
      const {
        run,
        commentaryMarker: commentary,
        toolMarker,
        outputMarker,
      } = buildSlackProgressFixture("slack-progress-commentary-verbose-dedupe", "U_SUT");
      const tool = markerKind === "TOOL" ? toolMarker : outputMarker;
      expect(() =>
        run.verifyObserved?.({
          finalMessage: { text: run.matchText, ts: "3" },
          messages: [
            slackMessage(`💬 ${commentary}`, "1"),
            slackMessage(
              finalEdit ? `${tool} ${run.matchText}` : `🛠️ Exec ${tool}`,
              finalEdit ? "3" : "2",
            ),
            slackMessage(run.matchText, "3"),
          ],
        }),
      ).toThrow("command details and output must stay hidden in verbose-on progress");
    },
  );

  it("requires actual full tool output instead of echoed command metadata", () => {
    const {
      run,
      commentaryMarker: commentary,
      outputMarker: output,
      toolMarker: command,
    } = buildSlackProgressFixture("slack-progress-commentary-verbose-full", "U_SUT");
    const verify = (toolMessages: Array<{ text: string; ts: string }>) =>
      run.verifyObserved?.({
        finalMessage: { text: run.matchText, ts: "final" },
        messages: [
          slackMessage(`💬 ${commentary}`, "commentary"),
          ...toolMessages.map((message) => ({ channelId: "C123456789", ...message })),
          slackMessage(run.matchText, "final"),
        ],
      });
    expect(() => verify([{ text: `🛠️ Exec: printf '${output}'`, ts: "tool" }])).toThrow(
      "expected exact tool output",
    );
    expect(() => verify([{ text: `🛠️ ${output}`, ts: "tool" }])).toThrow(
      "expected exact tool output",
    );
    // Slack's monitor transform removes compact command headers before delivery.
    const summary = `🛠️ \`sleep 5; printf '%s\\n' '${output}' # ${command}\``;
    const deliveredOutput = sanitizeAssistantVisibleText(
      `${summary}\n\`\`\`txt\n${output}\n\`\`\``,
    );
    expect(sanitizeAssistantVisibleText(summary)).toBe("");
    expect(deliveredOutput).toBe(`\`\`\`txt\n${output}\n\`\`\``);
    expect(() => verify([{ text: deliveredOutput, ts: "tool" }])).not.toThrow();
    expect(() => verify([{ text: output ?? "", ts: "tool" }])).not.toThrow();
    expect(() =>
      verify([{ text: `🛠️ Run command: # ${command}\n${output}`, ts: "tool" }]),
    ).not.toThrow();
    expect(() =>
      verify([
        { text: `🛠️ Exec\n${output}`, ts: "tool-1" },
        { text: `🛠️ Exec\n${output}`, ts: "tool-2" },
      ]),
    ).toThrow("expected exact tool output in one standalone verbose message");
    expect(() =>
      verify([
        { text: "🛠️ run sleep → print text", ts: "summary" },
        { text: `🛠️ run sleep → print text\n${output}`, ts: "output" },
      ]),
    ).not.toThrow();
    expect(() =>
      verify([
        { text: "🛠️ run sleep → print text", ts: "summary-1" },
        { text: "🛠️ run sleep → print text", ts: "summary-2" },
        { text: `🛠️ run sleep → print text\n${output}`, ts: "output" },
      ]),
    ).toThrow(
      "expected exact tool output in one standalone verbose message and at most one summary",
    );
    expect(() =>
      verify([
        { text: "🛠️ Exec", ts: "tool" },
        { text: `🛠️ Exec\n\`\`\`\n${output}\n\`\`\``, ts: "tool" },
      ]),
    ).not.toThrow();
  });

  it.each(["🛠️ run sleep → print text", "🛠️ Exec\nunmarked output"])(
    "rejects verbose-on metadata or output updates without protocol markers: %s",
    (text) => {
      const { run, commentaryMarker: commentary } = buildSlackProgressFixture(
        "slack-progress-commentary-verbose-dedupe",
        "U_SUT",
      );
      expect(() =>
        run.verifyObserved?.({
          finalMessage: { text: run.matchText, ts: "final" },
          messages: [
            slackMessage(`💬 ${commentary}`, "commentary"),
            slackMessage("🛠️ Exec", "tool"),
            { channelId: "C123456789", text, ts: "tool" },
            slackMessage(run.matchText, "final"),
          ],
        }),
      ).toThrow("command details and output must stay hidden in verbose-on progress");
    },
  );

  it.each(["slack-progress-commentary-verbose-dedupe", "slack-progress-commentary-verbose-full"])(
    "rejects absent or merged standalone tool identities for %s",
    (scenarioId) => {
      const {
        run,
        commentaryMarker: commentary,
        outputMarker: output,
      } = buildSlackProgressFixture(scenarioId, "U_SUT");
      for (const toolTs of [undefined, "1", "3"]) {
        expect(() =>
          run.verifyObserved?.({
            finalMessage: { text: run.matchText, ts: "3" },
            messages: [
              slackMessage(`💬 ${commentary}`, "1"),
              ...(toolTs
                ? [
                    slackMessage(
                      scenarioId.endsWith("-full") ? `🛠️ Exec\n${output}` : "🛠️ Exec",
                      toolTs,
                    ),
                  ]
                : []),
              slackMessage(run.matchText, "3"),
            ],
          }),
        ).toThrow("standalone verbose message");
      }
    },
  );

  it("reports bounded presentation facts without raw Slack text or identities", () => {
    const { run, commentaryMarker: commentary } = buildSlackProgressFixture(
      "slack-progress-commentary-true",
      "U_SUT",
    );
    const privateText = "private-observation-sentinel";
    const privateId = "private-message-identity";
    let failure = "";
    try {
      run.verifyObserved({
        finalMessage: { text: run.matchText, ts: "final" },
        messages: [
          ...Array.from({ length: 40 }, (_, index) =>
            slackMessage(
              `:speech_balloon: ${commentary} ${privateText}\n${privateText}`,
              `${privateId}-${index}`,
              [`• *Commentary* — _${commentary}_`, privateText.repeat(1_000)],
            ),
          ),
          slackMessage(run.matchText, "final"),
        ],
      });
    } catch (error) {
      failure = String(error);
    }
    expect(failure).toContain("expected exactly one Slack message identity containing commentary");
    expect(failure).toContain("presentation=");
    expect(failure).toContain('"text":"emoji/other"');
    expect(JSON.parse(failure.split("presentation=")[1] ?? "[]")).toHaveLength(16);
    expect(failure).not.toContain(privateText);
    expect(failure).not.toContain(privateId);
    expect(failure).not.toContain(commentary);
    expect(failure.length).toBeLessThan(4_000);
  });

  it("distinguishes marker envelopes and missing command comments without retaining text", () => {
    const { run, commentaryMarker: commentary } = buildSlackProgressFixture(
      "slack-progress-commentary-true",
      "U_SUT",
    );
    const presentations = [
      ["", "", "none/none"],
      ["**", "**", "bold/bold"],
      ["_", "_", "italic/italic"],
      ["\\_", "\\_", "escaped-italic/escaped-italic"],
      ["`", "`", "code/code"],
      ["> ", "", "quote/none"],
      ["• ", "", "bullet/none"],
      [":speech_balloon: ", "", "emoji/none"],
    ];
    let failure = "";
    try {
      run.verifyObserved({
        finalMessage: { text: "invalid final", ts: "final" },
        messages: [
          ...presentations.map(([prefix, suffix]) =>
            slackMessage(`${prefix}${commentary}${suffix}`, "same-private-identity", [
              `• *Commentary* — _${commentary}_\n_${commentary}_`,
            ]),
          ),
          ...Array.from({ length: 40 }, () =>
            slackMessage("🛠️ `sleep 5`", "tool-private-identity"),
          ),
        ],
      });
    } catch (error) {
      failure = String(error);
    }
    const facts = JSON.parse(failure.split("presentation=")[1] ?? "[]");
    expect(facts).toHaveLength(presentations.length + 1);
    expect(facts.map((fact: { text: string }) => fact.text)).toEqual([
      ...presentations.map((presentation) => presentation[2]),
      "missing",
    ]);
    expect(facts[0]).toMatchObject({
      block: "commentary-row/italic",
      lines: [1, 2],
      occurrences: [1, 2],
    });
    expect(facts.at(-1)).toMatchObject({ tool: "sleep-without-marker" });
    expect(failure).not.toContain(commentary);
    expect(failure).not.toContain("private-identity");
    expect(failure).not.toContain("sleep 5");
    expect(failure.length).toBeLessThan(4_000);
  });

  it("settles complete channel and thread observations after the final reply", async () => {
    // The second observation belongs to the settle window, not host scheduling speed.
    vi.useFakeTimers();
    let historyCalls = 0;
    const observedMessages: Array<{ text: string }> = [];
    const observationParams = {
      channelId: "C123456789",
      client: {
        conversations: {
          history: async () => {
            historyCalls += 1;
            return {
              messages:
                historyCalls === 1
                  ? [
                      { text: "FINAL_MARKER", ts: "3.000000", user: "U999999999" },
                      { text: "EARLIER_COMMENTARY", ts: "2.000000", user: "U999999999" },
                    ]
                  : [
                      { text: "LATE_DUPLICATE", ts: "4.000000", user: "U999999999" },
                      { text: "FINAL_MARKER", ts: "3.000000", user: "U999999999" },
                    ],
            };
          },
          replies: async () => ({
            messages: [{ text: "THREAD_DUPLICATE", ts: "5.000000", user: "U999999999" }],
          }),
        },
      } as never,
      matchText: "FINAL_MARKER",
      observedMessages: observedMessages as never,
      observationScenarioId: "slack-progress-commentary-verbose-dedupe",
      observationScenarioTitle: "Slack commentary dedupe",
      sentTs: "1.000000",
      // The observer re-polls only while the settle window is open; keep it well above one
      // poll's wall time so a loaded runner still reaches the second observation.
      settleMs: 500,
      sutIdentity: { userId: "U999999999" },
      threadTs: "1.000000",
    };
    const observation = testing.observeSlackScenarioMessages(observationParams);
    // A shorter clock advance strands the observer's final timer.
    await vi.advanceTimersByTimeAsync(observationParams.settleMs);
    await observation;

    expect(historyCalls).toBeGreaterThanOrEqual(2);
    expect(new Set(observedMessages.map((message) => message.text))).toEqual(
      new Set(["FINAL_MARKER", "EARLIER_COMMENTARY", "LATE_DUPLICATE", "THREAD_DUPLICATE"]),
    );
  });

  it("extracts plugin approval ids from typed Slack approval action values", () => {
    expect(
      testing.extractSlackNativeApprovalId({
        actionValues: [
          'openclaw:approval:v1:{"approvalId":"plugin:abc123","approvalKind":"plugin","decision":"allow-once"}',
          'openclaw:approval:v1:{"approvalId":"plugin:abc123","approvalKind":"plugin","decision":"deny"}',
        ],
        decision: "allow-once",
      }),
    ).toBe("plugin:abc123");
  });

  it("instructs the live reaction scenario to preserve the exact emoji glyph", () => {
    const scenario = testing.findScenario(["slack-reaction-glyph-native"])[0];
    const run = scenario?.buildRun("U999999999");

    expect(run).toMatchObject({ expectReply: true });
    expect(run && "input" in run ? run.input : "").toContain('emoji to exactly "✅"');
    expect(run && "input" in run ? run.input : "").toContain("Do not substitute a shortcode");
  });

  it("proves the public Slack send path stores complete ordered fallback chunks", async () => {
    const probe = testing.buildSlackInvalidBlocksTableProbe();
    const storedPayloads: Array<Record<string, unknown> & { ts: string }> = [];
    const postMessage = vi.fn(async (payload: Record<string, unknown>) => {
      const ts = `2.${String(storedPayloads.length + 1).padStart(6, "0")}`;
      storedPayloads.push({ ...payload, ts });
      return { channel: "C123456789", ok: true, ts };
    });
    const history = vi.fn(async () => ({
      messages: storedPayloads.toReversed().map((payload) => ({
        blocks: payload.blocks,
        text: typeof payload.text === "string" ? payload.text.replace(/\s+/gu, " ") : payload.text,
        ts: payload.ts,
        user: "U999999999",
      })),
    }));
    const sutWriteClient = { chat: { postMessage } };
    const cfg = buildSlackConfigFixture({}, { driverBotUserId: "U111111111" });

    const result = await testing.runSlackTableInvalidBlocksFallbackScenario({
      cfg,
      channelId: "C123456789",
      sutAccountId: "sut",
      sutIdentity: { userId: "U999999999" },
      sutReadClient: { conversations: { history } } as never,
      sutWriteClient: sutWriteClient as never,
      timeoutMs: 0,
    });

    expect(postMessage).toHaveBeenCalledTimes(3);
    const fallbackRequests = postMessage.mock.calls.map(([request]) => request);
    expect(fallbackRequests.every((request) => !Object.hasOwn(request, "blocks"))).toBe(true);
    expect(fallbackRequests.every((request) => request.mrkdwn === false)).toBe(true);
    const fallbackText = fallbackRequests.map((request) => request.text).join("");
    expect(fallbackText).toHaveLength(probe.fallbackText.length);
    expect(fallbackText.split("\n")).toContain(probe.firstRowText);
    expect(fallbackText.split("\n")).toContain(probe.finalRowText);
    expect(storedPayloads.map((payload) => payload.ts)).toEqual([
      "2.000001",
      "2.000002",
      "2.000003",
    ]);
    expect(
      storedPayloads
        .map((payload) =>
          typeof payload.text === "string" ? payload.text.replace(/\s+/gu, " ") : "",
        )
        .join(""),
    ).toBe(fallbackText.replace(/\s+/gu, " "));
    expect(result.message).toMatchObject({ ts: "2.000003", user: "U999999999" });
    expect(result.details).toContain("first API failure=invalid_blocks");
    expect(result.details).toContain("API attempts=4");
    expect(result.details).toContain("fallback formatting disabled=true");
    expect(result.details).toContain("fallback chunks=3");
    expect(result.details).toContain("first row=present");
    expect(result.details).toContain("final row=present");
    expect(result.details).toContain("complete delivery=true");
    expect(sutWriteClient.chat.postMessage).toBe(postMessage);
  });

  it("bounds invalid_blocks readback diagnostics while showing the observed text", async () => {
    const malformedReadback = `BROKEN-${"x".repeat(2_000)}`;
    let postCount = 0;
    const postMessage = vi.fn(async () => {
      postCount += 1;
      return {
        channel: "C123456789",
        ok: true,
        ts: `2.${String(postCount).padStart(6, "0")}`,
      };
    });
    const sutWriteClient = { chat: { postMessage } };
    const cfg = buildSlackConfigFixture({}, { driverBotUserId: "U111111111" });

    const error = await testing
      .runSlackTableInvalidBlocksFallbackScenario({
        cfg,
        channelId: "C123456789",
        sutAccountId: "sut",
        sutIdentity: { userId: "U999999999" },
        sutReadClient: {
          conversations: {
            history: vi.fn(async () => ({
              messages: [
                { text: "", ts: "2.000003", user: "U999999999" },
                { text: "", ts: "2.000002", user: "U999999999" },
                { text: malformedReadback, ts: "2.000001", user: "U999999999" },
              ],
            })),
          },
        } as never,
        sutWriteClient: sutWriteClient as never,
        timeoutMs: 0,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(`${malformedReadback.length} characters`);
    expect(message).toContain('actual="BROKEN-');
    expect(message).toContain("…");
    expect(message.length).toBeLessThan(700);
  });

  it("reports the real Slack error when the fallback request fails", async () => {
    const postMessage = vi.fn(async () => {
      throw Object.assign(new Error("do not persist this raw platform detail"), {
        data: { error: "invalid_arguments", ok: false },
      });
    });
    const sutWriteClient = { chat: { postMessage } };
    const cfg = buildSlackConfigFixture({}, { driverBotUserId: "U111111111" });

    await expect(
      testing.runSlackTableInvalidBlocksFallbackScenario({
        cfg,
        channelId: "C123456789",
        sutAccountId: "sut",
        sutIdentity: { userId: "U999999999" },
        sutReadClient: { conversations: { history: vi.fn() } } as never,
        sutWriteClient: sutWriteClient as never,
        timeoutMs: 0,
      }),
    ).rejects.toThrow(
      "Slack fallback part 1 failed after invalid_blocks; observed invalid_arguments",
    );
    expect(sutWriteClient.chat.postMessage).toBe(postMessage);
  });

  it("does not expose an untrusted Slack fallback error value", async () => {
    const postMessage = vi.fn(async () => {
      throw Object.assign(new Error("private platform detail"), {
        data: { error: "unsafe private detail", ok: false },
      });
    });
    const sutWriteClient = { chat: { postMessage } };
    const cfg = buildSlackConfigFixture({}, { driverBotUserId: "U111111111" });

    await expect(
      testing.runSlackTableInvalidBlocksFallbackScenario({
        cfg,
        channelId: "C123456789",
        sutAccountId: "sut",
        sutIdentity: { userId: "U999999999" },
        sutReadClient: { conversations: { history: vi.fn() } } as never,
        sutWriteClient: sutWriteClient as never,
        timeoutMs: 0,
      }),
    ).rejects.toThrow(
      "Slack fallback part 1 failed after invalid_blocks; observed no fallback API failure code",
    );
    expect(sutWriteClient.chat.postMessage).toBe(postMessage);
  });

  it("reports a later Slack fallback chunk failure", async () => {
    const postMessage = vi
      .fn()
      .mockResolvedValueOnce({ channel: "C123456789", ok: true, ts: "2.000001" })
      .mockRejectedValueOnce(
        Object.assign(new Error("do not persist this raw platform detail"), {
          data: { error: "invalid_arguments", ok: false },
        }),
      );
    const sutWriteClient = { chat: { postMessage } };
    const cfg = buildSlackConfigFixture({}, { driverBotUserId: "U111111111" });

    await expect(
      testing.runSlackTableInvalidBlocksFallbackScenario({
        cfg,
        channelId: "C123456789",
        sutAccountId: "sut",
        sutIdentity: { userId: "U999999999" },
        sutReadClient: { conversations: { history: vi.fn() } } as never,
        sutWriteClient: sutWriteClient as never,
        timeoutMs: 0,
      }),
    ).rejects.toThrow(
      "Slack fallback part 2 failed after invalid_blocks; observed invalid_arguments",
    );
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(sutWriteClient.chat.postMessage).toBe(postMessage);
  });

  it("enables the message tool for the live reaction scenario", () => {
    const scenario = testing.findScenario(["slack-reaction-glyph-native"])[0];
    const cfg = buildSlackConfigFixture({}, { overrides: scenario?.configOverrides });

    expect(cfg.tools?.alsoAllow).toContain("message");
  });

  it("adds the message tool to an explicit allowlist without mixing tool policies", () => {
    const scenario = testing.findScenario(["slack-reaction-glyph-native"])[0];
    const cfg = buildSlackConfigFixture(
      { tools: { allow: ["read"] } },
      { overrides: scenario?.configOverrides },
    );

    expect(cfg.tools?.allow).toEqual(["read", "message"]);
    expect(cfg.tools?.alsoAllow).toBeUndefined();
  });

  it("preserves an empty allowlist as allow-all when enabling the message tool", () => {
    const scenario = testing.findScenario(["slack-reaction-glyph-native"])[0];
    const cfg = buildSlackConfigFixture(
      { tools: { allow: [] } },
      { overrides: scenario?.configOverrides },
    );

    expect(cfg.tools?.allow).toEqual([]);
    expect(cfg.tools?.alsoAllow).toEqual(["message"]);
  });

  it("requires the SUT-owned normalized Slack reaction", async () => {
    const get = vi.fn(async () => ({
      message: {
        reactions: [{ count: 1, name: "white_check_mark", users: ["U999999999"] }],
      },
    }));

    await expect(
      testing.waitForSlackReaction({
        channelId: "C123456789",
        client: { reactions: { get } } as never,
        expectedReactionName: "white_check_mark",
        messageId: "123.456",
        sutUserId: "U999999999",
        timeoutMs: 0,
      }),
    ).resolves.toMatchObject({ name: "white_check_mark" });
    expect(get).toHaveBeenCalledWith({
      channel: "C123456789",
      full: true,
      timestamp: "123.456",
    });
  });

  it("aborts, awaits terminal cleanup, and stops the gateway process tree before cleanup", async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ aborted: true, runIds: ["run-123"] })
      .mockResolvedValueOnce({ endedAt: 123, runId: "run-123", status: "ok" });
    const stopGateway = vi.fn();

    await testing.quiesceCodexApprovalAgentRun({
      context: { gateway: { call } } as never,
      preserveDebugArtifacts: false,
      runId: "run-123",
      sessionKey: "agent:qa:approval",
      stopGateway,
    });

    expect(call).toHaveBeenNthCalledWith(
      1,
      "chat.abort",
      { runId: "run-123", sessionKey: "agent:qa:approval" },
      { timeoutMs: 10_000 },
    );
    expect(call).toHaveBeenNthCalledWith(
      2,
      "agent.wait",
      { runId: "run-123", timeoutMs: 10_000 },
      { timeoutMs: 15_000 },
    );
    expect(stopGateway).toHaveBeenCalledWith(false);
  });

  it("preserves debug artifacts when abort and terminal acknowledgements fail", async () => {
    const call = vi.fn().mockRejectedValue(new Error("gateway unavailable"));
    const stopGateway = vi.fn();

    await testing.quiesceCodexApprovalAgentRun({
      context: { gateway: { call } } as never,
      preserveDebugArtifacts: true,
      runId: "run-123",
      sessionKey: "agent:qa:approval",
      stopGateway,
    });

    expect(stopGateway).toHaveBeenCalledWith(true);
  });

  it("builds approval checkpoint message evidence from Slack blocks", () => {
    expect(
      testing.buildSlackApprovalCheckpointMessage({
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: "Plugin approval required" },
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "Allow Once" },
                value:
                  'openclaw:approval:v1:{"approvalId":"plugin:abc","approvalKind":"plugin","decision":"allow-once"}',
              },
            ],
          },
        ],
        text: "Plugin approval required",
      }),
    ).toEqual({
      actionLabels: ["Allow Once"],
      blockText: ["Plugin approval required", "Allow Once"],
      hasNativeActions: true,
      text: "Plugin approval required",
    });
  });

  it("allows live approval resolve RPCs to take longer than the generic gateway probe timeout", async () => {
    const call = vi.fn(async () => ({ decision: "allow-once" }));

    await testing.resolveApprovalDecision({
      approvalId: "plugin:abc",
      context: {
        gateway: { call },
      } as never,
      decision: "allow-once",
      kind: "plugin",
    });

    expect(call).toHaveBeenCalledWith(
      "plugin.approval.resolve",
      { decision: "allow-once", id: "plugin:abc" },
      {
        expectFinal: false,
        timeoutMs: 35_000,
      },
    );
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
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
