// Memory Wiki tests cover ingest plugin behavior.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { describe, expect, it, vi } from "vitest";
import { deferred } from "./deferred.test-helpers.js";
import { ingestMemoryWikiSource } from "./ingest.js";
import { withMemoryWikiVaultMutation } from "./mutation-coordinator.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createTempDir, createVault } = createMemoryWikiTestHarness();
const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("ingestMemoryWikiSource", () => {
  it("copies a local text file into sources markdown", async () => {
    const rootDir = await createTempDir("memory-wiki-ingest-");
    const inputPath = path.join(rootDir, "meeting-notes.txt");
    await fs.writeFile(inputPath, "hello from source\n", "utf8");
    const { config } = await createVault({
      rootDir: path.join(rootDir, "vault"),
    });

    const result = await ingestMemoryWikiSource({
      config,
      inputPath,
      nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
    });

    expect(result.pageId).toBe("source.meeting-notes");
    expect(result.pagePath).toBe("sources/meeting-notes.md");
    expect(result.indexUpdatedFiles.length).toBeGreaterThan(0);
    await expect(fs.readFile(path.join(config.vault.path, "sources", "meeting-notes.md"), "utf8"))
      .resolves.toBe(`---
pageType: source
id: source.meeting-notes
title: meeting notes
sourceType: local-file
sourcePath: ${inputPath}
ingestedAt: 2026-04-05T12:00:00.000Z
updatedAt: 2026-04-05T12:00:00.000Z
status: active
---

# meeting notes

## Source
- Type: \`local-file\`
- Path: \`${inputPath}\`
- Bytes: 18
- Updated: 2026-04-05T12:00:00.000Z

## Content
\`\`\`text
hello from source

\`\`\`

## Notes
<!-- openclaw:human:start -->
<!-- openclaw:human:end -->

## Related
<!-- openclaw:wiki:related:start -->
- No related pages yet.
<!-- openclaw:wiki:related:end -->
`);
    await expect(fs.readFile(path.join(config.vault.path, "index.md"), "utf8")).resolves.toContain(
      "[meeting notes](sources/meeting-notes.md)",
    );
  });

  it("breaks a hardlink before writing the ingested page", async () => {
    const rootDir = await createTempDir("memory-wiki-ingest-hardlink-");
    const inputPath = path.join(rootDir, "meeting-notes.txt");
    const externalPath = path.join(rootDir, "outside.md");
    await fs.writeFile(inputPath, "updated source\n", "utf8");
    await fs.writeFile(externalPath, "keep external content\n", "utf8");
    const { config } = await createVault({
      rootDir: path.join(rootDir, "vault"),
      initialize: true,
    });
    const pagePath = path.join(config.vault.path, "sources", "meeting-notes.md");
    await fs.link(externalPath, pagePath);

    await expect(ingestMemoryWikiSource({ config, inputPath })).resolves.toMatchObject({
      created: false,
    });
    const externalAfter = await fs.readFile(externalPath, "utf8");
    const pageAfter = await fs.readFile(pagePath, "utf8");
    expect(externalAfter).toBe("keep external content\n");
    expect(pageAfter).toContain("updated source");
    process.stdout.write(
      "REAL_MEMORY_WIKI_HARDLINK_PROOF created=false pageUpdated=true externalUnchanged=true\n",
    );
  });

  it("preserves the external target through the OpenClaw CLI", async () => {
    const rootDir = await createTempDir("memory-wiki-cli-hardlink-");
    const tempHome = path.join(rootDir, "home");
    const inputPath = path.join(rootDir, "meeting-notes.txt");
    const externalPath = path.join(rootDir, "outside.md");
    const vaultPath = path.join(rootDir, "vault");
    const workspacePath = path.join(rootDir, "workspace");
    const configPath = path.join(tempHome, "openclaw.json");
    await fs.mkdir(tempHome, { recursive: true });
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.writeFile(inputPath, "updated source\n", "utf8");
    await fs.writeFile(externalPath, "keep external content\n", "utf8");
    const { config } = await createVault({ rootDir: vaultPath, initialize: true });
    const pagePath = path.join(config.vault.path, "sources", "meeting-notes.md");
    await fs.link(externalPath, pagePath);
    await fs.writeFile(
      configPath,
      JSON.stringify({
        agents: { defaults: { workspace: workspacePath } },
        plugins: {
          enabled: true,
          load: { paths: [path.join(repoRoot, "extensions", "memory-wiki")] },
          entries: {
            "memory-wiki": {
              enabled: true,
              config: { vault: { path: config.vault.path } },
            },
          },
        },
        logging: { level: "silent", consoleLevel: "silent" },
      }),
      "utf8",
    );

    const result = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(repoRoot, "scripts", "run-node.mts"),
        "wiki",
        "ingest",
        inputPath,
        "--json",
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          CI: "1",
          NODE_DISABLE_COMPILE_CACHE: "1",
          NODE_ENV: undefined,
          VITEST: undefined,
          HOME: tempHome,
          USERPROFILE: tempHome,
          OPENCLAW_HOME: tempHome,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: path.join(tempHome, "state"),
          OPENCLAW_DEV_SOURCE_ROOT: repoRoot,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1",
          OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB: "8192",
          OPENCLAW_DISABLE_UPDATE_CHECK: "1",
          OPENCLAW_NO_RESPAWN: "1",
        },
        maxBuffer: 4 * 1024 * 1024,
        timeout: 120_000,
      },
    );
    const cliResult = JSON.parse(result.stdout) as {
      created: boolean;
      pagePath: string;
    };
    const externalAfter = await fs.readFile(externalPath, "utf8");
    const pageAfter = await fs.readFile(pagePath, "utf8");
    expect(cliResult).toMatchObject({ created: false, pagePath: "sources/meeting-notes.md" });
    expect(externalAfter).toBe("keep external content\n");
    expect(pageAfter).toContain("updated source");
    process.stdout.write(
      "REAL_OPENCLAW_MEMORY_WIKI_CLI_PROOF command=wiki-ingest-json status=0 created=false pageUpdated=true externalUnchanged=true\n",
    );
  });

  it("queues behind a held vault mutation instead of writing mid-transaction", async () => {
    const rootDir = await createTempDir("memory-wiki-ingest-lock-");
    const inputPath = path.join(rootDir, "meeting-notes.txt");
    await fs.writeFile(inputPath, "hello from source\n", "utf8");
    const { config } = await createVault({
      rootDir: path.join(rootDir, "vault"),
    });
    const pagePath = path.join(config.vault.path, "sources", "meeting-notes.md");

    const lockEntered = deferred();
    const releaseLock = deferred();
    const holder = withMemoryWikiVaultMutation(config.vault.path, async () => {
      lockEntered.resolve();
      await releaseLock.promise;
    });
    await lockEntered.promise;

    const ingestQueued = deferred();
    const originalEnqueue = Object.getOwnPropertyDescriptor(KeyedAsyncQueue.prototype, "enqueue")
      ?.value as KeyedAsyncQueue["enqueue"];
    const enqueueSpy = vi
      .spyOn(KeyedAsyncQueue.prototype, "enqueue")
      .mockImplementation(function (this: KeyedAsyncQueue, key, task, hooks) {
        ingestQueued.resolve();
        return originalEnqueue.call(this, key, task, hooks);
      });
    let ingest: ReturnType<typeof ingestMemoryWikiSource> | undefined;
    try {
      ingest = ingestMemoryWikiSource({
        config,
        inputPath,
        nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
      });
      // On fixed code this observes ingest joining the held queue before any
      // filesystem work. On unfixed code it observes nested compile only after
      // the source page was already written, so the assertion fails.
      await ingestQueued.promise;
      await expect(fs.access(pagePath)).rejects.toThrow();

      releaseLock.resolve();
      // Completion also proves the nested compile re-enters the held vault
      // lock reentrantly instead of deadlocking.
      const result = await ingest;
      await holder;
      expect(result.created).toBe(true);
      await expect(fs.readFile(pagePath, "utf8")).resolves.toContain("hello from source");
    } finally {
      releaseLock.resolve();
      enqueueSpy.mockRestore();
      await Promise.allSettled([holder, ...(ingest ? [ingest] : [])]);
    }
  });
});
