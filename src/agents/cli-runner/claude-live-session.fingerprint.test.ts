import { describe, expect, it } from "vitest";
import { buildClaudeLiveFingerprint } from "./claude-live-session.js";
import type { PreparedCliRunContext } from "./types.js";

function buildContext(overrides?: {
  systemPrompt?: string;
  extraSystemPromptHash?: string;
  normalizedModel?: string;
  workspaceDir?: string;
}): PreparedCliRunContext {
  const backend = {
    command: "claude",
    args: [],
    output: "jsonl" as const,
    input: "stdin" as const,
    serialize: true,
    liveSession: "claude-stdio" as const,
    sessionArg: "--session",
    systemPromptArg: "--system-prompt",
    systemPromptFileArg: "--system-prompt-file",
  };
  return {
    params: {
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: overrides?.workspaceDir ?? "/tmp/workspace",
      prompt: "hi",
      provider: "claude-cli",
      model: "model",
      timeoutMs: 1_000,
      runId: "run-1",
    },
    started: Date.now(),
    workspaceDir: overrides?.workspaceDir ?? "/tmp/workspace",
    backendResolved: {
      id: "claude-cli",
      config: backend,
      bundleMcp: false,
    },
    preparedBackend: {
      backend,
      env: {},
    },
    reusableCliSession: {},
    modelId: "model",
    normalizedModel: overrides?.normalizedModel ?? "model",
    systemPrompt: overrides?.systemPrompt ?? "you are an agent",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    bootstrapPromptWarningLines: [],
    authEpochVersion: 2,
    extraSystemPromptHash: overrides?.extraSystemPromptHash ?? "static-hash-a",
  };
}

describe("buildClaudeLiveFingerprint", () => {
  it("ignores volatile changes to the per-turn system prompt", () => {
    // Per-turn inbound metadata (timestamps, sender envelope, heartbeat, channel
    // guidance) is folded into `context.systemPrompt`. The fingerprint must not
    // diverge on these volatile chunks — otherwise the runtime rotates the live
    // claude-cli subprocess on every turn and loses prior context.
    const baselineArgv = ["claude", "--model", "model"];
    const a = buildClaudeLiveFingerprint({
      context: buildContext({ systemPrompt: "[turn 1 metadata]\nyou are an agent" }),
      argv: baselineArgv,
      env: {},
    });
    const b = buildClaudeLiveFingerprint({
      context: buildContext({ systemPrompt: "[turn 2 different metadata]\nyou are an agent" }),
      argv: baselineArgv,
      env: {},
    });
    expect(a).toBe(b);
  });

  it("diverges when extraSystemPromptHash changes (static config still gates session reuse)", () => {
    const argv = ["claude", "--model", "model"];
    const a = buildClaudeLiveFingerprint({
      context: buildContext({ extraSystemPromptHash: "static-hash-a" }),
      argv,
      env: {},
    });
    const b = buildClaudeLiveFingerprint({
      context: buildContext({ extraSystemPromptHash: "static-hash-b" }),
      argv,
      env: {},
    });
    expect(a).not.toBe(b);
  });

  it("diverges when the normalized model changes", () => {
    const argv = ["claude", "--model", "model"];
    const a = buildClaudeLiveFingerprint({
      context: buildContext({ normalizedModel: "sonnet-4.6" }),
      argv,
      env: {},
    });
    const b = buildClaudeLiveFingerprint({
      context: buildContext({ normalizedModel: "opus-4.7" }),
      argv,
      env: {},
    });
    expect(a).not.toBe(b);
  });

  it("diverges when the workspace directory changes", () => {
    const argv = ["claude", "--model", "model"];
    const a = buildClaudeLiveFingerprint({
      context: buildContext({ workspaceDir: "/tmp/one" }),
      argv,
      env: {},
    });
    const b = buildClaudeLiveFingerprint({
      context: buildContext({ workspaceDir: "/tmp/two" }),
      argv,
      env: {},
    });
    expect(a).not.toBe(b);
  });
});
