import { afterEach, expect, it, vi } from "vitest";
import { createCliCurrentPromptRenderer, prepareCliTurnPromptContext } from "./prompt-context.js";

afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "refreshes the date on resumed CLI turns with private context %s",
  async (privateContext) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-09T14:59:59Z"));
    const params = {
      agentId: "main",
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
  const render = createCliCurrentPromptRenderer({}, session, note);
  expect(render("Read the latest token.")).toBe(`${note}\n\nRead the latest token.`);
  expect(render("Read the latest token.", true)).toBe(`${note}\n\nRead the latest token.`);
  expect(createCliCurrentPromptRenderer({}, session)("Read the latest token.")).toBe(
    "Read the latest token.",
  );
});
