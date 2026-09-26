import { it, vi } from "vitest";
import { fixture, page } from "./session-catalog-list-operation.test-support.js";
import { CODEX_APP_SERVER_THREADS_LIST_COMMAND } from "./session-catalog-parsing.js";

it.runIf(process.env.OPENCLAW_CATALOG_NODE_BENCH === "1")(
  "measures a one-second paired node",
  async () => {
    const f = await fixture();
    vi.mocked(f.runtime.nodes.invoke).mockImplementation(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 1_000);
      });
      return { payloadJSON: JSON.stringify(page(["node-row"])) };
    });
    const elapsed: number[] = [];
    const local: number[] = [];
    for (let i = 0; i < 6; i++) {
      const started = performance.now();
      const operation = f.start({
        hostIds: undefined,
        allowPartialResults: true,
        listNodes: async () => ({
          nodes: [
            {
              nodeId: "remote",
              connected: true,
              commands: [CODEX_APP_SERVER_THREADS_LIST_COMMAND],
            },
          ],
        }),
        onHost: (host) => {
          if (host.kind === "gateway") {
            local.push(performance.now() - started);
          }
        },
      });
      try {
        let step = await operation.next();
        while (!step.done) {
          step = await operation.next();
        }
        elapsed.push(performance.now() - started);
      } finally {
        operation.close();
        await Promise.all(f.publications);
      }
    }
    console.info("paired node benchmark", JSON.stringify({ elapsedMs: elapsed, localMs: local }));
  },
  15_000,
);
