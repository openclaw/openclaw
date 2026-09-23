import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { resolveNextcloudTalkAccount } from "./accounts.js";
import { probeNextcloudTalkBotResponseFeature } from "./bot-preflight.js";
import * as guardedResponse from "./guarded-response.js";
import { sendMessageNextcloudTalk, sendReactionNextcloudTalk } from "./send.js";
import type { CoreConfig } from "./types.js";

const REQUEST_TIMEOUT_MS = 50;

function createTalkConfig(baseUrl: string): CoreConfig {
  return {
    channels: {
      "nextcloud-talk": {
        baseUrl,
        botSecret: "test-secret",
        apiUser: "test-admin",
        apiPassword: "test-password",
        webhookPublicUrl: "https://bot.example.test/hook",
        network: { dangerouslyAllowPrivateNetwork: true },
      },
    },
  };
}

async function expectHangingTalkRequestTimesOut(params: {
  path: string;
  run: (baseUrl: string) => Promise<unknown>;
}): Promise<void> {
  let received = false;
  await withServer(
    (request) => {
      received = true;
      expect(request.method).toBe("POST");
      expect(request.url).toBe(params.path);
      request.resume();
    },
    async (baseUrl) => {
      let thrown: unknown;
      try {
        await params.run(baseUrl);
      } catch (error) {
        thrown = error;
      }

      expect(received).toBe(true);
      if (!(thrown instanceof Error)) {
        throw new Error(`expected request timeout, received ${String(thrown)}`);
      }
      expect(["AbortError", "TimeoutError"]).toContain(thrown.name);
    },
  );
}

function captureStalledErrorBodyDeadline() {
  const readBody = guardedResponse.readNextcloudTalkErrorBody;
  const ready = createDeferred<void>();
  let refreshes = 0;
  let fires = 0;
  let delay: number | undefined;
  let fireDeadline: (() => void) | undefined;
  let restoreRefresh: (() => void) | undefined;
  const bodySpy = vi
    .spyOn(guardedResponse, "readNextcloudTalkErrorBody")
    .mockImplementationOnce((...args) => {
      const schedule = globalThis.setTimeout;
      const timerSpy = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementationOnce((callback, ms, ...timerArgs) => {
          const timer = schedule(callback, ms, ...timerArgs);
          delay = ms;
          const refresh = timer.refresh.bind(timer);
          const refreshSpy = vi.spyOn(timer, "refresh").mockImplementation(() => {
            const result = refresh();
            refreshes += 1;
            if (refreshes === 2) {
              ready.resolve();
            }
            return result;
          });
          restoreRefresh = () => refreshSpy.mockRestore();
          fireDeadline = () => {
            clearTimeout(timer);
            fires += 1;
            callback(...timerArgs);
          };
          return timer;
        });
      try {
        // The idle timer is installed synchronously; socket timers stay outside this scope.
        return readBody(...args);
      } finally {
        timerSpy.mockRestore();
      }
    });
  return {
    ready: ready.promise,
    assertReady() {
      // Refresh precedes each reader.read(); this observes the next read, not its byte count.
      expect(refreshes).toBeGreaterThanOrEqual(2);
      expect(bodySpy).toHaveBeenCalledOnce();
      expect(delay).toBe(10_000);
      expect(fires).toBe(0);
    },
    fire() {
      expect(fires).toBe(0);
      if (!fireDeadline) {
        throw new Error("expected the native error-body deadline");
      }
      fireDeadline();
      expect(fires).toBe(1);
    },
    restore() {
      try {
        restoreRefresh?.();
      } finally {
        bodySpy.mockRestore();
      }
    },
  };
}

