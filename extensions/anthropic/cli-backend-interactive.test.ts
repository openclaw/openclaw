import type { CliBackendNormalizeConfigContext } from "openclaw/plugin-sdk/cli-backend";
import { describe, expect, it } from "vitest";
import { buildAnthropicInteractiveCliBackend } from "./cli-backend-interactive.js";
import { buildAnthropicCliBackend } from "./cli-backend.js";

// Inheritance detection compares merged.command against the user-configured
// claude-cli command in context.config. The tests therefore have to pass a
// synthetic OpenClawConfig containing that claude-cli backend command;
// otherwise the production code classifies non-bun commands as direct Bun
// overrides (the opposite of what these tests want to exercise).
function ctxForInheritedCommand(claudeCommand: string): CliBackendNormalizeConfigContext {
  return {
    backendId: "claude-cli-interactive",
    config: {
      agents: {
        defaults: {
          cliBackends: {
            "claude-cli": { command: claudeCommand },
          },
        },
      },
    } as CliBackendNormalizeConfigContext["config"],
  };
}

describe("buildAnthropicInteractiveCliBackend.normalizeConfig", () => {
  const backend = buildAnthropicInteractiveCliBackend();
  const baseConfig = backend.config;

  it("forces command back to bun after the inherited claude path takes over via shallow merge", () => {
    const inherited = "C:\\Users\\test\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";
    const merged = { ...baseConfig, command: inherited };
    const result = backend.normalizeConfig!(merged, ctxForInheritedCommand(inherited));
    expect(result.command).toBe("bun");
  });

  it("stashes the inherited claude binary path on env for wrapper.ts to consume", () => {
    const inherited = "/usr/local/bin/claude";
    const merged = { ...baseConfig, command: inherited };
    const result = backend.normalizeConfig!(merged, ctxForInheritedCommand(inherited));
    expect(result.env?.OPENCLAW_INTERACTIVE_CLAUDE_BINARY).toBe(inherited);
  });

  it("preserves other env entries from the inherited config", () => {
    const inherited = "/usr/local/bin/claude";
    const merged = {
      ...baseConfig,
      command: inherited,
      env: { CUSTOM_VAR: "value" },
    };
    const result = backend.normalizeConfig!(merged, ctxForInheritedCommand(inherited));
    expect(result.env?.CUSTOM_VAR).toBe("value");
    expect(result.env?.OPENCLAW_INTERACTIVE_CLAUDE_BINARY).toBe(inherited);
  });

  it("omits OPENCLAW_INTERACTIVE_CLAUDE_BINARY when no claude-cli override took effect", () => {
    // Without an inherited override, mergeBackendConfig leaves merged.command
    // as our own base "bun". The wrapper would otherwise try to spawn bun as
    // the claude binary, so the env var must stay unset and let wrapper.ts
    // fall back to a PATH lookup of "claude".
    const merged = { ...baseConfig };
    const result = backend.normalizeConfig!(merged, { backendId: "claude-cli-interactive" });
    expect(result.env?.OPENCLAW_INTERACTIVE_CLAUDE_BINARY).toBeUndefined();
  });

  it("treats a non-bun, non-inherited command as a direct Bun-path override", () => {
    // When the operator sets cliBackends.claude-cli-interactive.command
    // directly to e.g. an absolute Bun binary path (not equal to the user's
    // claude-cli command), normalizeConfig must NOT misclassify it as the
    // claude binary — keep the override as the spawn command and leave the
    // env var unset.
    const bunOverride = "C:\\custom-bun\\bun.exe";
    const merged = { ...baseConfig, command: bunOverride };
    const result = backend.normalizeConfig!(
      merged,
      ctxForInheritedCommand("/usr/local/bin/claude"),
    );
    expect(result.command).toBe(bunOverride);
    expect(result.env?.OPENCLAW_INTERACTIVE_CLAUDE_BINARY).toBeUndefined();
  });

  it("treats a legacy `anthropic-cli`-only sibling as a direct override, since upstream no longer aliases it to claude-cli", () => {
    // Upstream removed `anthropic-cli` from `normalizeProviderId` (it now maps
    // to itself, not `claude-cli`). resolveCliBackendConfig inherits sibling
    // config by that same normalized id, so a legacy `anthropic-cli`-only key is
    // no longer merged into this backend at all — and the classifier here, which
    // uses the same normalized lookup, is consistent with that: it does not
    // recognise the legacy key as the inherited claude binary. Live inheritance
    // from the current `claude-cli` key is covered by the tests above.
    const inherited = "/usr/local/bin/claude";
    const merged = { ...baseConfig, command: inherited };
    const result = backend.normalizeConfig!(merged, {
      backendId: "claude-cli-interactive",
      config: {
        agents: {
          defaults: {
            cliBackends: {
              "anthropic-cli": { command: inherited },
            },
          },
        },
      } as CliBackendNormalizeConfigContext["config"],
    });
    expect(result.command).toBe(inherited);
    expect(result.env?.OPENCLAW_INTERACTIVE_CLAUDE_BINARY).toBeUndefined();
  });
});

