// Microsoft Graph Mail Wake tests cover redaction helper behavior.
import { describe, expect, it } from "vitest";
import { GraphRequestError } from "./graph-client.js";
import { describeErrorRedacted, redactHandle, sha256Hex } from "./redact.js";

describe("redactHandle", () => {
  it("returns a stable non-reversible 16-char handle", () => {
    const handle = redactHandle("sub-1");
    expect(handle).toMatch(/^[a-f0-9]{16}$/);
    expect(redactHandle("sub-1")).toBe(handle);
    expect(redactHandle("sub-2")).not.toBe(handle);
  });

  it("does not expose the raw value", () => {
    expect(redactHandle("ops@example.com")).not.toContain("ops");
    expect(redactHandle("ops@example.com")).not.toContain("example.com");
  });
});

describe("describeErrorRedacted", () => {
  it("returns only the error name, never the message", () => {
    const sensitive = new TypeError(
      "fetch failed for https://graph.microsoft.com/users/ops@example.com/messages with Bearer abc123",
    );
    expect(describeErrorRedacted(sensitive)).toBe("TypeError");
  });

  it("does not trust a custom error name", () => {
    const sensitive = new Error("dependency failed");
    sensitive.name = "Bearer token-raw for ops@example.com";
    expect(describeErrorRedacted(sensitive)).toBe("Error");
  });

  it("handles non-Error values", () => {
    expect(describeErrorRedacted("string failure")).toBe("string");
    expect(describeErrorRedacted({ odd: true })).toBe("object");
    expect(describeErrorRedacted(undefined)).toBe("undefined");
  });

  it("surfaces the already-sanitized GraphRequestError summary in full", () => {
    const err = new GraphRequestError({
      op: "create_subscription",
      status: 403,
      graphErrorCode: "Forbidden",
    });
    expect(describeErrorRedacted(err)).toBe(
      "Graph request failed: op=create_subscription status=403 code=Forbidden",
    );
  });

  it("does not surface a spoofed GraphRequestError name with an unsafe message", () => {
    // instanceof is spoof-proof: a plain Error/object with a forged name is not
    // a GraphRequestError, so it falls back to name-only and cannot leak a raw
    // message.
    const spoof = new Error("Bearer token-raw for ops@example.com");
    spoof.name = "GraphRequestError";
    expect(describeErrorRedacted(spoof)).toBe("Error");
    expect(
      describeErrorRedacted({ name: "GraphRequestError", message: "https://graph/ops@x tokens" }),
    ).toBe("object");
  });
});

describe("sha256Hex", () => {
  it("hashes deterministically", () => {
    expect(sha256Hex("value")).toBe(sha256Hex("value"));
    expect(sha256Hex("value")).not.toBe(sha256Hex("other"));
  });
});
