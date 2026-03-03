import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  parseModelRef,
  redactSecrets,
  resolveAdaptiveRoutingConfig,
  resolveBypassReason,
  runEmbeddedPiAgentWithAdaptiveRouting,
  validateHeuristic,
} from "./adaptive-routing.js";
import type { RunEmbeddedPiAgentParams } from "./pi-embedded-runner/run/params.js";
import type { EmbeddedRunAttemptResult } from "./pi-embedded-runner/run/types.js";
import type { EmbeddedPiRunResult } from "./pi-embedded-runner/types.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeAdaptiveCfg(overrides: Partial<OpenClawConfig["agents"]> = {}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: {
          primary: "openai/gpt-4.1-mini",
          fallbacks: ["openai/gpt-4.1-nano"],
          adaptiveRouting: {
            enabled: true,
            localFirstModel: "ollama/qwen2.5-coder",
            cloudEscalationModel: "openai/gpt-4.1-mini",
            maxEscalations: 1,
            bypassOnExplicitOverride: true,
            validation: {
              mode: "heuristic",
              minScore: 0.75,
            },
          },
        },
        ...overrides.defaults,
      },
    },
  } as unknown as OpenClawConfig;
}

function makeAttemptResult(
  overrides: Partial<EmbeddedRunAttemptResult> = {},
): EmbeddedRunAttemptResult {
  return {
    aborted: false,
    timedOut: false,
    timedOutDuringCompaction: false,
    promptError: null,
    sessionIdUsed: "test-session",
    messagesSnapshot: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ],
    assistantTexts: ["world"],
    toolMetas: [],
    lastAssistant: undefined,
    lastToolError: undefined,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    ...overrides,
  } as EmbeddedRunAttemptResult;
}

function makeRunResult(overrides: Partial<EmbeddedPiRunResult> = {}): EmbeddedPiRunResult {
  return {
    payloads: [{ text: "world" }],
    meta: {
      durationMs: 100,
      agentMeta: { sessionId: "test", provider: "ollama", model: "qwen2.5-coder" },
    },
    ...overrides,
  } as EmbeddedPiRunResult;
}

function makeParams(overrides: Partial<RunEmbeddedPiAgentParams> = {}): RunEmbeddedPiAgentParams {
  return {
    sessionId: "test-session-id",
    sessionFile: "/tmp/test-session.jsonl",
    workspaceDir: "/tmp/workspace",
    config: makeAdaptiveCfg(),
    prompt: "Hello, world!",
    timeoutMs: 30000,
    runId: "test-run-id",
    ...overrides,
  } as RunEmbeddedPiAgentParams;
}

// ─── resolveAdaptiveRoutingConfig ────────────────────────────────────────────

describe("resolveAdaptiveRoutingConfig", () => {
  it("returns null when config is undefined", () => {
    expect(resolveAdaptiveRoutingConfig(undefined)).toBeNull();
  });

  it("returns null when agents.defaults.model is a string", () => {
    const cfg = {
      agents: { defaults: { model: "openai/gpt-4.1-mini" } },
    } as unknown as OpenClawConfig;
    expect(resolveAdaptiveRoutingConfig(cfg)).toBeNull();
  });

  it("returns null when adaptiveRouting is not present", () => {
    const cfg = {
      agents: { defaults: { model: { primary: "openai/gpt-4.1-mini" } } },
    } as unknown as OpenClawConfig;
    expect(resolveAdaptiveRoutingConfig(cfg)).toBeNull();
  });

  it("returns null when adaptiveRouting.enabled is false", () => {
    const cfg = makeAdaptiveCfg();
    (
      cfg.agents!.defaults!.model as { adaptiveRouting: { enabled: boolean } }
    ).adaptiveRouting.enabled = false;
    expect(resolveAdaptiveRoutingConfig(cfg)).toBeNull();
  });

  it("returns config when enabled with required fields", () => {
    const cfg = makeAdaptiveCfg();
    const result = resolveAdaptiveRoutingConfig(cfg);
    expect(result).not.toBeNull();
    expect(result!.enabled).toBe(true);
    expect(result!.localFirstModel).toBe("ollama/qwen2.5-coder");
    expect(result!.cloudEscalationModel).toBe("openai/gpt-4.1-mini");
  });

  it("caps maxEscalations to 1", () => {
    const cfg = makeAdaptiveCfg();
    (
      cfg.agents!.defaults!.model as { adaptiveRouting: { maxEscalations: number } }
    ).adaptiveRouting.maxEscalations = 5;
    const result = resolveAdaptiveRoutingConfig(cfg);
    expect(result!.maxEscalations).toBe(1);
  });

  it("returns null when localFirstModel is missing while enabled", () => {
    const cfg = makeAdaptiveCfg();
    (
      cfg.agents!.defaults!.model as { adaptiveRouting: { localFirstModel: string } }
    ).adaptiveRouting.localFirstModel = "";
    expect(resolveAdaptiveRoutingConfig(cfg)).toBeNull();
  });
});

