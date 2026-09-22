import { describe, expect, it } from "vitest";
import { readQaMockRequestCursor } from "../shared/debug-request-cursor.js";
import {
  createMockServerTestHarness,
  expectOpenAiNonStreamingResponsesJson,
  getJson,
  makeUserInput,
  requireArray,
  requireRecord,
} from "./server.test-harness.js";

const { startMockServer } = createMockServerTestHarness();

describe("qa mock openai server", () => {
  it("keeps cursor reads correct when retained debug requests rotate", async () => {
    const server = await startMockServer();
    const debugRequestLimit = 2_000;
    const readCursor = async () =>
      readQaMockRequestCursor(
        await fetch(`${server.baseUrl}/debug/request-cursor`).then((response) => response.json()),
      );

    const sendRequest = (index: number) =>
      expectOpenAiNonStreamingResponsesJson(server, {
        input: [makeUserInput(`cursor request ${index}`)],
      });

    expect(await readCursor()).toBe(0);
    // Keep the evicted request and its retained successor ordered.
    await sendRequest(0);
    await sendRequest(1);
    const batchSize = 32;
    for (let start = 2; start < debugRequestLimit; start += batchSize) {
      const results = await Promise.allSettled(
        Array.from({ length: Math.min(batchSize, debugRequestLimit - start) }, (_, offset) =>
          sendRequest(start + offset),
        ),
      );
      // Join the whole batch before reporting a failure or issuing overflow.
      for (const result of results) {
        if (result.status === "rejected") {
          throw result.reason;
        }
      }
    }
    const cursor = await readCursor();
    expect(cursor).toBe(debugRequestLimit);

    await expectOpenAiNonStreamingResponsesJson(server, {
      input: [makeUserInput("cursor request overflow")],
    });

    const retained = requireArray(
      await getJson(server, "/debug/requests"),
      "retained debug requests",
    );
    expect(retained).toHaveLength(debugRequestLimit);
    expect(requireRecord(retained[0], "retained request 0").cursor).toBe(2);
    expect(requireRecord(retained.at(-1), "last retained request").cursor).toBe(
      debugRequestLimit + 1,
    );
    expect(String(requireRecord(retained[0], "retained request 0").allInputText)).toContain(
      "cursor request 1",
    );
    expect(String(requireRecord(retained.at(-1), "last retained request").allInputText)).toContain(
      "cursor request overflow",
    );

    const nextRequests = requireArray(
      await fetch(`${server.baseUrl}/debug/requests?after=${cursor}`).then((response) =>
        response.json(),
      ),
      "debug requests after cursor",
    );
    expect(nextRequests).toHaveLength(1);
    expect(String(requireRecord(nextRequests[0], "next request").prompt)).toContain("overflow");

    const expired = await fetch(`${server.baseUrl}/debug/requests?after=0`);
    expect(expired.status).toBe(409);
    expect(await expired.json()).toEqual({
      error: "request cursor expired",
      after: 0,
      oldestCursor: 2,
      latestCursor: debugRequestLimit + 1,
    });

    const futureCursor = debugRequestLimit + 2;
    const future = await fetch(`${server.baseUrl}/debug/requests?after=${futureCursor}`);
    expect(future.status).toBe(409);
    expect(await future.json()).toEqual({
      error: "request cursor is ahead of the latest recorded request",
      after: futureCursor,
      latestCursor: debugRequestLimit + 1,
    });

    const invalid = await fetch(`${server.baseUrl}/debug/requests?after=1.5`);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: "after must be a non-negative safe integer",
    });
  });
});
