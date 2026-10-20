// QA Lab Matrix tests cover scenario runtime shared plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockMatrixQaHttp } from "../substrate/http.test-support.js";
import {
  buildMatrixReplyArtifact,
  createMatrixQaScenarioClient,
  resolveMatrixQaNoReplyWindowMs,
  runNoReplyExpectedScenario,
  truncateMatrixQaPreview,
} from "./scenario-runtime-shared.js";

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
      return Response.json({
        next_batch: "next",
        rooms: url.searchParams.has("since")
          ? {
              join: {
                "!room:test": {
                  timeline: {
                    events: ["first", "second"].map((id) => ({
                      event_id: `$${id}`,
                      sender: "@sut:test",
                      type: "m.room.message",
                      content: { body: `${token}:${id}` },
                    })),
                  },
                },
              },
            }
          : {},
      });
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
    expect(requests).toEqual([
      "Bearer driver-a:prime",
      "Bearer driver-a:next",
      "Bearer observer-a:prime",
      "Bearer observer-a:next",
      "Bearer driver-b:prime",
      "Bearer driver-b:next",
    ]);
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
            ? { event_id: "$trigger", sender: "@observer:matrix-qa.test" }
            : polls > 1 && reply
              ? { event_id: "$reply", sender: "@sut:matrix-qa.test" }
              : undefined;
        return Response.json({
          next_batch: `batch-${polls}`,
          rooms: {
            join: {
              "!room:matrix-qa.test": {
                timeline: {
                  events: event
                    ? [{ ...event, type: "m.room.message", content: { body: "marker" } }]
                    : [],
                },
              },
            },
          },
        });
      };
      mockMatrixQaHttp(fetchImpl);
      let settled = false;
      const pending = runNoReplyExpectedScenario({
        accessToken: "token",
        actorId: "observer",
        actorUserId: "@observer:matrix-qa.test",
        baseUrl: "http://127.0.0.1:28008/",
        body: "marker",
        observedEvents: [],
        roomId: "!room:matrix-qa.test",
        syncStreams: {},
        sutUserId: "@sut:matrix-qa.test",
        timeoutMs: 8_000,
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
        if (error) {
          expect(result).toMatchObject({
            error: expect.objectContaining({ message: expect.stringContaining(error) }),
          });
        } else {
          expect(result).toMatchObject({
            value: {
              details:
                "trigger event: $trigger\ntrigger sender: @observer:matrix-qa.test\nwaited 8000ms with no SUT reply",
            },
          });
        }
      } finally {
        await vi.runAllTimersAsync();
        await pending;
        vi.useRealTimers();
      }
    },
  );

  it("keeps every shared Matrix preview UTF-16 safe", () => {
    const prefix = "a".repeat(199);
    const event = {
      kind: "message" as const,
      roomId: "!room:matrix-qa.test",
      eventId: "$event",
      sender: "@sut:matrix-qa.test",
      type: "m.room.message",
    };
    expect(truncateMatrixQaPreview(`${prefix}😀tail`)).toBe(prefix);
    expect(buildMatrixReplyArtifact({ ...event, body: `${prefix}😀tail` }).bodyPreview).toBe(
      prefix,
    );
    expect(buildMatrixReplyArtifact({ ...event, body: " " }).bodyPreview).toBe("");
  });
});
