import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchDiscordApplicationId,
  fetchDiscordApplicationSummary,
  probeDiscordApplicationId,
  probeDiscord,
  resolveDiscordPrivilegedIntentsFromFlags,
} from "./probe.js";
import { jsonResponse } from "./test-http-helpers.js";

const probeGetMe = (fetcher: typeof fetch, timeout = 1_000) =>
  probeDiscord("MTIz.abc.def", timeout, { fetcher });
const lookup = (fetcher: typeof fetch, timeout = 1_000) =>
  fetchDiscordApplicationId("unparseable.token", timeout, fetcher);
const jsonStream = (source: UnderlyingDefaultSource<Uint8Array>) =>
  new Response(new ReadableStream(source), { headers: { "content-type": "application/json" } });

const DISCORD_PROBE_JSON_CAP_BYTES = 16 * 1024 * 1024;
function oversizedDiscordProbeJsonResponse(onCancel: () => void): Response {
  const response = jsonStream({
    start(controller) {
      controller.enqueue(new Uint8Array(DISCORD_PROBE_JSON_CAP_BYTES + 1));
    },
    cancel: onCancel,
  });
  response.json = async () => {
    throw new Error("unbounded json reader was used");
  };
  return response;
}

function stalledJsonResponse(
  signal: AbortSignal | null | undefined,
  onTerminate: () => void,
  trickle = false,
): Response {
  let interval: ReturnType<typeof setInterval> | undefined;
  let terminated = false;
  const terminate = () => {
    if (terminated) {
      return;
    }
    terminated = true;
    if (interval) {
      clearInterval(interval);
    }
    onTerminate();
  };
  return jsonStream({
    start(controller) {
      const abort = () => {
        terminate();
        controller.error(signal?.reason ?? new Error("request aborted"));
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      if (trickle) {
        controller.enqueue(new TextEncoder().encode('{"id":"bot-1"'));
        interval = setInterval(() => controller.enqueue(new Uint8Array([0x20])), 10);
      }
      signal?.addEventListener("abort", abort, { once: true });
    },
    cancel: terminate,
  });
}

function rateLimitedResponse(retry = false) {
  return new Response("<html><title>Error 1015</title></html>", {
    status: 429,
    headers: { "content-type": "text/html", ...(retry ? { "retry-after": "0" } : {}) },
  });
}

describe("resolveDiscordPrivilegedIntentsFromFlags", () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    { state: "disabled", flags: 0 },
    { state: "enabled", flags: (1 << 12) | (1 << 14) | (1 << 18) },
    { state: "limited", flags: (1 << 13) | (1 << 15) | (1 << 19) },
  ])("reports $state intents", ({ state, flags }) => {
    expect(resolveDiscordPrivilegedIntentsFromFlags(flags)).toEqual({
      presence: state,
      guildMembers: state,
      messageContent: state,
    });
  });

  it("retries Cloudflare HTML rate limits during application id lookup", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rateLimitedResponse(true))
      .mockImplementation(async () => jsonResponse({ id: "app-1" }));
    const fetcher = withFetchPreconnect(fetchMock);
    vi.useFakeTimers();
    const pending = lookup(fetcher);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe("app-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    { status: 403, kind: "rejected" },
    { status: 503, kind: "unavailable" },
  ] as const)("classifies application id HTTP $status as $kind", async ({ status, kind }) => {
    vi.useFakeTimers();
    const fetcher = withFetchPreconnect(async () =>
      Response.json({ message: "probe failed" }, { status }),
    );
    const probe = probeDiscordApplicationId("unparseable.token", 1_000, fetcher);
    await vi.runAllTimersAsync();
    await expect(probe).resolves.toMatchObject({ kind, status });
  });

  it("does not retry Cloudflare HTML rate limits during application summary probes", async () => {
    const fetchMock = vi.fn(async () => rateLimitedResponse());
    const fetcher = withFetchPreconnect(fetchMock);
    await expect(
      fetchDiscordApplicationSummary("unparseable.token", 1_000, fetcher),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("cancels failed getMe probe response bodies", async () => {
    const cancel = vi.fn(async () => undefined);
    const fetcher = withFetchPreconnect(
      async () => ({ ok: false, status: 401, body: { cancel } }) as unknown as Response,
    );
    await expect(probeGetMe(fetcher)).resolves.toMatchObject({
      ok: false,
      status: 401,
      error: "getMe failed (401)",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid UTF-8 in getMe probe JSON responses", async () => {
    const body = Buffer.concat([
      Buffer.from('{"id":"bot-1","username":"bad'),
      Buffer.from([0xff]),
      Buffer.from('"}'),
    ]);
    const fetcher = withFetchPreconnect(
      async () =>
        new Response(body, { headers: { "content-type": "application/json" }, status: 200 }),
    );
    await expect(probeGetMe(fetcher)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("discord.probe.getMe: malformed JSON response"),
    });
  });

  it("bounds oversized getMe probe JSON responses and cancels the stream", async () => {
    const cancel = vi.fn();
    const fetcher = withFetchPreconnect(async () => oversizedDiscordProbeJsonResponse(cancel));
    await expect(probeGetMe(fetcher)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("discord.probe.getMe: JSON response exceeds 16777216 bytes"),
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("uses one total deadline across getMe headers and a trickling JSON body", async () => {
    vi.useFakeTimers();
    const terminated = vi.fn();
    const fetcher = withFetchPreconnect(async (_input, init) => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 30);
      });
      return stalledJsonResponse(init?.signal, terminated, true);
    });
    const pending = probeGetMe(fetcher, 50);
    const assertion = expect(pending).resolves.toMatchObject({
      ok: false,
      error: "discord.probe.getMe: JSON response timed out after 50ms",
    });
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(terminated).toHaveBeenCalledOnce();
  });

  it("bounds stalled application-summary response bodies during probes", async () => {
    vi.useFakeTimers();
    const terminated = vi.fn();
    const fetcher = withFetchPreconnect(async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/users/@me")) {
        return jsonResponse({ id: "bot-1", username: "openclaw" });
      }
      return stalledJsonResponse(init?.signal, terminated);
    });
    const probe = probeDiscord("MTIz.abc.def", 50, { fetcher, includeApplication: true });
    const outerStatusResult = Promise.race([
      probe,
      new Promise<{ ok: false; timedOut: true }>((resolve) => {
        setTimeout(() => resolve({ ok: false, timedOut: true }), 50);
      }),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(50);
    await expect(outerStatusResult).resolves.toMatchObject({
      ok: true,
      bot: { id: "bot-1", username: "openclaw" },
    });
    expect(terminated).toHaveBeenCalledOnce();
  });

  it("bounds stalled application-id response bodies", async () => {
    vi.useFakeTimers();
    const terminated = vi.fn();
    const fetcher = withFetchPreconnect(async (_input, init) =>
      stalledJsonResponse(init?.signal, terminated),
    );
    const pending = lookup(fetcher, 50);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toBeUndefined();
    expect(terminated).toHaveBeenCalledOnce();
  });

  it("derives application id from parseable tokens before probing REST", async () => {
    const fetchMock = vi.fn(async () => rateLimitedResponse());
    const fetcher = withFetchPreconnect(fetchMock);
    const applicationId = "1477179610322964541";
    const token = `Bot ${Buffer.from(applicationId).toString("base64")}.abc.def`;
    await expect(fetchDiscordApplicationId(token, 1_000, fetcher)).resolves.toBe(applicationId);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
