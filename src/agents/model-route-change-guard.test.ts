import { describe, expect, it } from "vitest";
import {
  buildModelRouteChangeGuardNotice,
  evaluateModelRouteChangeGuard,
  resolveModelRouteBillingMode,
} from "./model-route-change-guard.js";

const base = {
  selectedProvider: "codex-cli",
  selectedModel: "gpt-5.4",
  activeProvider: "openai",
  activeModel: "gpt-4o",
  selectedAuthMode: "oauth" as const,
  activeAuthMode: "api-key" as const,
};

describe("model-route-change-guard", () => {
  it("classifies api-key/token/aws-sdk providers as metered", () => {
    expect(resolveModelRouteBillingMode({ provider: "openai", authMode: "api-key" })).toBe(
      "metered",
    );
    expect(resolveModelRouteBillingMode({ provider: "openrouter", authMode: "token" })).toBe(
      "metered",
    );
    expect(resolveModelRouteBillingMode({ provider: "amazon-bedrock", authMode: "aws-sdk" })).toBe(
      "metered",
    );
  });

  it("treats oauth and local providers as non-metered routes", () => {
    expect(resolveModelRouteBillingMode({ provider: "codex", authMode: "oauth" })).toBe(
      "subscription",
    );
    expect(resolveModelRouteBillingMode({ provider: "ollama", authMode: "unknown" })).toBe("local");
  });

  it("escalates a fallback from subscription auth into metered api-key billing in dry-run mode", () => {
    const result = evaluateModelRouteChangeGuard(base);

    expect(result.changed).toBe(true);
    expect(result.enforcement).toBe("dry-run");
    expect(result.action).toBe("escalate");
    expect(result.escalationRequired).toBe(true);
    expect(result.reason).toContain("metered billing");
    expect(result.selected.billingMode).toBe("subscription");
    expect(result.active.billingMode).toBe("metered");
    expect(buildModelRouteChangeGuardNotice(result)).toContain("budget cap");
  });

  it("blocks the same transition when enforcement is enabled", () => {
    const result = evaluateModelRouteChangeGuard({ ...base, enforcement: "block" });

    expect(result.action).toBe("block");
  });

  it("allows a metered transition when approval and budget cap metadata are present", () => {
    const result = evaluateModelRouteChangeGuard({
      ...base,
      enforcement: "block",
      approval: { approved: true, budgetCapUsd: 25, approvalId: "mc-approval-1" },
    });

    expect(result.action).toBe("allow");
    expect(result.escalationRequired).toBe(false);
    expect(result.approval).toEqual({
      approved: true,
      hasBudgetCap: true,
      approvalId: "mc-approval-1",
    });
  });

  it("does not escalate model-only changes that stay on non-metered auth", () => {
    const result = evaluateModelRouteChangeGuard({
      selectedProvider: "codex-cli",
      selectedModel: "gpt-5.4",
      activeProvider: "codex-cli",
      activeModel: "gpt-5.5",
      selectedAuthMode: "oauth",
      activeAuthMode: "oauth",
    });

    expect(result.changed).toBe(true);
    expect(result.action).toBe("allow");
    expect(result.escalationRequired).toBe(false);
  });
});
