import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { runtimeRegistry } = vi.hoisted(() => ({
  runtimeRegistry: new Map<string, { runtime: unknown; healthy?: () => boolean }>(),
}));

vi.mock("../runtime-api.js", () => ({
  getAcpRuntimeBackend: (id: string) => runtimeRegistry.get(id),
  registerAcpRuntimeBackend: (entry: { id: string; runtime: unknown; healthy?: () => boolean }) => {
    runtimeRegistry.set(entry.id, entry);
  },
  unregisterAcpRuntimeBackend: (id: string) => {
    runtimeRegistry.delete(id);
  },
}));

import { getAcpRuntimeBackend } from "../runtime-api.js";
import { createFileSessionStore } from "./runtime.js";
import { createAcpxRuntimeService } from "./service.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acpx-service-"));
  tempDirs.push(dir);
  return dir;
}

async function writeLegacySessionFile(stateDir: string, sessionId: string): Promise<string> {
  const sessionDir = path.join(stateDir, "sessions");
  await fs.mkdir(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, `${encodeURIComponent(sessionId)}.json`);
  await fs.writeFile(
    filePath,
    `${JSON.stringify(
      {
        schema: "openclaw.acpx.session.v1",
        acpxRecordId: sessionId,
        acpSessionId: "acp-session-1",
        agentSessionId: "agent-session-1",
        agentCommand: "acpx agent",
        cwd: "/tmp/project",
        createdAt: "2026-04-05T08:00:00.000Z",
        lastUsedAt: "2026-04-05T08:01:00.000Z",
        lastSeq: 7,
        eventLog: {
          active_path: "/tmp/log",
          segment_count: 1,
          max_segment_bytes: 1024,
          max_segments: 4,
        },
        title: "Legacy Session",
        messages: ["Resume"],
        updated_at: "2026-04-05T08:01:00.000Z",
        cumulative_token_usage: {},
        request_token_usage: {},
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return filePath;
}

afterEach(async () => {
  runtimeRegistry.clear();
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function createServiceContext(workspaceDir: string) {
  return {
    workspaceDir,
    stateDir: path.join(workspaceDir, ".openclaw-plugin-state"),
    config: {},
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}

describe("createAcpxRuntimeService", () => {
  it("registers and unregisters the embedded backend", async () => {
    const workspaceDir = await makeTempDir();
    const ctx = createServiceContext(workspaceDir);
    const runtime = {
      ensureSession: vi.fn(),
      runTurn: vi.fn(),
      cancel: vi.fn(),
      close: vi.fn(),
      probeAvailability: vi.fn(async () => {}),
      isHealthy: vi.fn(() => true),
      doctor: vi.fn(async () => ({ ok: true, message: "ok" })),
    };
    const service = createAcpxRuntimeService({
      runtimeFactory: () => runtime as never,
    });

    await service.start(ctx);

    expect(getAcpRuntimeBackend("acpx")?.runtime).toBe(runtime);

    await service.stop?.(ctx);

    expect(getAcpRuntimeBackend("acpx")).toBeUndefined();
  });

  it("creates the embedded runtime state directory before probing", async () => {
    const workspaceDir = await makeTempDir();
    const stateDir = path.join(workspaceDir, "custom-state");
    const ctx = createServiceContext(workspaceDir);
    const probeAvailability = vi.fn(async () => {
      await fs.access(stateDir);
    });
    const service = createAcpxRuntimeService({
      pluginConfig: { stateDir },
      runtimeFactory: () =>
        ({
          ensureSession: vi.fn(),
          runTurn: vi.fn(),
          cancel: vi.fn(),
          close: vi.fn(),
          probeAvailability,
          isHealthy: () => true,
          doctor: async () => ({ ok: true, message: "ok" }),
        }) as never,
    });

    await service.start(ctx);

    expect(probeAvailability).toHaveBeenCalledOnce();

    await service.stop?.(ctx);
  });

  it("migrates legacy OpenClaw ACPX session files before creating the runtime", async () => {
    const workspaceDir = await makeTempDir();
    const stateDir = path.join(workspaceDir, "custom-state");
    const ctx = createServiceContext(workspaceDir);
    const sessionId = "legacy/session";
    const filePath = await writeLegacySessionFile(stateDir, sessionId);

    const service = createAcpxRuntimeService({
      pluginConfig: { stateDir },
      runtimeFactory: ({ pluginConfig }) => {
        const payload = JSON.parse(
          fsSync.readFileSync(
            path.join(pluginConfig.stateDir, "sessions", `${encodeURIComponent(sessionId)}.json`),
            "utf8",
          ),
        ) as Record<string, unknown>;
        expect(payload.schema).toBe("acpx.session.v1");
        expect(payload.acpx_record_id).toBe(sessionId);

        return {
          ensureSession: vi.fn(),
          runTurn: vi.fn(),
          cancel: vi.fn(),
          close: vi.fn(),
          probeAvailability: vi.fn(async () => {}),
          isHealthy: () => true,
          doctor: async () => ({ ok: true, message: "ok" }),
        } as never;
      },
    });

    await service.start(ctx);

    const store = createFileSessionStore({ stateDir });
    await expect(store.load(sessionId)).resolves.toMatchObject({
      acpxRecordId: sessionId,
      acpSessionId: "acp-session-1",
      agentSessionId: "agent-session-1",
      lastSeq: 7,
    });
    expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toMatchObject({
      schema: "acpx.session.v1",
      acpx_record_id: sessionId,
    });
    expect(ctx.logger.info).toHaveBeenCalledWith("migrated 1 legacy ACPX session file(s)");

    await service.stop?.(ctx);
  });
});
