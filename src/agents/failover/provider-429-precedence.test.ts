import { describe, expect, it, vi } from "vitest";
import { classifyFailoverSignal } from "./classify.js";

describe("prepared provider HTTP 429 precedence", () => {
  it.each(["rate_limit", "billing", null, undefined, "timeout", "context_overflow"] as const)(
    "applies HTTP 429 precedence to the owner's %s decision",
    (reason) => {
      const classifyFailoverReason = vi.fn(() => reason ?? undefined);
      const providerPlugin =
        reason === null ? null : { id: "prepared-owner", classifyFailoverReason };
      const check = (message: string, expected: "billing" | "rate_limit", code?: string) => {
        expect(
          classifyFailoverSignal(
            { provider: "custom-route", status: 429, code, message },
            { providerPlugin },
          ),
        ).toEqual({ kind: "reason", reason: expected });
      };
      if (reason === "rate_limit" || reason === "billing") {
        check("insufficient_quota", reason, "OWNER_QUOTA");
        expect(classifyFailoverReason).toHaveBeenCalledOnce();
      } else if (reason == null) {
        check("insufficient_quota", "billing");
        check("Too many requests", "rate_limit");
      } else {
        check("Provider returned error", "rate_limit");
        check('Provider returned error\n{"error":{"code":"insufficient_quota"}}', "billing");
      }
    },
  );
});
