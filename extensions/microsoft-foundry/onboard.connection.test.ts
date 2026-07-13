// Microsoft Foundry tests cover bounded connection-test error reads.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as cli from "./cli.js";
import { testFoundryConnection } from "./onboard.js";
import { DEFAULT_API } from "./shared.js";

const hoisted = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: hoisted.fetchWithSsrFGuard,
}));

function cancelTrackedResponse(
  text: string,
  init: ResponseInit,
): {
  response: Response;
  wasCanceled: () => boolean;
} {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    response: new Response(stream, init),
    wasCanceled: () => canceled,
  };
}

describe("testFoundryConnection", () => {
  beforeEach(() => {
    vi.spyOn(cli, "getAccessTokenResult").mockReturnValue({ accessToken: "token" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    hoisted.fetchWithSsrFGuard.mockReset();
  });

  it("bounds connection-test error bodies without using response.text()", async () => {
    const note = vi.fn();
    const tracked = cancelTrackedResponse(`${"foundry failure ".repeat(1024)}tail`, {
      status: 503,
      headers: { "content-type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    hoisted.fetchWithSsrFGuard.mockResolvedValue({
      response: tracked.response,
      release: async () => {},
    });

    await testFoundryConnection({
      ctx: { prompter: { note } } as never,
      endpoint: "https://example.openai.azure.com",
      modelId: "gpt-4o",
      api: DEFAULT_API,
    });

    expect(textSpy).not.toHaveBeenCalled();
    expect(tracked.wasCanceled()).toBe(true);
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Warning: test request returned 503"),
      "Connection Test",
    );
  });
});
