import { beforeEach, describe, expect, it, vi } from "vitest";
import "./test-mocks.js";

const { runtimeFetchMock } = vi.hoisted(() => ({
  runtimeFetchMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-fetch", () => ({
  fetchWithRuntimeDispatcherOrMockedGlobal: runtimeFetchMock,
}));

import { blueBubblesFetchWithTimeout } from "./types.js";

describe("blueBubblesFetchWithTimeout", () => {
  beforeEach(() => {
    runtimeFetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("preserves a pinned dispatcher by routing through the runtime fetch helper", async () => {
    const globalFetch = vi.fn();
    vi.stubGlobal("fetch", globalFetch);
    const response = new Response("ok", { status: 200 });
    runtimeFetchMock.mockResolvedValueOnce(response);
    const dispatcher = { kind: "pinned-dispatcher" };

    const result = await blueBubblesFetchWithTimeout(
      "https://bluebubbles.example.com/api/v1/test",
      {
        dispatcher,
        headers: { "x-test": "1" },
      } as RequestInit & { dispatcher: unknown },
      250,
    );

    expect(result).toBe(response);
    expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
    expect(runtimeFetchMock).toHaveBeenCalledWith(
      "https://bluebubbles.example.com/api/v1/test",
      expect.objectContaining({
        dispatcher,
        headers: { "x-test": "1" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("falls back to the ambient fetch when no dispatcher is attached", async () => {
    const globalFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", globalFetch);
    const response = new Response("ok", { status: 200 });
    runtimeFetchMock.mockResolvedValueOnce(response);

    const result = await blueBubblesFetchWithTimeout(
      "https://bluebubbles.example.com/api/v1/test",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      250,
    );

    expect(result).toBe(response);
    expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
    expect(runtimeFetchMock).toHaveBeenCalledWith(
      "https://bluebubbles.example.com/api/v1/test",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(globalFetch).not.toHaveBeenCalled();
  });
});
