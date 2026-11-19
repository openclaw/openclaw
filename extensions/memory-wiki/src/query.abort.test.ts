import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { closeMemoryWikiQueryReader } from "./query-reader.js";
import { searchMemoryWiki } from "./query.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const harness = createMemoryWikiTestHarness();
const chmodFaultUnavailable = process.platform === "win32" || process.getuid?.() === 0;

it.skipIf(chmodFaultUnavailable)(
  "cancels a whole-vault search in the reader pool and serves the next search",
  async () => {
    const { rootDir, config } = await harness.createVault({ initialize: true });
    await Promise.all(
      Array.from({ length: 32 }, (_, index) =>
        fs.writeFile(
          path.join(rootDir, "entities", `page-${index}.md`),
          `---\npageType: entity\nid: page.${index}\ntitle: Archive ${index}\n---\nArchival text.\n`,
        ),
      ),
    );
    // A scan that reached this page would fail with EACCES, so rejecting with the
    // caller's reason shows the cancellation stopped the scan before it read the vault.
    const unreadable = path.join(rootDir, "entities", "page-0.md");
    await fs.chmod(unreadable, 0o000);
    // Start without reader workers: the search's first task is still waiting for the
    // worker being created when the caller cancels.
    await closeMemoryWikiQueryReader();
    const controller = new AbortController();
    const reason = new Error("Turn cancelled");
    process.once("worker", () => controller.abort(reason));

    await expect(
      searchMemoryWiki({ config, query: "archival text", signal: controller.signal }),
    ).rejects.toBe(reason);
    await fs.chmod(unreadable, 0o644);
    await expect(
      searchMemoryWiki({ config, query: "archival text", maxResults: 3 }),
    ).resolves.toHaveLength(3);
  },
);
