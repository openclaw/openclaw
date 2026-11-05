import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  AUDIENCE_CHILD_KEY,
  AUDIENCE_ROOT_KEY,
  withChildAudience,
} from "../../plugins/memory-provider-runtime.audience.test-support.js";
import { buildAgentHookContext } from "./hook-context.js";

it("gives harness hooks the host's currency check for their memory audience", async () => {
  await withChildAudience(true, async ({ audience, root, write }) => {
    const context = buildAgentHookContext({
      sessionKey: AUDIENCE_CHILD_KEY,
      memoryAudience: audience,
    });
    expect(context.memoryAudience).toBe(audience);
    expect(() => context.assertMemoryAudienceCurrent?.()).not.toThrow();

    write(AUDIENCE_ROOT_KEY, { ...root, lifecycleRevision: randomUUID(), updatedAt: 2 });
    expect(() => context.assertMemoryAudienceCurrent?.()).toThrow(
      "memory audience is no longer current",
    );
  });
});
