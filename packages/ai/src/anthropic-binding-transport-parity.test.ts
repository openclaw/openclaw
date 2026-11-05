import { describe, expect, it, vi } from "vitest";
import { capturePaths } from "./anthropic-parity.test-support.js";
import {
  anthropicEvents,
  registerParityHostLifecycle,
} from "./provider-transport-parity.test-support.js";

const bindingBeta = "thinking-binding-controls-2026-08-01";
const disabledThinking = { type: "disabled" as const };
const budgetThinking = { type: "enabled" as const, budget_tokens: 1024 };

describe("Anthropic thinking-binding transport parity", () => {
  registerParityHostLifecycle();

  it.each([
    { name: "direct API-key adaptive", enabled: true },
    { name: "caller beta", headers: { "Anthropic-Beta": "synthetic-beta" }, enabled: true },
    { name: "environment proxy", env: true, model: { baseUrl: undefined }, enabled: false },
    { name: "OAuth", apiKey: "sk-ant-oat01-synthetic", enabled: false },
    { name: "proxy", model: { baseUrl: "https://proxy.example/v1" }, enabled: false },
    { name: "Cloudflare", model: { provider: "cloudflare-ai-gateway" }, enabled: false },
    { name: "Copilot", model: { provider: "github-copilot" }, enabled: false },
    { name: "Foundry", model: { provider: "microsoft-foundry" }, enabled: false },
    { name: "Kimi", model: { provider: "kimi-coding" }, enabled: false },
    { name: "budget thinking", model: { id: "claude-sonnet-4-5" }, enabled: false },
    { name: "disabled thinking", reasoning: "off" as const, enabled: false },
    { name: "hook-disabled thinking", thinkingOverride: disabledThinking, enabled: false },
    { name: "hook-budget thinking", thinkingOverride: budgetThinking, enabled: false },
  ])("gates thinking-binding controls equally for $name", async ({ enabled, env, ...options }) => {
    if (env) {
      vi.stubEnv("ANTHROPIC_BASE_URL", "https://proxy.example/v1");
    }
    for await (const { payload, headers } of capturePaths(options)) {
      const beta = headers.get("anthropic-beta");
      expect(beta?.includes(bindingBeta) ?? false).toBe(enabled);
      expect(beta).not.toBe("");
      if (enabled) {
        expect(payload.thinking).toHaveProperty("block_binding", {
          prefix_mismatch_behavior: "drop_block",
        });
      } else {
        expect(payload.thinking).not.toHaveProperty("block_binding");
        expect(beta ?? "").not.toContain("thinking-binding-controls");
      }
      if (options.headers) {
        const betas = beta?.split(",").map((entry) => entry.trim());
        expect(betas?.filter((entry) => entry === "synthetic-beta")).toHaveLength(1);
        expect(betas).toContain(bindingBeta);
      }
    }
  });

  it.each(["start", "delta", "both", "unknown"] as const)(
    "reports bounded thinking drops, replacing start telemetry at final delta (%s)",
    async (location) => {
      const transformations = Array.from({ length: 7 }, (_, index) => ({
        type: "thinking_dropped",
        reason: index % 2 ? "model_binding_mismatch" : "prefix_binding_mismatch",
        path: `messages.${index}.content.0`,
      }));
      const unknown = location === "unknown";
      const final = unknown
        ? [
            { ...transformations[0], type: "future" },
            { ...transformations[0], reason: "future" },
          ]
        : transformations;
      const events = anthropicEvents.map((event) => {
        if (event.type === "message_start" && location !== "delta") {
          return Object.assign({}, event, {
            message: Object.assign({}, event.message, { input_transformations: transformations }),
          });
        }
        const patch = { input_transformations: final };
        return event.type === "message_delta" && location !== "start"
          ? Object.assign({}, event, unknown ? patch : { message: patch })
          : event;
      });
      for await (const { warnings } of capturePaths({ events })) {
        if (location === "unknown") {
          expect(warnings).toEqual([]);
          continue;
        }
        expect(warnings).toEqual([
          expect.stringContaining("replayed thinking dropped: 7 block(s)"),
        ]);
        expect(warnings[0]).toContain("prefix_binding_mismatch at messages.0.content.0");
        expect(warnings[0]).toContain("model_binding_mismatch at messages.1.content.0");
        expect(warnings[0]).toContain("messages.4.content.0");
        expect(warnings[0]).not.toContain("messages.5.content.0");
      }
    },
  );
});
