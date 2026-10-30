import { describe, expect, it } from "vitest";
import { createClientHarness } from "./test-support.js";
import { refreshCodexThreadPolicy } from "./thread-policy.js";

describe("generic native policy refresh", () => {
  it.each([
    { policy: "shared runtime policy", managedCollaboration: false },
    { policy: "", managedCollaboration: false },
    { policy: "current managed policy", managedCollaboration: true },
  ])(
    "limits replacement to the owned policy ($policy)",
    async ({ policy, managedCollaboration }) => {
      const h = createClientHarness();
      try {
        const update = refreshCodexThreadPolicy({
          client: h.client,
          threadId: "root",
          developerInstructions: policy,
          managedCollaboration,
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
          managedCollaboration
            ? "native managed, guardian, security, and project instructions retain their authority"
            : "native managed, guardian, security, collaboration, and project instructions retain their authority",
        );
        expect(text.includes("All earlier collaboration-mode instructions are withdrawn")).toBe(
          managedCollaboration,
        );
        expect(text).toContain(policy || "earlier OpenClaw generic policy is withdrawn");
      } finally {
        await h.client.closeAndWait();
      }
    },
  );
});
