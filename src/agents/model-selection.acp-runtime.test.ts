// An ACP-runtime agent's configured model belongs to its ACP harness, not to OpenClaw dispatch.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { resolveAgentHarnessPolicy } from "./harness/policy.js";
import { resolveDefaultModelForAgent } from "./model-selection.js";

// Live Cursor advertises this exact opaque id (openclaw#153217); it is not an OpenAI catalog id.
const CURSOR_MODEL_ID = "gpt-5.6-sol[context=272k,reasoning=medium,fast=false]";

function buildConfig(runtime?: Record<string, unknown>): OpenClawConfig {
  return {
    agents: {
      defaults: { model: "anthropic/claude-opus-5" },
      entries: {
        cursoragent: {
          id: "cursoragent",
          model: { primary: CURSOR_MODEL_ID, fallbacks: [] },
          ...(runtime ? { runtime } : {}),
        },
      },
    },
  } as unknown as OpenClawConfig;
}

describe("ACP-runtime agent default model resolution", () => {
  it("does not expose an ACP harness model id as the agent's dispatchable model", () => {
    const cfg = buildConfig({ type: "acp", acp: { agent: "cursor", backend: "acpx" } });

    expect(resolveDefaultModelForAgent({ cfg, agentId: "cursoragent" })).toEqual({
      provider: "anthropic",
      model: "claude-opus-5",
    });
  });

  it("keeps that agent off the native OpenAI runtime", () => {
    const cfg = buildConfig({ type: "acp", acp: { agent: "cursor", backend: "acpx" } });
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
});
