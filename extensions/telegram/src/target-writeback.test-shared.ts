import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

type UnknownMock = Mock<(...args: unknown[]) => unknown>;
type AsyncUnknownMock = Mock<(...args: unknown[]) => Promise<unknown>>;

const readConfigFileSnapshotForWrite: AsyncUnknownMock = vi.fn();
const writeConfigFile: AsyncUnknownMock = vi.fn();
const replaceConfigFile: AsyncUnknownMock = vi.fn(async (params: unknown) => {
  const record = params as { nextConfig?: unknown; writeOptions?: unknown };
  await writeConfigFile(record.nextConfig, record.writeOptions);
});
const resolveCronStorePath: UnknownMock = vi.fn();
const updateCronStoreJobs: AsyncUnknownMock = vi.fn();

vi.mock("openclaw/plugin-sdk/config-mutation", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/config-mutation")>(
    "openclaw/plugin-sdk/config-mutation",
  );
  return {
    ...actual,
    readConfigFileSnapshotForWrite,
    replaceConfigFile,
    writeConfigFile,
  };
});

vi.mock("openclaw/plugin-sdk/cron-store-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/cron-store-runtime")>(
    "openclaw/plugin-sdk/cron-store-runtime",
  );
  return {
    ...actual,
    resolveCronStorePath,
    updateCronStoreJobs,
  };
});

function mockCronJobUpdate(jobs: Array<Record<string, unknown>>) {
  const updatedJobs: Array<Record<string, unknown>> = [];
  updateCronStoreJobs.mockImplementation(async (_storePath, updateJob) => {
    let updatedCount = 0;
    updatedJobs.length = 0;
    for (const job of jobs) {
      const nextJob = (updateJob as (job: Record<string, unknown>) => unknown)({
        ...job,
        delivery:
          job.delivery && typeof job.delivery === "object"
            ? { ...(job.delivery as Record<string, unknown>) }
            : job.delivery,
      });
      if (nextJob) {
        updatedCount += 1;
        updatedJobs.push(nextJob as Record<string, unknown>);
      } else {
        updatedJobs.push(job);
      }
    }
    return { updatedJobs: updatedCount };
  });
  return updatedJobs;
}

