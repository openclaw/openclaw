import { describe, expect, it } from "vitest";
import {
  completionOwnerNeedsRequesterFinal,
  normalizeSubagentCompletionOwner,
  resolveSubagentCompletionOwner,
} from "./subagent-completion-owner.js";

describe("subagent completion owner", () => {
  it("normalizes only supported owner values", () => {
    expect(normalizeSubagentCompletionOwner("work-thread-final")).toBe("work-thread-final");
    expect(normalizeSubagentCompletionOwner(" requester-session-final ")).toBe(
      "requester-session-final",
    );
    expect(normalizeSubagentCompletionOwner("unknown")).toBeUndefined();
    expect(normalizeSubagentCompletionOwner(undefined)).toBeUndefined();
  });

  it("defaults thread-bound direct delivery to work-thread ownership", () => {
    expect(
      resolveSubagentCompletionOwner({
        expectsCompletionMessage: true,
        threadBoundDirectDelivery: true,
      }),
    ).toBe("work-thread-final");
  });

  it("defaults requester completion flows to requester-session ownership", () => {
    expect(
      resolveSubagentCompletionOwner({
        expectsCompletionMessage: true,
        threadBoundDirectDelivery: false,
      }),
    ).toBe("requester-session-final");
  });

  it("respects explicit none and requester-final owners", () => {
    expect(
      resolveSubagentCompletionOwner({
        requestedOwner: "none",
        expectsCompletionMessage: true,
        threadBoundDirectDelivery: true,
      }),
    ).toBe("none");
    expect(completionOwnerNeedsRequesterFinal("none")).toBe(false);
    expect(completionOwnerNeedsRequesterFinal("requester-session-final")).toBe(true);
    expect(completionOwnerNeedsRequesterFinal("origin-bridge-final")).toBe(true);
  });
});
