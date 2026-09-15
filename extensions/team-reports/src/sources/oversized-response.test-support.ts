const chunk = new Uint8Array(1024 * 1024).fill(0x20);

export function oversizedResponse(): {
  response: Response;
  cancellations: () => number;
} {
  let chunks = 0;
  let cancelCount = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunks++ < 18) {
        controller.enqueue(chunk);
      } else {
        controller.close();
      }
    },
    cancel() {
      cancelCount += 1;
    },
  });
  return {
    response: new Response(body, { headers: { "content-type": "application/json" } }),
    cancellations: () => cancelCount,
  };
}