describe("buildAnthropicInteractiveCliBackend Claude history-import parity", () => {
  // Pins the contract that claude-cli-interactive carries the same
  // Claude history-import wiring as plain claude-cli, so the bounded
  // raw-transcript reseed path, --session-id round-trip, and --resume
  // resumption all activate identically when this backend is selected.
  // Without these the MITM-proxy wrapper would start fresh sessions on
  // every turn and lose conversation history.
  //
  // Closes ClawSweeper P2 review on PR #81851: "Wire interactive sessions
  // into Claude history import". Backend remains opt-in (operator must
  // explicitly set their model ref to claude-cli-interactive/*) so this
  // contract only fires when the operator engages it.
  const interactive = buildAnthropicInteractiveCliBackend().config;
  const plain = buildAnthropicCliBackend().config;

  it("opts into bounded raw-transcript reseed before compaction (parity with claude-cli)", () => {
    expect(interactive.reseedFromRawTranscriptWhenUncompacted).toBe(true);
    expect(plain.reseedFromRawTranscriptWhenUncompacted).toBe(true);
  });

  it("uses Claude's --session-id flag with sessionMode:always for stable session id round-trip", () => {
    expect(interactive.sessionArg).toBe("--session-id");
    expect(interactive.sessionArg).toBe(plain.sessionArg);
    expect(interactive.sessionMode).toBe("always");
    expect(interactive.sessionMode).toBe(plain.sessionMode);
  });

  it("declares the same session-id JSONL fields as claude-cli so the reseed path can read the resume id", () => {
    expect(interactive.sessionIdFields).toEqual(plain.sessionIdFields);
  });

  it("threads --resume {sessionId} into resumeArgs so existing claude session transcripts are picked up", () => {
    expect(interactive.resumeArgs).toContain("--resume");
    expect(interactive.resumeArgs).toContain("{sessionId}");
  });

  it("emits claude-stream-json so the live-session JSONL parser can extract reseedable state", () => {
    // The interactive backend must set `jsonlDialect` explicitly because the
    // parser's auto-resolve path keys off providerId === "claude-cli", which
    // doesn't match this backend's provider id "claude-cli-interactive". The
    // plain backend can omit the field and rely on the provider-id gate
    // instead; both routes converge on the same claude-stream-json parser.
    expect(interactive.output).toBe("jsonl");
    expect(interactive.jsonlDialect).toBe("claude-stream-json");
    expect(plain.output).toBe("jsonl");
  });

  it("appends OpenClaw system prompts on first turn only (prevents double-injection on reseed)", () => {
    expect(interactive.systemPromptMode).toBe("append");
    expect(interactive.systemPromptMode).toBe(plain.systemPromptMode);
    // The interactive backend pins systemPromptWhen:"first" by design: it
    // kills the wrapper and resumes/reseeds the prior transcript each turn, so
    // re-appending the system prompt every turn ("always") would double-inject
    // it. This deliberately diverges from the plain claude-cli backend, which
    // upstream moved to "always" (its --append-system-prompt is a per-request
    // parameter, applied idempotently rather than accumulated).
    expect(interactive.systemPromptWhen).toBe("first");
    expect(plain.systemPromptWhen).toBe("always");
  });
});