export function installMaybePersistResolvedTelegramTargetTests(params?: {
  includeGatewayScopeCases?: boolean;
}) {
  describe("maybePersistResolvedTelegramTarget", () => {
    let maybePersistResolvedTelegramTarget: typeof import("./target-writeback.js").maybePersistResolvedTelegramTarget;

    beforeAll(async () => {
      ({ maybePersistResolvedTelegramTarget } = await import("./target-writeback.js"));
    });

    beforeEach(() => {
      readConfigFileSnapshotForWrite.mockReset();
      replaceConfigFile.mockClear();
      writeConfigFile.mockReset();
      resolveCronStorePath.mockReset();
      updateCronStoreJobs.mockReset();
      resolveCronStorePath.mockReturnValue("/tmp/cron/jobs.json");
      updateCronStoreJobs.mockResolvedValue({ updatedJobs: 0 });
    });

    it("skips writeback when target is already numeric", async () => {
      await maybePersistResolvedTelegramTarget({
        cfg: {} as OpenClawConfig,
        rawTarget: "-100123",
        resolvedChatId: "-100123",
      });

      expect(readConfigFileSnapshotForWrite).not.toHaveBeenCalled();
      expect(updateCronStoreJobs).not.toHaveBeenCalled();
    });

    if (params?.includeGatewayScopeCases) {
      it("skips config and cron writeback for gateway callers missing operator.admin", async () => {
        await maybePersistResolvedTelegramTarget({
          cfg: {
            cron: { store: "/tmp/cron/jobs.json" },
          } as OpenClawConfig,
          rawTarget: "t.me/mychannel",
          resolvedChatId: "-100123",
          gatewayClientScopes: ["operator.write"],
        });

        expect(readConfigFileSnapshotForWrite).not.toHaveBeenCalled();
        expect(writeConfigFile).not.toHaveBeenCalled();
        expect(updateCronStoreJobs).not.toHaveBeenCalled();
      });

      it("skips config and cron writeback for gateway callers with an empty scope set", async () => {
        await maybePersistResolvedTelegramTarget({
          cfg: {
            cron: { store: "/tmp/cron/jobs.json" },
          } as OpenClawConfig,
          rawTarget: "t.me/mychannel",
          resolvedChatId: "-100123",
          gatewayClientScopes: [],
        });

        expect(readConfigFileSnapshotForWrite).not.toHaveBeenCalled();
        expect(writeConfigFile).not.toHaveBeenCalled();
        expect(updateCronStoreJobs).not.toHaveBeenCalled();
      });
    }

    it("writes back matching config and cron targets", async () => {
      readConfigFileSnapshotForWrite.mockResolvedValue({
        snapshot: {
          config: {
            channels: {
              telegram: {
                defaultTo: "t.me/mychannel",
                accounts: {
                  alerts: {
                    defaultTo: "@mychannel",
                  },
                },
              },
            },
          },
        },
        writeOptions: { expectedConfigPath: "/tmp/openclaw.json" },
      });
      const updatedJobs = mockCronJobUpdate([
        { id: "a", delivery: { channel: "telegram", to: "https://t.me/mychannel" } },
        { id: "b", delivery: { channel: "slack", to: "C123" } },
      ]);

      await maybePersistResolvedTelegramTarget({
        cfg: {
          cron: { store: "/tmp/cron/jobs.json" },
        } as OpenClawConfig,
        rawTarget: "t.me/mychannel",
        resolvedChatId: "-100123",
      });

      expect(writeConfigFile).toHaveBeenCalledTimes(1);
      expect(writeConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          channels: {
            telegram: {
              defaultTo: "-100123",
              accounts: {
                alerts: {
                  defaultTo: "-100123",
                },
              },
            },
          },
        }),
        expect.objectContaining({ expectedConfigPath: "/tmp/openclaw.json" }),
      );
      expect(updateCronStoreJobs).toHaveBeenCalledTimes(1);
      expect(updateCronStoreJobs).toHaveBeenCalledWith("/tmp/cron/jobs.json", expect.any(Function));
      expect(updatedJobs).toEqual([
        { id: "a", delivery: { channel: "telegram", to: "-100123" } },
        { id: "b", delivery: { channel: "slack", to: "C123" } },
      ]);
    });

    it("preserves topic suffix style in writeback target", async () => {
      readConfigFileSnapshotForWrite.mockResolvedValue({
        snapshot: {
          config: {
            channels: {
              telegram: {
                defaultTo: "t.me/mychannel:topic:9",
              },
            },
          },
        },
        writeOptions: {},
      });
      updateCronStoreJobs.mockResolvedValue({ updatedJobs: 0 });

      await maybePersistResolvedTelegramTarget({
        cfg: {} as OpenClawConfig,
        rawTarget: "t.me/mychannel:topic:9",
        resolvedChatId: "-100123",
      });

      expect(writeConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          channels: {
            telegram: {
              defaultTo: "-100123:topic:9",
            },
          },
        }),
        expect.any(Object),
      );
    });

    it("matches username targets case-insensitively", async () => {
      readConfigFileSnapshotForWrite.mockResolvedValue({
        snapshot: {
          config: {
            channels: {
              telegram: {
                defaultTo: "https://t.me/mychannel",
              },
            },
          },
        },
        writeOptions: {},
      });
      const updatedJobs = mockCronJobUpdate([
        { id: "a", delivery: { channel: "telegram", to: "https://t.me/mychannel" } },
      ]);

      await maybePersistResolvedTelegramTarget({
        cfg: {} as OpenClawConfig,
        rawTarget: "@MyChannel",
        resolvedChatId: "-100123",
      });

      expect(writeConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          channels: {
            telegram: {
              defaultTo: "-100123",
            },
          },
        }),
        expect.any(Object),
      );
      expect(updateCronStoreJobs).toHaveBeenCalledWith("/tmp/cron/jobs.json", expect.any(Function));
      expect(updatedJobs).toEqual([{ id: "a", delivery: { channel: "telegram", to: "-100123" } }]);
    });
  });
}
