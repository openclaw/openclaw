// The JavaScript launcher reports only after this execution process closes.
import { runVitestEntry } from "./lib/vitest-cli-bootstrap.mts";

await runVitestEntry(undefined, async () => (await import("./run-vitest.mts")).runVitest);
