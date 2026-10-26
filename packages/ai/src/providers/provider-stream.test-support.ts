export function frame(type: string, fields: Record<string, unknown> = {}) {
  return { type, ...fields };
}

export function serializeSse(events: object[]): string {
  return events
    .map(
      (event) =>
        `${"type" in event && typeof event.type === "string" ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
    )
    .join("");
}

export function sseResponse(events: object[]): Response {
  return new Response(serializeSse(events), { headers: { "content-type": "text/event-stream" } });
}

export function makeStallingStream(
  initialChunks: Uint8Array[],
  onCancel: import("node:stream/web").UnderlyingSource<Uint8Array>["cancel"],
) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of initialChunks) {
        controller.enqueue(chunk);
      }
    },
    cancel: onCancel,
  });
}
