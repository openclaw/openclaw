import type { KnowledgeBase, KbResult } from "@claworks/runtime";
import { createKnowledgeBase } from "@claworks/runtime";
import { resolveSessionAgentIds } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

type MemoryKbOptions = {
  agentId?: string;
};

/**
 * Bridges ClaWorks KnowledgeBase to OpenClaw memory-core search manager.
 * Falls back to in-memory stub when memory-core is unavailable.
 */
export async function createMemoryKnowledgeBase(
  api: OpenClawPluginApi,
  opts?: MemoryKbOptions,
): Promise<KnowledgeBase> {
  const stub = createKnowledgeBase();
  const cfg = api.config;
  const { sessionAgentId } = resolveSessionAgentIds({
    config: cfg,
    agentId: opts?.agentId,
  });

  try {
    const { getMemoryManagerContext } = await import("../memory-core/src/tools.shared.js");
    const ctx = await getMemoryManagerContext({ cfg, agentId: sessionAgentId });
    if (!("manager" in ctx) || !ctx.manager) {
      api.logger.warn?.(
        `[claworks:kb] memory-core unavailable: ${"error" in ctx ? ctx.error : "no manager"} — using stub`,
      );
      return stub;
    }

    const manager = ctx.manager;

    return {
      async search(query, searchOpts) {
        const limit = searchOpts?.limit ?? 5;
        const results = await manager.search(query, { maxResults: limit });

        const mapped = results.map(
          (r): KbResult => ({
            id: `${r.source}:${r.path}:${r.startLine}`,
            score: r.score,
            text: r.snippet,
            source: r.path,
            namespace: r.source,
          }),
        );

        if (searchOpts?.namespace) {
          return mapped.filter((r) => r.namespace === searchOpts.namespace);
        }
        return mapped;
      },

      async ingest(text, ingestOpts) {
        await stub.ingest(text, ingestOpts);
        api.logger.info?.(
          `[claworks:kb] ingest stored in stub only (${text.length} chars); use memory tools for durable memory-core writes`,
        );
      },
    };
  } catch (err) {
    api.logger.warn?.(
      `[claworks:kb] memory-core bridge failed: ${err instanceof Error ? err.message : String(err)} — using stub`,
    );
    return stub;
  }
}
