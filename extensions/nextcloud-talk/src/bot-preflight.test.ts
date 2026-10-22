import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelTrackedTextResponse } from "../../test-support/streaming-error-response.js";
import { createAccount } from "./inbound-media.test-fixtures.js";

const fetchWithSsrFGuard = vi.hoisted(() => vi.fn());

vi.mock("../runtime-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime-api.js")>()),
  fetchWithSsrFGuard,
}));

const { probeNextcloudTalkBotResponseFeature } = await import("./bot-preflight.js");

const apiConfig = {
  apiUser: "admin",
  apiPassword: "app-password",
  webhookPublicUrl: "https://bot.example.com/nextcloud-talk-webhook",
};

function probe(config: NonNullable<Parameters<typeof createAccount>[0]>["config"] = apiConfig) {
  return probeNextcloudTalkBotResponseFeature({ account: createAccount({ config }) });
}

function mockResponse(response: Response): void {
  fetchWithSsrFGuard.mockResolvedValueOnce({
    response,
    release: async () => {},
    finalUrl: "https://cloud.example.com/ocs/v2.php/apps/spreed/api/v1/bot/admin",
  });
}

function mockBotAdmin(features: number | string): void {
  mockResponse(
    Response.json({
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
  );
}

describe("probeNextcloudTalkBotResponseFeature", () => {
  afterEach(() => {
    fetchWithSsrFGuard.mockReset();
  });

  it("accepts numeric response features", async () => {
    mockBotAdmin(1 | 2 | 8);

    await expect(probe()).resolves.toEqual({
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

    await expect(probe()).resolves.toEqual({
      ok: false,
      code: "missing_response_feature",
      botId: "7",
      botName: "OpenClaw",
      features: 9,
      message:
        'Nextcloud Talk bot "OpenClaw" (7) is missing the response feature (features=9); outbound replies will fail. Run ./occ talk:bot:state --feature webhook --feature response --feature reaction 7 1 or reinstall the bot with --feature response.',
    });
  });

  it("rejects malformed response features", async () => {
    mockBotAdmin("2response");

    await expect(probe()).resolves.toEqual({
      ok: false,
      code: "missing_response_feature",
      botId: "7",
      botName: "OpenClaw",
      message:
        'Nextcloud Talk bot "OpenClaw" (7) is missing the response feature; outbound replies will fail. Run ./occ talk:bot:state --feature webhook --feature response --feature reaction 7 1 or reinstall the bot with --feature response.',
    });
  });

  it("reports malformed bot admin JSON with a stable channel error", async () => {
    mockResponse(
      new Response("{ nope", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(probe()).resolves.toEqual({
      ok: false,
      code: "request_failed",
      message:
        "Nextcloud Talk bot response feature check failed: Nextcloud Talk bot response feature check failed: malformed JSON response",
    });
  });

  it("bounds bot admin error bodies without using response.text()", async () => {
    const tracked = cancelTrackedTextResponse(
      `${"nextcloud bot admin failure ".repeat(1024)}tail`,
      {
        status: 503,
        headers: { "content-type": "text/plain" },
      },
    );
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    mockResponse(tracked.response);

    await expect(probe()).resolves.toEqual({
      ok: false,
      code: "api_error",
      status: 503,
      message: "Nextcloud Talk bot response feature check failed (503)",
    });
    expect(textSpy).not.toHaveBeenCalled();
    expect(tracked.wasCanceled()).toBe(true);
  });

  it("skips when API credentials are absent", async () => {
    await expect(
      probe({ ...apiConfig, apiUser: undefined, apiPassword: undefined }),
    ).resolves.toEqual({
      ok: true,
      skipped: true,
      code: "missing_api_credentials",
      message:
        "Nextcloud Talk bot response feature check skipped: apiUser/apiPassword are not configured.",
    });
    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
  });
});
