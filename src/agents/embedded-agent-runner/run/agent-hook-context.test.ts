import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  AUDIENCE_CHILD_KEY,
  AUDIENCE_ROOT_KEY,
  withChildAudience,
} from "../../../plugins/memory-provider-runtime.audience.test-support.js";
import type { MemoryAudience } from "../../../plugins/memory-provider-types.js";
import { buildEmbeddedAgentHookContext } from "./agent-hook-context.js";

const build = (memoryAudience?: MemoryAudience, sessionKey = AUDIENCE_CHILD_KEY) =>
  buildEmbeddedAgentHookContext(
    { runId: "run", sessionId: "session", sessionKey, workspaceDir: "/w", memoryAudience },
    "main",
    undefined,
  );

it("pairs the embedded hook audience with its currency check", async () => {
  await withChildAudience(true, async ({ audience, root, write }) => {
    const context = build(audience);
    expect(context.memoryAudience).toBe(audience);
    expect(() => context.assertMemoryAudienceCurrent?.()).not.toThrow();

    write(AUDIENCE_ROOT_KEY, { ...root, lifecycleRevision: randomUUID(), updatedAt: 2 });
    expect(() => context.assertMemoryAudienceCurrent?.()).toThrow(
      "memory audience is no longer current",
    );
    expect(() => build(audience, AUDIENCE_ROOT_KEY)).toThrow(
      "memory audience is bound to a different session",
    );
  });
});

it("omits the audience fields when the embedded run has none", () => {
  const context = build();
  expect(context).not.toHaveProperty("memoryAudience");
  expect(context).not.toHaveProperty("assertMemoryAudienceCurrent");
});
