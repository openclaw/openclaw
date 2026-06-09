// Nextcloud Talk tests cover doctor plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNextcloudTalkReplayGuard } from "./replay-guard.js";

const hoisted = vi.hoisted(() => ({
  probeNextcloudTalkBotResponseFeature: vi.fn(),
}));

vi.mock("./bot-preflight.js", () => ({
  probeNextcloudTalkBotResponseFeature: hoisted.probeNextcloudTalkBotResponseFeature,
}));

const { nextcloudTalkDoctor } = await import("./doctor.js");

function getNextcloudTalkCompatibilityNormalizer(): NonNullable<
  typeof nextcloudTalkDoctor.normalizeCompatibilityConfig
> {
  const normalize = nextcloudTalkDoctor.normalizeCompatibilityConfig;
  if (!normalize) {
    throw new Error("Expected nextcloud-talk doctor to expose normalizeCompatibilityConfig");
  }
  return normalize;
}

describe("nextcloud-talk doctor", () => {
  beforeEach(() => {
    hoisted.probeNextcloudTalkBotResponseFeature.mockReset();
    resetPluginStateStoreForTests();
  });

  it("removes retired private-network config", () => {
    const normalize = getNextcloudTalkCompatibilityNormalizer();

    const result = normalize({
      cfg: {
        channels: {
          "nextcloud-talk": {
            allowPrivateNetwork: true,
            network: {
              dangerouslyAllowPrivateNetwork: true,
            },
            accounts: {
              work: {
                allowPrivateNetwork: false,
                network: {
                  dangerouslyAllowPrivateNetwork: false,
                  owner: "preserved",
                },
              },
            },
          },
        },
      } as never,
    });

    expect(result.changes).toEqual([
      "Removed channels.nextcloud-talk private-network config. Nextcloud Talk private-network fetch enforcement moved to proxy.enabled plus external proxy policy.",
      "Removed channels.nextcloud-talk.accounts.work private-network config. Nextcloud Talk private-network fetch enforcement moved to proxy.enabled plus external proxy policy.",
    ]);
    expect(result.config.channels?.["nextcloud-talk"]).not.toHaveProperty("allowPrivateNetwork");
    expect(result.config.channels?.["nextcloud-talk"]).not.toHaveProperty("network");
    expect(
      (
        result.config.channels?.["nextcloud-talk"]?.accounts?.work as
          | { network?: Record<string, unknown> }
          | undefined
      )?.network,
    ).toEqual({
      owner: "preserved",
    });
  });

  it("warns when the configured bot is missing the response feature", async () => {
    hoisted.probeNextcloudTalkBotResponseFeature.mockResolvedValueOnce({
      ok: false,
      code: "missing_response_feature",
      message:
        'Nextcloud Talk bot "OpenClaw" (1) is missing the response feature (features=9); outbound replies will fail.',
    });

    await expect(
      nextcloudTalkDoctor.collectPreviewWarnings?.({
        cfg: {
          channels: {
            "nextcloud-talk": {
              baseUrl: "https://cloud.example.com",
              botSecret: "secret",
              apiUser: "admin",
              apiPassword: "app-password",
              webhookPublicUrl: "https://gateway.example.com/nextcloud-talk-webhook",
            },
          },
        } as never,
        doctorFixCommand: "openclaw doctor --fix",
      }),
    ).resolves.toEqual([
      '- channels.nextcloud-talk.default: Nextcloud Talk bot "OpenClaw" (1) is missing the response feature (features=9); outbound replies will fail.',
    ]);
  });

  it("migrates legacy replay dedupe JSON into SQLite during doctor repair", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-nextcloud-doctor-"));
    const legacyDir = path.join(stateDir, "nextcloud-talk", "replay-dedupe");
    const legacyPath = path.join(legacyDir, "account-a.json");
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(
      legacyPath,
      JSON.stringify({
        "room-1:msg-1": Date.now(),
      }),
    );

    const mutation = await nextcloudTalkDoctor.repairConfig?.({
      cfg: {
        channels: {
          "nextcloud-talk": {
            accounts: {
              "account-a": {
                baseUrl: "https://cloud.example.com",
                botSecret: "secret",
              },
            },
          },
        },
      } as never,
      doctorFixCommand: "openclaw doctor --fix",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });

    expect(mutation?.changes.join("\n")).toContain(
      'Migrated Nextcloud Talk replay dedupe cache for account "account-a" to SQLite',
    );
    await expect(fs.access(legacyPath)).rejects.toThrow();

    const guard = createNextcloudTalkReplayGuard({ stateDir });
    await expect(
      guard.shouldProcessMessage({
        accountId: "account-a",
        roomToken: "room-1",
        messageId: "msg-1",
      }),
    ).resolves.toBe(false);
  });
});
