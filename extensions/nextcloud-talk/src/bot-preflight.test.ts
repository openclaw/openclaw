// Nextcloud Talk tests cover bot preflight plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";

const hoisted = vi.hoisted(() => ({
  fetchWithResponseRelease: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/fetch-runtime", () => ({
  fetchWithResponseRelease: hoisted.fetchWithResponseRelease,
}));

const { probeNextcloudTalkBotResponseFeature } = await import("./bot-preflight.js");

function account(
  overrides: Partial<ResolvedNextcloudTalkAccount> = {},
): ResolvedNextcloudTalkAccount {
  return {
    accountId: "default",
    enabled: true,
    baseUrl: "https://cloud.example.com",
    secret: "secret",
    secretSource: "config",
    config: {
      baseUrl: "https://cloud.example.com",
      botSecret: "secret",
      apiUser: "admin",
      apiPassword: "app-password",
      webhookPublicUrl: "https://bot.example.com/nextcloud-talk-webhook",
    },
    ...overrides,
  };
}

function mockBotAdmin(features: number | string): void {
  hoisted.fetchWithResponseRelease.mockResolvedValueOnce({
    response: new Response(
      JSON.stringify({
        ocs: {
          data: [
            {
              id: 7,
              name: "OpenClaw",
              url: "https://bot.example.com/nextcloud-talk-webhook",
              features,
            },
          ],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
    release: async () => {},
  });
}

describe("probeNextcloudTalkBotResponseFeature", () => {
  beforeEach(() => {
    hoisted.fetchWithResponseRelease.mockClear();
  });

  afterEach(() => {
    hoisted.fetchWithResponseRelease.mockReset();
  });

  it("passes when the matching bot has the response feature bit", async () => {
    mockBotAdmin(1 | 2 | 8);

    await expect(probeNextcloudTalkBotResponseFeature({ account: account() })).resolves.toEqual({
      ok: true,
      code: "ok",
      botId: "7",
      botName: "OpenClaw",
      features: 11,
      message: 'Nextcloud Talk bot "OpenClaw" has the response feature.',
    });
  });

  it("normalizes signed decimal bot feature strings through the shared parser", async () => {
    mockBotAdmin("+011");

    await expect(probeNextcloudTalkBotResponseFeature({ account: account() })).resolves.toEqual({
      ok: true,
      code: "ok",
      botId: "7",
      botName: "OpenClaw",
      features: 11,
      message: 'Nextcloud Talk bot "OpenClaw" has the response feature.',
    });
  });

  it("reports missing response feature for the matching webhook bot", async () => {
    mockBotAdmin(1 | 8);

    await expect(probeNextcloudTalkBotResponseFeature({ account: account() })).resolves.toEqual({
      ok: false,
      code: "missing_response_feature",
      botId: "7",
      botName: "OpenClaw",
      features: 9,
      message:
        'Nextcloud Talk bot "OpenClaw" (7) is missing the response feature (features=9); outbound replies will fail. Run ./occ talk:bot:state --feature webhook --feature response --feature reaction 7 1 or reinstall the bot with --feature response.',
    });
  });

  it("does not coerce partial bot feature strings", async () => {
    mockBotAdmin("2response");

    await expect(probeNextcloudTalkBotResponseFeature({ account: account() })).resolves.toEqual({
      ok: false,
      code: "missing_response_feature",
      botId: "7",
      botName: "OpenClaw",
      message:
        'Nextcloud Talk bot "OpenClaw" (7) is missing the response feature; outbound replies will fail. Run ./occ talk:bot:state --feature webhook --feature response --feature reaction 7 1 or reinstall the bot with --feature response.',
    });
  });

  it("does not treat negative feature masks as having every feature", async () => {
    mockBotAdmin(-1);

    await expect(probeNextcloudTalkBotResponseFeature({ account: account() })).resolves.toEqual({
      ok: false,
      code: "missing_response_feature",
      botId: "7",
      botName: "OpenClaw",
      message:
        'Nextcloud Talk bot "OpenClaw" (7) is missing the response feature; outbound replies will fail. Run ./occ talk:bot:state --feature webhook --feature response --feature reaction 7 1 or reinstall the bot with --feature response.',
    });
  });

  it("reports malformed bot admin JSON with a stable channel error", async () => {
    hoisted.fetchWithResponseRelease.mockResolvedValueOnce({
      response: new Response("{ nope", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      release: async () => {},
    });

    await expect(probeNextcloudTalkBotResponseFeature({ account: account() })).resolves.toEqual({
      ok: false,
      code: "request_failed",
      message:
        "Nextcloud Talk bot response feature probe failed: Nextcloud Talk bot response feature probe failed: malformed JSON response",
    });
  });

  it("skips when API credentials are absent", async () => {
    await expect(
      probeNextcloudTalkBotResponseFeature({
        account: account({
          config: {
            baseUrl: "https://cloud.example.com",
            botSecret: "secret",
            webhookPublicUrl: "https://bot.example.com/nextcloud-talk-webhook",
          },
        }),
      }),
    ).resolves.toEqual({
      ok: true,
      skipped: true,
      code: "missing_api_credentials",
      message:
        "Nextcloud Talk bot response feature probe skipped: apiUser/apiPassword are not configured.",
    });
    expect(hoisted.fetchWithResponseRelease).not.toHaveBeenCalled();
  });
});
