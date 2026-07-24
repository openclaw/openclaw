// Slack tests cover probe plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { probeSlack } from "./probe.js";

const authTestMock = vi.hoisted(() => vi.fn());
const createSlackWebClientMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createSlackWebClient: createSlackWebClientMock,
}));

const ABORTABLE_CLIENT_OPTIONS = {
  timeout: 2500,
  retryConfig: { retries: 0 },
  rejectRateLimitedCalls: true,
};

describe("probeSlack", () => {
  beforeEach(() => {
    authTestMock.mockReset();
    createSlackWebClientMock.mockReset();

    createSlackWebClientMock.mockReturnValue({
      auth: {
        test: authTestMock,
      },
    });
  });

  it("maps Slack auth metadata on success", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValueOnce(145);
    authTestMock.mockResolvedValue({
      ok: true,
      user_id: "U123",
      bot_id: "B123",
      user: "openclaw-bot",
      team_id: "T123",
      team: "OpenClaw",
    });

    await expect(probeSlack("xoxb-test", 2500)).resolves.toEqual({
      ok: true,
      status: 200,
      elapsedMs: 45,
      bot: { id: "U123", name: "openclaw-bot" },
      team: { id: "T123", name: "OpenClaw" },
    });
    // The probe must enforce the timeout through the WebClient's own request
    // timeout (which aborts the underlying socket) and disable retries, rather
    // than racing an un-cancellable promise (issue #106565).
    expect(createSlackWebClientMock).toHaveBeenCalledWith("xoxb-test", ABORTABLE_CLIENT_OPTIONS);
  });

  it("warns when auth.test looks like a user token in the bot token slot", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValueOnce(145);
    authTestMock.mockResolvedValue({
      ok: true,
      user_id: "UUSER",
      user: "human-installer",
      team_id: "T123",
      team: "OpenClaw",
    });

    await expect(probeSlack("xoxp-user-token", 2500, { accountId: "work" })).resolves.toMatchObject(
      {
        ok: true,
        warning:
          'Slack auth.test identified account "work" as user UUSER without bot_id. channels.slack.accounts.work.botToken appears to contain a user token; replace it with a Bot User OAuth Token. Until replaced, explicit bot-mention detection is disabled and required-mention channels fail closed.',
      },
    );
  });

  it("maps a human auth.test identity for user identity", async () => {
    authTestMock.mockResolvedValue({
      ok: true,
      user_id: "UUSER",
      user: "test-human",
      team_id: "T123",
      team: "OpenClaw",
    });

    await expect(probeSlack("test-user-token", 2500, { identity: "user" })).resolves.toMatchObject({
      ok: true,
      user: { id: "UUSER", name: "test-human" },
      team: { id: "T123", name: "OpenClaw" },
    });
  });

  it("rejects a bot token in the user identity slot", async () => {
    authTestMock.mockResolvedValue({
      ok: true,
      user_id: "UBOT",
      bot_id: "BBOT",
      user: "test-bot",
    });

    await expect(probeSlack("test-user-token", 2500, { identity: "user" })).resolves.toMatchObject({
      ok: false,
      error: "Slack auth.test identified a bot token; user identity requires a user OAuth token",
    });
  });

  it("rejects user identity auth.test responses without a human user_id", async () => {
    authTestMock.mockResolvedValue({ ok: true, user: "test-human" });

    await expect(probeSlack("test-user-token", 2500, { identity: "user" })).resolves.toMatchObject({
      ok: false,
      error: "Slack auth.test returned no human user_id for user identity",
    });
  });

  it("keeps optional auth metadata fields undefined when Slack omits them", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(200).mockReturnValueOnce(235);
    authTestMock.mockResolvedValue({ ok: true });

    const result = await probeSlack("xoxb-test");

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.elapsedMs).toBe(35);
    expect(result.bot).toStrictEqual({ id: undefined, name: undefined });
    expect(result.team).toStrictEqual({ id: undefined, name: undefined });
    // The default timeout still flows into the client's abort-capable request timeout.
    expect(createSlackWebClientMock).toHaveBeenCalledWith("xoxb-test", ABORTABLE_CLIENT_OPTIONS);
  });

  it("fails and builds an abortable client when the request times out (#106565)", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValueOnce(2600);
    // Mirror the WebClient's Axios timeout: it rejects after aborting the
    // underlying request. probeSlack must surface a failure and must have built
    // the client with the request timeout that performs that abort.
    const timeoutError = Object.assign(new Error("timeout of 2500ms exceeded"), {
      code: "ECONNABORTED",
    });
    authTestMock.mockRejectedValue(timeoutError);

    const result = await probeSlack("xoxb-test", 2500);

    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.elapsedMs).toBe(2500);
    expect(typeof result.error).toBe("string");
    expect(createSlackWebClientMock).toHaveBeenCalledWith("xoxb-test", ABORTABLE_CLIENT_OPTIONS);
  });
});
