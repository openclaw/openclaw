// Tlon tests cover channel runtime behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authenticate } from "./urbit/auth.js";
import { urbitFetch } from "./urbit/fetch.js";

vi.mock("./urbit/auth.js", () => ({
  authenticate: vi.fn(),
}));

vi.mock("./urbit/fetch.js", () => ({
  urbitFetch: vi.fn(),
}));

import { createHttpPokeApi, probeTlonAccount } from "./channel.runtime.js";

const account = {
  accountId: "default",
  configured: true,
  ship: "~zod",
  url: "https://example.com",
  code: "sample-code",
} as never;

function responseWithCancelableBody(
  status: number,
  cancelBody: () => void | PromiseLike<void>,
): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      cancel: cancelBody,
    }),
    { status },
  );
}

describe("probeTlonAccount", () => {
  beforeEach(() => {
    vi.mocked(authenticate).mockReset();
    vi.mocked(urbitFetch).mockReset();
    vi.mocked(authenticate).mockResolvedValue("urbauth-~zod=fake-cookie");
  });

  it.each([
    { status: 200, expected: { ok: true } },
    { status: 503, expected: { ok: false, error: "Name request failed: 503" } },
  ])("cancels a $status response before releasing the guard", async ({ status, expected }) => {
    const events: string[] = [];
    const cancelBody = vi.fn(() => {
      events.push("cancel");
    });
    const release = vi.fn(async () => {
      events.push("release");
    });
    vi.mocked(urbitFetch).mockResolvedValue({
      response: responseWithCancelableBody(status, cancelBody),
      finalUrl: "https://example.com/~/name",
      release,
      refreshTimeout: vi.fn(),
    });

    await expect(probeTlonAccount(account)).resolves.toEqual(expected);

    expect(cancelBody).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(events).toEqual(["cancel", "release"]);
  });

  it("still releases the guard when response cancellation fails", async () => {
    const events: string[] = [];
    const response = new Response(new ReadableStream<Uint8Array>());
    const cancel = vi.spyOn(response.body!, "cancel").mockImplementationOnce(async () => {
      events.push("cancel");
      throw new Error("cancel failed");
    });
    const release = vi.fn(async () => {
      events.push("release");
    });
    vi.mocked(urbitFetch).mockResolvedValue({
      response,
      finalUrl: "https://example.com/~/name",
      release,
      refreshTimeout: vi.fn(),
    });

    await expect(probeTlonAccount(account)).resolves.toEqual({ ok: true });
    expect(cancel).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(events).toEqual(["cancel", "release"]);
  });
});

describe("createHttpPokeApi", () => {
  const pokeParams = {
    url: "https://example.com",
    code: "sample-code",
    ship: "~zod",
  };

  beforeEach(() => {
    vi.mocked(authenticate).mockReset();
    vi.mocked(urbitFetch).mockReset();
    vi.mocked(authenticate).mockResolvedValue("urbauth-~zod=fake-cookie");
  });

  it("cancels a successful poke response body before releasing the guard", async () => {
    const events: string[] = [];
    const cancelBody = vi.fn(() => {
      events.push("cancel");
    });
    const release = vi.fn(async () => {
      events.push("release");
    });
    vi.mocked(urbitFetch).mockResolvedValue({
      response: responseWithCancelableBody(200, cancelBody),
      finalUrl: "https://example.com/~/channel/test",
      release,
      refreshTimeout: vi.fn(),
    });

    const api = await createHttpPokeApi(pokeParams);
    await expect(api.poke({ app: "test-app", mark: "test-mark", json: {} })).resolves.toBeTypeOf(
      "number",
    );

    expect(cancelBody).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(events).toEqual(["cancel", "release"]);
  });

  it("still releases when poke response cancellation fails", async () => {
    const events: string[] = [];
    const response = new Response(new ReadableStream<Uint8Array>());
    const cancel = vi.spyOn(response.body!, "cancel").mockImplementationOnce(async () => {
      events.push("cancel");
      throw new Error("cancel failed");
    });
    const release = vi.fn(async () => {
      events.push("release");
    });
    vi.mocked(urbitFetch).mockResolvedValue({
      response,
      finalUrl: "https://example.com/~/channel/test",
      release,
      refreshTimeout: vi.fn(),
    });

    const api = await createHttpPokeApi(pokeParams);
    await expect(api.poke({ app: "test-app", mark: "test-mark", json: {} })).resolves.toBeTypeOf(
      "number",
    );

    expect(cancel).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(events).toEqual(["cancel", "release"]);
  });
});
