#!/usr/bin/env node
import { runVitestEntry } from "./lib/vitest-cli-bootstrap.mts";

await runVitestEntry(
  undefined,
  async () => (await import("./test-extension-batch-run.mts")).runExtensionBatch,
);
