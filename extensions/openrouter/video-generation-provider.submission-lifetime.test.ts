import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import { expect, it } from "vitest";
import { buildOpenRouterVideoGenerationProvider } from "./video-generation-provider.js";

const { postJsonRequestMock, fetchWithTimeoutGuardedMock } = getProviderHttpMocks();
installProviderHttpMockCleanup();

it("releases the submitted job before polling and downloading its video", async () => {
  const events: string[] = [];
  postJsonRequestMock.mockResolvedValue({
    response: Response.json({
      id: "job-123",
      polling_url: "/api/v1/videos/job-123",
      status: "pending",
    }),
    release: async () => {
      events.push("release");
    },
  });
  fetchWithTimeoutGuardedMock
    .mockImplementationOnce(async () => {
      events.push("poll");
      return {
        response: Response.json({ id: "job-123", status: "completed" }),
        release: async () => {},
      };
    })
    .mockImplementationOnce(async () => {
      events.push("download");
      return {
        response: new Response("video-bytes", {
          headers: { "content-type": "video/mp4" },
        }),
        release: async () => {},
      };
    });

  await buildOpenRouterVideoGenerationProvider().generateVideo({
    provider: "openrouter",
    model: "google/veo-3.1",
    prompt: "submission lifetime",
    cfg: {},
  });

  expect(events).toEqual(["release", "poll", "download"]);
});
