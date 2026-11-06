import fs from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreConfig, NextcloudTalkAccountConfig } from "./types.js";

const probe = vi.hoisted(() => vi.fn());

// mock-isolation: Callback guidance must not probe a live Nextcloud server.
vi.mock("./bot-preflight.js", () => ({
  probeNextcloudTalkBotResponseFeature: probe,
}));

const { nextcloudTalkDoctor } = await import("./doctor.js");

const destination = "Gateway port 19801/nextcloud-talk-webhook";
const noListener = /no legacy listener is configured/;
const account = {
  baseUrl: "https://cloud.example.com",
  botSecret: "secret",
  apiUser: "admin",
  apiPassword: "app-password",
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
type NoteCase = [string | undefined, NextcloudTalkAccountConfig["legacyWebhook"], RegExp];
async function expectSequence(cfg: CoreConfig, pattern: RegExp, warning = false) {
  const before = structuredClone(cfg);
  const result = await runSequence(cfg);
  expect(result).toEqual({
    changeNotes: [],
    infoNotes: warning ? [] : [expect.stringMatching(pattern)],
    warningNotes: warning ? [expect.stringMatching(pattern)] : [],
  });
  const note = (warning ? result?.warningNotes : result?.infoNotes)?.[0];
  expect(note).toContain("channels.nextcloud-talk.default:");
  expect(note).toContain(destination);
  expect(cfg).toEqual(before);
  expect(probe).not.toHaveBeenCalled();
  return note;
}

describe("nextcloud-talk doctor", () => {
  beforeEach(() => {
    probe.mockReset();
  });

  it.each<NoteCase>([
    [undefined, { port: 9876, host: "127.0.0.1" }, /127\.0\.0\.1:9876.*legacyWebhook: false/],
    [undefined, undefined, noListener],
    [undefined, false, noListener],
    ["/ready?tenant=a", false, /reserved for Gateway checks/],
    ["/healthz?tenant=a", { port: 8788 }, /reserved for Gateway checks/],
    ["/api/channels/talk?tenant=a", false, /requires Gateway authentication/],
    ["/%61pi/channels/talk?tenant=a", { port: 8788 }, /requires Gateway authentication/],
  ])("reports callback guidance for %s", async (webhookPath, legacyWebhook, pattern) => {
    const note = await expectSequence(
      configure({ ...account, webhookPath, legacyWebhook }),
      pattern,
      Boolean(webhookPath),
    );
    if (webhookPath) {
      expect(note).toContain(`Webhook path "${webhookPath}"`);
      expect(note).toContain(legacyWebhook ? "0.0.0.0:8788 remains available" : "cannot start");
    }
  });

  it("keeps raw SecretRef guidance separate from the prepared preview network probe", async () => {
    await expectSequence(
      configure({
        ...account,
        botSecret: { source: "exec", provider: "fixture", id: "nextcloud-bot" },
        apiPassword: { source: "exec", provider: "fixture", id: "nextcloud-api" },
      }),
      noListener,
    );

    const message =
      'Nextcloud Talk bot "OpenClaw" (1) is missing the response feature; outbound replies will fail.';
    probe.mockResolvedValueOnce({
      ok: false,
      code: "missing_response_feature",
      message,
    });
    const warnings = await nextcloudTalkDoctor.collectPreviewWarnings?.({
      cfg: configure(account),
      doctorFixCommand: "openclaw doctor --fix",
    });
    expect(warnings).toEqual([`- channels.nextcloud-talk.default: ${message}`]);
    expect(probe).toHaveBeenCalledExactlyOnceWith({
      account: expect.objectContaining({ secret: account.botSecret }),
      timeoutMs: 5_000,
    });
  });

  it.each([false, true])(
    "preserves config and refuses retired replay state (present=%s)",
    (hasLegacyFile) =>
      withTempDir("openclaw-nextcloud-doctor-", async (stateDir) => {
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
              ...account,
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
      }),
  );
});
