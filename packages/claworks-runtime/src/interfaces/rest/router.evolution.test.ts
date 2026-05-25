import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRbacGuard, DEFAULT_RBAC_POLICIES } from "../../claworks/robot-identity.js";
import type { ClaworksRuntime } from "../../claworks/runtime.js";
import { createIngressRouter } from "../../kernel/ingress.js";
import { createClaworksRestHandler } from "./router.js";

function buildMockRuntime(
  overrides: Partial<{ listDrafts: () => Promise<unknown[]> }> = {},
): ClaworksRuntime & { kernelPublish: ReturnType<typeof vi.fn> } {
  const publish = vi.fn().mockResolvedValue(["evolution_simulation_pipeline"]);
  const runtime = {
    config: { kernel: {}, api: {}, packs: {} },
    identity: {
      name: "mock",
      role: "monolith",
      domain: "test",
      description: "",
      rules: [],
      agentMd: "# mock",
    },
    robot: { name: "mock" },
    rbac: createRbacGuard([...DEFAULT_RBAC_POLICIES]),
    ingress: createIngressRouter(),
    kernel: {
      publish,
      bus: { query: vi.fn().mockResolvedValue([]), subscribe: () => () => {} },
    },
    capabilities: { list: () => [], get: () => undefined },
    connectorManager: { list: () => [], invoke: vi.fn() },
    loadedPacks: [],
    playbookEngine: {
      list: () => [],
      listRuns: vi.fn().mockResolvedValue([]),
      trigger: vi.fn(),
      getRun: vi.fn(),
      submitHitlDecision: vi.fn(),
    },
    objectStore: {
      query: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      executeAction: vi.fn(),
    },
    kb: { search: vi.fn(), ingest: vi.fn() },
    evolveEngine: {
      listDrafts:
        overrides.listDrafts ??
        vi.fn(async () => [
          {
            proposal_id: "evolved_1",
            title: "OEE 查询",
            status: "pending_review",
            created_at: "2026-05-25T00:00:00.000Z",
            updated_at: "2026-05-25T00:00:00.000Z",
          },
        ]),
    },
    contextEngine: { append: vi.fn() },
    logger: () => undefined,
    kernelPublish: publish,
  };
  return runtime as unknown as ClaworksRuntime & { kernelPublish: ReturnType<typeof vi.fn> };
}

async function withTestServer(
  runtime: ClaworksRuntime,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  let server: Server | null = null;
  try {
    const handler = createClaworksRestHandler(runtime);
    server = createServer(async (req, res) => {
      req.url = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      await handler(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      server!.listen(0, "127.0.0.1", (err) => (err ? reject(err) : resolve()));
    });
    const addr = server!.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    await fn(port);
  } finally {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
  }
}

describe("POST /v1/evolution/simulate", () => {
  it("returns 200 and publishes evolution.simulation_requested", async () => {
    const runtime = buildMockRuntime();
    await withTestServer(runtime, async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/evolution/simulate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload: { trigger: "test" } }),
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ status: "ok", message: "流水线已触发" });
      expect(runtime.kernelPublish).toHaveBeenCalledWith(
        "evolution.simulation_requested",
        "rest-api",
        { trigger: "test" },
        expect.objectContaining({ subjectType: "system", subjectId: "local" }),
      );
    });
  });
});

describe("GET /v1/evolve/drafts", () => {
  it("returns pending evolution drafts for ops review", async () => {
    const runtime = buildMockRuntime();
    await withTestServer(runtime, async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/evolve/drafts`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.status).toBe("ok");
      expect(body.count).toBe(1);
      expect(body.drafts[0].proposal_id).toBe("evolved_1");
    });
  });
});
