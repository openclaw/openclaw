import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { applyPatch, createMemoryPatchSandbox } from "./apply-patch.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function applyTo(source: string, hunk: string) {
  const memory = createMemoryPatchSandbox({ "source.txt": source });
  await applyPatch(
    `*** Begin Patch\n*** Update File: source.txt\n${hunk}\n*** End Patch`,
    memory.options,
  );
  return memory.files.get("/sandbox/source.txt");
}

describe("apply_patch ambiguous hunk matching", () => {
  it.each([
    ["exact", "target\ntarget", "target"],
    ["trim-end", "target  \ntarget\t", "target"],
    ["trim", "  target\n\ttarget", "target"],
    ["punctuation", "It\u2019s done\nIt\u2018s done", "It's done"],
  ])("refuses duplicate matches at the %s tier", async (_tier, lines, pattern) => {
    const source = `before\n${lines}\nafter\n`;
    await expect(applyTo(source, `@@\n-${pattern}`)).rejects.toThrow(
      /Found 2 occurrences.*include more surrounding lines/s,
    );
  });
  it("refuses an exact duplicate @@ context", async () => {
    const source = "function target() {\n  return 1;\n}\nfunction target() {\n  return 2;\n}\n";

    await expect(
      applyTo(source, "@@ function target() {\n-  return 2;\n+  return 3;"),
    ).rejects.toThrow(/Found 2 occurrences of context.*more specific @@ context line/s);
  });

  it.each([
    ["exact", "target", "target"],
    ["trim-end", "target  ", "target"],
    ["trim", "  target", "target"],
    ["punctuation", "It\u2019s done", "It's done"],
  ])("applies a unique match at the %s tier", async (_tier, line, pattern) => {
    await expect(applyTo(`before\n${line}\nafter\n`, `@@\n-${pattern}`)).resolves.toBe(
      "before\nafter\n",
    );
  });

  it("prefers a unique exact match over broader tolerant lookalikes", async () => {
    const source = " target\ntarget\n\ttarget\n";

    await expect(applyTo(source, "@@\n-target")).resolves.toBe(" target\n\ttarget\n");
  });

  it("uses a unique @@ context to disambiguate repeated exact hunk text", async () => {
    const source = "function first() {\n  return 1;\n}\nfunction second() {\n  return 1;\n}\n";

    await expect(
      applyTo(source, "@@ function second() {\n-  return 1;\n+  return 2;"),
    ).resolves.toBe("function first() {\n  return 1;\n}\nfunction second() {\n  return 2;\n}\n");
  });

  it("keeps sequential hunk searches after the prior match", async () => {
    const source = "marker\ntarget\nmiddle\ntarget\n";

    await expect(
      applyTo(source, "@@\n marker\n-target\n+first\n@@\n-target\n+second"),
    ).resolves.toBe("marker\nfirst\nmiddle\nsecond\n");
  });

  it("keeps end-of-file matching anchored to the final candidate", async () => {
    const source = "\ttarget\nmiddle\n\ttarget\n";

    await expect(applyTo(source, "@@\n-  target\n+done\n*** End of File")).resolves.toBe(
      "\ttarget\nmiddle\ndone\n",
    );
  });

  it("leaves the file byte-identical when an ambiguous patch is refused", async () => {
    const dir = tempDirs.make("openclaw-patch-amb-");
    const file = path.join(dir, "source.txt");
    const source = "before\ntarget\ntarget\nafter\n";
    await fs.writeFile(file, source);

    const patch = `*** Begin Patch
*** Update File: source.txt
@@
-target
*** End Patch`;

    await expect(applyPatch(patch, { cwd: dir })).rejects.toThrow(
      /Found 2 occurrences.*include more surrounding lines/s,
    );
    await expect(fs.readFile(file, "utf8")).resolves.toBe(source);
  });
});
