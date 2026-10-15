// Memory Core tests cover dreaming plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  MANAGED_MEMORY_DREAMING_CRON_NAME,
  MANAGED_MEMORY_DREAMING_CRON_TAG,
  MEMORY_DREAMING_SYSTEM_EVENT_TEXT,
} from "openclaw/plugin-sdk/memory-core-host-status";
import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { resetSystemEventsForTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerShortTermPromotionDreaming } from "./dreaming.js";
import { recordShortTermRecalls } from "./short-term-promotion.js";
import { createMemoryCoreTestHarness, shortTermTestState } from "./test-helpers.js";

const runDreamingSweepPhasesMock = vi.hoisted(() =>
  vi.fn<typeof import("./dreaming-phases.js").runDreamingSweepPhases>(async () => ({
    narratives: [],
    failed: false,
  })),
);
// mock-isolation: Scheduler tests isolate phase preparation; the real sweep has separate coverage.
vi.mock("./dreaming-phases.js", () => ({
  runDreamingSweepPhases: runDreamingSweepPhasesMock,
}));

const constants = {
  MANAGED_DREAMING_CRON_NAME: MANAGED_MEMORY_DREAMING_CRON_NAME,
  MANAGED_DREAMING_CRON_TAG: MANAGED_MEMORY_DREAMING_CRON_TAG,
  DREAMING_SYSTEM_EVENT_TEXT: MEMORY_DREAMING_SYSTEM_EVENT_TEXT,
  RUNTIME_CRON_RECONCILE_INTERVAL_MS: 60_000,
};
const { createTempWorkspace } = createMemoryCoreTestHarness();

const registeredServiceStops = new Set<() => Promise<void>>();

afterEach(async () => {
  const stops = [...registeredServiceStops];
  registeredServiceStops.clear();
  await Promise.all(stops.map((stop) => stop()));
  vi.useRealTimers();
  resetSystemEventsForTest();
});

type CronSchedule = { kind: "cron"; expr: string; tz?: string };
type CronPayload =
  | { kind: "systemEvent"; text: string }
  | { kind: "agentTurn"; message: string; lightContext?: boolean };
type CronAddInput = {
  declarationKey: string;
  name: string;
  description: string;
  enabled: boolean;
  schedule: CronSchedule;
  sessionTarget: "main" | "isolated";
  wakeMode: "now";
  payload: CronPayload;
  delivery?: { mode: "none" };
};
type CronPatch = Partial<CronAddInput>;
type CronJobLike = {
  id: string;
  declarationKey?: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  schedule?: { kind?: string; expr?: string; tz?: string };
  sessionTarget?: string;
  wakeMode?: string;
  payload?: { kind?: string; text?: string; message?: string; lightContext?: boolean };
  delivery?: { mode?: string };
  createdAtMs?: number;
};
type CronParam = {
  list: (opts?: { includeDisabled?: boolean }) => Promise<CronJobLike[]>;
  add: (input: CronAddInput) => Promise<unknown>;
  update: (id: string, patch: CronPatch) => Promise<unknown>;
  remove: (id: string) => Promise<{ removed?: boolean }>;
};
type CronHarnessOptions = {
  listThrowsForFirstCalls?: number;
};
type DreamingPluginApi = Parameters<typeof registerShortTermPromotionDreaming>[0];
type DreamingPluginApiTestDouble = DreamingPluginApi & {
  scheduler: ReturnType<typeof createTestPluginServiceScheduler>;
  logger: ReturnType<typeof createLogger>;
  on: ReturnType<typeof vi.fn>;
  registerService: ReturnType<typeof vi.fn<DreamingPluginApi["registerService"]>>;
};

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createCronHarness(initialJobs: CronJobLike[] = [], opts?: CronHarnessOptions) {
  const jobs: CronJobLike[] = [...initialJobs];
  let listCalls = 0;
  const addCalls: CronAddInput[] = [];
  const updateCalls: Array<{ id: string; patch: CronPatch }> = [];
  const removeCalls: string[] = [];
  const mutationCalls: string[] = [];

  const cron: CronParam = {
    async list() {
      listCalls += 1;
      if (opts?.listThrowsForFirstCalls && listCalls <= opts.listThrowsForFirstCalls) {
        throw new Error(`list failed on call ${listCalls}`);
      }
      return jobs.map((job) => ({
        ...job,
        ...(job.schedule ? { schedule: { ...job.schedule } } : {}),
        ...(job.payload ? { payload: { ...job.payload } } : {}),
        ...(job.delivery ? { delivery: { ...job.delivery } } : {}),
      }));
    },
    async add(input) {
      mutationCalls.push("add");
      addCalls.push(input);
      jobs.push({
        ...input,
        id: `job-${jobs.length + 1}`,
        schedule: { ...input.schedule },
        payload: { ...input.payload },
        ...(input.delivery ? { delivery: { ...input.delivery } } : {}),
        createdAtMs: Date.now(),
      });
      return {};
    },
    async update(id, patch) {
      mutationCalls.push(`update:${id}`);
      updateCalls.push({ id, patch });
      const index = jobs.findIndex((entry) => entry.id === id);
      if (index < 0) {
        return {};
      }
      const current = expectDefined(jobs[index], `managed cron job ${id}`);
      jobs[index] = {
        ...current,
        ...(patch.name ? { name: patch.name } : {}),
        ...(patch.description ? { description: patch.description } : {}),
        ...(typeof patch.enabled === "boolean" ? { enabled: patch.enabled } : {}),
        ...(patch.schedule ? { schedule: { ...patch.schedule } } : {}),
        ...(patch.sessionTarget ? { sessionTarget: patch.sessionTarget } : {}),
        ...(patch.wakeMode ? { wakeMode: patch.wakeMode } : {}),
        ...(patch.payload ? { payload: { ...patch.payload } } : {}),
        ...(patch.delivery ? { delivery: { ...patch.delivery } } : {}),
      };
      return {};
    },
    async remove(id) {
      mutationCalls.push(`remove:${id}`);
      removeCalls.push(id);
      const index = jobs.findIndex((entry) => entry.id === id);
      if (index >= 0) {
        jobs.splice(index, 1);
      }
      return { removed: index >= 0 };
    },
  };

  return {
    cron,
    jobs,
    addCalls,
    updateCalls,
    removeCalls,
    mutationCalls,
    get listCalls() {
      return listCalls;
    },
  };
}

