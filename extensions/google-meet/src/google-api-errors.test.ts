// Google Meet tests cover bounded Google API error handling.
import { describe, expect, it, vi } from "vitest";
import { cancelTrackedTextResponse } from "../../test-support/streaming-error-response.js";
import { fetchGoogleMeetSpace } from "./meet-api.js";

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: vi.fn(),
}));

import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

describe("Google Meet API errors", () => {
  it("bounds error bodies and preserves the operation scope before releasing the request", async () => {
    const body = `${"access denied ".repeat(1024)}tail`;
    const tracked = cancelTrackedTextResponse(body, {
      status: 403,
      headers: { "content-type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    const release = vi.fn(async () => {
      expect(tracked.wasCanceled()).toBe(true);
    });
    vi.mocked(fetchWithSsrFGuard).mockResolvedValueOnce({
      response: tracked.response,
      finalUrl: "https://meet.googleapis.com/v2/spaces/abc-defg-hij",
      release,
    });

    await expect(
      fetchGoogleMeetSpace({ accessToken: "test-token", meeting: "abc-defg-hij" }),
    ).rejects.toMatchObject({
      message:
        `Google Meet spaces.get failed (403): ${body.slice(0, 8 * 1024)}` +
        " Required OAuth scope: `https://www.googleapis.com/auth/meetings.space.readonly`." +
        " Re-run `openclaw googlemeet auth login` and store the refreshed oauth block.",
    });
    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("does not tell the user to re-authenticate when the meeting does not exist", async () => {
    vi.mocked(fetchWithSsrFGuard).mockResolvedValueOnce({
      response: new Response("Requested entity was not found.", {
        status: 404,
        headers: { "content-type": "text/plain" },
      }),
      finalUrl: "https://meet.googleapis.com/v2/spaces/abc-defg-hij",
      release: vi.fn(async () => {}),
    });

    await expect(
      fetchGoogleMeetSpace({ accessToken: "test-token", meeting: "abc-defg-hij" }),
    ).rejects.toMatchObject({
      message: "Google Meet spaces.get failed (404): Requested entity was not found.",
    });
  });
});
