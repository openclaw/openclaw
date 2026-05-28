import {
  MANAGED_MEMORY_AUDIT_DAILY_CRON_NAME,
  type MemoryAuditConfig,
} from "openclaw/plugin-sdk/memory-core-host-status";
import { describe, expect, it, vi } from "vitest";
import {
  createMemoryAuditCronReconciler,
  reconcileMemoryAuditCronJobs,
} from "./memory-audit-cron.js";

type CronJob = Parameters<
  NonNullable<Parameters<typeof reconcileMemoryAuditCronJobs>[0]["cron"]>["update"]
>[1] & {
  id: string;
};

function config(overrides: Partial<MemoryAuditConfig> = {}): MemoryAuditConfig {
  return {
    enabled: true,
    agentId: "hex",
    sessionTarget: "session:memory-audit",
    model: "gpt-5.5",
    daily: { enabled: true, cron: "10 6 * * *" },
    weekly: { enabled: false, cron: "0 21 * * 0" },
    delivery: { mode: "none" },
    ...overrides,
  };
}

describe("memory audit cron reconciliation", () => {
  it("includes the configured audit model in created cron payloads", async () => {
    const add = vi.fn(async () => undefined);
    const cron = {
      list: vi.fn(async () => []),
      add,
      update: vi.fn(async () => undefined),
      remove: vi.fn(async () => ({ removed: true })),
    };

    await reconcileMemoryAuditCronJobs({
      cron,
      config: config(),
      logger: console,
    });

    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        name: MANAGED_MEMORY_AUDIT_DAILY_CRON_NAME,
        payload: expect.objectContaining({ kind: "agentTurn", model: "gpt-5.5" }),
      }),
    );
  });

  it("patches existing cron payloads when the configured audit model changes", async () => {
    const update = vi.fn(async () => undefined);
    const cron = {
      list: vi.fn(async () => [
        {
          id: "daily",
          name: MANAGED_MEMORY_AUDIT_DAILY_CRON_NAME,
          description:
            "[openclaw:memory-audit:daily] Review durable memory quality and stage human-approved recommendations.",
          enabled: true,
          agentId: "hex",
          sessionTarget: "session:memory-audit",
          wakeMode: "now",
          schedule: { kind: "cron", expr: "10 6 * * *" },
          payload: { kind: "agentTurn", message: "", lightContext: true, model: "gpt-5.4" },
        } satisfies CronJob,
      ]),
      add: vi.fn(async () => undefined),
      update,
      remove: vi.fn(async () => ({ removed: true })),
    };

    await reconcileMemoryAuditCronJobs({
      cron,
      config: config(),
      logger: console,
    });

    expect(update).toHaveBeenCalledWith(
      "daily",
      expect.objectContaining({
        payload: expect.objectContaining({ model: "gpt-5.5" }),
      }),
    );
  });

  it("replaces existing cron jobs when the configured audit model is cleared", async () => {
    const add = vi.fn(async () => undefined);
    const remove = vi.fn(async () => ({ removed: true }));
    const update = vi.fn(async () => undefined);
    const cron = {
      list: vi.fn(async () => [
        {
          id: "daily",
          name: MANAGED_MEMORY_AUDIT_DAILY_CRON_NAME,
          description:
            "[openclaw:memory-audit:daily] Review durable memory quality and stage human-approved recommendations.",
          enabled: true,
          agentId: "hex",
          sessionTarget: "session:memory-audit",
          wakeMode: "now",
          schedule: { kind: "cron", expr: "10 6 * * *" },
          payload: { kind: "agentTurn", message: "Run audit.", lightContext: true, model: "old" },
        } satisfies CronJob,
      ]),
      add,
      update,
      remove,
    };

    await reconcileMemoryAuditCronJobs({
      cron,
      config: config({ model: undefined }),
      logger: console,
    });

    expect(remove).toHaveBeenCalledWith("daily");
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.not.objectContaining({ model: expect.any(String) }),
      }),
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("retries startup reconciliation when cron is not available at gateway_start", async () => {
    const addedNames: string[] = [];
    const cron = {
      list: vi.fn(async () => []),
      add: async (job: { name: string }) => {
        addedNames.push(job.name);
      },
      update: vi.fn(async () => undefined),
      remove: vi.fn(async () => ({ removed: true })),
    };
    const api = {
      config: {},
      pluginConfig: {},
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    };
    let currentCron: unknown = null;
    const reconciler = createMemoryAuditCronReconciler(api as never, {
      startupRetryDelayMs: 10,
      startupRetryMaxAttempts: 1,
      runtimeIntervalMs: false,
    });

    await reconciler.handleGatewayStart({
      config: {
        plugins: {
          entries: {
            "memory-core": {
              config: {
                memoryAudit: {
                  enabled: true,
                  daily: { enabled: true, cron: "10 6 * * *" },
                  weekly: { enabled: false, cron: "0 21 * * 0" },
                },
              },
            },
          },
        },
      },
      getCron: () => currentCron,
    });

    expect(addedNames).toStrictEqual([]);

    currentCron = cron;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(addedNames).toContain(MANAGED_MEMORY_AUDIT_DAILY_CRON_NAME);
    reconciler.dispose();
  });
});