describe("nextcloud-talk send error responses", () => {
  it.each(["message", "reaction", "preflight"])(
    "redacts reflected credentials and drops incomplete %s error bodies",
    async (operation) => {
      for (const mode of ["complete", "display-boundary", "oversized", "stalled"]) {
        let credential = "";
        await withServer(
          (request, response) => {
            request.resume();
            credential = String(
              request.headers["x-nextcloud-talk-bot-signature"] ??
                request.headers.authorization?.replace(/^Basic /, ""),
            );
            expect(credential).not.toBe("undefined");
            response.writeHead(500, { "content-type": "text/plain" });
            // Put a secret across the read cap: exposing a prefix defeats exact redaction.
            const body =
              mode === "oversized"
                ? `${"x".repeat(8192 - 16)}${credential}`
                : `upstream rejected ${mode === "display-boundary" ? "x".repeat(160) : ""}${credential}; password=fixture-private-value${
                    request.headers.authorization ? "; decoded test-password" : ""
                  }`;
            if (mode === "stalled") {
              response.write(body);
            } else {
              response.end(body);
            }
          },
          async (baseUrl) => {
            const cfg = createTalkConfig(baseUrl);
            const deadline = mode === "stalled" ? captureStalledErrorBodyDeadline() : undefined;
            const pending =
              operation === "preflight"
                ? probeNextcloudTalkBotResponseFeature({
                    account: resolveNextcloudTalkAccount({ cfg }),
                  })
                : (operation === "message"
                    ? sendMessageNextcloudTalk("room:abc123", "hello", { cfg })
                    : sendReactionNextcloudTalk("room:abc123", "m-1", "ok", { cfg })
                  ).catch((error: unknown) => error);
            let settled = false;
            const operationSettled = pending.then(
              () => {
                settled = true;
              },
              () => {
                settled = true;
              },
            );
            let result: Awaited<typeof pending>;
            try {
              if (deadline) {
                const readyFirst = await Promise.race([
                  deadline.ready.then(() => true),
                  operationSettled.then(() => false),
                ]);
                expect(readyFirst).toBe(true);
                expect(settled).toBe(false);
                deadline.assertReady();
                deadline.fire();
              }
              result = await pending;
            } finally {
              try {
                // Keep the real native deadline as the fallback if readiness assertions fail.
                await pending.catch(() => undefined);
              } finally {
                deadline?.restore();
              }
            }
            const message =
              typeof result === "object" && result !== null && "message" in result
                ? result.message
                : undefined;
            expect(message).toBeTypeOf("string");
            expect(message).not.toContain(credential);
            expect(message).not.toContain(credential.slice(0, 16));
            expect(message).not.toContain("fixture-private-value");
            expect(message).not.toContain("test-password");
            if (mode === "oversized" || mode === "stalled") {
              expect(message).not.toContain("xxxxxxxx");
              expect(message).not.toContain("upstream rejected");
              expect(message).toContain("500");
            } else {
              expect(message).toContain("upstream rejected");
              expect(message).toContain("***");
            }
          },
        );
      }
    },
    15_000,
  );

  it("keeps send error body snippets UTF-16 safe", async () => {
    const prefix = "e".repeat(199);
    const errorBody = `${prefix}\u{1F600}tail`;

    await withServer(
      (request, response) => {
        expect(request.method).toBe("POST");
        expect(request.url).toBe("/ocs/v2.php/apps/spreed/api/v1/bot/abc123/message");
        request.resume();
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end(errorBody);
      },
      async (baseUrl) => {
        await expect(
          sendMessageNextcloudTalk("room:abc123", "hello", {
            cfg: createTalkConfig(baseUrl),
          }),
        ).rejects.toThrow(new Error(`Nextcloud Talk: bad request - ${prefix}…`));
      },
    );
  });
});

describe("nextcloud-talk send fetch timeouts", () => {
  it("bounds hanging message and reaction sends", async () => {
    await expectHangingTalkRequestTimesOut({
      path: "/ocs/v2.php/apps/spreed/api/v1/bot/abc123/message",
      run: async (baseUrl) =>
        sendMessageNextcloudTalk("room:abc123", "hello", {
          cfg: createTalkConfig(baseUrl),
          timeoutMs: REQUEST_TIMEOUT_MS,
        }),
    });
    await expectHangingTalkRequestTimesOut({
      path: "/ocs/v2.php/apps/spreed/api/v1/bot/abc123/reaction/m-1",
      run: async (baseUrl) =>
        sendReactionNextcloudTalk("room:abc123", "m-1", "ok", {
          cfg: createTalkConfig(baseUrl),
          timeoutMs: REQUEST_TIMEOUT_MS,
        }),
    });
  });
});
