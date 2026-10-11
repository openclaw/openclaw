import { describe, expect, it } from "vitest";
import { createClientHarness } from "./test-support.js";
import { CodexThreadPolicyHandoffError, refreshCodexThreadPolicy } from "./thread-policy.js";

describe("generic native policy refresh", () => {
  it.each([
    ["subscription-release", "not-written", "releasing this session's subscription"],
    ["native-unload", "not-written", "unloading its previous configuration"],
    ["tool-attestation", "not-written", "current tool policy"],
    ["policy-write", "unknown", "policy write outcome is unknown and will not be replayed"],
    ["binding-commit", "acknowledged", "policy binding"],
  ] as const)(
    "bounds %s failure diagnostics while retaining the private cause",
    (phase, outcome, text) => {
      const cause = new Error("private-instruction-and-credential-canary");
      const error = new CodexThreadPolicyHandoffError(outcome, cause, phase);
      expect(error).toMatchObject({ phase, outcome, cause });
      for (const message of [error.message, error.userMessage]) {
        expect(message).toContain(text);
        expect(message).toContain("reconnect this session before retrying");
        expect(message?.match(/conversation is preserved/g)).toHaveLength(1);
        expect(message).not.toMatch(/private-instruction|credential-canary|competing/);
        expect(message!.length).toBeLessThan(300);
      }
    },
  );

  it.each(["shared runtime policy", ""])(
    "limits replacement to the generic policy (%j)",
    async (policy) => {
      const h = createClientHarness();
      try {
        const update = refreshCodexThreadPolicy({
          client: h.client,
          threadId: "root",
          developerInstructions: policy,
          timeoutMs: 1_000,
          assertCurrent: () => {},
        });
        const request = JSON.parse(await h.waitForWrite(0));
        h.send({ id: request.id, result: {} });
        await update;
        expect(request.method).toBe("thread/inject_items");
        const text = request.params.items[0].content[0].text;
        expect(text).toContain("sections removed from that generic policy");
        expect(text).toContain(
          "Parent-local instructions supplied for the current inference request are outside this policy replacement",
        );
        expect(text).toContain(
          "native managed, guardian, security, collaboration, and project instructions retain their authority",
        );
        expect(text).toContain(policy || "earlier OpenClaw generic policy is withdrawn");
      } finally {
        await h.client.closeAndWait();
      }
    },
  );
});
