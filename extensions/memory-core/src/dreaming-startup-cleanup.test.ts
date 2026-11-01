import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { getSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSqliteSessionTranscriptEventForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerShortTermPromotionDreaming } from "./dreaming.js";

const ORPHAN_AGE_MS = 300_000;

type GatewayHook = (event: unknown, context: unknown) => Promise<void> | void;

let stateDir: string;
let state: OpenClawTestState;
let stopGateway: (() => Promise<void>) | undefined;

beforeEach(async () => {
  state = await createOpenClawTestState({
    prefix: "openclaw-dreaming-startup-",
    layout: "state-only",
  });
  stateDir = state.stateDir;
  setRuntimeConfigSnapshot(createConfig());
});

afterEach(async () => {
  await stopGateway?.();
  stopGateway = undefined;
  vi.useRealTimers();
  await state.restoreEnv();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetPluginStateStoreForTests();
  await state.cleanup();
  clearRuntimeConfigSnapshot();
});

type GatewayOptions = { agentIds?: string[]; sessionStore?: string; cronEnabled?: boolean };

function createConfig(params: GatewayOptions = {}): OpenClawConfig {
  const agentIds = params.agentIds ?? ["main"];
  return {
    cron: { enabled: params.cronEnabled ?? true },
    agents: {
      entries: Object.fromEntries(
        agentIds.map((id) => [id, { workspace: path.join(stateDir, `workspace-${id}`) }]),
      ),
    },
    plugins: {
      entries: {
        "memory-core": { config: { dreaming: { enabled: true, frequency: "0 2 * * *" } } },
      },
    },
    ...(params.sessionStore ? { session: { store: params.sessionStore } } : {}),
  } as OpenClawConfig;
}

function createGateway(
  params: GatewayOptions = {},
  scheduler = createTestPluginServiceScheduler(),
) {
  const config = createConfig(params);
  setRuntimeConfigSnapshot(config);
  const onMock = vi.fn<OpenClawPluginApi["on"]>();
  const services: Parameters<OpenClawPluginApi["registerService"]>[0][] = [];
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const cron = {
    isEnabled: vi.fn(async () => params.cronEnabled ?? true),
    list: vi.fn(async () => []),
    add: vi.fn(async () => ({})),
    update: vi.fn(async () => ({})),
    remove: vi.fn(async () => ({ removed: false })),
    removeStaleJobFamily: vi.fn(async () => 0),
  };
  const api = createTestPluginApi({
    config,
    pluginConfig: {},
    logger,
    on: onMock,
    registerService: (service) => services.push(service),
  });
  const backgroundTasks: Promise<unknown>[] = [];
  api.lifecycle.runInBackgroundContext = (run) => {
    const task = run();
    if (task instanceof Promise) {
      backgroundTasks.push(task);
    }
    return task;
  };
  Object.assign(api.runtime, { config: { current: () => config } });
  registerShortTermPromotionDreaming(api);

  const service = services.find((entry) => entry.id === "memory-core-dreaming");
  if (!service) {
    throw new Error("memory-core-dreaming service missing");
  }
  const serviceContext = { config, stateDir, logger, getCron: () => cron, scheduler };
  const startService = async () => {
    await service.start(serviceContext);
  };
  const start = async () => {
    await startService();
    const hook = onMock.mock.calls.find(([name]) => name === "gateway_start")?.[1] as
      | GatewayHook
      | undefined;
    if (!hook) {
      throw new Error("gateway_start hook missing");
    }
    await hook({ port: 0 }, { config, getCron: () => cron });
    // Storage assertions observe finished maintenance, not just a completed start hook.
    await Promise.all(backgroundTasks);
  };
  const stop = async () => {
    scheduler.beginClose();
    try {
      await service.stop?.(serviceContext);
    } finally {
      await scheduler.stop();
    }
  };
  stopGateway = stop;
  return { config, cron, logger, start, startService, stop };
}

