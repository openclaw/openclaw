// An ACP-runtime agent's configured model belongs to its ACP harness, not to OpenClaw dispatch.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import { resolveAgentHarnessPolicy } from "./harness/policy.js";
import { resolveDefaultModelForAgent } from "./model-selection.js";

// Live Cursor advertises this exact opaque id (openclaw#153217); it is not an OpenAI catalog id.
const CURSOR_MODEL_ID = "gpt-5.6-sol[context=272k,reasoning=medium,fast=false]";

const ACP_RUNTIME = { type: "acp", acp: { agent: "cursor", backend: "acpx" } };

function buildConfig(
  runtime?: Record<string, unknown>,
  overrides?: { primary?: string; defaultModel?: string | null },
): OpenClawConfig {
  const defaultModel = overrides?.defaultModel;
  return {
    agents: {
      ...(defaultModel === null
        ? {}
        : { defaults: { model: defaultModel ?? "anthropic/claude-opus-5" } }),
      entries: {
        cursoragent: {
          id: "cursoragent",
          model: { primary: overrides?.primary ?? CURSOR_MODEL_ID, fallbacks: [] },
          ...(runtime ? { runtime } : {}),
        },
      },
    },
  } as unknown as OpenClawConfig;
}

describe("ACP-runtime agent default model resolution", () => {
  it("does not expose an ACP harness model id as the agent's dispatchable model", () => {
    const cfg = buildConfig(ACP_RUNTIME);

    expect(resolveDefaultModelForAgent({ cfg, agentId: "cursoragent" })).toEqual({
      provider: "anthropic",
      model: "claude-opus-5",
    });
  });

  it("keeps that agent off the native OpenAI runtime", () => {
    const cfg = buildConfig(ACP_RUNTIME);
    const resolved = resolveDefaultModelForAgent({ cfg, agentId: "cursoragent" });

    // Before the fix this resolved to openai/<harness id> and selected the native Codex runtime.
    expect(
      resolveAgentHarnessPolicy({
        provider: resolved.provider,
        modelId: resolved.model,
        config: cfg,
        agentId: "cursoragent",
      }).runtime,
    ).not.toBe("codex");
  });

  it("still resolves a bare primary model for an embedded agent", () => {
    const cfg = buildConfig();

    expect(resolveDefaultModelForAgent({ cfg, agentId: "cursoragent" })).toEqual({
      provider: "openai",
      model: CURSOR_MODEL_ID,
    });
  });

  // Upgrade case: an existing ACP agent whose primary was a dispatchable reference. Its
  // OpenClaw-side calls move to the global default, which must still be a usable route.
  it("leaves an ACP agent a usable local model route when its primary was dispatchable", () => {
    const cfg = buildConfig(ACP_RUNTIME, { primary: "openai/gpt-5.4" });

    const resolved = resolveDefaultModelForAgent({ cfg, agentId: "cursoragent" });
    expect(resolved).toEqual({ provider: "anthropic", model: "claude-opus-5" });
    expect(resolved.provider).not.toBe("");
    expect(resolved.model).not.toBe("");
    expect(resolved.model).not.toContain("[");
  });

  it("falls back to the shipped default when an ACP agent has no global default", () => {
    const cfg = buildConfig(ACP_RUNTIME, { primary: "openai/gpt-5.4", defaultModel: null });

    expect(resolveDefaultModelForAgent({ cfg, agentId: "cursoragent" })).toEqual({
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
    });
  });
});