// ─── resolveBypassReason ─────────────────────────────────────────────────────

describe("resolveBypassReason", () => {
  it("returns null when no override and bypassOnExplicitOverride=true", () => {
    const cfg = resolveAdaptiveRoutingConfig(makeAdaptiveCfg())!;
    expect(resolveBypassReason(cfg, { hasExplicitModelOverride: false })).toBeNull();
  });

  it("returns 'explicit_override' when override present and bypassOnExplicitOverride=true", () => {
    const cfg = resolveAdaptiveRoutingConfig(makeAdaptiveCfg())!;
    expect(resolveBypassReason(cfg, { hasExplicitModelOverride: true })).toBe("explicit_override");
  });

  it("returns null when override present but bypassOnExplicitOverride=false", () => {
    const cfg = resolveAdaptiveRoutingConfig(makeAdaptiveCfg())!;
    const cfgWithNoBypass = { ...cfg, bypassOnExplicitOverride: false };
    expect(resolveBypassReason(cfgWithNoBypass, { hasExplicitModelOverride: true })).toBeNull();
  });
});

// ─── parseModelRef ───────────────────────────────────────────────────────────

describe("parseModelRef", () => {
  it("splits provider/model correctly", () => {
    expect(parseModelRef("ollama/qwen2.5-coder")).toEqual({
      provider: "ollama",
      model: "qwen2.5-coder",
    });
  });

  it("handles no slash by treating whole string as both provider and model", () => {
    expect(parseModelRef("gpt-4")).toEqual({ provider: "gpt-4", model: "gpt-4" });
  });

  it("handles multi-slash correctly (first slash is the delimiter)", () => {
    expect(parseModelRef("openai/gpt-4/turbo")).toEqual({
      provider: "openai",
      model: "gpt-4/turbo",
    });
  });
});

// ─── redactSecrets ───────────────────────────────────────────────────────────

describe("redactSecrets", () => {
  it("redacts sk- prefixed keys", () => {
    const result = redactSecrets("api key is sk-abc123def456 done");
    expect(result).toContain("[REDACTED");
    expect(result).not.toContain("sk-abc123def456");
  });

  it("redacts Bearer tokens", () => {
    const result = redactSecrets("Authorization: Bearer mytoken1234567890");
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("mytoken1234567890");
  });

  it("passes through clean text unchanged", () => {
    const clean = "hello world, no secrets here";
    expect(redactSecrets(clean)).toBe(clean);
  });
});

// ─── validateHeuristic ───────────────────────────────────────────────────────

