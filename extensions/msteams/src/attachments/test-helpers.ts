// Shared MSTeams attachment test utilities.

/**
 * Build a `Response` whose body stream `cancel()` rejects. Useful for proving
 * that cleanup sites using `response.body?.cancel().catch(() => undefined)` do
 * not emit unhandled rejections.
 */
export function createResponseWithRejectingCancel(
  bodyInit: BodyInit | null = null,
  init?: ResponseInit,
): Response {
  const chunks: Uint8Array[] = [];
  if (bodyInit !== null) {
    if (typeof bodyInit === "string") {
      chunks.push(new TextEncoder().encode(bodyInit));
    } else if (bodyInit instanceof Uint8Array) {
      chunks.push(bodyInit);
    } else if (bodyInit instanceof ArrayBuffer) {
      chunks.push(new Uint8Array(bodyInit));
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
    cancel() {
      return Promise.reject(new Error("body cancel rejected"));
    },
  });

  return new Response(stream, init);
}

/**
 * Attach a process-level unhandled rejection listener for the duration of a
 * test. Returns the collected reasons and a detach function.
 */
export function watchUnhandledRejections(): {
  unhandled: unknown[];
  detach: () => void;
} {
  const unhandled: unknown[] = [];
  const handler = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", handler);
  return {
    unhandled,
    detach: () => {
      process.off("unhandledRejection", handler);
    },
  };
}
