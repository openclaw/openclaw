import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi } from "vitest";
import { resolveNextcloudTalkAccount } from "./accounts.js";
import { probeNextcloudTalkBotResponseFeature } from "./bot-preflight.js";
import * as guardedResponse from "./guarded-response.js";
import { sendMessageNextcloudTalk, sendReactionNextcloudTalk } from "./send.js";
import type { CoreConfig } from "./types.js";

const REQUEST_TIMEOUT_MS = 30_000;
const BOT_PATH = "/ocs/v2.php/apps/spreed/api/v1/bot/abc123";
type Operation = "message" | "reaction" | "preflight";

function observe(pending: Promise<unknown>) {
  const state = { settled: false, result: pending.catch((error: unknown) => error) };
  state.result = state.result.finally(() => {
    state.settled = true;
  });
  return state;
}

function send(operation: Operation, baseUrl: string) {
  const account = {
    baseUrl,
    botSecret: "test-secret",
    apiUser: "test-admin",
    apiPassword: "test-password",
    webhookPublicUrl: "https://bot.example.test/hook",
    network: { dangerouslyAllowPrivateNetwork: true },
  };
  const cfg: CoreConfig = { channels: { "nextcloud-talk": account } };
  const opts = { cfg };
  return operation === "preflight"
    ? probeNextcloudTalkBotResponseFeature({ account: resolveNextcloudTalkAccount({ cfg }) })
    : operation === "message"
      ? sendMessageNextcloudTalk("room:abc123", "hello", opts)
      : sendReactionNextcloudTalk("room:abc123", "m-1", "ok", opts);
}

async function expectHangingTalkRequestTimesOut(operation: "message" | "reaction") {
  const received = createDeferred<void>();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await withServer(
      (request) => {
        const suffix = operation === "message" ? "message" : "reaction/m-1";
        expect(request).toMatchObject({ method: "POST", url: `${BOT_PATH}/${suffix}` });
        request.resume();
        received.resolve();
      },
      async (baseUrl) => {
        const pending = observe(send(operation, baseUrl));
        await Promise.race([
          received.promise,
          pending.result.then(() => {
            throw new Error("Request settled before the server received it");
          }),
        ]);
        expect(pending.settled).toBe(false);
        await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
        const thrown = await pending.result;
        expect(thrown).toBeInstanceOf(Error);
        expect(thrown).toMatchObject({
          name: expect.stringMatching(/^(AbortError|TimeoutError)$/),
        });
      },
    );
  } finally {
    vi.useRealTimers();
  }
}

function captureStalledErrorBodyDeadline() {
  const readBody = guardedResponse.readNextcloudTalkErrorBody;
  const ready = createDeferred<void>();
  let refreshes = 0;
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
            refreshes += 1;
            if (refreshes === 2) {
              ready.resolve();
            }
            return refresh();
          });
          restoreRefresh = () => refreshSpy.mockRestore();
          fireDeadline = () => {
            clearTimeout(timer);
            callback(...timerArgs);
          };
          return timer;
        });
      // This async reader installs its idle timer before returning; exclude socket timers.
      const pending = readBody(...args);
      timerSpy.mockRestore();
      return pending;
    });
  return {
    async fire(pending: ReturnType<typeof observe>) {
      // Refresh precedes each reader.read(); this observes the next read, not its byte count.
      const readyFirst = await Promise.race([
        ready.promise.then(() => true),
        pending.result.then(() => false),
      ]);
      expect(readyFirst).toBe(true);
      expect(pending.settled).toBe(false);
      expect(delay).toBe(10_000);
      expectDefined(fireDeadline, "native error-body deadline")();
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

it.each(["message", "reaction", "preflight"] as const)(
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
          response[mode === "stalled" ? "write" : "end"](body);
        },
        async (baseUrl) => {
          const deadline = mode === "stalled" ? captureStalledErrorBodyDeadline() : undefined;
          const pending = observe(send(operation, baseUrl));
          let result: unknown;
          try {
            await deadline?.fire(pending);
            result = await pending.result;
          } finally {
            // Keep the native deadline as fallback if readiness assertions fail.
            await pending.result;
            deadline?.restore();
          }
          if (operation === "preflight" && result instanceof Error) {
            throw result;
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

  await withServer(
    (request, response) => {
      expect(request).toMatchObject({ method: "POST", url: `${BOT_PATH}/message` });
      request.resume();
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end(`${prefix}\u{1F600}tail`);
    },
    (baseUrl) =>
      expect(send("message", baseUrl)).rejects.toThrow(
        new Error(`Nextcloud Talk: bad request - ${prefix}…`),
      ),
  );
});
it.each(["message", "reaction"] as const)(
  "bounds hanging %s sends",
  expectHangingTalkRequestTimesOut,
);
