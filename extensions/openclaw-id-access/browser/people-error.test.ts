import { describe, expect, it, vi } from "vitest";
import { NoOwnerKeyError } from "./owner-signing.js";
import { peopleError } from "./people-error.js";

const unchanged = (text: string) => text;
const refusal = (code: string, message = "raw authority detail") =>
  Object.assign(new Error(message), { code: "INVALID_REQUEST", details: { code } });

describe("People error copy", () => {
  it("maps Gateway detail codes and the local missing-owner-key error, never message text", () => {
    expect(peopleError(refusal("not_direct"), "update", unchanged).message).toBe(
      "Use an approved owner browser to change access.",
    );
    expect(peopleError(new NoOwnerKeyError(), "update", unchanged).message).toBe(
      "This browser cannot manage access to this claw. Use an approved owner browser.",
    );
    expect(peopleError(refusal("not_owner"), "load", unchanged).message).toContain(
      "Only the owner",
    );
    expect(peopleError(new Error("seq_conflict"), "update", unchanged).message).toContain(
      "Could not confirm",
    );
  });

  it("requires renewed review for changed requests and does not guess which target mismatch occurred", () => {
    expect(peopleError(refusal("seq_conflict"), "update", unchanged).message).toContain(
      "review the current access",
    );
    expect(peopleError(refusal("invite_not_pending"), "approve", unchanged).message).toBe(
      "This request is no longer waiting for approval. Refresh this page to see its status.",
    );
    for (const message of [
      "approval does not match the pending redemption",
      "approval grants more than the invite",
      "unknown member",
    ]) {
      expect(peopleError(refusal("target_mismatch", message), "approve", unchanged).message).toBe(
        "This update does not match the current access or invitation. Refresh this page and review the request and its allowed access before making changes.",
      );
    }
  });

  it("keeps verification, expiration and permission refusals distinct from temporary outages", () => {
    for (const code of [
      "bad_signature",
      "wrong_signer",
      "root_mismatch",
      "wrong_claw",
      "host_mismatch",
      "rollback",
      "bad_proof",
      "audience_mismatch",
    ]) {
      expect(peopleError(refusal(code), "approve", unchanged).message).toContain("Do not continue");
    }
    expect(peopleError(refusal("expired"), "approve", unchanged).message).toContain(
      "This access approval expired",
    );
    expect(peopleError(refusal("expired"), "approve", unchanged).message).not.toContain(
      "This browser",
    );
    expect(peopleError(refusal("not_an_owner"), "update", unchanged).message).toContain(
      "owner access was removed",
    );
    expect(peopleError(refusal("limit_reached"), "update", unchanged).message).toContain(
      "Remove one to add another",
    );
    expect(peopleError(refusal("missing_capability"), "update", unchanged).message).toContain(
      "approved owner browser",
    );
  });

  it("separates load failures from uncertain updates even when retryable is true", () => {
    for (const code of [
      "UNAVAILABLE",
      "CLIENT_TIMEOUT",
      "future_code",
      "constructor",
      "malformed",
      "unsupported",
    ]) {
      const error = { code, message: "internal failure", retryable: true };
      expect(peopleError(error, "load", unchanged).message).toBe(
        "Could not load people. Refresh this page to try again.",
      );
      expect(peopleError(error, "update", unchanged).message).toBe(
        "Could not confirm the access update. Refresh this page and check who has access before making another change.",
      );
      expect(peopleError(error, "approve", unchanged).message).toBe(
        "Could not confirm whether access was approved. Refresh this page and check the person's access before approving again.",
      );
    }
  });

  it("sanitizes and bounds diagnostics without serializing stacks or arbitrary payloads", () => {
    const redact = vi.fn((text: string) => text.replace(/Bearer \S+/g, "Bearer [redacted]"));
    // A URL with userinfo, built at runtime so the fixture holds no credential literal.
    const credentialedUrl = Object.assign(
      new URL("https://example.test/path?code=private#secret"),
      {
        username: "user",
        password: "password",
      },
    ).href;
    const error = Object.assign(
      new Error(
        `failed\u202e ${credentialedUrl} ` +
          "OCK1-ABCDE-ABCDE-ABCDE-ABCDE-ABCDE-ABCDE-A Bearer short-secret " +
          "proofKey=abcdefghijklmnopqrstuvwxyz1234567890 " +
          "diagnostic ".repeat(150),
      ),
      { details: { code: "not_direct", payload: "private payload" } },
    );
    const result = peopleError(error, "update", redact);
    expect(result.message).toBe("Use an approved owner browser to change access.");
    expect(result.diagnostic).toContain("not_direct: failed");
    expect(result.diagnostic).not.toMatch(
      /OCK1|ABCDE|https:|password|private|short-secret|abcdefghijklmnopqrstuvwxyz|\u202e|Error:|\bat /,
    );
    expect(result.diagnostic.length).toBeLessThanOrEqual(1200);
    expect(result.diagnostic).toMatch(/…$/);
    expect(redact).toHaveBeenCalledOnce();
    expect(peopleError({ secret: "do not serialize" }, "load", unchanged).diagnostic).toBe("");
    expect(peopleError(null, "load", unchanged).diagnostic).toBe("");
  });
});
