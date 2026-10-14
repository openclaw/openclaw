import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as markdown from "./markdown.js";
import { searchMemoryWiki } from "./query.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

vi.mock("./markdown.js", { spy: true });
const harness = createMemoryWikiTestHarness();
afterEach(() => vi.restoreAllMocks());

it("stops parsing vault pages after cancellation during a scan", async () => {
  const { rootDir, config } = await harness.createVault({ initialize: true });
  await Promise.all(
    Array.from({ length: 32 }, (_, index) =>
      fs.writeFile(
        path.join(rootDir, "entities", `page-${index}.md`),
        `---\npageType: entity\nid: page.${index}\ntitle: Archive ${index}\n---\nArchival text.\n`,
      ),
    ),
  );
  const controller = new AbortController();
  const { scanWikiPageSummary: original } = await vi.importActual<typeof markdown>("./markdown.js");
  const scan = vi.spyOn(markdown, "scanWikiPageSummary").mockImplementation((params) => {
    const page = original(params);
    controller.abort(new Error("Turn cancelled"));
    return page;
  });
  await expect(
    searchMemoryWiki({ config, query: "absent multi term", signal: controller.signal }),
  ).rejects.toThrow("Turn cancelled");
  expect(scan).toHaveBeenCalledTimes(1);
});
