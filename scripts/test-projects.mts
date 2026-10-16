// Importing this public entrypoint also starts the serial/max/import aliases.
import { runVitestEntry } from "./lib/vitest-cli-bootstrap.mts";

await runVitestEntry("test", async () => (await import("./test-projects-run.mts")).runTestProjects);
