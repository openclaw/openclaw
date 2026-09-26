// Nextcloud Talk tests cover doctor plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPersistentDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  NEXTCLOUD_TALK_PLUGIN_ID,
  NEXTCLOUD_TALK_REPLAY_DEDUPE_MAX_ENTRIES,
  NEXTCLOUD_TALK_REPLAY_DEDUPE_NAMESPACE_PREFIX,
  NEXTCLOUD_TALK_REPLAY_DEDUPE_TTL_MS,
} from "./replay-migration-contract.js";

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

  it("normalizes legacy private-network aliases", () => {
    const normalize = getNextcloudTalkCompatibilityNormalizer();

    const result = normalize({
      cfg: {
        channels: {
          "nextcloud-talk": {
            allowPrivateNetwork: true,
            accounts: {
              work: {
                allowPrivateNetwork: false,
              },
            },
          },
        },
      } as never,
    });

    expect(result.config.channels?.["nextcloud-talk"]?.network).toEqual({
      dangerouslyAllowPrivateNetwork: true,
    });
    expect(
      (
        result.config.channels?.["nextcloud-talk"]?.accounts?.work as
          | { network?: Record<string, unknown> }
          | undefined
      )?.network,
    ).toEqual({
      dangerouslyAllowPrivateNetwork: false,
    });
  });

  it.each([
    {
      label: "explicit legacy listener",
      noteKind: "info",
      webhookPath: undefined,
      legacyWebhook: { port: 9876, host: "127.0.0.1" },
      expectedNote:
        "- channels.nextcloud-talk.default: legacy webhook listener 127.0.0.1:9876 forwards to the Gateway route. Point the Nextcloud callback or reverse-proxy upstream to Gateway port 19801/nextcloud-talk-webhook, verify delivery, then set legacyWebhook: false to disable this account's legacy forwarding.",
    },
    {
      label: "preserved implicit listener",
      noteKind: "info",
      webhookPath: undefined,
      legacyWebhook: undefined,
      expectedNote:
        "- channels.nextcloud-talk.default: legacy webhook listener 0.0.0.0:8788 forwards to the Gateway route. Point the Nextcloud callback or reverse-proxy upstream to Gateway port 19801/nextcloud-talk-webhook, verify delivery, then set legacyWebhook: false to disable this account's legacy forwarding.",
    },
    {
      label: "explicit opt-out",
      noteKind: "info",
      webhookPath: undefined,
      legacyWebhook: false,
      expectedNote:
        "- channels.nextcloud-talk.default: legacyWebhook is false; use Gateway port 19801/nextcloud-talk-webhook for the Nextcloud callback or reverse-proxy upstream.",
    },
    {
      label: "blocked probe path",
      noteKind: "warning",
      webhookPath: "/ready?tenant=a",
      legacyWebhook: false,
      expectedNote:
        '- channels.nextcloud-talk.default: Webhook path "/ready?tenant=a" is reserved for Gateway probes and cannot receive Nextcloud callbacks on the Gateway port. Set webhookPath to "/nextcloud-talk-webhook" and update the Nextcloud bot callback and reverse-proxy upstream to Gateway port 19801/nextcloud-talk-webhook. This account cannot start until the callback path is changed.',
    },
    {
      label: "implicit legacy probe path",
      noteKind: "warning",
      webhookPath: "/healthz?tenant=a",
      legacyWebhook: undefined,
      expectedNote:
        '- channels.nextcloud-talk.default: Webhook path "/healthz?tenant=a" is reserved for Gateway probes and cannot receive Nextcloud callbacks on the Gateway port. Set webhookPath to "/nextcloud-talk-webhook" and update the Nextcloud bot callback and reverse-proxy upstream to Gateway port 19801/nextcloud-talk-webhook. Legacy webhook listener 0.0.0.0:8788 remains available; verify the new route before setting legacyWebhook: false.',
    },
    {
      label: "blocked Gateway-authenticated path",
      noteKind: "warning",
      webhookPath: "/api/channels/talk?tenant=a",
      legacyWebhook: false,
      expectedNote:
        '- channels.nextcloud-talk.default: Webhook path "/api/channels/talk?tenant=a" requires Gateway authentication and cannot receive Nextcloud callbacks on the Gateway port. Set webhookPath to "/nextcloud-talk-webhook" and update the Nextcloud bot callback and reverse-proxy upstream to Gateway port 19801/nextcloud-talk-webhook. This account cannot start until the callback path is changed.',
    },
    {
      label: "legacy encoded Gateway-authenticated path",
      noteKind: "warning",
      webhookPath: "/%61pi/channels/talk?tenant=a",
      legacyWebhook: { port: 8788 },
      expectedNote:
        '- channels.nextcloud-talk.default: Webhook path "/%61pi/channels/talk?tenant=a" requires Gateway authentication and cannot receive Nextcloud callbacks on the Gateway port. Set webhookPath to "/nextcloud-talk-webhook" and update the Nextcloud bot callback and reverse-proxy upstream to Gateway port 19801/nextcloud-talk-webhook. Legacy webhook listener 0.0.0.0:8788 remains available; verify the new route before setting legacyWebhook: false.',
    },
  ])(
    "reports $label at the correct severity without changing config",
    async ({ webhookPath, legacyWebhook, expectedNote, noteKind }) => {
      const cfg = {
        channels: {
          "nextcloud-talk": {
            baseUrl: "https://cloud.example.com",
            botSecret: "secret",
            apiUser: "admin",
            apiPassword: "app-password",
            webhookPublicUrl: "https://gateway.example.com/nextcloud-talk-webhook",
            webhookPath,
            legacyWebhook,
          },
        },
      };
      const before = structuredClone(cfg);
      const result = await nextcloudTalkDoctor.runConfigSequence?.({
        cfg,
        shouldRepair: true,
        env: { OPENCLAW_GATEWAY_PORT: "19801" },
      });
      expect(result).toEqual({
        changeNotes: [],
        infoNotes: noteKind === "info" ? [expectedNote] : [],
        warningNotes: noteKind === "warning" ? [expectedNote] : [],
      });
      expect(cfg).toEqual(before);
      expect(hoisted.probeNextcloudTalkBotResponseFeature).not.toHaveBeenCalled();
    },
  );

  it("keeps raw SecretRef guidance separate from the prepared preview network probe", async () => {
    const cfg = {
      channels: {
        "nextcloud-talk": {
          baseUrl: "https://cloud.example.com",
          botSecret: { source: "exec", provider: "fixture", id: "nextcloud-bot" },
          apiUser: "admin",
          apiPassword: { source: "exec", provider: "fixture", id: "nextcloud-api" },
          webhookPublicUrl: "https://gateway.example.com/nextcloud-talk-webhook",
        },
      },
    };
    const before = structuredClone(cfg);
    const sequence = await nextcloudTalkDoctor.runConfigSequence?.({
      cfg,
      shouldRepair: true,
      env: { OPENCLAW_GATEWAY_PORT: "19801" },
    });
    expect(sequence).toEqual({
      changeNotes: [],
      warningNotes: [],
      infoNotes: [
        "- channels.nextcloud-talk.default: legacy webhook listener 0.0.0.0:8788 forwards to the Gateway route. Point the Nextcloud callback or reverse-proxy upstream to Gateway port 19801/nextcloud-talk-webhook, verify delivery, then set legacyWebhook: false to disable this account's legacy forwarding.",
      ],
    });
    expect(cfg).toEqual(before);
    expect(hoisted.probeNextcloudTalkBotResponseFeature).not.toHaveBeenCalled();

    const message =
      'Nextcloud Talk bot "OpenClaw" (1) is missing the response feature; outbound replies will fail.';
    hoisted.probeNextcloudTalkBotResponseFeature.mockResolvedValueOnce({
      ok: false,
      code: "missing_response_feature",
      message,
    });
    const warnings = await nextcloudTalkDoctor.collectPreviewWarnings?.({
      cfg: {
        channels: {
          "nextcloud-talk": {
            ...cfg.channels["nextcloud-talk"],
            botSecret: "resolved-fixture-bot-secret",
            apiPassword: "resolved-fixture-api-password",
          },
        },
      },
      doctorFixCommand: "openclaw doctor --fix",
    });
    expect(warnings).toEqual([`- channels.nextcloud-talk.default: ${message}`]);
    expect(hoisted.probeNextcloudTalkBotResponseFeature).toHaveBeenCalledExactlyOnceWith({
      account: expect.objectContaining({ secret: "resolved-fixture-bot-secret" }),
      timeoutMs: 5_000,
    });
  });

  it("migrates legacy replay dedupe JSON into SQLite during doctor repair", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-nextcloud-doctor-"));
    const canonicalStateDir = await fs.realpath(stateDir);
    const legacyDir = path.join(canonicalStateDir, "nextcloud-talk", "replay-dedupe");
    const legacyPath = path.join(legacyDir, "account-a.json");
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(
      legacyPath,
      JSON.stringify({
        "room-1:msg-1": Date.now(),
      }),
    );

    const env = { ...process.env, OPENCLAW_STATE_DIR: canonicalStateDir };
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
      env,
    });

    expect(mutation?.changes.join("\n")).toContain(
      'Migrated Nextcloud Talk replay dedupe cache for account "account-a" to SQLite',
    );
    await expect(fs.access(legacyPath)).rejects.toThrow();

    const dedupe = createPersistentDedupe({
      ttlMs: NEXTCLOUD_TALK_REPLAY_DEDUPE_TTL_MS,
      memoryMaxSize: 0,
      pluginId: NEXTCLOUD_TALK_PLUGIN_ID,
      namespacePrefix: NEXTCLOUD_TALK_REPLAY_DEDUPE_NAMESPACE_PREFIX,
      stateMaxEntries: NEXTCLOUD_TALK_REPLAY_DEDUPE_MAX_ENTRIES,
      env,
    });
    await expect(dedupe.hasRecent("room-1:msg-1", { namespace: "account-a" })).resolves.toBe(true);
  });
});
