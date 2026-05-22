import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { KnowledgeBase, KbResult } from "@claworks/runtime";
import { resolveSessionAgentIds } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

type MemoryKbOptions = {
  agentId?: string;
};

function claworksStateDir(): string {
  return process.env.OPENCLAW_STATE_DIR?.trim() || join(homedir(), ".claworks");
}

/**
 * Fallback in-memory KB that also writes ingested docs to the kb-drop directory
 * so they can be picked up by later indexing pipelines.
 */
function createDropDirKnowledgeBase(): KnowledgeBase {
  const docs: Array<{ id: string; text: string; namespace?: string; source?: string }> = [];

  return {
    async search(query, opts) {
      const limit = opts?.limit ?? 5;
      const q = query.toLowerCase();
      return docs
        .filter((d) => !opts?.namespace || d.namespace === opts.namespace)
        .filter((d) => d.text.toLowerCase().includes(q))
        .slice(0, limit)
        .map(
          (d, i): KbResult => ({
            id: d.id,
            score: 1 - i * 0.1,
            text: d.text,
            source: d.source,
            namespace: d.namespace,
          }),
        );
    },

    async ingest(text, opts) {
      const id = `kb-drop-${docs.length + 1}`;
      docs.push({ id, text, namespace: opts?.namespace, source: opts?.source });
      const ns = opts?.namespace ?? "default";
      const dropDir = join(claworksStateDir(), "kb-drop", ns);
      mkdirSync(dropDir, { recursive: true });
      writeFileSync(join(dropDir, `${randomUUID()}.md`), text, "utf8");
    },
  };
}

/**
 * Bridges ClaWorks KnowledgeBase to OpenClaw memory-core search manager.
 * Falls back to a drop-dir-backed stub when memory-core is unavailable.
 */
export async function createMemoryKnowledgeBase(
  api: OpenClawPluginApi,
  opts?: MemoryKbOptions,
): Promise<KnowledgeBase> {
  const stub = createDropDirKnowledgeBase();
  const cfg = api.config;
  const { sessionAgentId } = resolveSessionAgentIds({
    config: cfg,
    agentId: opts?.agentId,
  });

  try {
    const { getMemoryManagerContext } = await import("../memory-core/api.js");
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