function createDreamingConfig(
  dreaming: Record<string, unknown> = {
    enabled: true,
    frequency: "15 4 * * *",
    timezone: "UTC",
  },
  config: Partial<OpenClawConfig> = {},
): OpenClawConfig {
  return {
    ...config,
    plugins: {
      entries: {
        "memory-core": { config: { dreaming } },
      },
    },
  } as OpenClawConfig;
}

function createDreamingTestContext(
  params: {
    config?: OpenClawConfig;
    runtime?: { config?: Pick<DreamingPluginApi["runtime"]["config"], "current"> };
    initialJobs?: CronJobLike[];
    cronOptions?: CronHarnessOptions;
  } = {},
) {
  const logger = createLogger();
  const harness = createCronHarness(params.initialJobs, params.cronOptions);
  const api: DreamingPluginApiTestDouble = {
    ...createTestPluginApi({
      config: params.config ?? createDreamingConfig(),
      pluginConfig: {},
      logger,
    }),
    logger,
    on: vi.fn<DreamingPluginApi["on"]>(),
    scheduler: createTestPluginServiceScheduler(),
    registerService: vi.fn<DreamingPluginApi["registerService"]>(),
  };
  Object.assign(api.runtime, { agent: createPluginRuntimeMock().agent }, params.runtime);
  return { api, harness, logger };
}

function mockStringMessages(mock: { mock: { calls: unknown[][] } }): string[] {
  return mock.mock.calls.map(([message]) => (typeof message === "string" ? message : ""));
}

function expectLogContains(mock: { mock: { calls: unknown[][] } }, expected: string): void {
  expect(mockStringMessages(mock).join("\n")).toContain(expected);
}

function requireAddCall(harness: { addCalls: CronAddInput[] }, index: number): CronAddInput {
  return expectDefined(harness.addCalls[index], `expected cron add call ${index}`);
}

function requireAgentTurnPayload(
  payload: CronAddInput["payload"],
): Extract<CronAddInput["payload"], { kind: "agentTurn" }> {
  if (payload.kind !== "agentTurn") {
    throw new Error(`expected agentTurn payload, got ${payload.kind}`);
  }
  return payload;
}

function expectCronSchedule(
  schedule: CronAddInput["schedule"] | CronPatch["schedule"] | undefined,
  expr: string,
  tz?: string,
): void {
  expect(schedule?.kind).toBe("cron");
  expect(schedule?.expr).toBe(expr);
  expect(schedule?.tz).toBe(tz);
}

function getBeforeAgentReplyHandler(onMock: ReturnType<typeof vi.fn>) {
  const call = expectDefined(
    onMock.mock.calls.find(([eventName]) => eventName === "before_agent_reply"),
    "before_agent_reply hook was not registered",
  );
  return call[1] as (
    event: { cleanedBody: string },
    ctx: {
      agentId?: string;
      trigger?: string;
      workspaceDir?: string;
      sessionKey?: string;
      heartbeatEventQueueSessionKey?: string;
    },
  ) => Promise<unknown>;
}

function getDreamingService(api: DreamingPluginApiTestDouble) {
  return expectDefined(
    api.registerService.mock.calls.find(([service]) => service.id === "memory-core-dreaming"),
    "memory-core-dreaming service registration",
  )[0];
}

