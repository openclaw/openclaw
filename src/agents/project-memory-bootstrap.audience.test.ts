// Project recall against real session lineage and a registered native provider.
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  AUDIENCE_ROOT_KEY,
  NATIVE_PROVIDER_ID,
  childMemoryContext,
  withChildAudience,
  withNativeMemoryProvider,
} from "../plugins/memory-provider-runtime.audience.test-support.js";
import type { MemoryProviderHandle } from "../plugins/memory-provider-types.js";
import { prepareProjectMemoryBootstrap } from "./project-memory-bootstrap.js";

const PROJECT_KEY = "github.com/OpenClaw/OpenClaw";

it.each([
  ["stays current", undefined],
  ["goes stale during selection", "candidates"],
  ["goes stale during provider close", "close"],
] as const)("returns project lines only while the audience %s", async (_name, staleDuring) => {
  await withChildAudience(true, async ({ audience, root, write }) => {
    // A lineage parent reset revokes the child's inherited audience.
    const revoke = (stage: "candidates" | "close") => {
      if (stage === staleDuring) {
        write(AUDIENCE_ROOT_KEY, { ...root, lifecycleRevision: randomUUID(), updatedAt: 2 });
      }
    };
    const provider: MemoryProviderHandle = {
      capabilities: {
        sources: ["memory"],
        pagination: false,
        candidates: ["project"],
        projectFilter: true,
      },
      search: async () => ({ hits: [] }),
      get: async () => ({ status: "not_found" }),
      health: async () => ({ status: "ready" }),
      candidates: async () => {
        revoke("candidates");
        return {
          hits: [
            {
              reference: { providerId: NATIVE_PROVIDER_ID, id: "release" },
              excerpt: "Use the release helper.",
              automaticRecall: { eligible: true, projectKeys: [PROJECT_KEY] },
            },
          ],
        };
      },
      close: async () => revoke("close"),
    };
    const lines = await withNativeMemoryProvider(
      () => provider,
      () =>
        prepareProjectMemoryBootstrap({
          cfg: {},
          agentId: "main",
          activeProjectKeys: [PROJECT_KEY],
          context: childMemoryContext(audience),
        }),
    );
    if (staleDuring) {
      expect(lines).toEqual([]);
    } else {
      expect(lines.join("\n")).toContain("Use the release helper.");
    }
  });
});
