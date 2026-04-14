import { describe, expect, it } from "vitest";
import {
  buildRouteMetadata,
  inferRoutingLane,
  LANE_DESCRIPTIONS,
  type RoutingLane,
} from "./routing-lanes.js";

describe("routing-lanes", () => {
  describe("inferRoutingLane", () => {
    it("returns orchestrator_high for main agent", () => {
      expect(
        inferRoutingLane({
          agentId: "main",
          model: "claude-opus-4-6",
          provider: "anthropic",
        }),
      ).toBe("orchestrator_high");
    });

    it("returns judge_semantic for judge agent", () => {
      expect(inferRoutingLane({ agentId: "judge" })).toBe("judge_semantic");
    });

    it("returns research for research-agent", () => {
      expect(inferRoutingLane({ agentId: "research-agent" })).toBe("research");
    });

    it("returns executor_codex for codex model", () => {
      expect(inferRoutingLane({ model: "gpt-5.4", provider: "openai-codex" })).toBe(
        "executor_codex",
      );
    });

    it("returns routine for mini models", () => {
      expect(inferRoutingLane({ model: "gpt-5.4-mini", provider: "openai" })).toBe("routine");
    });

    it("returns routine as default", () => {
      expect(inferRoutingLane({})).toBe("routine");
    });
  });

  describe("buildRouteMetadata", () => {
    it("builds metadata with primary reason when models match", () => {
      const meta = buildRouteMetadata({
        agentId: "main",
        requestedProvider: "anthropic",
        requestedModel: "claude-opus-4-6",
        selectedProvider: "anthropic",
        selectedModel: "claude-opus-4-6",
      });
      expect(meta.routeReason).toBe("primary");
      expect(meta.requestedLane).toBe("orchestrator_high");
      expect(meta.selectedLane).toBe("orchestrator_high");
      expect(meta.actualLane).toBe("orchestrator_high");
      expect(meta.requestedModel).toBe("anthropic/claude-opus-4-6");
      expect(meta.selectedModel).toBe("anthropic/claude-opus-4-6");
    });

    it("builds metadata with failover reason when models differ", () => {
      const meta = buildRouteMetadata({
        requestedProvider: "anthropic",
        requestedModel: "claude-opus-4-6",
        selectedProvider: "anthropic",
        selectedModel: "claude-sonnet-4-6",
        failoverReason: "rate_limit",
      });
      expect(meta.routeReason).toBe("failover");
      expect(meta.failoverReason).toBe("rate_limit");
    });

    it("preserves explicit route reason", () => {
      const meta = buildRouteMetadata({
        routeReason: "cron_override",
        selectedProvider: "openai-codex",
        selectedModel: "gpt-5.4",
      });
      expect(meta.routeReason).toBe("cron_override");
    });
  });

  describe("LANE_DESCRIPTIONS", () => {
    it("has descriptions for all lanes", () => {
      const lanes: RoutingLane[] = [
        "routine",
        "orchestrator_high",
        "executor_codex",
        "research",
        "judge_deterministic",
        "judge_semantic",
        "challenger",
      ];
      for (const lane of lanes) {
        expect(LANE_DESCRIPTIONS[lane]).toBeTruthy();
      }
    });
  });
});