async function seedSession(params: {
  agentId?: string;
  suffix: string;
  updatedAt: number;
  transcriptAt?: number;
  pluginOwnerId?: string;
  storePath?: string;
}) {
  const agentId = params.agentId ?? "main";
  const sessionKey = `agent:${agentId}:${params.suffix}`;
  const sessionId = `${agentId}-${params.suffix}`;
  await upsertSessionEntry({
    agentId,
    sessionKey,
    ...(params.storePath ? { storePath: params.storePath } : {}),
    entry: {
      sessionId,
      updatedAt: params.updatedAt,
      ...(params.pluginOwnerId ? { pluginOwnerId: params.pluginOwnerId } : {}),
    },
  });
  if (params.transcriptAt !== undefined) {
    await appendSqliteSessionTranscriptEventForTest({
      agentId,
      sessionId,
      sessionKey,
      ...(params.storePath ? { storePath: params.storePath } : {}),
      event: {
        runId: `dreaming-narrative-${sessionId}`,
        timestamp: params.transcriptAt,
        type: "metadata",
      },
    });
  }
  return { agentId, sessionKey };
}

function hasSession(scope: { agentId: string; sessionKey: string }): boolean {
  return getSessionEntry(scope) !== undefined;
}

function seedRun(
  suffix: string,
  updatedAt = Date.now() - ORPHAN_AGE_MS - 1,
  transcript = true,
  options: Pick<Parameters<typeof seedSession>[0], "agentId" | "pluginOwnerId" | "storePath"> = {},
) {
  return seedSession({
    ...options,
    suffix: `dreaming-narrative-${suffix}`,
    updatedAt,
    ...(transcript ? { transcriptAt: updatedAt } : {}),
  });
}

