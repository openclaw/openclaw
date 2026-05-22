import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bridgeImMessage,
  createIngressRouter,
  createRbacGuard,
  DEFAULT_RBAC_POLICIES,
  type ClaworksRuntime,
} from "@claworks/runtime";
import { createEventKernel } from "@claworks/runtime/kernel";
import {
  openDatabase,
  createKnowledgeBase,
  createObjectStore,
} from "@claworks/runtime/planes/data";
import { createHitlGate, createPlaybookEngine } from "@claworks/runtime/planes/orch";
import { describe, expect, it } from "vitest";

/** Extension package smoke: agent tool path uses the same bridge as REST /v1/bridge/im. */
describe("cw_bridge_im_message runtime bridge", () => {
  it("routes IM text through ingress intent_route", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-ext-bridge-"));
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
            id: "classify_im_to_business_event",
            name: "im",
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
    const kernel = createEventKernel({ playbookEngine, db });
    await kernel.start();

    const runtime = {
      playbookEngine,
      kernel,
      ingress: createIngressRouter(),
      rbac: createRbacGuard([...DEFAULT_RBAC_POLICIES]),
    } as unknown as ClaworksRuntime;

    const result = await bridgeImMessage(runtime, {
      channel: "feishu",
      messageId: "ext-1",
      userId: "u1",
      text: "测试桥接",
    });
    expect(result.action).toBe("intent_routed");
    close();
  });
});