describe("validateHeuristic", () => {
  const cfg = resolveAdaptiveRoutingConfig(makeAdaptiveCfg())!;

  it("passes when attempt has assistant text and no errors", () => {
    const attempt = makeAttemptResult({ assistantTexts: ["Here is the result"] });
    const result = validateHeuristic(attempt, cfg);
    expect(result.passed).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0.75);
    expect(result.reason).toBe("ok");
  });

  it("fails when promptError is set", () => {
    const attempt = makeAttemptResult({
      promptError: new Error("provider error"),
      assistantTexts: [],
    });
    const result = validateHeuristic(attempt, cfg);
    expect(result.passed).toBe(false);
    expect(result.score).toBeLessThan(0.75);
    expect(result.reason).toContain("provider_error");
  });

  it("fails when assistantTexts is empty", () => {
    const attempt = makeAttemptResult({ assistantTexts: [] });
    const result = validateHeuristic(attempt, cfg);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("empty_assistant_output");
  });

  it("fails when there is a tool error", () => {
    const attempt = makeAttemptResult({
      assistantTexts: ["done"],
      lastToolError: { toolName: "exec", error: "command not found" },
    });
    const result = validateHeuristic(attempt, cfg);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("tool_error:exec");
  });

  it("fails when timed out", () => {
    const attempt = makeAttemptResult({
      timedOut: true,
      assistantTexts: ["partial..."],
    });
    const result = validateHeuristic(attempt, cfg);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("timed_out");
  });

  it("penalises pending toolCall blocks in final message", () => {
    const attempt = makeAttemptResult({
      assistantTexts: [""],
      messagesSnapshot: [
        {
          role: "user",
          content: "run something",
          timestamp: Date.now(),
        } as import("@mariozechner/pi-ai").UserMessage,
        {
          role: "assistant",
          content: [{ type: "toolCall", toolCall: { id: "t1", name: "exec", params: {} } }],
          timestamp: Date.now(),
          stopReason: "toolUse",
        } as unknown as import("@mariozechner/pi-agent-core").AgentMessage,
      ],
    });
    const result = validateHeuristic(attempt, cfg);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("pending_tool_calls");
  });

  it("score is clamped to [0, 1]", () => {
    const attempt = makeAttemptResult({
      promptError: new Error("error"),
      timedOut: true,
      assistantTexts: [],
      lastToolError: { toolName: "exec", error: "fail" },
    });
    const result = validateHeuristic(attempt, cfg);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });
});

// ─── runEmbeddedPiAgentWithAdaptiveRouting ───────────────────────────────────

