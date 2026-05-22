import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ClaworksRuntime } from "../../claworks/runtime.js";
import { createEventKernel } from "../../kernel/event-kernel.js";
import { createIngressRouter } from "../../kernel/ingress.js";
import { openDatabase } from "../../planes/data/db.js";
import { createDocumentKnowledgeBase } from "../../planes/data/kb-document-knowledge-base.js";
import { createKnowledgeBase } from "../../planes/data/knowledge-base.js";
import { createObjectStore } from "../../planes/data/object-store.js";
import { createHitlGate } from "../../planes/orch/hitl-gate.js";
import { createPlaybookEngine } from "../../planes/orch/playbook-engine.js";
import { CLAWORKS_MCP_TOOLS, callClaworksMcpTool } from "./tools.js";

describe("MCP tools", () => {
  it("includes extended tool names", () => {
    const names = CLAWORKS_MCP_TOOLS.map((t) => t.name);
    expect(names).toContain("cw_get_identity");
    expect(names).toContain("cw_bridge_im_message");
    expect(names).toContain("cw_list_runs");
    expect(names).toContain("cw_get_run");
    expect(names).toContain("cw_submit_hitl");
  });

  it("cw_get_identity returns robot summary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-mcp-"));
    const { db, close } = openDatabase(`sqlite://${join(dir, "t.db")}`);
    const playbookEngine = createPlaybookEngine({
      db,
      objectStore: createObjectStore(db),
      kb: createKnowledgeBase(),
      robot: { name: "t", role: "monolith", version: "0", endpoint: "http://127.0.0.1:18800" },
      hitl: createHitlGate(),
    });
    const kernel = createEventKernel({ playbookEngine, db });
    await kernel.start();

    const runtime = {
      identity: {
        name: "test-robot",
        role: "monolith",
        domain: "test",
        description: "d",
        rules: [],
        agentMd: "# md",
      },
      robot: {
        name: "test-robot",
        role: "monolith",
        version: "0",
        endpoint: "http://127.0.0.1:18800",
      },
      kb: createKnowledgeBase(),
      objectStore: createObjectStore(db),
      playbookEngine,
      kernel,
      ingress: { decide: () => ({ action: "deny" as const }) },
      rbac: { check: () => ({ allowed: false, reason: "deny" }) },
    } as unknown as ClaworksRuntime;

    const result = (await callClaworksMcpTool(runtime, "cw_get_identity", {})) as {
      name: string;
    };
    expect(result.name).toBe("test-robot");
    close();
  });

  it("cw_kb_status describes stub KB", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-mcp-kb-"));
    const { db, close } = openDatabase(`sqlite://${join(dir, "t.db")}`);
    const kb = createKnowledgeBase();
    const runtime = {
      config: { data: { kb_provider: "stub", kb_embed_model: "text-embedding-3-small" } },
      kb,
    } as unknown as ClaworksRuntime;

    const status = (await callClaworksMcpTool(runtime, "cw_kb_status", {})) as {
      provider: string;
      vector: boolean;
    };
    expect(status.provider).toBe("bm25-memory");
    expect(status.vector).toBe(false);
    close();
  });

  it("cw_kb_ingest_document publishes searchable document metadata", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-mcp-doc-kb-"));
    const { db, close } = openDatabase(`sqlite://${join(dir, "t.db")}`);
    const kb = createDocumentKnowledgeBase(db, createKnowledgeBase());
    const runtime = {
      config: { data: {} },
      kb,
    } as unknown as ClaworksRuntime;

    const ingest = (await callClaworksMcpTool(runtime, "cw_kb_ingest_document", {
      text: "Compressor vibration threshold is 4.5 mm/s",
      source: "compressor-manual.md",
      namespace: "plant",
      auto_publish: true,
    })) as { document: { id: string; status: string } };

    expect(ingest.document.status).toBe("published");

    const search = (await callClaworksMcpTool(runtime, "cw_kb_search", {
      query: "vibration",
      namespace: "plant",
    })) as { results: Array<{ document_id?: string; citation?: string }> };

    expect(search.results.length).toBeGreaterThan(0);
    expect(search.results[0]?.document_id).toBe(ingest.document.id);
    close();
  });

  it("cw_publish_event uses ingress router (mcp → kernel)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-mcp-ingress-"));
    const { db, close } = openDatabase(`sqlite://${join(dir, "t.db")}`);
    const playbookEngine = createPlaybookEngine({
      db,
      objectStore: createObjectStore(db),
      kb: createKnowledgeBase(),
      robot: { name: "t", role: "monolith", version: "0", endpoint: "http://127.0.0.1:18800" },
      hitl: createHitlGate(),
    });
    const kernel = createEventKernel({ playbookEngine, db });
    await kernel.start();

    const runtime = {
      identity: {
        name: "t",
        role: "monolith",
        domain: "d",
        description: "",
        rules: [],
        agentMd: "",
      },
      robot: { name: "t", role: "monolith", version: "0", endpoint: "http://127.0.0.1:18800" },
      kb: createKnowledgeBase(),
      objectStore: createObjectStore(db),
      playbookEngine,
      kernel,
      ingress: createIngressRouter(),
      rbac: { check: () => ({ allowed: true }) },
    } as unknown as ClaworksRuntime;

    const result = (await callClaworksMcpTool(runtime, "cw_publish_event", {
      type: "custom.probe",
      payload: { ok: true },
    })) as { action: string; matched_playbooks?: string[] };

    expect(result.action).toBe("published");
    expect(Array.isArray(result.matched_playbooks)).toBe(true);
    close();
  });
});
