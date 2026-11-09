import { describe, expect, it } from "vitest";
import { createClientHarness } from "./test-support.js";
import { refreshCodexThreadPolicy } from "./thread-policy.js";

describe("generic native policy refresh", () => {
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
        expect(text).toContain(
          "replacing earlier OpenClaw generic policy, including omitted rules",
        );
        expect(text).toContain(
          "Independent native, project and current-request instructions retain authority",
        );
        expect(text).toContain("Preserve conversation history and unfinished user requests");
        expect(text).toContain(policy || "earlier OpenClaw generic policy is withdrawn");
      } finally {
        await h.client.closeAndWait();
      }
    },
  );
});
