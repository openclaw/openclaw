// Nextcloud Talk tests cover doctor plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  probeNextcloudTalkBotResponseFeature: vi.fn(),
}));

vi.mock("./bot-preflight.js", () => ({
  probeNextcloudTalkBotResponseFeature: hoisted.probeNextcloudTalkBotResponseFeature,
}));

const { nextcloudTalkDoctor } = await import("./doctor.js");

describe("nextcloud-talk doctor", () => {
  beforeEach(() => {
    hoisted.probeNextcloudTalkBotResponseFeature.mockReset();
  });

  it.each([
    {
      label: "explicit legacy listener",
      noteKind: "info",
      webhookPath: undefined,
      legacyWebhook: { port: 9876, host: "127.0.0.1" },
      expectedNote:
        "- channels.nextcloud-talk.default: legacy webhook listener 127.0.0.1:9876 forwards to the Gateway route. Point the Nextcloud callback or reverse-proxy upstream to Gateway port 19801/nextcloud-talk-webhook, verify delivery, then remove the legacyWebhook pin; use legacyWebhook: false to override an inherited endpoint.",
    },
    {
      label: "Gateway-only default",
      noteKind: "info",
      webhookPath: undefined,
      legacyWebhook: undefined,
      expectedNote:
        "- channels.nextcloud-talk.default: no legacy listener is configured; use Gateway port 19801/nextcloud-talk-webhook for the Nextcloud callback or reverse-proxy upstream.",
    },
    {
      label: "explicit opt-out",
      noteKind: "info",
      webhookPath: undefined,
      legacyWebhook: false,
      expectedNote:
        "- channels.nextcloud-talk.default: no legacy listener is configured; use Gateway port 19801/nextcloud-talk-webhook for the Nextcloud callback or reverse-proxy upstream.",
    },
    {
      label: "blocked probe path",
      noteKind: "warning",
      webhookPath: "/ready?tenant=a",
      legacyWebhook: false,
      expectedNote:
        '- channels.nextcloud-talk.default: Webhook path "/ready?tenant=a" is reserved for Gateway checks and cannot receive Nextcloud callbacks on the Gateway port. Set webhookPath to "/nextcloud-talk-webhook" and update the Nextcloud bot callback and reverse-proxy upstream to Gateway port 19801/nextcloud-talk-webhook. This account cannot start until the callback path is changed.',
    },
    {
      label: "explicit legacy probe path",
      noteKind: "warning",
      webhookPath: "/healthz?tenant=a",
      legacyWebhook: { port: 8788 },
      expectedNote:
        '- channels.nextcloud-talk.default: Webhook path "/healthz?tenant=a" is reserved for Gateway checks and cannot receive Nextcloud callbacks on the Gateway port. Set webhookPath to "/nextcloud-talk-webhook" and update the Nextcloud bot callback and reverse-proxy upstream to Gateway port 19801/nextcloud-talk-webhook. Legacy webhook listener 0.0.0.0:8788 remains available; verify the new route before removing the legacyWebhook pin.',
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
        '- channels.nextcloud-talk.default: Webhook path "/%61pi/channels/talk?tenant=a" requires Gateway authentication and cannot receive Nextcloud callbacks on the Gateway port. Set webhookPath to "/nextcloud-talk-webhook" and update the Nextcloud bot callback and reverse-proxy upstream to Gateway port 19801/nextcloud-talk-webhook. Legacy webhook listener 0.0.0.0:8788 remains available; verify the new route before removing the legacyWebhook pin.',
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
        "- channels.nextcloud-talk.default: no legacy listener is configured; use Gateway port 19801/nextcloud-talk-webhook for the Nextcloud callback or reverse-proxy upstream.",
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

  it.each([false, true])(
    "preserves supported July config and refuses retired JSON replay state when present (%s)",
    async (hasLegacyFile) => {
      const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-nextcloud-doctor-"));
      try {
        const canonicalStateDir = await fs.realpath(stateDir);
        const legacyDir = path.join(canonicalStateDir, "nextcloud-talk", "replay-dedupe");
        const legacyPath = path.join(legacyDir, "account-a.json");
        const original = '{ "room-1:msg-1": 1780272000000 }\n';
        if (hasLegacyFile) {
          await fs.mkdir(legacyDir, { recursive: true });
          await fs.writeFile(legacyPath, original);
        }
        const cfg = {
          channels: {
            "nextcloud-talk": {
              accounts: {
                "account-a": {
                  baseUrl: "https://cloud.example.com",
                  botSecret: "synthetic-bot-secret",
                  network: { dangerouslyAllowPrivateNetwork: false },
                },
              },
            },
          },
        };
        const before = structuredClone(cfg);
        const repair = async () =>
          nextcloudTalkDoctor.repairConfig?.({
            cfg,
            doctorFixCommand: "openclaw --profile home doctor --fix",
            env: { OPENCLAW_STATE_DIR: canonicalStateDir },
          });
        if (hasLegacyFile) {
          await expect(repair()).rejects.toThrow(
            `Retired pre-July Nextcloud Talk replay state at ${legacyPath} was left unchanged. Install OpenClaw 2026.9.5, run "openclaw --profile home doctor --fix", then upgrade to latest.`,
          );
          expect(await fs.readFile(legacyPath, "utf8")).toBe(original);
        } else {
          await expect(repair()).resolves.toEqual({ config: cfg, changes: [] });
        }
        expect(cfg).toEqual(before);
        expect(await fs.readdir(canonicalStateDir)).toEqual(
          hasLegacyFile ? ["nextcloud-talk"] : [],
        );
      } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    },
  );
});
