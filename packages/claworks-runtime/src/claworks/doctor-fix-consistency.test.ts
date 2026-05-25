import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createClaworksRestHandler,
  createClaworksRuntime,
  startClaworksRuntime,
  stopClaworksRuntime,
} from "../index.js";
import { runClaworksDoctorFix } from "./doctor.js";
import { repairClaworksJsonConfig } from "./product-config-repair.js";

describe("doctor fix REST/CLI consistency", () => {
  let server: Server | null = null;
  let runtime: Awaited<ReturnType<typeof createClaworksRuntime>> | null = null;

  afterEach(async () => {
    if (runtime) {
      await stopClaworksRuntime(runtime);
      runtime = null;
    }
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it("runClaworksDoctorFix applies repairClaworksJsonConfig actions (CLI doctor --fix 同真源)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-doctor-fix-"));
    runtime = await createClaworksRuntime({
      data: { database_url: `sqlite://${join(dir, "cli.db")}` },
      packs: { installed: ["base"], paths: [] },
    });
    await startClaworksRuntime(runtime);

    const wrapped: Record<string, unknown> = {
      plugins: {
        allow: ["claworks-robot"],
        entries: {
          "claworks-robot": { enabled: true, config: structuredClone(runtime.config) },
        },
      },
    };
    const directRepair = repairClaworksJsonConfig(wrapped, {
      seedRobotMd: false,
      enableEchoConnector: true,
    });

    const fixResult = await runClaworksDoctorFix(runtime);
    for (const action of directRepair.actions) {
      expect(fixResult.applied).toContain(action);
    }
    expect(fixResult.repair.actions).toEqual(expect.arrayContaining(directRepair.actions));
  });

  it("POST /v1/doctor?fix=true returns checks and fix payload shape", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-doctor-rest-"));
    runtime = await createClaworksRuntime({
      robot: { name: "doctor-rest", role: "monolith" },
      data: { database_url: `sqlite://${join(dir, "rest.db")}` },
      packs: {
        paths: [join(process.cwd(), "../claworks-packs")],
        installed: ["base", "process-industry"],
      },
    });
    await startClaworksRuntime(runtime);

    const rest = createClaworksRestHandler(runtime);
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname.startsWith("/v1")) {
        req.url = url.pathname + url.search;
        if (await rest(req, res)) {
          return;
        }
      }
      res.statusCode = 404;
      res.end("{}");
    });

    await new Promise<void>((resolve, reject) => {
      server!.listen(0, "127.0.0.1", (err) => (err ? reject(err) : resolve()));
    });
    const addr = server!.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    const res = await fetch(`http://127.0.0.1:${port}/v1/doctor?fix=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      checks?: Array<{ id: string; status: string }>;
      fix?: {
        applied?: string[];
        warnings?: string[];
        repair?: { changed?: boolean; actions?: string[]; warnings?: string[] };
      };
    };

    expect(Array.isArray(body.checks)).toBe(true);
    expect(body.checks!.length).toBeGreaterThan(0);
    expect(body.fix).toBeDefined();
    expect(Array.isArray(body.fix!.applied)).toBe(true);
    expect(Array.isArray(body.fix!.warnings)).toBe(true);
    expect(body.fix!.repair).toMatchObject({
      changed: expect.any(Boolean),
      actions: expect.any(Array),
      warnings: expect.any(Array),
    });
  });
});