describe("dreaming gateway restart cleanup", () => {
  it("does not create agent storage on a fresh gateway startup", async () => {
    const gateway = createGateway({ agentIds: ["main", "researcher"] });

    await gateway.start();

    await expect(fs.access(path.join(stateDir, "agents"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reclaims every stale dreaming phase without touching active, unrelated, or other-agent sessions", async () => {
    const now = Date.now();
    const stale = await Promise.all(
      ["light", "rem", "deep", "consolidation"].map((phase) =>
        seedRun(
          `${phase}-interrupted`,
          now - ORPHAN_AGE_MS - 1,
          true,
          phase === "rem" ? {} : { pluginOwnerId: "memory-core" },
        ),
      ),
    );
    const activeWithTranscript = await seedRun("light-active", now);
    const activeBeforeTranscript = await seedRun("rem-starting", now, false);
    const userSession = await seedSession({
      suffix: "telegram:group:dreaming-narrative-room",
      updatedAt: now - ORPHAN_AGE_MS - 1,
    });
    const foreignPluginSession = await seedRun("foreign", now - ORPHAN_AGE_MS - 1, true, {
      pluginOwnerId: "other-plugin",
    });
    const otherAgent = await seedRun("light-interrupted", now - ORPHAN_AGE_MS - 1, true, {
      agentId: "researcher",
    });
    const gateway = createGateway();

    await gateway.start();

    expect(stale.map(hasSession)).toEqual([false, false, false, false]);
    expect(
      [
        activeWithTranscript,
        activeBeforeTranscript,
        userSession,
        foreignPluginSession,
        otherAgent,
      ].map(hasSession),
    ).toEqual([true, true, true, true, true]);
  });

  it("does not reclaim post-startup runs when the deferred cleanup callback runs late", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-01T12:00:00.000Z") });
    const interruptedAtStartup = await seedRun("deep-interrupted", Date.now() - 1);
    const clock = createGatewaySchedulerClock(Date.now());
    const gateway = createGateway(
      {},
      createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock)),
    );

    await gateway.start();
    const postStartupUpdatedAt = Date.now();
    const activeWithTranscript = await seedRun("light-still-running", postStartupUpdatedAt);
    const activeWithoutTranscript = await seedRun("rem-still-running", postStartupUpdatedAt, false);

    // Wall-clock stalls can outlive agent.wait; that wait never cancels the agent run.
    vi.setSystemTime(Date.now() + ORPHAN_AGE_MS + 1);
    // Join the late scheduler wake before closing admission for service teardown.
    await clock.advanceTo(Date.now());
    await gateway.stop();

    expect(Date.now() - postStartupUpdatedAt).toBeGreaterThan(ORPHAN_AGE_MS);
    expect(hasSession(interruptedAtStartup)).toBe(false);
    expect([activeWithTranscript, activeWithoutTranscript].map(hasSession)).toEqual([true, true]);
    expect(gateway.logger.warn).not.toHaveBeenCalled();
    expect(gateway.logger.error).not.toHaveBeenCalled();
  });

  it("does not reclaim post-startup runs when cron startup reconciliation stalls", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-01T12:00:00.000Z") });
    const staleAtStartup = await seedRun("deep-interrupted", undefined, false);
    const postStartupSessions: Array<{ agentId: string; sessionKey: string }> = [];
    let postStartupUpdatedAt = 0;
    const gateway = createGateway();
    gateway.cron.list.mockImplementationOnce(async () => {
      await vi.advanceTimersByTimeAsync(1);
      postStartupUpdatedAt = Date.now();
      postStartupSessions.push(
        await seedRun("light-reconciliation-active", postStartupUpdatedAt),
        await seedRun("rem-reconciliation-active", postStartupUpdatedAt, false),
      );
      vi.setSystemTime(postStartupUpdatedAt + ORPHAN_AGE_MS + 1);
      return [];
    });

    await gateway.start();

    expect(Date.now() - postStartupUpdatedAt).toBeGreaterThan(ORPHAN_AGE_MS);
    expect(hasSession(staleAtStartup)).toBe(false);
    expect(postStartupSessions.map(hasSession)).toEqual([true, true]);
  });

  it("preserves unconfigured agents sharing a configured agent's SQLite store", async () => {
    const storePath = path.join(stateDir, "shared.sqlite");
    const staleUpdatedAt = Date.now() - ORPHAN_AGE_MS - 1;
    const main = await seedRun("main-interrupted", staleUpdatedAt, false, {
      agentId: "main",
      storePath,
    });
    const researcher = await seedRun("researcher-interrupted", staleUpdatedAt, false, {
      agentId: "researcher",
      storePath,
    });
    const gateway = createGateway({ sessionStore: storePath });

    await gateway.start();

    expect(getSessionEntry({ ...main, storePath })).toBeUndefined();
    expect(getSessionEntry({ ...researcher, storePath })).toMatchObject({
      sessionId: "researcher-dreaming-narrative-researcher-interrupted",
    });
  });

  it("does not repeat restart cleanup when the dreaming service is replaced", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-01T12:00:00.000Z") });
    const interrupted = await seedRun("light-interrupted", Date.now() - 1);
    const gateway = createGateway();

    await gateway.start();
    await vi.advanceTimersByTimeAsync(120_000);
    const currentRun = await seedRun("rem-current", Date.now());
    await gateway.stop();
    await vi.advanceTimersByTimeAsync(ORPHAN_AGE_MS + 1);
    const successor = createGateway();
    await successor.startService();
    await vi.advanceTimersByTimeAsync(ORPHAN_AGE_MS);
    await successor.stop();

    expect(hasSession(interrupted)).toBe(true);
    expect(hasSession(currentRun)).toBe(true);
  });

  it("cleans historical artifacts while automatic scheduling is disabled", async () => {
    const interrupted = await seedRun("light-interrupted");
    const gateway = createGateway({ cronEnabled: false });

    await gateway.start();

    expect(hasSession(interrupted)).toBe(false);
    expect(gateway.cron.add).not.toHaveBeenCalled();
    expect(gateway.logger.error).not.toHaveBeenCalled();
  });
});
