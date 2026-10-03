import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { testing as adapterTesting } from "./adapter.runtime.js";
import { quiesceCodexApprovalAgentRun } from "./slack-live.codex-approval.js";
import {
  buildSlackQaConfig,
  parseSlackQaCredentialPayload,
  resolveSlackQaRuntimeEnv,
} from "./slack-live.config.js";
import {
  type SlackObservedMessage,
  SLACK_QA_NATIVE_CHART,
  SLACK_QA_NATIVE_TABLE,
  assertSlackCodexApprovalModelSupported,
} from "./slack-live.contracts.js";
import { buildSlackInvalidBlocksTableProbe } from "./slack-live.invalid-blocks.js";
import {
  observeSlackScenarioMessages,
  waitForSlackNoReply,
} from "./slack-live.message-observations.js";
import {
  buildSlackApprovalCheckpointMessage,
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
  const run = findScenario([id])[0]?.buildRun(sutUserId);
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

const observationContext = {
  channelId: "C123456789",
  matchText: "FINAL_MARKER",
  sentTs: "1",
  sutIdentity: { userId: "U999999999" },
  observationScenarioId: "slack-mention-gating",
  observationScenarioTitle: "Slack message observation",
};
const fallbackContext = {
  cfg: buildSlackConfigFixture({}, { driverBotUserId: "U111111111" }),
  channelId: "C123456789",
  sutAccountId: "sut",
  sutIdentity: { userId: "U999999999" },
  timeoutMs: 0,
};

describe("Slack live QA runtime helpers", () => {
  beforeAll(async () => {
    // Warm the real action graph outside the scenario deadlines.
    await loadSlackQaRuntime().preloadSlackActions();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function progress(suffix: string) {
    const f = buildSlackProgressFixture(`slack-progress-commentary-${suffix}`);
    return {
      commentary: f.commentaryMarker,
      tool: f.toolMarker,
      output: f.outputMarker,
      final: f.finalMarker,
      verify: (messages: SlackObservedMessage[], text = f.finalMarker) =>
        f.verifyObserved({
          finalMessage: { text, ts: "final" },
          messages: [...messages, slackMessage(f.finalMarker, "final")],
        }),
    };
  }

  it("converts Slack rate-limit retry seconds for the observer backoff", () => {
    expect(adapterTesting.resolveSlackRateLimitDelayMs({ retryAfter: 10 })).toBe(10_000);
    expect(adapterTesting.resolveSlackRateLimitDelayMs({ retryAfter: 0 })).toBeUndefined();
    expect(
      adapterTesting.resolveSlackRateLimitDelayMs(new Error("network failed")),
    ).toBeUndefined();
  });

  it("normalizes credentials from env and Convex and rejects malformed channel ids", () => {
    const credentials = {
      channelId: "C123456789",
      driverBotToken: "xoxb-driver",
      sutBotToken: "xoxb-sut",
      sutAppToken: "xapp-sut",
    };
    const env = {
      OPENCLAW_QA_SLACK_CHANNEL_ID: credentials.channelId,
      OPENCLAW_QA_SLACK_DRIVER_BOT_TOKEN: credentials.driverBotToken,
      OPENCLAW_QA_SLACK_SUT_BOT_TOKEN: credentials.sutBotToken,
      OPENCLAW_QA_SLACK_SUT_APP_TOKEN: credentials.sutAppToken,
    };
    expect(resolveSlackQaRuntimeEnv(env)).toEqual(credentials);
    expect(parseSlackQaCredentialPayload(credentials)).toEqual(credentials);
    expect(() =>
      resolveSlackQaRuntimeEnv({ ...env, OPENCLAW_QA_SLACK_CHANNEL_ID: "qa-channel" }),
    ).toThrow("OPENCLAW_QA_SLACK channelId must be a Slack id like C123 or U123.");
  });

  it("surfaces MPIM cleanup failures and retains ownership for a retry", async () => {
    const run = findScenario(["slack-mpim-app-mention-dedupe"])[0]?.buildRun("U_SUT");
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

  it("sends an MPIM recall only for a valid threaded seed, without leaking its nonce", async () => {
    const run = buildSlackReplyRun("slack-mpim-app-mention-dedupe", "U_SUT");
    const seed = /SLACK_QA_MPIM_SEED_[A-Z0-9]+/u.exec(run.input)?.[0];
    if (!seed) {
      throw new Error("missing Slack MPIM seed marker");
    }
    const recall = seed.replace("SEED", "RECALL");
    const postMessage = vi.fn(async (_request: { text?: string }) => ({
      channel: "C_MPIM",
      ts: "2.000000",
    }));
    const context = {
      channelId: "C_MPIM",
      sentTs: "1.000000",
      sutIdentity: { botId: "B_SUT", userId: "U_SUT" },
      driverClient: { chat: { postMessage } },
      sutReadClient: {
        conversations: {
          history: async () => ({ messages: [] }),
          replies: async () => ({
            messages: [
              {
                bot_id: "B_SUT",
                text: `${recall}_TESTNONCE`,
                thread_ts: "1.000000",
                ts: "3.000000",
                user: "U_SUT",
              },
            ],
          }),
        },
      },
    } as never;
    const reply = { thread_ts: "1.000000", ts: "1.500000", user: "U_SUT" };
    await expect(run.afterReply(reply, context)).rejects.toThrow(
      "MPIM seed reply did not contain the provider-generated bot nonce",
    );
    await expect(
      run.afterReply({ ...reply, text: `${seed}_BOT_TESTNONCE`, thread_ts: undefined }, context),
    ).rejects.toThrow("MPIM seed reply escaped the native Slack thread");
    expect(postMessage).not.toHaveBeenCalled();
    await expect(
      run.afterReply({ ...reply, text: `${seed}_BOT_TESTNONCE` }, context),
    ).resolves.toContain("recovered the prior bot reply");
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "C_MPIM", thread_ts: "1.000000" }),
    );
    const text = postMessage.mock.calls[0]?.[0]?.text;
    expect(text).toContain(`previous reply beginning with ${seed}_BOT_`);
    expect(text).toContain(`exact format: ${recall}_<NONCE>`);
    expect(text).not.toContain("TESTNONCE");
  });

  it("accepts only Codex harness providers for Codex approval scenarios", () => {
    expect(() => assertSlackCodexApprovalModelSupported("openai/gpt-5.6-luna")).not.toThrow();
    expect(() => assertSlackCodexApprovalModelSupported("codex/gpt-5.6-luna")).not.toThrow();
    expect(() => assertSlackCodexApprovalModelSupported("anthropic/claude-sonnet-4-6")).toThrow(
      'Slack Codex approval scenarios require an openai/* or codex/* model; received "anthropic/claude-sonnet-4-6".',
    );
  });

  it("configures native approval forwarding and the guardian runtime", () => {
    const cfg = buildSlackConfigFixture(
      { agents: { defaults: {}, list: [{ id: "qa", model: { primary: "openai/gpt-5.6-luna" } }] } },
      {
        overrides: {
          approvals: { exec: true, plugin: true, target: "channel" },
          codexApproval: true,
        },
        primaryModel: "openai/gpt-5.6-luna",
      },
    );
    expect(cfg.plugins?.allow).toEqual(["slack", "codex"]);
    expect(cfg.plugins?.entries?.codex).toEqual({
      enabled: true,
      config: { appServer: { mode: "guardian" } },
    });
    expect(cfg.tools?.exec?.mode).toBe("ask");
    expect(cfg.agents?.defaults?.models?.["openai/gpt-5.6-luna"]?.agentRuntime).toEqual({
      id: "codex",
    });
    expect(cfg.approvals).toEqual({
      exec: { enabled: true, mode: "session" },
      plugin: { enabled: true, mode: "session" },
    });
    expect(cfg.channels?.slack?.accounts?.sut).toMatchObject({
      allowFrom: ["U999999999"],
      execApprovals: { enabled: true, approvers: ["U999999999"], target: "channel" },
      channels: { C123456789: { users: ["U999999999"] } },
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

  it("requires a complete disabled-channel warning after the captured log cursor", async () => {
    const run = buildSlackMessageRun("slack-channel-disabled-warning");
    const call = vi
      .fn()
      .mockResolvedValueOnce({ cursor: 12 })
      .mockResolvedValueOnce({
        lines: ["Slack channel denied by configuration channel_not_allowed channel_disabled"],
      })
      .mockResolvedValueOnce({
        lines: ["Slack channel denied by configuration channel_not_allowed", "channel_disabled"],
      });
    const context = { gateway: { call } } as never;
    await run.beforeRun?.(context);
    await expect(run.afterNoReply?.(context)).resolves.toBe(
      "structured disabled-channel warning observed",
    );
    expect(call).toHaveBeenNthCalledWith(
      2,
      "logs.tail",
      { cursor: 12, limit: 200, maxBytes: 256_000 },
      { timeoutMs: 20_000 },
    );
    await expect(run.afterNoReply?.(context)).rejects.toThrow(
      "did not emit the structured warning",
    );
  });

  it("configures independent commentary, tool progress, and durable verbosity", () => {
    const config = (id: string) =>
      buildSlackConfigFixture(
        {
          agents: {
            defaults: { verboseDefault: "off" },
            list: [{ id: "qa", identity: { name: "C-3PO QA" } }],
          },
        },
        { overrides: findScenario([id])[0]?.configOverrides },
      );
    const enabled = config("slack-progress-commentary-true");
    const disabled = config("slack-progress-commentary-false");
    const omitted = config("slack-progress-commentary-omitted").channels?.slack?.accounts?.sut
      ?.streaming?.progress;
    expect(enabled.channels?.slack?.accounts?.sut?.streaming).toMatchObject({
      nativeTransport: false,
      progress: { commentary: true, commandText: "raw", toolProgress: false },
    });
    expect(disabled.channels?.slack?.accounts?.sut?.streaming?.progress).toMatchObject({
      commentary: false,
      commandText: "raw",
      toolProgress: false,
    });
    expect(disabled.agents?.defaults?.verboseDefault).toBe("off");
    expect(omitted).toMatchObject({ style: "compact", toolProgress: true });
    expect(Object.hasOwn(omitted ?? {}, "commentary")).toBe(false);
    expect(
      config("slack-progress-commentary-verbose-dedupe").agents?.defaults?.verboseDefault,
    ).toBe("on");
    expect(config("slack-progress-commentary-verbose-full").agents?.defaults?.verboseDefault).toBe(
      "full",
    );
    expect(enabled.agents?.list?.[0]?.identity).toBeUndefined();
    expect(config("slack-mpim-app-mention-dedupe").channels?.slack?.accounts?.sut).toMatchObject({
      dm: { enabled: true, groupEnabled: true },
      replyToMode: "all",
      streaming: { mode: "off" },
    });
  });

  it("verifies progress commentary from history and captured writes", () => {
    for (const suffix of ["true", "false", "omitted", "verbose-dedupe", "verbose-full"]) {
      const {
        commentaryMarker: commentary,
        toolMarker: tool,
        outputMarker: output,
        finalMarker: final,
        input,
        verifyObserved,
      } = buildSlackProgressFixture(`slack-progress-commentary-${suffix}`);
      expect(input).toContain(
        `printf '%s' '${tool}' >/dev/null; sleep 5; printf '%s\\n' '${output}'`,
      );
      const messages = [
        slackMessage(final, "2"),
        suffix === "true"
          ? slackMessage("Working…", "1", [`• *Commentary* — _${commentary}_`])
          : slackMessage(commentary, "1"),
      ];
      if (suffix === "omitted") {
        messages.push(slackMessage(commentary, "1", ["🛠️ *Exec* — sleep 5"]));
      }
      if (suffix === "verbose-dedupe") {
        messages.push(slackMessage(":hammer_and_wrench: Exec", "1.5"));
      }
      if (suffix === "verbose-full") {
        messages.push(slackMessage(`🛠️ Exec\n\`\`\`\n${output}\n\`\`\``, "1.5"));
      }
      const verify = () => verifyObserved({ finalMessage: { text: final, ts: "2" }, messages });
      expect(verify()).toContain("verified");
      if (suffix === "omitted") {
        messages[2] = slackMessage(commentary, "1", ["Exec — sleep 5"]);
        expect(verify()).toContain("verified");
        messages[2] = slackMessage(commentary, "1", ["Run — `sleep 5`"]);
        expect(verify()).toContain("verified");
      }
    }
  });

  it("recognizes exact commentary rows within Slack progress cards", () => {
    const { commentary: c, verify } = progress("true");
    for (const message of [
      { text: `_${c}_` },
      { text: `💬 ${c}` },
      { text: `:speech_balloon: ${c}` },
      { text: `_${c}_\n_more commentary_` },
      {
        text: "Working…",
        blockText: [`✅ *Working*`, `• *Commentary* — _${c}_\n• *Commentary* — _another note_`],
      },
    ]) {
      expect(() =>
        verify([{ channelId: "C123456789", ts: "commentary", ...message }]),
      ).not.toThrow();
    }
    for (const message of [
      { text: c },
      { text: `prefix _${c}_ suffix` },
      { text: `💬 ${c} extra prose` },
      { text: "Working…", blockText: [`• *Exec* — _${c}_`] },
      { text: "Working…", blockText: [`• *Commentary* — _${c} extra prose_`] },
      { text: "Working…", blockText: [`• *Update* — ${c}`] },
    ]) {
      expect(() => verify([{ channelId: "C123456789", ts: "commentary", ...message }])).toThrow(
        "expected commentary in the Slack progress commentary lane",
      );
    }
  });

  it("rejects commentary when false and mismatched tool progress", () => {
    const headline = progress("false");
    expect(() =>
      headline.verify([slackMessage(`💬 ${headline.commentary}`, "commentary")]),
    ).toThrow("status headline");
    const lane = progress("true");
    for (const text of [lane.tool, lane.output, "🛠️ Exec"]) {
      expect(() =>
        lane.verify([
          slackMessage(`💬 ${lane.commentary}`, "commentary"),
          slackMessage(text, "tool"),
        ]),
      ).toThrow("tool progress to stay out");
    }
    const draft = progress("omitted");
    expect(() => draft.verify([slackMessage(draft.commentary, "commentary")])).toThrow(
      "tool progress on the draft",
    );
    expect(() =>
      lane.verify(
        [slackMessage(`💬 ${lane.commentary} ${lane.final}`, "final")],
        `${lane.commentary} ${lane.final}`,
      ),
    ).toThrow("only the final marker");
  });

  it.each([
    { finalEdit: false, markerKind: "TOOL" },
    { finalEdit: true, markerKind: "OUTPUT" },
  ])(
    "rejects $markerKind disclosure in verbose-on progress (final edit: $finalEdit)",
    ({ finalEdit, markerKind }) => {
      const p = progress("verbose-dedupe");
      const marker = markerKind === "TOOL" ? p.tool : p.output;
      expect(() =>
        p.verify([
          slackMessage(`💬 ${p.commentary}`, "commentary"),
          slackMessage(
            finalEdit ? `${marker} ${p.final}` : `🛠️ Exec ${marker}`,
            finalEdit ? "final" : "tool",
          ),
        ]),
      ).toThrow("command details and output must stay hidden in verbose-on progress");
    },
  );

  it("requires full tool output rather than echoed command metadata", () => {
    const p = progress("verbose-full");
    const verify = (...messages: Array<{ text: string; ts: string }>) =>
      p.verify([
        slackMessage(`💬 ${p.commentary}`, "commentary"),
        ...messages.map((m) => slackMessage(m.text, m.ts)),
      ]);
    const tool = (text: string, ts = "tool") => ({ text, ts });
    expect(() => verify(tool(`🛠️ Exec: printf '${p.output}'`))).toThrow(
      "expected exact tool output",
    );
    expect(() => verify(tool(`🛠️ ${p.output}`))).toThrow("expected exact tool output");
    const summary = `🛠️ \`sleep 5; printf '%s\\\\n' '${p.output}' # ${p.tool}\``;
    const delivered = sanitizeAssistantVisibleText(`${summary}\n\`\`\`txt\n${p.output}\n\`\`\``);
    expect(sanitizeAssistantVisibleText(summary)).toBe("");
    expect(delivered).toBe(`\`\`\`txt\n${p.output}\n\`\`\``);
    expect(() => verify(tool(delivered))).not.toThrow();
    expect(() => verify(tool(p.output))).not.toThrow();
    expect(() => verify(tool(`🛠️ Run command: # ${p.tool}\n${p.output}`))).not.toThrow();
    expect(() =>
      verify(tool(`🛠️ Exec\n${p.output}`, "tool-1"), tool(`🛠️ Exec\n${p.output}`, "tool-2")),
    ).toThrow("expected exact tool output in one standalone verbose message");
    const start = "🛠️ run sleep → print text";
    expect(() => verify(tool(start, "summary"), tool(`${start}\n${p.output}`))).not.toThrow();
    expect(() =>
      verify(tool(start, "summary-1"), tool(start, "summary-2"), tool(`${start}\n${p.output}`)),
    ).toThrow(
      "expected exact tool output in one standalone verbose message and at most one summary",
    );
    expect(() =>
      verify(tool("🛠️ Exec"), tool(`🛠️ Exec\n\`\`\`\n${p.output}\n\`\`\``)),
    ).not.toThrow();
  });

  it("rejects verbose-on output updates without protocol markers", () => {
    const p = progress("verbose-dedupe");
    expect(() =>
      p.verify([
        slackMessage(`💬 ${p.commentary}`, "commentary"),
        slackMessage("🛠️ Exec", "tool"),
        slackMessage("🛠️ Exec\nunmarked output", "tool"),
      ]),
    ).toThrow("command details and output must stay hidden in verbose-on progress");
  });

  it("requires a standalone identity for the safe verbose summary", () => {
    const p = progress("verbose-dedupe");
    for (const ts of [undefined, "commentary", "final"]) {
      expect(() =>
        p.verify([
          slackMessage(`💬 ${p.commentary}`, "commentary"),
          ...(ts ? [slackMessage("🛠️ Exec", ts)] : []),
        ]),
      ).toThrow("standalone verbose message");
    }
  });

  it("bounds presentation facts and redacts Slack text, identities and command details", () => {
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
    const privateText = "private-observation-sentinel";
    let failure = "";
    try {
      run.verifyObserved({
        finalMessage: { text: run.matchText, ts: "final" },
        messages: [
          ...Array.from({ length: 40 }, (_, index) => {
            const [prefix, suffix] = presentations[index % presentations.length]!;
            return slackMessage(
              `${prefix}${commentary}${suffix}\n${privateText}`,
              `private-identity-${index}`,
              [`• *Commentary* — _${commentary}_\n_${commentary}_`, privateText.repeat(1_000)],
            );
          }),
          slackMessage("🛠️ `sleep 5`", "private-tool-identity"),
        ],
      });
    } catch (error) {
      failure = String(error);
    }
    expect(failure).toContain("exactly one Slack message identity containing commentary");
    const facts = JSON.parse(failure.split("presentation=")[1] ?? "[]");
    expect(facts).toHaveLength(16);
    expect(new Set(facts.map((fact: { text: string }) => fact.text))).toEqual(
      new Set([...presentations.map((presentation) => presentation[2]), "missing"]),
    );
    expect(facts[0]).toMatchObject({
      block: "commentary-row/italic",
      lines: [2, 3],
      occurrences: [1, 2],
    });
    expect(facts.at(-1)).toMatchObject({ tool: "sleep-without-marker" });
    expect(failure).not.toContain(privateText);
    expect(failure).not.toContain("private-identity");
    expect(failure).not.toContain("private-tool-identity");
    expect(failure).not.toContain(commentary);
    expect(failure).not.toContain("sleep 5");
    expect(failure.length).toBeLessThan(4_000);
  });

  it("settles channel and thread observations after the final reply", async () => {
    vi.useFakeTimers();
    let historyCalls = 0;
    const observedMessages: Array<{ text: string }> = [];
    const message = (text: string, ts: string) => ({ text, ts, user: "U999999999" });
    const observation = observeSlackScenarioMessages({
      ...observationContext,
      observedMessages: observedMessages as never,
      client: {
        conversations: {
          history: async () => ({
            messages:
              ++historyCalls === 1
                ? [message("FINAL_MARKER", "3"), message("EARLIER_COMMENTARY", "2")]
                : [message("LATE_DUPLICATE", "4"), message("FINAL_MARKER", "3")],
          }),
          replies: async () => ({ messages: [message("THREAD_DUPLICATE", "5")] }),
        },
      } as never,
      settleMs: 500,
      threadTs: "1",
    });
    await vi.advanceTimersByTimeAsync(500);
    await observation;
    expect(historyCalls).toBeGreaterThanOrEqual(2);
    expect(new Set(observedMessages.map((observed) => observed.text))).toEqual(
      new Set(["FINAL_MARKER", "EARLIER_COMMENTARY", "LATE_DUPLICATE", "THREAD_DUPLICATE"]),
    );
  });

  it("stores complete ordered invalid_blocks fallback chunks through the public send path", async () => {
    const probe = buildSlackInvalidBlocksTableProbe();
    const stored: Array<Record<string, unknown> & { ts: string }> = [];
    const postMessage = vi.fn(async (payload: Record<string, unknown>) => {
      const ts = `2.${String(stored.length + 1).padStart(6, "0")}`;
      stored.push({ ...payload, ts });
      return { channel: "C123456789", ok: true, ts };
    });
    const history = vi.fn(async () => ({
      messages: stored.toReversed().map((payload) => ({
        blocks: payload.blocks,
        text: typeof payload.text === "string" ? payload.text.replace(/\s+/gu, " ") : payload.text,
        ts: payload.ts,
        user: "U999999999",
      })),
    }));
    const client = { chat: { postMessage } };
    const result = await runSlackTableInvalidBlocksFallbackScenario({
      ...fallbackContext,
      sutReadClient: { conversations: { history } } as never,
      sutWriteClient: client as never,
    });
    expect(postMessage).toHaveBeenCalledTimes(3);
    expect(
      stored.every((payload) => !Object.hasOwn(payload, "blocks") && payload.mrkdwn === false),
    ).toBe(true);
    const text = stored.map((payload) => payload.text).join("");
    expect(text).toHaveLength(probe.fallbackText.length);
    expect(text.split("\n")).toContain(probe.firstRowText);
    expect(text.split("\n")).toContain(probe.finalRowText);
    expect(stored.map((payload) => payload.ts)).toEqual(["2.000001", "2.000002", "2.000003"]);
    expect(result.message).toMatchObject({ ts: "2.000003", user: "U999999999" });
    expect(result.details).toContain("API attempts=4");
    expect(result.details).toContain("complete delivery=true");
    expect(client.chat.postMessage).toBe(postMessage);
  });

  it("bounds invalid_blocks readback diagnostics", async () => {
    const malformed = `BROKEN-${"x".repeat(2_000)}`;
    let count = 0;
    const postMessage = vi.fn(async () => ({
      channel: "C123456789",
      ok: true,
      ts: `2.00000${++count}`,
    }));
    const error = await runSlackTableInvalidBlocksFallbackScenario({
      ...fallbackContext,
      sutWriteClient: { chat: { postMessage } } as never,
      sutReadClient: {
        conversations: {
          history: async () => ({
            messages: [3, 2, 1].map((index) => ({
              text: index === 1 ? malformed : "",
              ts: `2.00000${index}`,
              user: "U999999999",
            })),
          }),
        },
      } as never,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) {
      throw new Error("expected readback failure");
    }
    expect(error.message).toContain(`${malformed.length} characters`);
    expect(error.message).toContain('actual="BROKEN-');
    expect(error.message).toContain("…");
    expect(error.message.length).toBeLessThan(700);
  });

  it.each([
    { code: "unsafe private detail", part: 1, diagnostic: "no fallback API failure code" },
    { code: "invalid_arguments", part: 2, diagnostic: "invalid_arguments" },
  ])(
    "reports fallback failure at part $part using only safe error codes",
    async ({ code, part, diagnostic }) => {
      const postMessage = vi.fn();
      if (part === 2) {
        postMessage.mockResolvedValueOnce({ channel: "C123456789", ok: true, ts: "2.000001" });
      }
      postMessage.mockRejectedValueOnce(
        Object.assign(new Error("private platform detail"), { data: { error: code, ok: false } }),
      );
      const client = { chat: { postMessage } };
      await expect(
        runSlackTableInvalidBlocksFallbackScenario({
          ...fallbackContext,
          sutReadClient: { conversations: { history: vi.fn() } } as never,
          sutWriteClient: client as never,
        }),
      ).rejects.toThrow(
        `Slack fallback part ${part} failed after invalid_blocks; observed ${diagnostic}`,
      );
      expect(postMessage).toHaveBeenCalledTimes(part);
      expect(client.chat.postMessage).toBe(postMessage);
    },
  );

  it("adds the message tool to an explicit allowlist without mixing tool policies", () => {
    const scenario = findScenario(["slack-reaction-glyph-native"])[0];
    const cfg = buildSlackConfigFixture(
      { tools: { allow: ["read"] } },
      { overrides: scenario?.configOverrides },
    );

    expect(cfg.tools?.allow).toEqual(["read", "message"]);
    expect(cfg.tools?.alsoAllow).toBeUndefined();
  });

  it("preserves an empty allowlist as allow-all when enabling the message tool", () => {
    const scenario = findScenario(["slack-reaction-glyph-native"])[0];
    const cfg = buildSlackConfigFixture(
      { tools: { allow: [] } },
      { overrides: scenario?.configOverrides },
    );

    expect(cfg.tools?.allow).toEqual([]);
    expect(cfg.tools?.alsoAllow).toEqual(["message"]);
  });

  it("verifies the reaction scenario using the SUT-owned normalized glyph", async () => {
    const run = buildSlackReplyRun("slack-reaction-glyph-native");
    expect(run.input).toContain('emoji to exactly "✅"');
    expect(run.input).toContain("Do not substitute a shortcode");
    const get = vi.fn(async () => ({
      message: { reactions: [{ count: 1, name: "white_check_mark", users: ["U999999999"] }] },
    }));
    await expect(
      run.afterReply({}, {
        channelId: "C123456789",
        sentTs: "123.456",
        sutIdentity: { userId: "U999999999" },
        sutReadClient: { reactions: { get } },
      } as never),
    ).resolves.toContain("verified SUT white_check_mark reaction");
    expect(get).toHaveBeenCalledWith({ channel: "C123456789", full: true, timestamp: "123.456" });
  });

  it("aborts and awaits the agent before stopping even when acknowledgements fail", async () => {
    const call = vi.fn().mockRejectedValue(new Error("gateway unavailable"));
    const stopGateway = vi.fn();
    await quiesceCodexApprovalAgentRun({
      context: { gateway: { call } } as never,
      preserveDebugArtifacts: true,
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
    expect(stopGateway).toHaveBeenCalledWith(true);
    expect(stopGateway.mock.invocationCallOrder[0]).toBeGreaterThan(
      call.mock.invocationCallOrder[1]!,
    );
  });

  it("builds approval checkpoint message evidence from Slack blocks", () => {
    expect(
      buildSlackApprovalCheckpointMessage({
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

  it("ignores unrelated SUT replies but rejects the scenario marker during mention-gating", async () => {
    vi.useFakeTimers();
    const run = buildSlackMessageRun("slack-mention-gating");
    const history = vi
      .fn()
      .mockResolvedValueOnce({
        messages: [{ text: "unrelated reply", ts: "2", user: "U999999999" }],
      })
      .mockResolvedValueOnce({ messages: [{ text: run.matchText, ts: "3", user: "U999999999" }] });
    const observedMessages: SlackObservedMessage[] = [];
    const pending = expect(
      waitForSlackNoReply({
        ...observationContext,
        matchText: run.matchText,
        observedMessages,
        client: { conversations: { history } } as never,
        timeoutMs: run.noReplyObservationMs!,
      }),
    ).rejects.toThrow("unexpected Slack SUT reply observed");
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
    expect(observedMessages).toMatchObject([
      { matchedScenario: false, text: "unrelated reply", ts: "2", userId: "U999999999" },
      { matchedScenario: true, text: run.matchText, ts: "3" },
    ]);
  });
});

function buildNativeDataRun(kind: "chart" | "table") {
  const run = findScenario([`slack-${kind}-presentation-native`])[0]?.buildRun("U_SUT");
  if (!run || !("input" in run) || !run.captureBeforeReply || !run.afterReply) {
    throw new Error(`missing Slack native ${kind} scenario verifier`);
  }
  const summary = run.input.match(
    new RegExp(`SLACK_QA_${kind.toUpperCase()}_SUMMARY_[A-Z0-9]+`, "u"),
  )?.[0];
  if (!summary) {
    throw new Error("missing Slack native summary marker");
  }
  const accessibleText = [
    summary,
    "",
    ...(kind === "chart"
      ? [
          "QA latency trend (line chart)",
          "X axis: Percentile",
          "Y axis: Milliseconds",
          "- Latency: P50: 120; P95: 240",
        ]
      : [
          "QA pipeline report (table)",
          "Account\tStage\tARR",
          "Acme\tWon\t125000",
          "Globex\tReview\t82000",
        ]),
  ]
    .join("\n")
    .replace(/\s+/gu, " ");
  return {
    ...run,
    afterReply: run.afterReply,
    captureBeforeReply: run.captureBeforeReply,
    summary,
    accessibleText,
  };
}
const context = { channelId: "C123456789", sentTs: "1.000000", sutIdentity: { userId: "U_SUT" } };

describe("Slack native data QA scenarios", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["chart", "table"] as const)(
    "keeps interleaved native %s identities within their captured runs",
    async (kind) => {
      const first = buildNativeDataRun(kind);
      const second = buildNativeDataRun(kind);
      expect(first.summary).not.toBe(second.summary);
      expect(first.matchText).not.toBe(second.matchText);
      const reads = [
        { ts: "22.000000", run: second },
        { ts: "11.000000", run: first },
      ];
      const history = vi.fn(async (query: unknown) => {
        const expected = reads.shift();
        if (!expected) {
          throw new Error("unexpected Slack history retry");
        }
        expect(query).toEqual({
          channel: context.channelId,
          inclusive: true,
          latest: expected.ts,
          limit: 1,
        });
        return {
          messages: [
            {
              blocks: [kind === "chart" ? SLACK_QA_NATIVE_CHART : SLACK_QA_NATIVE_TABLE],
              text: expected.run.accessibleText,
              ts: expected.ts,
              user: "U_SUT",
            },
          ],
        };
      });
      const params = { ...context, sutReadClient: { conversations: { history } } } as never;
      await expect(first.afterReply({}, params)).rejects.toThrow("did not retain its message id");
      expect(history).not.toHaveBeenCalled();
      const writes = reads.map(({ ts, run }) => ({
        channelId: context.channelId,
        text: run.summary,
        ts,
      }));
      expect(first.captureBeforeReply(writes)).toBe(true);
      expect(second.captureBeforeReply(writes)).toBe(true);
      const verdict = `verified native ${kind === "chart" ? "data_visualization" : "data_table"} block and deterministic accessible text`;
      await expect(second.afterReply({}, params)).resolves.toBe(verdict);
      await expect(first.afterReply({}, params)).resolves.toBe(verdict);
      expect(history).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["chart", "table"] as const)("rejects fallback-only native %s delivery", async (kind) => {
    vi.useFakeTimers();
    const run = buildNativeDataRun(kind);
    const history = vi.fn(async () => ({
      messages: [{ text: run.accessibleText, ts: "2.000000", user: "U_SUT" }],
    }));
    expect(
      run.captureBeforeReply([{ channelId: context.channelId, text: run.summary, ts: "2.000000" }]),
    ).toBe(true);
    const result = expect(
      run.afterReply({}, { ...context, sutReadClient: { conversations: { history } } } as never),
    ).rejects.toThrow("waiting for Slack message");
    await vi.advanceTimersByTimeAsync(16_000);
    await result;
  });
});
