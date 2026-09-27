import { describe, expect, it, vi } from "vitest";
import { classifyFailoverSignal } from "./classify.js";
import type { PreparedProviderFailoverOwner } from "./provider-patterns.js";

function expect429Reason(
  message: string,
  providerPlugin: PreparedProviderFailoverOwner | null,
  reason: "billing" | "rate_limit",
  code?: string,
) {
  expect(
    classifyFailoverSignal(
      { provider: "custom-route", status: 429, code, message },
      { providerPlugin },
    ),
  ).toEqual({ kind: "reason", reason });
}

describe("prepared provider HTTP 429 precedence", () => {
  it.each(["rate_limit", "billing"] as const)("retains the owner's %s decision", (reason) => {
    const providerPlugin = { id: "prepared-owner", classifyFailoverReason: vi.fn(() => reason) };
    expect429Reason("insufficient_quota", providerPlugin, reason, "OWNER_QUOTA");
    expect(providerPlugin.classifyFailoverReason).toHaveBeenCalledOnce();
  });

  it("keeps generic billing and rate limits when no provider decision is available", () => {
    for (const providerPlugin of [
      null,
      { id: "unknown-owner", classifyFailoverReason: () => undefined },
    ]) {
      expect429Reason("insufficient_quota", providerPlugin, "billing");
      expect429Reason("Too many requests", providerPlugin, "rate_limit");
    }
  });

  it.each(["timeout", "context_overflow"] as const)(
    "does not promote the provider's %s fallback above HTTP 429 semantics",
    (reason) => {
      const providerPlugin = { id: "prepared-owner", classifyFailoverReason: () => reason };
      expect429Reason("Provider returned error", providerPlugin, "rate_limit");
      expect429Reason(
        'Provider returned error\n{"error":{"code":"insufficient_quota"}}',
        providerPlugin,
        "billing",
      );
    },
  );
});
