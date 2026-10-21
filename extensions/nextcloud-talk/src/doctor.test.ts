import fs from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreConfig, NextcloudTalkAccountConfig } from "./types.js";

const hoisted = vi.hoisted(() => ({
  probeNextcloudTalkBotResponseFeature: vi.fn(),
}));

vi.mock("./bot-preflight.js", () => ({
  probeNextcloudTalkBotResponseFeature: hoisted.probeNextcloudTalkBotResponseFeature,
}));

const { nextcloudTalkDoctor } = await import("./doctor.js");

const destination = "Gateway port 19801/nextcloud-talk-webhook";
const noListener = `- channels.nextcloud-talk.default: no legacy listener is configured; use ${destination} for the Nextcloud callback or reverse-proxy upstream.`;
const legacyAvailable =
  " Legacy webhook listener 0.0.0.0:8788 remains available; verify the new route before removing the legacyWebhook pin.";
const account = {
  baseUrl: "https://cloud.example.com",
  botSecret: "secret",
  apiUser: "admin",
  apiPassword: "app-password",
  webhookPublicUrl: "https://gateway.example.com/nextcloud-talk-webhook",
};
const configure = (
  settings: NonNullable<NonNullable<CoreConfig["channels"]>["nextcloud-talk"]>,
): CoreConfig => ({
  channels: { "nextcloud-talk": settings },
});
const runSequence = (cfg: CoreConfig) =>
  nextcloudTalkDoctor.runConfigSequence?.({
    cfg,
    shouldRepair: true,
    env: { OPENCLAW_GATEWAY_PORT: "19801" },
  });
const legacyNote = `- channels.nextcloud-talk.default: legacy webhook listener 127.0.0.1:9876 forwards to the Gateway route. Point the Nextcloud callback or reverse-proxy upstream to ${destination}, verify delivery, then remove the legacyWebhook pin; use legacyWebhook: false to override an inherited endpoint.`;
const reserved = "is reserved for Gateway checks";
const authenticated = "requires Gateway authentication";
const notes = (infoNotes: string[] = [], warningNotes: string[] = []) => ({
  changeNotes: [],
  infoNotes,
  warningNotes,
});
type NoteCase = [NextcloudTalkAccountConfig, ReturnType<typeof notes>];
function conflictCase(webhookPath: string, reason: string, legacy = false): NoteCase {
  const note =
    `- channels.nextcloud-talk.default: Webhook path "${webhookPath}" ${reason} and cannot receive Nextcloud callbacks on the Gateway port. Set webhookPath to "/nextcloud-talk-webhook" and update the Nextcloud bot callback and reverse-proxy upstream to ${destination}.` +
    (legacy ? legacyAvailable : " This account cannot start until the callback path is changed.");
  return [{ webhookPath, legacyWebhook: legacy ? { port: 8788 } : false }, notes([], [note])];
}
async function expectSequence(cfg: CoreConfig, expected: ReturnType<typeof notes>) {
  const before = structuredClone(cfg);
  expect(await runSequence(cfg)).toEqual(expected);
  expect(cfg).toEqual(before);
  expect(hoisted.probeNextcloudTalkBotResponseFeature).not.toHaveBeenCalled();
}

describe("nextcloud-talk doctor", () => {
  beforeEach(() => {
    hoisted.probeNextcloudTalkBotResponseFeature.mockReset();
  });

  it.each<NoteCase>([
    [{ legacyWebhook: { port: 9876, host: "127.0.0.1" } }, notes([legacyNote])],
    [{}, notes([noListener])],
    [{ legacyWebhook: false }, notes([noListener])],
    conflictCase("/ready?tenant=a", reserved),
    conflictCase("/healthz?tenant=a", reserved, true),
    conflictCase("/api/channels/talk?tenant=a", authenticated),
    conflictCase("/%61pi/channels/talk?tenant=a", authenticated, true),
  ])("reports callback guidance for %j without changing config", async (settings, expected) => {
    await expectSequence(configure({ ...account, ...settings }), expected);
  });

  it("keeps raw SecretRef guidance separate from the prepared preview network probe", async () => {
    const cfg = configure({
      ...account,
      botSecret: { source: "exec", provider: "fixture", id: "nextcloud-bot" },
      apiPassword: { source: "exec", provider: "fixture", id: "nextcloud-api" },
    });
    await expectSequence(cfg, notes([noListener]));

    const message =
      'Nextcloud Talk bot "OpenClaw" (1) is missing the response feature; outbound replies will fail.';
    hoisted.probeNextcloudTalkBotResponseFeature.mockResolvedValueOnce({
      ok: false,
      code: "missing_response_feature",
      message,
    });
    const warnings = await nextcloudTalkDoctor.collectPreviewWarnings?.({
      cfg: configure({
        ...account,
        botSecret: "resolved-fixture-bot-secret",
        apiPassword: "resolved-fixture-api-password",
      }),
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
      await withTempDir("openclaw-nextcloud-doctor-", async (stateDir) => {
        const canonicalStateDir = await fs.realpath(stateDir);
        const legacyDir = path.join(canonicalStateDir, "nextcloud-talk", "replay-dedupe");
        const legacyPath = path.join(legacyDir, "account-a.json");
        const original = '{ "room-1:msg-1": 1780272000000 }\n';
        if (hasLegacyFile) {
          await fs.mkdir(legacyDir, { recursive: true });
          await fs.writeFile(legacyPath, original);
        }
        const cfg = configure({
          accounts: {
            "account-a": {
              baseUrl: "https://cloud.example.com",
              botSecret: "synthetic-bot-secret",
              network: { dangerouslyAllowPrivateNetwork: false },
            },
          },
        });
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
      });
    },
  );
});
