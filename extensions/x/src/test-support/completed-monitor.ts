import { fixture, post, type Payload } from "./monitor-fixture.js";
import { createQueue } from "./monitor.js";

export function completedMonitor(
  options: Omit<Parameters<typeof fixture>[0], "queue" | "posts"> & {
    posts?: Parameters<typeof fixture>[0]["posts"];
  } = {},
) {
  const completed = Promise.withResolvers<void>();
  const test = fixture({
    ...options,
    posts: options.posts ?? [post("501", "10")],
    queue: createQueue<Payload>({ onCompleted: () => completed.resolve() }),
  });
  return {
    ...test,
    async run(
      inspect: (running: ReturnType<typeof test.start>) => Promise<void> = async () => {},
      phase: "during" | "completed" = "completed",
    ) {
      const running = test.start();
      try {
        if (phase === "completed") {
          await completed.promise;
        }
        await inspect(running);
        if (phase === "during") {
          await completed.promise;
        }
      } finally {
        await test.stop();
      }
    },
  };
}
