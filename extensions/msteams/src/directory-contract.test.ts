import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { msteamsDirectoryContractPlugin } from "../directory-contract-api.js";

describe("msteams directory contract", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("uses account-scoped Teams config", async () => {
    const cfg = {
      channels: {
        msteams: {
          tenantId: "tenant-id",
          appId: "default-app-id",
          appPassword: "default-secret",
          allowFrom: ["user:default-user"],
          accounts: {
            support: {
              appId: "support-app-id",
              appPassword: "support-secret",
              allowFrom: ["user:support-user"],
              teams: {
                team1: {
                  channels: {
                    "19:support-channel": {},
                  },
                },
              },
              webhook: { path: "/api/messages/named" },
            },
          },
        },
      },
    } as OpenClawConfig;

    await expect(
      msteamsDirectoryContractPlugin.directory.self?.({
        cfg,
        accountId: "support",
        runtime: {} as never,
      }),
    ).resolves.toEqual({ kind: "user", id: "support-app-id", name: "support-app-id" });
    await expect(
      msteamsDirectoryContractPlugin.directory.listPeers?.({
        cfg,
        accountId: "support",
        runtime: {} as never,
      }),
    ).resolves.toEqual([{ id: "user:support-user", kind: "user" }]);
    await expect(
      msteamsDirectoryContractPlugin.directory.listGroups?.({
        cfg,
        accountId: "support",
        runtime: {} as never,
      }),
    ).resolves.toEqual([{ id: "conversation:19:support-channel", kind: "group" }]);
  });

  it("does not use default env credentials for named directory accounts", async () => {
    vi.stubEnv("MSTEAMS_APP_ID", "env-default-app");
    vi.stubEnv("MSTEAMS_APP_PASSWORD", "env-default-secret");
    vi.stubEnv("MSTEAMS_TENANT_ID", "env-default-tenant");
    const cfg = {
      channels: {
        msteams: {
          defaultAccount: "support",
          accounts: {
            support: {
              appId: "support-app-id",
              tenantId: "support-tenant-id",
              webhook: { path: "/api/messages/named" },
            },
          },
        },
      },
    } as OpenClawConfig;

    await expect(
      msteamsDirectoryContractPlugin.directory.self?.({
        cfg,
        runtime: {} as never,
      }),
    ).resolves.toBeNull();
  });
});