async function triggerDreamingServiceStart(
  api: DreamingPluginApiTestDouble,
  ctx: { config: OpenClawConfig; workspaceDir?: string; getCron?: () => unknown },
): Promise<void> {
  const context = {
    ...ctx,
    stateDir: ".",
    logger: api.logger,
  } as OpenClawPluginServiceContext;
  await getDreamingService(api).start({ ...context, scheduler: api.scheduler });
}

async function triggerDreamingServiceStop(api: DreamingPluginApiTestDouble): Promise<void> {
  api.scheduler.beginClose();
  try {
    await getDreamingService(api).stop?.({
      config: api.config,
      stateDir: ".",
      logger: api.logger,
      scheduler: api.scheduler,
    });
  } finally {
    await api.scheduler.stop();
  }
}

function registerShortTermPromotionDreamingForTest(api: DreamingPluginApiTestDouble): void {
  registerShortTermPromotionDreaming(api);
  registeredServiceStops.add(() => triggerDreamingServiceStop(api));
}

describe("dreaming service reconciliation", () => {
  it("drains pending reconciliation on service stop without arming runtime recovery", async () => {
    vi.useFakeTimers();
    let rejectStartupList: (reason?: unknown) => void = () => undefined;
    const startupListPromise = new Promise<CronJobLike[]>((_resolve, reject) => {
      rejectStartupList = reject;
    });
    let listCalls = 0;
    const addCalls: CronAddInput[] = [];
    const cron: CronParam = {
      async list() {
        listCalls += 1;
        if (listCalls === 1) {
          return startupListPromise;
        }
        return [];
      },
      async add(input) {
        addCalls.push(input);
        return {};
      },
      async update() {
        return {};
      },
      async remove() {
        return { removed: false };
      },
    };
    const { api, logger } = createDreamingTestContext();

    try {
      registerShortTermPromotionDreamingForTest(api);
      const startup = triggerDreamingServiceStart(api, {
        config: api.config,
        getCron: () => cron,
      });

      let stopped = false;
      const stopping = triggerDreamingServiceStop(api).then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(false);
      rejectStartupList(new Error("startup list failed"));
      await Promise.all([startup, stopping]);
      await vi.advanceTimersByTimeAsync(constants.RUNTIME_CRON_RECONCILE_INTERVAL_MS);

      expect(listCalls).toBe(1);
      expect(addCalls).toHaveLength(0);
      expectLogContains(logger.error, "dreaming startup reconciliation failed");
    } finally {
      rejectStartupList(new Error("test cleanup"));
      await triggerDreamingServiceStop(api).catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("updates the existing job on service replacement and stops the old reconciliation timer", async () => {
    vi.useFakeTimers();
    const { api, harness } = createDreamingTestContext({
      config: createDreamingConfig({ enabled: true, frequency: "0 1 * * *", timezone: "UTC" }),
    });
    const { api: successorApi } = createDreamingTestContext({
      config: createDreamingConfig({
        enabled: true,
        frequency: "45 8 * * *",
        timezone: "America/Los_Angeles",
      }),
    });

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerDreamingServiceStart(api, { config: api.config, getCron: () => harness.cron });
      const originalId = expectDefined(harness.jobs[0], "original dreaming job").id;

      await vi.advanceTimersByTimeAsync(constants.RUNTIME_CRON_RECONCILE_INTERVAL_MS / 2);
      await triggerDreamingServiceStop(api);
      registerShortTermPromotionDreamingForTest(successorApi);
      await triggerDreamingServiceStart(successorApi, {
        config: successorApi.config,
        getCron: () => harness.cron,
      });

      expect(harness.addCalls).toHaveLength(1);
      expect(harness.updateCalls).toEqual([
        {
          id: originalId,
          patch: {
            schedule: { kind: "cron", expr: "45 8 * * *", tz: "America/Los_Angeles" },
          },
        },
      ]);
      await vi.advanceTimersByTimeAsync(constants.RUNTIME_CRON_RECONCILE_INTERVAL_MS * 2);

      expect(harness.listCalls).toBe(4);
      expect(harness.updateCalls).toHaveLength(1);
      expect(harness.jobs).toHaveLength(1);
      expect(harness.jobs[0]).toMatchObject({
        id: originalId,
        schedule: { kind: "cron", expr: "45 8 * * *", tz: "America/Los_Angeles" },
      });

      await triggerDreamingServiceStop(successorApi);
      await vi.advanceTimersByTimeAsync(constants.RUNTIME_CRON_RECONCILE_INTERVAL_MS);
      expect(harness.listCalls).toBe(4);
    } finally {
      await triggerDreamingServiceStop(api);
      await triggerDreamingServiceStop(successorApi);
      vi.useRealTimers();
    }
  });

  it.each([true])(
    "requests Doctor without changing legacy jobs when dreaming enabled=%s",
    async (enabled) => {
      vi.useFakeTimers();
      const legacyJobs: CronJobLike[] = [
        {
          id: "legacy-tagged",
          name: constants.MANAGED_DREAMING_CRON_NAME,
          description: `${constants.MANAGED_DREAMING_CRON_TAG} legacy job`,
          payload: { kind: "agentTurn", message: "authored payload" },
        },
        {
          id: "legacy-agent-turn",
          name: constants.MANAGED_DREAMING_CRON_NAME,
          payload: { kind: "agentTurn", message: constants.DREAMING_SYSTEM_EVENT_TEXT },
        },
        {
          id: "legacy-system-event",
          name: constants.MANAGED_DREAMING_CRON_NAME,
          payload: { kind: "systemEvent", text: constants.DREAMING_SYSTEM_EVENT_TEXT },
        },
        {
          id: "legacy-light-tagged",
          name: "Renamed light job",
          description: "[managed-by=memory-core.dreaming.light]",
        },
        {
          id: "legacy-rem-tagged",
          name: "Renamed REM job",
          description: "[managed-by=memory-core.dreaming.rem]",
        },
        {
          id: "legacy-light-event",
          name: "Memory Light Dreaming",
          payload: { kind: "systemEvent", text: "__openclaw_memory_core_light_sleep__" },
        },
        {
          id: "legacy-rem-event",
          name: "Memory REM Dreaming",
          payload: { kind: "systemEvent", text: "__openclaw_memory_core_rem_sleep__" },
        },
        {
          id: "operator-job",
          name: constants.MANAGED_DREAMING_CRON_NAME,
          payload: { kind: "agentTurn", message: "authored payload" },
        },
        {
          id: "other-declaration",
          declarationKey: "other-plugin:dreaming",
          name: constants.MANAGED_DREAMING_CRON_NAME,
          description: constants.MANAGED_DREAMING_CRON_TAG,
        },
      ].map((job) =>
        Object.assign(
          {
            enabled: true,
            schedule: { kind: "cron", expr: "0 3 * * *" },
            sessionTarget: "main",
            wakeMode: "next-heartbeat",
            payload: { kind: "systemEvent", text: "authored payload" },
            createdAtMs: 10,
          },
          job,
        ),
      );
      const before = structuredClone(legacyJobs);
      const { api, harness, logger } = createDreamingTestContext({
        config: createDreamingConfig({ enabled, frequency: "*/3 * * * *" }),
        initialJobs: legacyJobs,
      });
      const removeStaleJobFamily = vi.fn(async () => 0);
      const cron = { ...harness.cron, removeStaleJobFamily };

      registerShortTermPromotionDreamingForTest(api);
      await triggerDreamingServiceStart(api, { config: api.config, getCron: () => cron });
      await vi.advanceTimersByTimeAsync(constants.RUNTIME_CRON_RECONCILE_INTERVAL_MS);

      expect(harness.listCalls).toBe(2);
      expect(harness.jobs).toEqual(before);
      expect(harness.mutationCalls).toEqual([]);
      expect(removeStaleJobFamily).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expectLogContains(logger.warn, "openclaw doctor --fix");
    },
  );

  it.each([false, true])("defers declared jobs only when legacy=%s", async (hasLegacy) => {
    const seeded = (id: string, createdAtMs: number, expr: string): CronJobLike => ({
      id,
      declarationKey: "memory-core:memory-dreaming-promotion",
      name: constants.MANAGED_DREAMING_CRON_NAME,
      description: `${constants.MANAGED_DREAMING_CRON_TAG} declared dreaming job`,
      enabled: true,
      schedule: { kind: "cron", expr },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: constants.DREAMING_SYSTEM_EVENT_TEXT },
      delivery: { mode: "none" },
      createdAtMs,
    });
    const legacyJob = seeded("legacy-job", 5, "0 3 * * *");
    delete legacyJob.declarationKey;
    const { api, harness, logger } = createDreamingTestContext({
      config: createDreamingConfig({ enabled: true, frequency: "*/3 * * * *" }),
      initialJobs: [
        ...(hasLegacy ? [legacyJob] : []),
        seeded("job-oldest", 10, "0 3 * * *"),
        seeded("job-duplicate", 20, "*/5 * * * *"),
      ],
    });
    const before = structuredClone(harness.jobs);

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerDreamingServiceStart(api, { config: api.config, getCron: () => harness.cron });

      expect(harness.addCalls).toHaveLength(0);
      if (hasLegacy) {
        expect(harness.jobs).toEqual(before);
        expect(harness.mutationCalls).toEqual([]);
        expectLogContains(logger.warn, "openclaw doctor --fix");
        return;
      }
      expect(harness.removeCalls).toEqual(["job-duplicate"]);
      expect(harness.updateCalls).toHaveLength(1);
      expect(harness.updateCalls[0]?.id).toBe("job-oldest");
      expectCronSchedule(harness.updateCalls[0]?.patch.schedule, "*/3 * * * *");
      expect(harness.jobs).toHaveLength(1);
      expect(harness.jobs[0]).toMatchObject({
        id: "job-oldest",
        declarationKey: "memory-core:memory-dreaming-promotion",
      });
      expect(logger.warn).not.toHaveBeenCalled();
    } finally {
      await triggerDreamingServiceStop(api).catch(() => undefined);
    }
  });

  it("keeps scheduler maintenance out of user, heartbeat, and cron reply hooks", async () => {
    const { api, harness } = createDreamingTestContext({
      config: createDreamingConfig({ enabled: true, frequency: "0 2 * * *", timezone: "UTC" }),
    });

    registerShortTermPromotionDreamingForTest(api);
    await triggerDreamingServiceStart(api, {
      config: api.config,
      getCron: () => harness.cron,
    });

    expect(harness.listCalls).toBe(1);

    const beforeAgentReply = getBeforeAgentReplyHandler(api.on);
    await beforeAgentReply({ cleanedBody: "hello" }, { trigger: "user", workspaceDir: "." });
    await beforeAgentReply({ cleanedBody: "" }, { trigger: "heartbeat", workspaceDir: "." });
    await beforeAgentReply({ cleanedBody: "" }, { trigger: "cron", workspaceDir: "." });

    expect(harness.listCalls).toBe(1);
  });

  it("only triggers managed dreaming when the queued cron event is still pending", async () => {
    const { api, harness } = createDreamingTestContext({
      config: createDreamingConfig({ enabled: true, phases: { deep: { limit: 0 } } }),
    });

    registerShortTermPromotionDreamingForTest(api);
    await triggerDreamingServiceStart(api, {
      config: api.config,
      getCron: () => harness.cron,
    });

    const sessionKey = "agent:main:main";
    enqueueSystemEvent(constants.DREAMING_SYSTEM_EVENT_TEXT, {
      sessionKey,
      contextKey: "cron:memory-dreaming",
    });

    const beforeAgentReply = getBeforeAgentReplyHandler(api.on);
    const first = await beforeAgentReply(
      { cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT },
      { trigger: "heartbeat", workspaceDir: ".", sessionKey },
    );

    expect(first).toEqual({
      handled: true,
      reason: "memory-core: short-term dreaming disabled by limit",
    });

    resetSystemEventsForTest();

    const second = await beforeAgentReply(
      { cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT },
      { trigger: "heartbeat", workspaceDir: ".", sessionKey },
    );

    expect(second).toBeUndefined();
  });

  it("resolves queued managed dreaming cron events from the base session for isolated heartbeats", async () => {
    const { api, harness } = createDreamingTestContext({
      config: createDreamingConfig({ enabled: true, phases: { deep: { limit: 0 } } }),
    });

    registerShortTermPromotionDreamingForTest(api);
    await triggerDreamingServiceStart(api, {
      config: api.config,
      getCron: () => harness.cron,
    });

    enqueueSystemEvent(constants.DREAMING_SYSTEM_EVENT_TEXT, {
      sessionKey: "agent:main:main",
      contextKey: "cron:memory-dreaming",
    });

    const beforeAgentReply = getBeforeAgentReplyHandler(api.on);
    const result = await beforeAgentReply(
      { cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT },
      {
        trigger: "heartbeat",
        workspaceDir: ".",
        sessionKey: "agent:main:main:heartbeat",
        heartbeatEventQueueSessionKey: "agent:main:main",
      },
    );

    expect(result).toEqual({
      handled: true,
      reason: "memory-core: short-term dreaming disabled by limit",
    });
  });

  it("does not start background reconciliation in a host without Gateway cron access", async () => {
    vi.useFakeTimers();
    const { api, harness, logger } = createDreamingTestContext();

    try {
      registerShortTermPromotionDreamingForTest(api);
      await triggerDreamingServiceStart(api, { config: api.config });
      await vi.advanceTimersByTimeAsync(constants.RUNTIME_CRON_RECONCILE_INTERVAL_MS * 2);

      expect(harness.listCalls).toBe(0);
      expect(logger.debug).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await triggerDreamingServiceStop(api);
      vi.useRealTimers();
    }
  });

  it("recovers unavailable cron on the regular interval without a heartbeat or repeated warnings", async () => {
    vi.useFakeTimers();
    const { api, harness, logger } = createDreamingTestContext();

    try {
      registerShortTermPromotionDreamingForTest(api);
      let cronAvailable = false;
      await triggerDreamingServiceStart(api, {
        config: api.config,
        getCron: () => (cronAvailable ? harness.cron : undefined),
      });

      expect(harness.addCalls).toHaveLength(0);
      expectLogContains(logger.debug, "cron service not yet available at service start");

      await vi.advanceTimersByTimeAsync(constants.RUNTIME_CRON_RECONCILE_INTERVAL_MS);
      expect(harness.addCalls).toHaveLength(0);
      expectLogContains(logger.warn, "cron service unavailable");
      await vi.advanceTimersByTimeAsync(constants.RUNTIME_CRON_RECONCILE_INTERVAL_MS);
      expect(logger.warn).toHaveBeenCalledTimes(1);

      cronAvailable = true;
      await vi.advanceTimersByTimeAsync(constants.RUNTIME_CRON_RECONCILE_INTERVAL_MS);

      expect(harness.addCalls).toHaveLength(1);
      const addCall = requireAddCall(harness, 0);
      expect(addCall.name).toBe("Memory Dreaming Promotion");
      expectCronSchedule(addCall.schedule, "15 4 * * *", "UTC");
      expect(addCall.sessionTarget).toBe("isolated");
      const payload = requireAgentTurnPayload(addCall.payload);
      expect(payload.message).toBe(constants.DREAMING_SYSTEM_EVENT_TEXT);
      expect(payload.lightContext).toBe(true);
    } finally {
      await triggerDreamingServiceStop(api);
      vi.useRealTimers();
    }
  });

  it("removes only declared dreaming jobs when disabled cron reconciliation becomes available", async () => {
    vi.useFakeTimers();
    const managedJob: CronJobLike = {
      id: "job-managed",
      declarationKey: "memory-core:memory-dreaming-promotion",
      name: "Historical Dreaming Promotion Name",
      description: `${constants.MANAGED_DREAMING_CRON_TAG} test`,
      enabled: true,
      schedule: { kind: "cron", expr: "0 3 * * *" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: constants.DREAMING_SYSTEM_EVENT_TEXT },
      createdAtMs: 10,
    };
    const legacyJob: CronJobLike = {
      ...managedJob,
      id: "job-legacy",
      declarationKey: undefined,
      name: constants.MANAGED_DREAMING_CRON_NAME,
    };
    const { api, harness, logger } = createDreamingTestContext({
      config: createDreamingConfig({
        enabled: false,
        frequency: "15 4 * * *",
        timezone: "UTC",
      }),
      initialJobs: [legacyJob, managedJob],
    });

    try {
      registerShortTermPromotionDreamingForTest(api);
      let cronAvailable = false;
      await triggerDreamingServiceStart(api, {
        config: api.config,
        getCron: () => (cronAvailable ? harness.cron : undefined),
      });

      await vi.advanceTimersByTimeAsync(constants.RUNTIME_CRON_RECONCILE_INTERVAL_MS);
      expect(harness.removeCalls).toHaveLength(0);

      cronAvailable = true;
      await vi.advanceTimersByTimeAsync(constants.RUNTIME_CRON_RECONCILE_INTERVAL_MS);

      expect(harness.removeCalls).toEqual(["job-managed"]);
      expect(harness.jobs).toEqual([legacyJob]);
      expect(harness.addCalls).toHaveLength(0);
      expectLogContains(logger.info, "removed 1 managed dreaming cron job");
      expectLogContains(logger.warn, "openclaw doctor --fix");
    } finally {
      await triggerDreamingServiceStop(api);
      vi.useRealTimers();
    }
  });

  it("does not recreate startup cron from stale enabled config after runtime config disables dreaming", async () => {
    vi.useFakeTimers();
    const { api, harness, logger } = createDreamingTestContext({
      cronOptions: { listThrowsForFirstCalls: 1 },
    });

    try {
      registerShortTermPromotionDreamingForTest(api);
      let cronAvailable = false;
      await triggerDreamingServiceStart(api, {
        config: api.config,
        getCron: () => (cronAvailable ? harness.cron : undefined),
      });

      api.config = createDreamingConfig({
        enabled: false,
        frequency: "15 4 * * *",
        timezone: "UTC",
      });
      cronAvailable = true;

      await vi.advanceTimersByTimeAsync(constants.RUNTIME_CRON_RECONCILE_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(constants.RUNTIME_CRON_RECONCILE_INTERVAL_MS);

      expectLogContains(logger.error, "dreaming cron reconcile failed");
      expect(harness.listCalls).toBe(2);
      expect(harness.addCalls).toHaveLength(0);
    } finally {
      await triggerDreamingServiceStop(api);
      vi.useRealTimers();
    }
  });

  it("uses the product default instead of startup plugin config when live config is removed", async () => {
    const workspaceDir = await createTempWorkspace("memory-dreaming-default-on-live-config-");
    const runtimeCurrentConfig = vi.fn(
      () =>
        ({
          agents: {
            defaults: { workspace: workspaceDir },
            entries: { main: { workspace: workspaceDir } },
          },
        }) as OpenClawConfig,
    );
    const { api, harness } = createDreamingTestContext({
      runtime: { config: { current: runtimeCurrentConfig } },
    });

    registerShortTermPromotionDreamingForTest(api);
    await triggerDreamingServiceStart(api, {
      config: api.config,
      getCron: () => harness.cron,
    });

    const sessionKey = "agent:main:main";
    enqueueSystemEvent(constants.DREAMING_SYSTEM_EVENT_TEXT, {
      sessionKey,
      contextKey: "cron:memory-dreaming",
    });

    const beforeAgentReply = getBeforeAgentReplyHandler(api.on);
    const result = await beforeAgentReply(
      { cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT },
      { trigger: "heartbeat", workspaceDir, sessionKey },
    );

    expect(runtimeCurrentConfig).toHaveBeenCalled();
    expect(result).toEqual({
      handled: true,
      reason: "memory-core: short-term dreaming processed",
    });
  });

  // Regression: the sweep dropped the agent id entirely, so narrative subagent sessions used
  // unscoped keys that no per-agent SQLite store could resolve and every phase failed.
  it("sweeps each workspace as its owning agent rather than the roster default", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-owner-");
    runDreamingSweepPhasesMock.mockClear();
    const { api, harness } = createDreamingTestContext({
      config: createDreamingConfig(
        {
          enabled: true,
          limit: 5,
          phases: { light: { enabled: false }, rem: { enabled: false } },
        },
        { agents: { defaults: { workspace: workspaceDir } } },
      ),
    });

    registerShortTermPromotionDreamingForTest(api);
    await triggerDreamingServiceStart(api, {
      config: api.config,
      getCron: () => harness.cron,
    });

    const beforeAgentReply = getBeforeAgentReplyHandler(api.on);
    await beforeAgentReply(
      { cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT },
      {
        trigger: "cron",
        agentId: "researcher",
        workspaceDir,
        sessionKey: "agent:researcher:cron:memory-dreaming",
      },
    );

    expect(runDreamingSweepPhasesMock).toHaveBeenCalledTimes(1);
    const sweepArgs = expectDefined(
      runDreamingSweepPhasesMock.mock.calls[0],
      "dreaming sweep call",
    )[0];
    expect(sweepArgs.agentId).toBe("researcher");
    expect(sweepArgs.workspaceDir).toBe(workspaceDir);
  });

  it.each([{ label: "mixed outcomes", rejected: 1, promoted: 1 }])(
    "reports bounded rejection counts through the cron hook: $label",
    async ({ rejected, promoted }) => {
      const workspaceDir = await createTempWorkspace("openclaw-dreaming-rejections-");
      const nowMs = Date.now();
      const sourcePath = `memory/.dreams/session-corpus/${new Date(nowMs).toISOString().slice(0, 10)}.txt`;
      const snippets = Array.from(
        { length: rejected + promoted },
        (_, index) => `Private project detail number ${index}: keep the release checklist current.`,
      );
      await fs.mkdir(path.dirname(path.join(workspaceDir, sourcePath)), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, sourcePath), snippets.join("\n"));
      const originalMemory = "# Long-Term Memory\n\nKeep this existing preference.\n";
      await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), originalMemory);
      await recordShortTermRecalls({
        workspaceDir,
        query: "private synthetic query",
        nowMs,
        results: snippets.map((snippet, index) => ({
          path: sourcePath,
          source: "memory",
          startLine: index + 1,
          endLine: index + 1,
          score: 0.95,
          snippet,
          provenance: {
            originClass: "agent",
            sessionKind: index >= rejected ? "interactive" : "cron",
            observedAt: nowMs,
          },
        })),
      });
      const store = await shortTermTestState.readRecallStore(
        workspaceDir,
        new Date(nowMs).toISOString(),
      );
      expect(Object.keys(store.entries)).toHaveLength(rejected + promoted);
      const { api, harness, logger } = createDreamingTestContext({
        config: createDreamingConfig(
          {
            enabled: true,
            timezone: "UTC",
            phases: {
              light: { enabled: false },
              rem: { enabled: false },
              deep: { limit: 50, minScore: 0, minRecallCount: 0, minUniqueQueries: 0 },
            },
          },
          { agents: { defaults: { workspace: workspaceDir } } },
        ),
      });
      registerShortTermPromotionDreamingForTest(api);
      await triggerDreamingServiceStart(api, { config: api.config, getCron: () => harness.cron });
      const payload = requireAgentTurnPayload(requireAddCall(harness, 0).payload);
      await getBeforeAgentReplyHandler(api.on)(
        { cleanedBody: payload.message },
        { trigger: "cron", agentId: "main", workspaceDir },
      );
      expect(logger.error).not.toHaveBeenCalled();
      const reportDir = path.join(workspaceDir, "memory", "dreaming", "deep");
      const reports = await fs.readdir(reportDir);
      expect(reports).toHaveLength(1);
      const report = await fs.readFile(
        path.join(reportDir, expectDefined(reports[0], "deep report filename")),
        "utf-8",
      );
      expect(report).toContain(
        `- Ranked ${rejected + promoted} candidate(s) for durable promotion.`,
      );
      expect(report).toContain(`- Promoted ${promoted} candidate(s) into MEMORY.md.`);
      expect(report).toContain(
        `- Not promoted: ${rejected} candidate(s) (consolidation origin/session: ${rejected}).`,
      );
      expect(report.split("\n").filter((line) => line.startsWith("- Not promoted:"))).toHaveLength(
        1,
      );
      expect(report.length).toBeLessThan(400);
      for (const privateValue of [...snippets, sourcePath, ...Object.keys(store.entries)]) {
        expect(report).not.toContain(privateValue);
      }
      expect(report).not.toMatch(/score=|threshold|sessionKind|originClass/);
      const memory = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
      expect(memory).toContain(expectDefined(snippets[rejected], "promoted snippet"));
      for (const snippet of snippets.slice(0, rejected)) {
        expect(memory).not.toContain(snippet);
      }
    },
  );

  it.each([
    {
      label: "rewrite without removals",
      counts: [0, 0, 0],
      rewrite: true,
      stale: false,
      changed: true,
      expected: "rewrote recall store",
    },
    {
      label: "all counts and lock",
      counts: [2, 3, 4],
      rewrite: true,
      stale: true,
      changed: true,
      expected:
        "rewrote recall store (-2 invalid, -3 dangling, -4 overflow), removed stale promotion lock",
    },
  ] as const)(
    "formats recall repair log and report: $label",
    async ({ counts, rewrite, stale, changed, expected }) => {
      const workspaceDir = await createTempWorkspace("openclaw-dreaming-repair-summary-");
      const producer = await import("./short-term-promotion-artifacts.js");
      const repairSpy = vi.spyOn(producer, "repairShortTermPromotionArtifacts").mockResolvedValue({
        changed,
        removedInvalidEntries: counts[0],
        removedDanglingEntries: counts[1],
        removedOverflowEntries: counts[2],
        rewroteStore: rewrite,
        removedStaleLock: stale,
      });
      try {
        const { api, harness, logger } = createDreamingTestContext({
          config: createDreamingConfig(
            {
              enabled: true,
              limit: 5,
              phases: { light: { enabled: false }, rem: { enabled: false } },
            },
            { agents: { defaults: { workspace: workspaceDir } } },
          ),
        });
        registerShortTermPromotionDreamingForTest(api);
        await triggerDreamingServiceStart(api, { config: api.config, getCron: () => harness.cron });
        await getBeforeAgentReplyHandler(api.on)(
          { cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT },
          { trigger: "cron", agentId: "main", workspaceDir },
        );
        expect(logger.error).not.toHaveBeenCalled();
        const summaryLines = mockStringMessages(logger.info).filter((line) =>
          line.startsWith("memory-core: normalized recall artifacts before dreaming"),
        );
        const reportDir = path.join(workspaceDir, "memory", "dreaming", "deep");
        expect(summaryLines).toEqual([
          `memory-core: normalized recall artifacts before dreaming (${expected}) [workspace=${workspaceDir}].`,
        ]);
        const reports = await fs.readdir(reportDir);
        expect(reports).toHaveLength(1);
        const report = await fs.readFile(
          path.join(reportDir, expectDefined(reports[0], "deep report filename")),
          "utf-8",
        );
        expect(
          report.split("\n").filter((line) => line.startsWith("- Repaired recall artifacts:")),
        ).toEqual([`- Repaired recall artifacts: ${expected}.`]);
      } finally {
        repairSpy.mockRestore();
      }
    },
  );

  it("does not create memory/ or DREAMS.md on an empty workspace sweep", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-empty-sweep-");
    const { api, harness } = createDreamingTestContext({
      config: createDreamingConfig(
        {
          enabled: true,
          limit: 5,
          phases: { light: { enabled: false }, rem: { enabled: false } },
        },
        { agents: { defaults: { workspace: workspaceDir } } },
      ),
    });

    registerShortTermPromotionDreamingForTest(api);
    await triggerDreamingServiceStart(api, { config: api.config, getCron: () => harness.cron });

    await getBeforeAgentReplyHandler(api.on)(
      { cleanedBody: constants.DREAMING_SYSTEM_EVENT_TEXT },
      { trigger: "cron", agentId: "main", workspaceDir },
    );

    await expect(fs.access(path.join(workspaceDir, "memory"))).rejects.toThrow();
    await expect(fs.access(path.join(workspaceDir, "DREAMS.md"))).rejects.toThrow();
  });
});
