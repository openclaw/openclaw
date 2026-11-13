// Project recall against real session lineage and a registered native provider.
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { withDiagnosticsTimelineObserver } from "../infra/diagnostics-timeline.js";
import type { MemoryProviderHandle } from "../plugins/memory-provider-runtime-types.js";
import {
  AUDIENCE_ROOT_KEY,
  NATIVE_PROVIDER_ID,
  childMemoryContext,
  withChildAudience,
  withNativeMemoryProvider,
} from "../plugins/memory-provider-runtime.audience.test-support.js";
import { prepareProjectMemoryBootstrap } from "./project-memory-bootstrap.js";

const PROJECT_KEY = "github.com/OpenClaw/OpenClaw";

it.each([
  ["stays current", undefined],
  ["goes stale during selection", "candidates"],
  ["goes stale during provider close", "close"],
] as const)("returns project lines only while the audience %s", async (_name, staleDuring) => {
  await withChildAudience(true, async ({ audience, root, write }) => {
    let elapsed = 0;
    const durations = new Map<string, number>();
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
        elapsed += 5_800;
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
      close: async () => {
        elapsed += 40;
        revoke("close");
      },
    };
    const lines = await withDiagnosticsTimelineObserver(
      (name) => {
        const start = elapsed;
        return () => durations.set(name, (durations.get(name) ?? 0) + elapsed - start);
      },
      () =>
        withNativeMemoryProvider(
          () => provider,
          () =>
            prepareProjectMemoryBootstrap({
              cfg: {},
              agentId: "main",
              activeProjectKeys: [PROJECT_KEY],
              context: childMemoryContext(audience),
            }),
        ),
    );
    expect(durations.get("project-memory.provider")).toBe(0);
    expect(durations.get("memory.provider-open.open")).toBe(0);
    expect(durations.get("project-memory.candidates")).toBe(5_800);
    expect(durations.get("memory.provider-call.execute")).toBe(5_800);
    expect(durations.get("project-memory.close")).toBe(40);
    expect(durations.get("project-memory.publish")).toBe(0);
    if (staleDuring) {
      expect(lines).toEqual([]);
    } else {
      expect(lines.join("\n")).toContain("Use the release helper.");
    }
  });
});
