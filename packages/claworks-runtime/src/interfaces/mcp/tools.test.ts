import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ClaworksRuntime } from "../../claworks/runtime.js";
import { createEventKernel } from "../../kernel/event-kernel.js";
import { createIngressRouter } from "../../kernel/ingress.js";
import { openDatabase } from "../../planes/data/db.js";
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
