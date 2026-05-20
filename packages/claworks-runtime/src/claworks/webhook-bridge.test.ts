import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEventKernel } from "../kernel/event-kernel.js";
import { createIngressRouter } from "../kernel/ingress.js";
import { openDatabase } from "../planes/data/db.js";
import { createKnowledgeBase } from "../planes/data/knowledge-base.js";
import { createObjectStore } from "../planes/data/object-store.js";
import { createHitlGate } from "../planes/orch/hitl-gate.js";
import { createPlaybookEngine } from "../planes/orch/playbook-engine.js";
import { createRbacGuard, DEFAULT_RBAC_POLICIES } from "./robot-identity.js";
import type { ClaworksRuntime } from "./runtime-types.js";
import { bridgeWebhookPayload } from "./webhook-bridge.js";

describe("webhook-bridge", () => {
  it("intent_route triggers classify playbook when loaded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-wh-bridge-"));
    const { db, close } = openDatabase(`sqlite://${join(dir, "t.db")}`);
    const playbookEngine = createPlaybookEngine({
      db,
      objectStore: createObjectStore(db),
      kb: createKnowledgeBase(),
      robot: { name: "t", role: "monolith", version: "0", endpoint: "http://127.0.0.1:18800" },
      hitl: createHitlGate(),
    });
    await playbookEngine.loadFromPacks([
      {
        manifest: { id: "base", version: "1", name: "base" },
        playbooks: [
          {
            id: "classify_webhook_to_business_event",
            name: "wh",
            pack: "base",
            priority: 1,
            trigger: { kind: "manual" },
            steps: [{ id: "noop", kind: "function", functionApiName: "noop", params: {} }],
          },
        ],
        objectTypes: [],
        functions: [],
        connectors: [],
      },
    ]);

    const kernel = createEventKernel({
      playbookEngine,
      db,
    });
    await kernel.start();

    const runtime = {
      playbookEngine,
      kernel,
      ingress: createIngressRouter(),
      rbac: createRbacGuard([...DEFAULT_RBAC_POLICIES]),
      logger: () => undefined,
    } as unknown as ClaworksRuntime;

    const result = await bridgeWebhookPayload(runtime, {
      source: "mes",
      body: { alarm: "high" },
      subjectId: "webhook:mes",
    });

    expect(result.action).toBe("intent_routed");
    if (result.action === "intent_routed") {
      expect(result.playbookId).toBe("classify_webhook_to_business_event");
    }
    close();
  });
});
