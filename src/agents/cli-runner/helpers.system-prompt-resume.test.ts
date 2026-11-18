// Regression #80374: system prompts must reach resumed turns through argv.
import { expect, it } from "vitest";
import type { CliBackendConfig } from "../../plugins/cli-backend.types.js";
import { buildCliArgs, resolveSystemPromptUsage } from "./helpers.js";

const always: CliBackendConfig = {
  command: "claude",
  systemPromptFileArg: "--append-system-prompt-file",
  systemPromptWhen: "always",
  modelArg: "--model",
};
const first: CliBackendConfig = { ...always, systemPromptWhen: "first" };
const prompt = "You are a test assistant. Append SYSTEM-PROOF-ACTIVE after every reply.";
const promptFile = "/tmp/test-system-prompt.txt";
function args(overrides: Partial<Parameters<typeof buildCliArgs>[0]>) {
  return buildCliArgs({
    backend: always,
    baseArgs: ["--resume", "source-session"],
    modelId: "claude-haiku-4-5",
    sessionId: "source-session",
    useResume: true,
    ...overrides,
  });
}

it.each([
  { backend: first, isNewSession: false, expected: null },
  { backend: first, isNewSession: true, expected: prompt },
  { backend: always, isNewSession: true, expected: prompt },
])(
  "resolves $backend.systemPromptWhen prompt for new=$isNewSession",
  ({ backend, isNewSession, expected }) => {
    expect(resolveSystemPromptUsage({ backend, isNewSession, systemPrompt: prompt })).toBe(
      expected,
    );
  },
);

it.each([
  { backend: first, sendSystemPromptOnResume: true },
  { backend: always, sendSystemPromptOnResume: undefined },
])("sends the prompt file on $backend.systemPromptWhen resume", (options) => {
  const actual = args({
    ...options,
    baseArgs: ["-p", "--output-format", "stream-json"],
    sessionId: "test-session-id",
    systemPrompt: prompt,
    systemPromptFilePath: promptFile,
  });
  expect(actual).toEqual(expect.arrayContaining(["--append-system-prompt-file", promptFile]));
});

it("appends fork and checkpoint arguments only to the marked resume", () => {
  const backend = { ...always, forkArg: "--fork-session", resumeAtArg: "--resume-session-at" };
  expect(args({ backend, forkResume: true, resumeAt: "assistant-before-turn" })).toEqual(
    expect.arrayContaining(["--fork-session", "--resume-session-at", "assistant-before-turn"]),
  );
  const subsequent = args({
    backend,
    baseArgs: ["--resume", "forked-session"],
    sessionId: "forked-session",
    forkResume: false,
  });
  expect(subsequent).not.toContain("--fork-session");
  expect(subsequent).not.toContain("--resume-session-at");
});

it.each([
  { backend: always, resumeAt: undefined, error: "does not support forked session resume" },
  {
    backend: { ...always, forkArg: "--fork-session" },
    resumeAt: "assistant-before-turn",
    error: "does not support checkpointed session resume",
  },
])("rejects unsupported resume: $error", ({ backend, resumeAt, error }) => {
  expect(() => args({ backend, forkResume: true, resumeAt })).toThrow(error);
});
