import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { AgentModelMapSchema } from "../config/zod-schema.agent-entry-base.js";
import { FailoverError } from "./failover-error.js";
import { resolveModelCandidateChain } from "./model-fallback-candidates.js";
import { runWithModelFallback } from "./model-fallback-runner.js";

function config(): OpenClawConfig {
  return {
    plugins: { enabled: false },
    agents: {
      defaults: {
        model: { primary: "alpha/main", fallbacks: ["alpha/other", "beta/peer", "beta/small"] },
        models: { "alpha/main": { fallbackPriority: ["beta/peer"] } },
      },
    },
  };
}

function chain(cfg: OpenClawConfig, extra = {}) {
  return resolveModelCandidateChain({
    cfg,
    provider: "alpha",
    model: "main",
    manifestPlugins: [],
    ...extra,
  }).map(({ provider, model }) => `${provider}/${model}`);
}

describe("configured fallback priority", () => {
  it("accepts priority metadata on exact model refs", () => {
    const models = { "alpha/main": { fallbackPriority: ["beta/peer"] } };
    expect(AgentModelMapSchema.safeParse(models).success).toBe(true);
  });
  it("tries the selected model's configured peer before the remaining candidates", () => {
    expect(chain(config())).toEqual(["alpha/main", "beta/peer", "alpha/other", "beta/small"]);
  });
});

describe("priority scope and route resolution", () => {
  it.each(["alpha/*", "main"])("rejects priority on non-exact key %s", (key) => {
    expect(AgentModelMapSchema.safeParse({ [key]: { fallbackPriority: [] } }).success).toBe(false);
  });

  it.each([
    { entry: { fallbackPriority: ["beta/small"] }, first: "beta/small" },
    { entry: { fallbackPriority: [] }, first: "alpha/other" },
    { entry: { alias: "agent-main" }, first: "beta/peer" },
  ])("uses agent-owned priority while omitted metadata inherits: $first", ({ entry, first }) => {
    const cfg = config();
    cfg.agents!.entries = { worker: { models: { "alpha/main": entry } } };
    expect(chain(cfg, { agentId: "worker" })[1]).toBe(first);
  });

  it("resolves selected and target aliases and never adds absent or duplicate candidates", () => {
    const cfg = config();
    cfg.agents!.defaults!.models = {
      "alpha/main": {
        alias: "selected",
        fallbackPriority: ["absent/model", "peer", "peer", "selected"],
      },
      "beta/peer": { alias: "peer" },
    };
    expect(chain(cfg, { model: "selected" })).toEqual([
      "alpha/main",
      "beta/peer",
      "alpha/other",
      "beta/small",
    ]);
  });

  it("recomputes cached priority after configuration changes", () => {
    const cfg = config();
    expect(chain(cfg, { manifestPlugins: undefined })[1]).toBe("beta/peer");
    cfg.agents!.defaults!.models!["alpha/main"]!.fallbackPriority = ["beta/small"];
    expect(chain(cfg, { manifestPlugins: undefined })[1]).toBe("beta/small");
  });

  it.each([
    { selected: "alpha/main", peer: "beta/peer" },
    { selected: "beta/peer", peer: "alpha/main" },
    { selected: "alpha/other", peer: "beta/small" },
    { selected: "beta/small", peer: "alpha/other" },
  ])("keeps $selected selected and prioritizes $peer", ({ selected, peer }) => {
    const cfg = config();
    cfg.agents!.defaults!.models![selected] = { fallbackPriority: [peer] };
    const [provider, model] = selected.split("/");
    expect(chain(cfg, { provider, model }).slice(0, 2)).toEqual([selected, peer]);
  });

  it.each([[], ["alpha/other", "beta/peer"]].map((fallbacksOverride) => ({ fallbacksOverride })))(
    "preserves absolute explicit fallback order $fallbacksOverride",
    ({ fallbacksOverride }) => {
      expect(chain(config(), { fallbacksOverride })).toEqual(["alpha/main", ...fallbacksOverride]);
    },
  );

  it("applies priority to a projected configured override without appending the configured primary", () => {
    const cfg = config();
    cfg.agents!.defaults!.model = { primary: "absent/primary" };
    expect(
      chain(cfg, {
        fallbacksOverride: ["alpha/other", "beta/peer"],
        fallbacksOverrideSource: "configured",
      }),
    ).toEqual(["alpha/main", "beta/peer", "alpha/other"]);
  });
});

it("continues through the preserved remainder when the preferred peer is unavailable", async () => {
  const attempted: string[] = [];
  const result = await runWithModelFallback({
    cfg: config(),
    provider: "alpha",
    model: "main",
    manifestPlugins: [],
    skipAuthProfileRuntime: true,
    run: async (provider, model) => {
      attempted.push(`${provider}/${model}`);
      if (model !== "other") {
        throw new FailoverError("Synthetic model unavailable", {
          reason: "model_not_found",
          provider,
          model,
        });
      }
      return "recovered";
    },
  });
  expect(result.result).toBe("recovered");
  expect(attempted).toEqual(["alpha/main", "beta/peer", "alpha/other"]);
});

it("keeps exact metadata keys literal when another model has the same alias", () => {
  const cfg = config();
  cfg.agents!.defaults!.models!["beta/small"] = { alias: "alpha/main" };
  expect(chain(cfg, { requestedRouteResolution: "resolved" })).toEqual([
    "alpha/main",
    "beta/peer",
    "alpha/other",
    "beta/small",
  ]);
});
