import { getEventListeners } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import type { DirectoryEntry } from "../../../infra/directory-entries.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { createLsTool } from "./ls.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type Listing = Awaited<ReturnType<ReturnType<typeof createLsTool>["execute"]>>;
const textContent = ({ content: [first] }: Listing) =>
  first?.type === "text" ? (first.text ?? "") : "";
const pageNames = (page: Listing) =>
  textContent(page)
    .split("\n")
    .flatMap((line) => (line.startsWith('"') ? [JSON.parse(line)] : []));
const expectText = (page: Listing, text: string) =>
  expect(page.content).toEqual([{ type: "text", text }]);

it("pages complete, quoted Unicode/control names in binary order within model context", async () => {
  const modelBudget = { maxChars: 1_800, maxContextChars: 2_500 };
  const longNames = Array.from({ length: 8 }, (_, i) => `${i}-${"x".repeat(210)}`);
  const names = ["\ta", '"q"', ...longNames, "A", "Z", "a", "a\nb", "á", "🦀"];
  const tool = createLsTool("/workspace", {
    operations: {
      readDirectory: () => names.toReversed().map((name) => ({ name, isDirectory: false })),
    },
    modelBudget,
  });
  const { signal } = new AbortController();
  const seen: unknown[] = [];
  let after: string | undefined;
  for (let remainingPages = names.length; remainingPages > 0; remainingPages -= 1) {
    const page = await tool.execute("list-page", { limit: 500, after }, signal);
    const output = textContent(page);
    const namesInPage = pageNames(page);
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
    expect(namesInPage.length).toBeGreaterThan(0);
    expect(output.length * 2).toBeLessThanOrEqual(modelBudget.maxContextChars);
    seen.push(...namesInPage);
    const nextAfter = page.details?.nextAfter;
    if (nextAfter === undefined) {
      break;
    }
    expect(nextAfter).toBe(namesInPage.at(-1));
    expect(output).toContain(`after=${JSON.stringify(nextAfter)}`);
    after = nextAfter;
  }
  expect(seen).toEqual(names);
});

it("lists empty directories and links, resuming from a deleted directory's raw name", async () => {
  const cwd = tempDirs.make("openclaw-ls-");
  const tool = createLsTool(cwd);
  expectText(await tool.execute("empty", {}), "(empty directory)");
  await Promise.all(["alpha", "target-dir"].map((name) => fs.mkdir(path.join(cwd, name))));
  await Promise.all(["beta", "gamma"].map((name) => fs.writeFile(path.join(cwd, name), "")));
  const symlinkType = process.platform === "win32" ? "junction" : "dir";
  await fs.symlink(path.join(cwd, "missing-target"), path.join(cwd, "z-broken"), symlinkType);
  await fs.symlink(path.join(cwd, "target-dir"), path.join(cwd, "z-link"), symlinkType);
  const first = await tool.execute("first-page", { limit: 1 });
  expect(first.details?.nextAfter).toBe("alpha");
  await fs.rmdir(path.join(cwd, "alpha"));

  const second = await tool.execute("second-page", { limit: 1, after: first.details?.nextAfter });
  expect(second.details?.nextAfter).toBe("beta");
  const final = await tool.execute("final-page", { after: second.details?.nextAfter });
  expectText(final, '"gamma"\n"target-dir/"\n"z-broken"\n"z-link"');
  expect(final.details?.nextAfter).toBeUndefined();
  await expect(tool.execute("missing", { path: "missing" })).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("cancels a pending listing and releases its listener", async () => {
  const listing = createDeferredCore<DirectoryEntry[]>();
  const reading = createDeferredCore<AbortSignal | undefined>();
  const tool = createLsTool("/workspace", {
    operations: {
      readDirectory: (_path, signal) => {
        reading.resolve(signal);
        return listing.promise;
      },
    },
  });
  const controller = new AbortController();
  const result = tool.execute("ls", {}, controller.signal);
  await expect(reading.promise).resolves.toBe(controller.signal);
  controller.abort();
  await expect(result).rejects.toThrow("Operation aborted");
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  listing.resolve([]);
});
