import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenBlobStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginBlobKernelStore } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  configureMemoryWikiCompiledCacheStore,
  createMemoryWikiCompiledCacheStore,
} from "./compiled-cache.js";
import { resolveMemoryWikiConfig } from "./config.js";
import { ingestMemoryWikiSource } from "./ingest.js";
import { withMemoryWikiVaultMutation } from "./mutation-coordinator.js";
import { initializeMemoryWikiVault } from "./vault.js";

const [rootDir, target] = process.argv.slice(2);
assert.ok(rootDir);
assert.ok(target === "source" || target === "page");
configureMemoryWikiCompiledCacheStore(
  createMemoryWikiCompiledCacheStore(<T>(options: OpenBlobStoreOptions) =>
    createPluginBlobKernelStore<T>("memory-wiki", {
      ...options,
      env: { OPENCLAW_STATE_DIR: path.join(rootDir, "state") },
    }),
  ),
);
const config = resolveMemoryWikiConfig({ vault: { path: path.join(rootDir, "vault") } });
await initializeMemoryWikiVault(config);
const inputPath = path.join(rootDir, "notes.txt");
const pagePath = path.join(config.vault.path, "sources", "notes.md");
const notes = "Handwritten notes must remain unchanged.\n";
await fs.writeFile(inputPath, "source content\n");
await fs.writeFile(pagePath, notes);
const fifoPath = target === "source" ? inputPath : pagePath;
await fs.rename(fifoPath, fifoPath + ".saved");
execFileSync("mkfifo", [fifoPath]);
// The parent owns a hard subprocess timeout: regressing to readFile must never
// leave a blocked libuv read or vault queue in the test runner.
await assert.rejects(ingestMemoryWikiSource({ config, inputPath }), /regular/);
assert.ok((await fs.lstat(fifoPath)).isFIFO());
assert.equal(
  await fs.readFile(target === "source" ? pagePath : pagePath + ".saved", "utf8"),
  notes,
);
await withMemoryWikiVaultMutation(config.vault.path, async () => {
  await fs.writeFile(path.join(rootDir, "queue-released"), "yes");
});
assert.equal(await fs.readFile(path.join(rootDir, "queue-released"), "utf8"), "yes");
console.log("FIFO refused; original preserved; vault queue released");
