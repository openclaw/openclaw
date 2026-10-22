import { afterEach, describe, expect, it, vi } from "vitest";
import { mockMatrixQaHttp } from "../substrate/http.test-support.js";
import { createMatrixQaE2eeTestContext } from "./scenario-runtime-e2ee.test-helpers.js";
import {
  createMatrixQaScenarioClient,
  resolveMatrixQaNoReplyWindowMs,
  runNoReplyExpectedScenario,
  truncateMatrixQaPreview,
} from "./scenario-runtime-shared.js";
import { matrixMessage, matrixSyncResponse } from "./scenario-runtime.test-support.js";

describe("matrix scenario runtime shared", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("normalizes the Matrix QA no-reply window env", () => {
    expect(resolveMatrixQaNoReplyWindowMs(30_000)).toBe(8_000);

    vi.stubEnv("OPENCLAW_QA_MATRIX_NO_REPLY_WINDOW_MS", "12000");
    expect(resolveMatrixQaNoReplyWindowMs(30_000)).toBe(12_000);
    expect(resolveMatrixQaNoReplyWindowMs(5_000)).toBe(5_000);

    for (const value of ["1e3", "0x1000", "1.5", "nope"]) {
      vi.stubEnv("OPENCLAW_QA_MATRIX_NO_REPLY_WINDOW_MS", value);
      expect(resolveMatrixQaNoReplyWindowMs(30_000)).toBe(8_000);
    }
  });

  it("reuses buffered actor observations across clients without joining another actor or environment", async () => {
    const requests: string[] = [];
    mockMatrixQaHttp(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const token = new Headers(init?.headers).get("authorization") ?? "";
      requests.push(`${token}:${url.searchParams.get("since") ?? "prime"}`);
      return url.searchParams.has("since")
        ? matrixSyncResponse(
            "!room:test",
            ["first", "second"].map((id) => matrixMessage(`$${id}`, `${token}:${id}`)),
          )
        : Response.json({ next_batch: "next", rooms: {} });
    });
    const firstEnvironment = {};
    for (const [actorId, accessToken, syncStreams] of [
      ["driver", "driver-a", firstEnvironment],
      ["observer", "observer-a", firstEnvironment],
      ["driver", "driver-b", {}],
    ] as const) {
      const params = {
        accessToken,
        actorId,
        baseUrl: "http://127.0.0.1:28008/",
        observedEvents: [],
        syncStreams,
      };
      for (const id of ["first", "second"]) {
        const client = createMatrixQaScenarioClient(params);
        await client.primeRoom();
        const result = await client.waitForRoomEvent({
          observedEvents: params.observedEvents,
          predicate: (event) => event.eventId === `$${id}`,
          roomId: "!room:test",
          timeoutMs: 1_000,
        });
        expect(result.event.body).toBe(`Bearer ${accessToken}:${id}`);
      }
    }
    expect(requests).toEqual(
      ["driver-a", "observer-a", "driver-b"].flatMap((token) =>
        ["prime", "next"].map((cursor) => `Bearer ${token}:${cursor}`),
      ),
    );
  });

  it.each([
    { observeTrigger: false, reply: false, error: "did not observe the trigger event" },
    { observeTrigger: true, reply: false, error: undefined },
    { observeTrigger: true, reply: true, error: "unexpected SUT reply" },
  ])(
    "requires observed ingress throughout the no-reply window (trigger=$observeTrigger, reply=$reply)",
    async ({ observeTrigger, reply, error }) => {
      vi.useFakeTimers();
      let polls = 0;
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (init?.method === "PUT") {
          return Response.json({ event_id: "$trigger" });
        }
        if (!url.searchParams.has("since")) {
          return Response.json({ next_batch: "primed" });
        }
        polls += 1;
        if (polls > 1) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, Number(url.searchParams.get("timeout")));
          });
        }
        const event =
          polls === 1 && observeTrigger
            ? matrixMessage("$trigger", "marker", "@observer:matrix-qa.test")
            : polls > 1 && reply
              ? matrixMessage("$reply", "marker", "@sut:matrix-qa.test")
              : undefined;
        return matrixSyncResponse("!room:matrix-qa.test", event ? [event] : [], `batch-${polls}`);
      };
      mockMatrixQaHttp(fetchImpl);
      let settled = false;
      const pending = runNoReplyExpectedScenario({
        ...createMatrixQaE2eeTestContext({ baseUrl: "http://127.0.0.1:28008/", timeoutMs: 8_000 }),
        actorId: "observer",
        actorUserId: "@observer:matrix-qa.test",
        accessToken: "token",
        body: "marker",
        token: "marker",
      }).then(
        (value) => ({ value }),
        (failure: unknown) => ({ error: failure }),
      );
      void pending.then(() => {
        settled = true;
      });
      try {
        await vi.advanceTimersByTimeAsync(7_999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        const result = await pending;
        expect(result).toMatchObject(
          error
            ? {
                error: expect.objectContaining({ message: expect.stringContaining(error) }),
              }
            : {
                value: {
                  details:
                    "trigger event: $trigger\ntrigger sender: @observer:matrix-qa.test\nwaited 8000ms with no SUT reply",
                },
              },
        );
      } finally {
        await vi.runAllTimersAsync();
        await pending;
        vi.useRealTimers();
      }
    },
  );

  it("keeps every shared Matrix preview UTF-16 safe", () => {
    const prefix = "a".repeat(199);
    expect(truncateMatrixQaPreview(`${prefix}😀tail`)).toBe(prefix);
  });
});
