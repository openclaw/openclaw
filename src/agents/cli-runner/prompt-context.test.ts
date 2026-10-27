import { afterEach, expect, it, vi } from "vitest";
import { buildCliSessionDriftNote } from "../cli-session-drift.js";
import * as media from "../media-generation-task-status.js";
import { createCliCurrentPromptRenderer, prepareCliTurnPromptContext } from "./prompt-context.js";
import type { CliReusableSession } from "./types.js";

afterEach(() => vi.restoreAllMocks());
const stable = "Stable instructions.";

function prepare(overrides: Partial<Parameters<typeof prepareCliTurnPromptContext>[0]> = {}) {
  return prepareCliTurnPromptContext({
    agentId: "main",
    backendId: "claude-cli",
    backend: { command: "claude", systemPromptArg: "--system-prompt" },
    systemPrompt: stable,
    prompt: "Hello",
    capabilityToolNames: new Set<string>(),
    context: [],
    prependContext: [],
    privateContext: true,
    isNewSession: true,
    ...overrides,
  });
}

it.each([false, true])("refreshes resumed CLI dates (private: %s)", async (privateContext) => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-09T14:59:59Z"));
  const params = {
    backendId: "fixture-cli",
    backend: { command: "fixture-cli", systemPromptArg: "--system-prompt" },
    prompt: "What is today's date?",
    configuredTimezone: "Asia/Tokyo",
    privateContext,
  };
  const first = await prepare(params);
  clock.mockReturnValue(Date.parse("2026-10-09T15:00:01Z"));
  const resumed = await prepare({ ...params, isNewSession: false });
  const context = (turn: typeof first) => turn.promptContext?.appendContext ?? turn.prompt;

  expect([first.systemPrompt, resumed.systemPrompt]).toEqual([stable, stable]);
  expect(context(first)).toContain("Current date: 2026-10-09");
  expect(context(resumed)).toContain("Current date: 2026-10-10");
  expect(context(resumed)).toContain("Time zone: Asia/Tokyo");
  expect(context(resumed)).not.toContain("session_status");
  expect(resumed.prompt).toEqual(
    privateContext ? params.prompt : expect.stringMatching(/^What is today's date\?/),
  );
});

it("keeps a transient session notice at the top of the native user prompt", () => {
  const session = { mode: "reuse", sessionId: "native-session" } as const;
  const note = "[OpenClaw: Messages occurred outside this Claude session.]";
  const prompt = "Read the latest token.";
  const expected = `${note}\n\n${prompt}`;
  const render = createCliCurrentPromptRenderer({}, session, { sessionGapContext: note });
  expect([render(prompt), render(prompt, true)]).toEqual([expected, expected]);
  expect(createCliCurrentPromptRenderer({}, session)(prompt)).toBe(prompt);
});

const inboundPrompt = "Conversation info\n\nask";
const drift = buildCliSessionDriftNote(["system-prompt"]);
it.each<[CliReusableSession, string]>([
  [
    { mode: "reuse-with-drift", sessionId: "native-bound", drift: { reasons: ["system-prompt"] } },
    [drift, inboundPrompt].join("\n\n"),
  ],
  [{ mode: "invalidate", invalidatedReason: "mcp" }, inboundPrompt],
  [{ mode: "reuse", sessionId: "native-bound" }, inboundPrompt],
])("renders saved CLI context for %j", (session, expected) => {
  const render = createCliCurrentPromptRenderer(
    { currentInboundContext: { text: "Conversation info" } },
    session,
  );
  expect(render("ask")).toBe(expected);
});

const runtimeFacts = "Runtime: session=agent:main:private-probe | channel=cli";
const systemPrompt = `${stable}\n<!-- OPENCLAW-RELOCATABLE-BOUNDARY -->\n${runtimeFacts}\n<!-- /OPENCLAW-RELOCATABLE-BOUNDARY -->`;

it("preserves private Runtime facts when optional turn context fails", async () => {
  vi.spyOn(media, "buildMediaTaskRuntimeContext").mockRejectedValueOnce(new Error("unavailable"));
  const guidance = "Reply in this conversation.";
  const turn = await prepare({ systemPrompt, deliveryGuidance: guidance });
  expect(turn).toMatchObject({ systemPrompt: stable, prompt: "Hello" });
  expect(turn.promptContext?.appendContext).toBe(`${runtimeFacts}\n\n${guidance}`);
});

it("lets a whole-system hook replacement remove ordinary Claude Runtime facts", async () => {
  const turn = await prepare({
    systemPrompt,
    hookResult: {
      systemPrompt: "Replacement instructions.",
      hasPendingNonPromptBuildContext: false,
    },
  });
  expect(turn).toMatchObject({ systemPrompt: "Replacement instructions.", prompt: "Hello" });
  expect(turn.promptContext?.appendContext).not.toContain(runtimeFacts);
});
