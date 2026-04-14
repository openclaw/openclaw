import { describe, expect, it } from "vitest";
import { buildRouteMetadata, inferRoutingLane } from "./routing-lanes.js";

describe("route-metadata semantics", () => {
  describe("no-failover path", () => {
    it("requested/selected/actual all match when no failover occurs", () => {
      const meta = buildRouteMetadata({
        agentId: "main",
        requestedProvider: "anthropic",
        requestedModel: "claude-opus-4-6",
        selectedProvider: "anthropic",
        selectedModel: "claude-opus-4-6",
      });
      expect(meta.requestedLane).toBe("orchestrator_high");
      expect(meta.selectedLane).toBe("orchestrator_high");
      expect(meta.actualLane).toBe("orchestrator_high");
      expect(meta.requestedModel).toBe("anthropic/claude-opus-4-6");
      expect(meta.selectedModel).toBe("anthropic/claude-opus-4-6");
      expect(meta.actualModel).toBe("anthropic/claude-opus-4-6");
      expect(meta.routeReason).toBe("primary");
      expect(meta.failoverReason).toBeUndefined();
      expect(meta.escalationReason).toBeUndefined();
    });
  });

  describe("failover path", () => {
    it("preserves original requestedModel when failover changes the actual model", () => {
      const meta = buildRouteMetadata({
        agentId: "main",
        requestedProvider: "anthropic",
        requestedModel: "claude-opus-4-6",
        selectedProvider: "anthropic",
        selectedModel: "claude-sonnet-4-6",
        failoverReason: "rate_limit",
      });
      expect(meta.requestedModel).toBe("anthropic/claude-opus-4-6");
      expect(meta.selectedModel).toBe("anthropic/claude-sonnet-4-6");
      expect(meta.actualModel).toBe("anthropic/claude-sonnet-4-6");
      expect(meta.routeReason).toBe("failover");
      expect(meta.failoverReason).toBe("rate_limit");
      expect(meta.escalationReason).toBeUndefined();
    });

    it("requestedLane reflects original intent, not failover target", () => {
      const meta = buildRouteMetadata({
        requestedProvider: "anthropic",
        requestedModel: "claude-opus-4-6",
        selectedProvider: "openai-codex",
        selectedModel: "gpt-5.4",
        failoverReason: "auth",
      });
      expect(meta.requestedLane).toBe("orchestrator_high");
      expect(meta.selectedLane).toBe("executor_codex");
      expect(meta.actualLane).toBe("executor_codex");
    });
  });

  describe("escalation vs failover separation", () => {
    it("escalation reason is separate from failover reason", () => {
      const meta = buildRouteMetadata({
        requestedProvider: "openai-codex",
        requestedModel: "gpt-5.4",
        selectedProvider: "anthropic",
        selectedModel: "claude-opus-4-6",
        routeReason: "escalation",
        escalationReason: "revise_loop_exceeded",
      });
      expect(meta.routeReason).toBe("escalation");
      expect(meta.escalationReason).toBe("revise_loop_exceeded");
      expect(meta.failoverReason).toBeUndefined();
    });
  });

  describe("lane inference", () => {
    it("codex model maps to executor_codex lane", () => {
      expect(inferRoutingLane({ provider: "openai-codex", model: "gpt-5.4" })).toBe(
        "executor_codex",
      );
    });

    it("mini model maps to routine lane", () => {
      expect(inferRoutingLane({ provider: "openai", model: "gpt-5.4-mini" })).toBe("routine");
    });

    it("judge agent always maps to judge_semantic", () => {
      expect(
        inferRoutingLane({
          agentId: "judge",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
        }),
      ).toBe("judge_semantic");
    });
  });
});
