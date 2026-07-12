// Browser tests cover geolocation HTTP API behavior.
import { describe, expect, it } from "vitest";
import {
  installAgentContractHooks,
  postJson,
  startServerAndBase,
} from "./server.agent-contract.test-harness.js";
import { getPwMocks } from "./server.control-server.test-harness.js";
import { getBrowserTestFetch } from "./test-support/fetch.js";

type MockFn = {
  mock: { calls: unknown[][] };
  mockClear: () => void;
};

type HttpJsonResponse<T> = {
  status: number;
  body: T;
};

async function postSetGeolocation<T>(
  base: string,
  body: Record<string, unknown>,
): Promise<HttpJsonResponse<T>> {
  const realFetch = getBrowserTestFetch();
  const response = await realFetch(`${base}/set/geolocation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as T,
  };
}

function getGeolocationMock(): MockFn {
  return getPwMocks().setGeolocationViaPlaywright as MockFn;
}

function lastGeolocationCall(): Record<string, unknown> {
  const calls = getGeolocationMock().mock.calls;
  const call = calls.at(-1);
  const arg = call?.[0];
  if (!arg || typeof arg !== "object" || Array.isArray(arg)) {
    throw new Error("expected geolocation call argument");
  }
  return arg as Record<string, unknown>;
}

describe("browser control geolocation API", () => {
  installAgentContractHooks();

  it("normalizes set origins and preserves malformed-origin clear behavior", async () => {
    const base = await startServerAndBase();
    const geolocation = getGeolocationMock();
    geolocation.mockClear();

    const setResponse = await postJson<{ ok: boolean; targetId?: string }>(
      `${base}/set/geolocation`,
      {
        latitude: "48.2082",
        longitude: 16.3738,
        accuracy: "12.5",
        origin: "https://geo.example/path?query=1#hash",
        targetId: "abcd1234",
      },
    );

    expect(setResponse).toEqual({ ok: true, targetId: "abcd1234" });
    expect(lastGeolocationCall()).toMatchObject({
      cdpUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/),
      targetId: "abcd1234",
      latitude: 48.2082,
      longitude: 16.3738,
      accuracy: 12.5,
      origin: "https://geo.example",
    });

    const malformedSet = await postSetGeolocation<{ error?: string }>(base, {
      latitude: 48,
      longitude: 16,
      origin: "not a url",
      targetId: "abcd1234",
    });

    expect(malformedSet).toEqual({
      status: 400,
      body: { error: "origin must be an http(s) origin" },
    });
    expect(geolocation.mock.calls).toHaveLength(1);

    const clearResponse = await postJson<{ ok: boolean; targetId?: string }>(
      `${base}/set/geolocation`,
      {
        clear: true,
        origin: "not a url",
        targetId: "abcd1234",
      },
    );

    expect(clearResponse).toEqual({ ok: true, targetId: "abcd1234" });
    expect(geolocation.mock.calls).toHaveLength(2);
    expect(lastGeolocationCall()).toMatchObject({
      cdpUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/),
      targetId: "abcd1234",
      clear: true,
    });
    expect(lastGeolocationCall()).not.toHaveProperty("origin");
  });
});
