/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DISCORD_ACTIVITY_SHELL_JS } from "./shell.js";

const IMPORT_LINE = 'import { DiscordSDK } from "./vendor/embedded-app-sdk.mjs";';

type ScheduledTimeout = {
  callback: () => void;
  delayMs: number;
  id: number;
};

function executeShell(fetchMock: ReturnType<typeof vi.fn>) {
  const scheduledTimeouts: ScheduledTimeout[] = [];
  const activeTimeouts = new Map<number, ScheduledTimeout>();
  const clearTimeoutSpy = vi.fn((id: number) => {
    activeTimeouts.delete(id);
  });
  const ready = vi.fn(async () => {});
  const authorize = vi.fn(async () => ({ code: "authorization-code" }));
  const authenticate = vi.fn(async () => ({}));
  const scheduleTimeout = (callback: () => void, delayMs: number) => {
    const id = scheduledTimeouts.length + 1;
    const timeout = { callback, delayMs, id };
    scheduledTimeouts.push(timeout);
    activeTimeouts.set(id, timeout);
    return id;
  };
  class DiscordSDK {
    customId = "widget-1";
    instanceId = "instance-1";
    commands = { authorize, authenticate };

    ready = ready;
  }
  const activityWindow = {
    location: {
      hostname: "123.discordsays.com",
      origin: "https://123.discordsays.com",
    },
  };
  const bootstrap = DISCORD_ACTIVITY_SHELL_JS.replace(IMPORT_LINE, "");
  if (bootstrap === DISCORD_ACTIVITY_SHELL_JS) {
    throw new Error("Discord Activity shell import did not match the test harness");
  }

  // oxlint-disable-next-line typescript/no-implied-eval -- Execute the generated shell itself so timeout coverage cannot drift into a reimplementation.
  new Function(
    "DiscordSDK",
    "window",
    "document",
    "AbortController",
    "setTimeout",
    "clearTimeout",
    "fetch",
    bootstrap,
  )(
    DiscordSDK,
    activityWindow,
    document,
    AbortController,
    scheduleTimeout,
    clearTimeoutSpy,
    fetchMock,
  );

  const fireTimeout = (id: number) => {
    const timeout = activeTimeouts.get(id);
    if (!timeout) {
      throw new Error(`timeout ${id} is no longer active`);
    }
    timeout.callback();
  };

  return { scheduledTimeouts, clearTimeoutSpy, fireTimeout };
}

function expectGatewayOffline() {
  expect(document.querySelector("h1")?.textContent).toBe("Gateway offline");
  expect(document.querySelector("iframe")).toBeNull();
}

describe("Discord Activity shell request timeout", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
  });

  it("expires a request that stalls before response headers", async () => {
    const fetchMock = vi.fn((_input: string, init: { signal: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    });
    const { scheduledTimeouts, clearTimeoutSpy, fireTimeout } = executeShell(fetchMock);

    await vi.waitFor(() => expect(scheduledTimeouts).toHaveLength(1));
    const requestTimeout = scheduledTimeouts[0];
    expect(requestTimeout?.delayMs).toBe(15_000);
    fireTimeout(requestTimeout?.id ?? -1);

    await vi.waitFor(expectGatewayOffline);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(scheduledTimeouts[0]?.id);
  });

  it("expires a successful response whose body stalls", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "access-token", session_token: "session-token" }),
          { headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockImplementationOnce((_input: string, init: { signal: AbortSignal }) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            init.signal.addEventListener("abort", () => controller.error(init.signal.reason), {
              once: true,
            });
          },
        });
        return Promise.resolve(
          new Response(body, { status: 200, headers: { "Content-Type": "application/json" } }),
        );
      });
    const { scheduledTimeouts, clearTimeoutSpy, fireTimeout } = executeShell(fetchMock);

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(scheduledTimeouts).toHaveLength(2);
    });
    const bodyTimeout = scheduledTimeouts[1];
    expect(bodyTimeout?.delayMs).toBe(15_000);
    expect(clearTimeoutSpy).not.toHaveBeenCalledWith(bodyTimeout?.id);
    fireTimeout(bodyTimeout?.id ?? -1);

    await vi.waitFor(expectGatewayOffline);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(scheduledTimeouts[1]?.id);
  });
});
