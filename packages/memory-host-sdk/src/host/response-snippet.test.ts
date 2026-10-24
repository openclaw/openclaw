import { describe, expect, it, vi } from "vitest";
import { withTestTimeout } from "../../../../test/helpers/promise.js";
import {
  readMemoryHostResponseTextSnippet as snippet,
  readResponseJsonWithLimit as json,
} from "./response-snippet.js";
import { createPendingResponse } from "./response-snippet.test-harness.js";

function read(kind: "snippet" | "json", response: Response, signal: AbortSignal) {
  return kind === "snippet"
    ? snippet(response, { signal })
    : json(response, { signal, errorPrefix: "fixture" });
}

describe("readMemoryHostResponseTextSnippet", () => {
  it.each(["snippet", "json"] as const)(
    "preserves non-Error abort messages for %s reads",
    async (kind) => {
      const controller = new AbortController();
      controller.abort("stop");
      const response = new Response("{}");
      const operation = read(kind, response, controller.signal);
      await expect(operation).rejects.toThrow(
        kind === "snippet"
          ? "Response snippet body read aborted"
          : "fixture: response body read aborted",
      );
      expect(response.body?.locked).toBe(false);
    },
  );

  it.each([
    ["UTF-8 byte cap", "abc€tail", { maxBytes: 5 }],
    ["surrogate pair character cap", "abc🤖tail", { maxChars: 4 }],
  ] as const)("keeps Unicode intact at the %s", async (_name, text, limits) => {
    await expect(snippet(new Response(text), limits)).resolves.toBe("abc... [truncated]");
  });

  it.each(["prefix", "overflow", "length", "preabort"] as const)(
    "settles %s reads while a response clone remains open",
    async (kind) => {
      const cancel = vi.fn();
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("abcdefgh"));
          },
          cancel,
        }),
        { headers: kind === "length" ? { "content-length": "16" } : {} },
      );
      const capture = response.clone();
      const parent = new AbortController();
      const expected = new Error("reader aborted");
      parent.abort(expected);
      const operation = (
        kind === "prefix" || kind === "preabort"
          ? snippet(response, {
              maxBytes: 4,
              signal: kind === "preabort" ? parent.signal : undefined,
            })
          : json(response, { maxBytes: 4, errorPrefix: "fixture" })
      ).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        const result = await Promise.race([
          operation,
          new Promise<undefined>((resolve) => {
            setImmediate(() => resolve(undefined));
          }),
        ]);
        const error =
          kind === "preabort"
            ? expected
            : new Error(
                `fixture: response body too large: ${kind === "length" ? 16 : 8} bytes (limit: 4 bytes)`,
              );
        expect(result).toEqual(kind === "prefix" ? { value: "abcd... [truncated]" } : { error });
        expect(response.body?.locked).toBe(false);
        expect(cancel).not.toHaveBeenCalled();
      } finally {
        await capture.body?.cancel();
        await operation;
      }
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("does not wait for another chunk after reading the byte cap exactly", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("abcd"));
      },
      cancel,
    });

    await expect(snippet(new Response(stream), { maxBytes: 4, maxChars: 100 })).resolves.toBe(
      "abcd... [truncated]",
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    ["snippet", undefined],
    ["json", undefined],
    ["json", '{"ok":true}'],
  ] as const)("cancels %s body reads when the caller aborts (prefix: %s)", async (kind, prefix) => {
    const fixture = createPendingResponse({ prefix });
    const controller = new AbortController();
    const expected = new Error(`${kind} aborted`);
    const settled = read(kind, fixture.response, controller.signal).then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await withTestTimeout(fixture.readStarted, 1_000, "read did not start");
      expect(fixture.response.body?.locked).toBe(true);
      controller.abort(expected);

      await expect(withTestTimeout(settled, 1_000, "abort did not settle")).resolves.toBe(expected);
      expect(fixture.cancel).toHaveBeenCalledOnce();
      expect(fixture.response.body?.locked).toBe(false);
    } finally {
      controller.abort(expected);
      fixture.dispose();
      await withTestTimeout(settled, 1_000, "cleanup did not settle");
    }
  });

  it("rejects a JSON body with invalid UTF-8 bytes", async () => {
    const body = new TextEncoder().encode('{"ok":"value"}');
    body[8] = 0xff;

    await expect(json(new Response(body), { errorPrefix: "remote memory" })).rejects.toThrow(
      /not valid for encoding/,
    );
  });
});
