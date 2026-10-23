import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import type { DirectoryEntry } from "../../../infra/directory-entries.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { createLsTool, type LsOperations } from "./ls.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function operations(entries: string[]): LsOperations {
  return { readDirectory: () => entries.map((name) => ({ name, isDirectory: false })) };
}

type Listing = Awaited<ReturnType<ReturnType<typeof createLsTool>["execute"]>>;
const textContent = ({ content: [first] }: Listing) =>
  first?.type === "text" ? (first.text ?? "") : "";
const pageNames = (page: Listing, paged = false) =>
  textContent(page)
    .split("\n")
    .flatMap((line) => (!paged || line.startsWith('"') ? [JSON.parse(line)] : []));

function trackAbortListener() {
  const controller = new AbortController();
  const signal = controller.signal;
  const add = vi.spyOn(signal, "addEventListener");
  const remove = vi.spyOn(signal, "removeEventListener");
  return {
    controller,
    signal,
    expectReleased() {
      const listener = add.mock.calls.find(([type]) => type === "abort")?.[1];
      expect(listener).toBeDefined();
      expect(remove).toHaveBeenCalledWith("abort", listener);
    },
  };
}
const expectText = (page: Listing, text: string) =>
  expect(page.content).toEqual([{ type: "text", text }]);
function expectPage(page: Listing, first: string, nextAfter?: string) {
  expect([textContent(page).split("\n")[0], page.details?.nextAfter]).toEqual([first, nextAfter]);
}

it("visits every filename through complete pages bounded by model context", async () => {
  const modelBudget = { maxChars: 1_800, maxContextChars: 2_500 };
  const suffix = "x".repeat(210);
  const names = Array.from({ length: 300 }, (_, i) => `${String(i).padStart(3, "0")}-${suffix}`);
  const tool = createLsTool("/workspace", { operations: operations(names), modelBudget });
  const seen: unknown[] = [];
  let after: string | undefined;
  for (let remainingPages = names.length; remainingPages > 0; remainingPages -= 1) {
    const page = await tool.execute("list-page", { limit: 500, after });
    const output = textContent(page);
    const namesInPage = pageNames(page, true);
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

it("quotes complete control-character and Unicode names in binary order", async () => {
  const tool = createLsTool("/workspace", {
    operations: operations(["a\nb", "á", "a", "Z", "A", "\ta", '"q"', "🦀"]),
  });

  const listener = trackAbortListener();
  const page = await tool.execute("list-unusual-names", {}, listener.signal);

  expect(pageNames(page)).toEqual(["\ta", '"q"', "A", "Z", "a", "a\nb", "á", "🦀"]);
  expect(page.details?.nextAfter).toBeUndefined();
  listener.expectReleased();
});

it("continues after a deleted directory using its raw name without skipping unseen entries", async () => {
  const cwd = tempDirs.make("openclaw-ls-delete-page-");
  await fs.mkdir(path.join(cwd, "alpha"));
  await Promise.all(["beta", "gamma"].map((name) => fs.writeFile(path.join(cwd, name), "")));
  const tool = createLsTool(cwd);
  const first = await tool.execute("first-page", { limit: 1 });
  expectPage(first, '"alpha/"', "alpha");
  await fs.rmdir(path.join(cwd, "alpha"));

  const second = await tool.execute("second-page", { limit: 1, after: first.details?.nextAfter });
  expectPage(second, '"beta"', "beta");
  const final = await tool.execute("final-page", { limit: 1, after: second.details?.nextAfter });
  expectText(final, '"gamma"');
  expect(final.details?.nextAfter).toBeUndefined();
});

it("retains links without following targets and marks only actual directories", async () => {
  const cwd = tempDirs.make("openclaw-ls-links-");
  const tool = createLsTool(cwd);
  const symlinkType = process.platform === "win32" ? "junction" : "dir";
  const list = (limit?: number) => tool.execute("ls-links", limit ? { limit } : {});

  expectText(await list(), "(empty directory)");
  await fs.symlink(path.join(cwd, "missing-target"), path.join(cwd, "a-broken"), symlinkType);

  await fs.mkdir(path.join(cwd, "target-dir"));
  await fs.symlink(path.join(cwd, "target-dir"), path.join(cwd, "link-to-dir"), symlinkType);
  await fs.writeFile(path.join(cwd, "z-file.txt"), "fixture\n");
  expectText(await list(), '"a-broken"\n"link-to-dir"\n"target-dir/"\n"z-file.txt"');

  const limited = await list(1);
  expect(textContent(limited).split("\n")[0]).toBe('"a-broken"');
  expect(limited.details).toEqual({ content: textContent(limited), nextAfter: "a-broken" });
});

it.each(["failure", "abort"] as const)("releases the listener after %s", async (mode) => {
  const listing = createDeferredCore<DirectoryEntry[]>();
  const reading = createDeferredCore<AbortSignal | undefined>();
  const tool = createLsTool("/workspace", {
    operations: {
      readDirectory: (_path, signal) => {
        if (mode === "failure") {
          throw new Error("permission denied");
        }
        reading.resolve(signal);
        return listing.promise;
      },
    },
  });
  const listener = trackAbortListener();
  const result = tool.execute("ls", {}, listener.signal);
  if (mode === "abort") {
    await expect(reading.promise).resolves.toBe(listener.signal);
    listener.controller.abort();
  }
  await expect(result).rejects.toThrow(
    mode === "abort" ? "Operation aborted" : "permission denied",
  );
  listener.expectReleased();
  listing.resolve([]);
});