describe("runEmbeddedPiAgentWithAdaptiveRouting", () => {
  it("delegates directly when adaptive routing is disabled", async () => {
    const disabledCfg = {
      agents: { defaults: { model: { primary: "openai/gpt-4.1-mini" } } },
    } as unknown as OpenClawConfig;
    const params = makeParams({ config: disabledCfg });
    const runFn = vi.fn().mockResolvedValueOnce(makeRunResult());
    await runEmbeddedPiAgentWithAdaptiveRouting(params, runFn);
    expect(runFn).toHaveBeenCalledTimes(1);
    // Called with original params (no model override)
    expect(runFn.mock.calls[0][0].provider).toBeUndefined();
  });

  it("bypasses when explicit model override is present and bypassOnExplicitOverride=true", async () => {
    const params = makeParams({ _hasExplicitModelOverride: true });
    const runFn = vi.fn().mockResolvedValueOnce(makeRunResult());
    await runEmbeddedPiAgentWithAdaptiveRouting(params, runFn);
    expect(runFn).toHaveBeenCalledTimes(1);
    // Called with original (non-overridden) params
    expect(runFn.mock.calls[0][0].provider).toBeUndefined();
  });

  it("runs local model first and returns local result when validation passes", async () => {
    const params = makeParams();
    const localResult = makeRunResult({ payloads: [{ text: "local answer" }] });

    const runFn = vi.fn().mockImplementation(async (p: RunEmbeddedPiAgentParams) => {
      // Fire attempt callback with a passing attempt
      p._onAttemptResult?.(makeAttemptResult({ assistantTexts: ["local answer"] }));
      return localResult;
    });

    const result = await runEmbeddedPiAgentWithAdaptiveRouting(params, runFn);

    expect(runFn).toHaveBeenCalledTimes(1);
    expect(runFn.mock.calls[0][0].provider).toBe("ollama");
    expect(runFn.mock.calls[0][0].model).toBe("qwen2.5-coder");
    expect(result).toBe(localResult);
  });

  it("escalates to cloud model when local validation fails (empty output)", async () => {
    const cloudResult = makeRunResult({ payloads: [{ text: "cloud answer" }] });
    const localResult = makeRunResult({ payloads: [] });

    const runFn = vi.fn().mockImplementation(async (p: RunEmbeddedPiAgentParams) => {
      if (p.provider === "ollama") {
        p._onAttemptResult?.(makeAttemptResult({ assistantTexts: [] }));
        return localResult;
      }
      return cloudResult;
    });

    const result = await runEmbeddedPiAgentWithAdaptiveRouting(makeParams(), runFn);

    expect(runFn).toHaveBeenCalledTimes(2);
    expect(runFn.mock.calls[0][0].provider).toBe("ollama");
    expect(runFn.mock.calls[1][0].provider).toBe("openai");
    expect(runFn.mock.calls[1][0].model).toBe("gpt-4.1-mini");
    expect(result).toBe(cloudResult);
  });

  it("escalates when local attempt has a tool error", async () => {
    const cloudResult = makeRunResult({ payloads: [{ text: "cloud fixed it" }] });

    const runFn = vi.fn().mockImplementation(async (p: RunEmbeddedPiAgentParams) => {
      if (p.provider === "ollama") {
        p._onAttemptResult?.(
          makeAttemptResult({
            assistantTexts: ["partial"],
            lastToolError: { toolName: "bash", error: "command not found" },
          }),
        );
        return makeRunResult({ payloads: [{ text: "partial", isError: true }] });
      }
      return cloudResult;
    });

    const result = await runEmbeddedPiAgentWithAdaptiveRouting(makeParams(), runFn);

    expect(runFn).toHaveBeenCalledTimes(2);
    expect(result).toBe(cloudResult);
  });

  it("returns local result even if validation failed when maxEscalations=0", async () => {
    const cfg = makeAdaptiveCfg();
    (
      cfg.agents!.defaults!.model as { adaptiveRouting: { maxEscalations: number } }
    ).adaptiveRouting.maxEscalations = 0;
    const localResult = makeRunResult({ payloads: [] });

    const runFn = vi.fn().mockImplementation(async (p: RunEmbeddedPiAgentParams) => {
      p._onAttemptResult?.(makeAttemptResult({ assistantTexts: [] }));
      return localResult;
    });

    const result = await runEmbeddedPiAgentWithAdaptiveRouting(makeParams({ config: cfg }), runFn);

    expect(runFn).toHaveBeenCalledTimes(1);
    expect(result).toBe(localResult);
  });

  it("cloud run uses the original session file (not temp)", async () => {
    const capturedSessionFiles: string[] = [];

    const runFn = vi.fn().mockImplementation(async (p: RunEmbeddedPiAgentParams) => {
      capturedSessionFiles.push(p.sessionFile);
      if (p.provider === "ollama") {
        p._onAttemptResult?.(makeAttemptResult({ assistantTexts: [] }));
        return makeRunResult({ payloads: [] });
      }
      return makeRunResult({ payloads: [{ text: "cloud answer" }] });
    });

    const originalSessionFile = "/tmp/test-session.jsonl";
    await runEmbeddedPiAgentWithAdaptiveRouting(
      makeParams({ sessionFile: originalSessionFile }),
      runFn,
    );

    // Local run used a temp file (different from original)
    expect(capturedSessionFiles[0]).not.toBe(originalSessionFile);
    expect(capturedSessionFiles[0]).toContain(originalSessionFile);
    // Cloud run used the original file
    expect(capturedSessionFiles[1]).toBe(originalSessionFile);
  });

  it("existing provider failover still works: provider error on local triggers escalation", async () => {
    // Simulate the case where local model fails with a provider error.
    // The run result will have meta.error set.
    const cloudResult = makeRunResult({ payloads: [{ text: "cloud fallback" }] });

    const runFn = vi.fn().mockImplementation(async (p: RunEmbeddedPiAgentParams) => {
      if (p.provider === "ollama") {
        // Provider error – _onAttemptResult fires with promptError set
        p._onAttemptResult?.(
          makeAttemptResult({
            promptError: new Error("ollama not available"),
            assistantTexts: [],
          }),
        );
        return makeRunResult({
          payloads: [{ isError: true }],
          meta: {
            durationMs: 50,
            agentMeta: { sessionId: "x", provider: "ollama", model: "q" },
            error: { kind: "retry_limit", message: "ollama not available" },
          },
        });
      }
      return cloudResult;
    });

    const result = await runEmbeddedPiAgentWithAdaptiveRouting(makeParams(), runFn);

    expect(runFn).toHaveBeenCalledTimes(2);
    expect(result).toBe(cloudResult);
  });
});
