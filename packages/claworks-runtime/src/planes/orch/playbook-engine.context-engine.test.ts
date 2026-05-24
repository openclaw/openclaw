import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ContextEngine } from "../../kernel/context-engine.js";
import { openDatabase } from "../data/db.js";
import { createKnowledgeBase } from "../data/knowledge-base.js";
import { createObjectStore } from "../data/object-store.js";
import { createHitlGate } from "./hitl-gate.js";
import { createPlaybookEngine } from "./playbook-engine.js";
import type { PlaybookDefinition } from "./playbook-types.js";

describe("playbook-engine contextEngine integration", () => {
  it("records assistant turn when sync run completes with session_id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-ctx-engine-"));
    const { db, close } = openDatabase(`sqlite://${join(dir, "t.db")}`);
    const append = vi.fn();
    const contextEngine: ContextEngine = {
      append,
      getRecent: vi.fn().mockReturnValue([]),
      clear: vi.fn(),
    };

    const engine = createPlaybookEngine({
      db,
      objectStore: createObjectStore(db),
      kb: createKnowledgeBase(),
      robot: {
        name: "t",
        role: "monolith",
        version: "0",
        endpoint: "http://127.0.0.1:18800",
      },
      hitl: createHitlGate(),
      contextEngine,
      llmComplete: vi.fn().mockResolvedValue({ text: "route to alarm handler" }),
    });

    const def: PlaybookDefinition = {
      id: "classify_im",
      name: "Classify IM",
      pack: "test",
      trigger: { kind: "manual" },
      priority: 0,
      steps: [
        {
          kind: "llm",
          id: "classify",
          prompt: "classify message",
          output: "reply",
        },
      ],
    };

    await engine.loadFromPacks([
      {
        manifest: {
          id: "test",
          name: "t",
          version: "1",
          license: "MIT",
          provides: { objectTypes: [], playbooks: ["classify_im"], actionTypes: [] },
        },
        path: dir,
        objectTypes: [],
        playbooks: [def],
      },
    ]);

    const run = await engine.trigger("classify_im", { session_id: "feishu:user:u1" });
    expect(run.status).toBe("completed");
    expect(append).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith(
      "feishu:user:u1",
      "assistant",
      "route to alarm handler",
      expect.objectContaining({ playbook_id: "classify_im", run_id: run.id }),
    );

    close();
  });
});
