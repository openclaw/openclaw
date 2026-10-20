import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliHistoryWriter } from "../../config/sessions/cli-history-boundary.js";
import { buildCliSessionDriftNote } from "../cli-session.js";
import * as mediaTaskStatus from "../media-generation-task-status.js";
import { createCliCurrentPromptRenderer, prepareCliTurnPromptContext } from "./prompt-context.js";

afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "refreshes the date on resumed CLI turns with private context %s",
  async (privateContext) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-09T14:59:59Z"));
    const params = {
      agentId: "main",
      backendId: "fixture-cli",
      backend: { command: "fixture-cli", systemPromptArg: "--system-prompt" },
      systemPrompt: "Stable instructions.",
      prompt: "What is today's date?",
      configuredTimezone: "Asia/Tokyo",
      capabilityToolNames: new Set<string>(),
      context: [],
      prependContext: [],
      privateContext,
    };
    const first = await prepareCliTurnPromptContext({ ...params, isNewSession: true });
    clock.mockReturnValue(Date.parse("2026-10-09T15:00:01Z"));
    const resumed = await prepareCliTurnPromptContext({ ...params, isNewSession: false });
    const context = (turn: typeof first) => turn.promptContext?.appendContext ?? turn.prompt;

    expect(first.systemPrompt).toBe("Stable instructions.");
    expect(resumed.systemPrompt).toBe(first.systemPrompt);
    expect(context(first)).toContain("Current date: 2026-10-09");
    expect(context(resumed)).toContain("Current date: 2026-10-10");
    expect(context(resumed)).toContain("Time zone: Asia/Tokyo");
    expect(context(resumed)).not.toContain("session_status");
    if (privateContext) {
      expect(resumed.prompt).toBe(params.prompt);
    } else {
      expect(resumed.prompt).toMatch(/^What is today's date\?/);
    }
  },
);

it("keeps a transient session notice at the top of the native user prompt", () => {
  const session = { mode: "reuse", sessionId: "native-session" } as const;
  const note = "[OpenClaw: Messages occurred outside this Claude session.]";
  const render = createCliCurrentPromptRenderer({}, session, { sessionGapContext: note });
  expect(render("Read the latest token.")).toBe(`${note}\n\nRead the latest token.`);
  expect(render("Read the latest token.", true)).toBe(`${note}\n\nRead the latest token.`);
  expect(createCliCurrentPromptRenderer({}, session)("Read the latest token.")).toBe(
    "Read the latest token.",
  );
});

const preservedTurnsContext = "Recorded completion: CHILD_RESULT; reply: Relayed.";
const currentInboundContext = { text: "Conversation info" };
const historyWriter = {} as CliHistoryWriter;

describe("CLI resume user context", () => {
  it("puts the drift note before exchanges the resumed session missed", () => {
    const render = createCliCurrentPromptRenderer(
      { currentInboundContext },
      {
        mode: "reuse-with-drift",
        sessionId: "native-bound",
        drift: { reasons: ["system-prompt"] },
      },
      { preservedTurnsContext, writer: historyWriter },
    );

    expect(render("ask")).toBe(
      [
        buildCliSessionDriftNote(["system-prompt"]),
        preservedTurnsContext,
        "Conversation info",
        "ask",
      ].join("\n\n"),
    );
  });

  it("leaves a fresh session to recover from saved history", () => {
    expect(
      createCliCurrentPromptRenderer(
        { currentInboundContext },
        { mode: "invalidate", invalidatedReason: "mcp" },
        { preservedTurnsContext, writer: historyWriter },
      )("ask"),
    ).toBe("Conversation info\n\nask");
  });

  it("withholds missed exchanges without the history account boundary", () => {
    expect(
      createCliCurrentPromptRenderer(
        { currentInboundContext },
        { mode: "reuse", sessionId: "native-bound" },
        { preservedTurnsContext },
      )("ask"),
    ).toBe("Conversation info\n\nask");
  });
});

const runtimeFacts = "Runtime: session=agent:main:private-probe | channel=cli";
const claudeTurn = {
  agentId: "main",
  backendId: "claude-cli",
  backend: { command: "claude", systemPromptArg: "--system-prompt" },
  systemPrompt: `Stable instructions.\n<!-- OPENCLAW-RELOCATABLE-BOUNDARY -->\n${runtimeFacts}\n<!-- /OPENCLAW-RELOCATABLE-BOUNDARY -->`,
  prompt: "Hello",
  capabilityToolNames: new Set<string>(),
  context: [],
  prependContext: [],
  privateContext: true,
  isNewSession: true,
};

it("preserves private Runtime facts when optional turn context fails", async () => {
  vi.spyOn(mediaTaskStatus, "buildMediaTaskRuntimeContext").mockRejectedValueOnce(
    new Error("snapshot unavailable"),
  );
  const turn = await prepareCliTurnPromptContext({
    ...claudeTurn,
    deliveryGuidance: "Reply in this conversation.",
  });
  expect(turn.systemPrompt).toBe("Stable instructions.");
  expect(turn.prompt).toBe("Hello");
  expect(turn.promptContext?.appendContext).toBe(`${runtimeFacts}\n\nReply in this conversation.`);
});

it("lets a whole-system hook replacement remove ordinary Claude Runtime facts", async () => {
  const turn = await prepareCliTurnPromptContext({
    ...claudeTurn,
    hookResult: {
      systemPrompt: "Replacement instructions.",
      hasPendingNonPromptBuildContext: false,
    },
  });
  expect(turn.systemPrompt).toBe("Replacement instructions.");
  expect(turn.prompt).toBe("Hello");
  expect(turn.promptContext?.appendContext).not.toContain(runtimeFacts);
});
