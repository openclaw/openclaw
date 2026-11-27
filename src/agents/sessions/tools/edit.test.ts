// Edit tool tests cover exact-match diagnostics, post-write recovery, newline
// preservation, and custom operations.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { applyPatch } from "diff";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasErrnoCode } from "../../../infra/errno.js";
import { createEditTool, type EditToolOptions } from "./edit.js";
import { readPersistedFileStat } from "./file-write-verification.js";
import type { EditToolDetails, EditToolInput } from "./tool-contracts.js";

type EditOperations = NonNullable<EditToolOptions["operations"]>;

function executeEdit(
  tool: ReturnType<typeof createEditTool>,
  filePath: string,
  edits: EditToolInput["edits"],
) {
  return tool.execute("edit", { path: filePath, edits }, undefined);
}

describe("edit tool", () => {
  let tmpDir = "";
  let tool: ReturnType<typeof createEditTool>;

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  async function createTempFile(content: string | Buffer) {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-tool-"));
    tool = createEditTool(tmpDir);
    const filePath = path.join(tmpDir, "demo.txt");
    await fs.writeFile(filePath, content, "utf-8");
    return filePath;
  }

  function createEditOperations(writeFile: EditOperations["writeFile"]): EditOperations {
    return {
      access: async (absolutePath) => {
        await fs.access(absolutePath);
      },
      readFile: (absolutePath) => fs.readFile(absolutePath),
      statFile: (absolutePath) =>
        readPersistedFileStat(absolutePath, (error) => hasErrnoCode(error, "ENOENT")),
      writeFile,
    };
  }

  async function expectEdit(
    original: string | Buffer,
    edits: EditToolInput["edits"],
    expected: string,
  ) {
    const filePath = await createTempFile(original);
    const result = await executeEdit(tool, filePath, edits);
    const first = expectDefined(result.content[0], "edit result");
    expect("text" in first ? first.text : "").toContain("Successfully replaced");
    await expect(fs.readFile(filePath)).resolves.toEqual(Buffer.from(expected, "utf8"));
    return result;
  }

  function expectPatch(
    result: Awaited<ReturnType<typeof executeEdit>>,
    original: string,
    expected: string,
  ) {
    const details = result.details as EditToolDetails;
    expect(details.changed).toBe(true);
    if (!details.changed) {
      throw new Error("Expected changed edit details");
    }
    expect(applyPatch(original, details.patch)).toBe(expected);
    return details;
  }

  it("preserves a valid UTF-8 BOM when editing a real file", async () => {
    await expectEdit(
      "\uFEFFheading\nprice: 5\n",
      [{ oldText: "price: 5", newText: "price: 7" }],
      "\uFEFFheading\nprice: 7\n",
    );
  });

  it("writes and reports only the requested fuzzy Unicode replacement", async () => {
    const original =
      "export const RETRY\u00A0MAX = 3; // \u518D\u8A66\u884C\uFF08\u6700\u5927\uFF13\u56DE\uFF09\uFF71\uFF72\uFF73 \u2014 \u8A2D\u5B9A\n";
    const expected =
      "export const RETRY_MAX = 5; // \u518D\u8A66\u884C\uFF08\u6700\u5927\uFF13\u56DE\uFF09\uFF71\uFF72\uFF73 \u2014 \u8A2D\u5B9A\n";
    const result = await expectEdit(
      original,
      [{ oldText: "export const RETRY MAX = 3;", newText: "export const RETRY_MAX = 5;" }],
      expected,
    );
    const details = expectPatch(result, original, expected);
    expect(details.diff).toContain(
      "+1 export const RETRY_MAX = 5; // \u518D\u8A66\u884C\uFF08\u6700\u5927\uFF13\u56DE\uFF09\uFF71\uFF72\uFF73 \u2014 \u8A2D\u5B9A",
    );
    expect(details.diff).not.toContain("// \u518D\u8A66\u884C(\u6700\u59273\u56DE)");
  });

  it("rejects invalid UTF-8 without changing a real file", async () => {
    const original = Buffer.concat([Buffer.from("heading\nprice: 5\n"), Buffer.from([0xff, 0xfe])]);
    const filePath = await createTempFile(original);

    await expect(
      executeEdit(tool, filePath, [{ oldText: "price: 5", newText: "price: 7" }]),
    ).rejects.toThrow(/valid UTF-8/);

    await expect(fs.readFile(filePath)).resolves.toEqual(original);
  });

  it("rejects invalid remote-operation UTF-8 before any write", async () => {
    const original = Buffer.concat([Buffer.from("heading\nprice: 5\n"), Buffer.from([0xff, 0xfe])]);
    const writeFile = vi.fn<EditOperations["writeFile"]>();
    const operations: EditOperations = {
      access: async () => {},
      readFile: async () => Buffer.from(original),
      statFile: async () => null,
      writeFile,
    };
    tool = createEditTool("/remote/workspace", { operations });

    await expect(
      tool.execute(
        "call-remote-invalid-utf8",
        {
          path: "/remote/workspace/source.txt",
          edits: [{ oldText: "price: 5", newText: "price: 7" }],
        },
        undefined,
      ),
    ).rejects.toThrow(/valid UTF-8/);

    expect(writeFile).not.toHaveBeenCalled();
  });

  it("adds current file contents to exact-match mismatch errors", async () => {
    const filePath = await createTempFile("actual current content");

    await expect(
      executeEdit(tool, filePath, [{ oldText: "missing", newText: "replacement" }]),
    ).rejects.toThrow(/Current file contents:\nactual current content/);
  });

  it("truncates exact-match mismatch hints without splitting UTF-16 surrogate pairs", async () => {
    const boundaryEmoji = "🙂";
    const filePath = await createTempFile(`${"a".repeat(799)}${boundaryEmoji}tail`);

    await expect(
      executeEdit(tool, filePath, [{ oldText: "missing", newText: "replacement" }]),
    ).rejects.toThrow(`${"a".repeat(799)}\n... (truncated)`);
  });

  it("recovers success after a post-write throw when the edit already applied", async () => {
    // Some backends throw after flushing content; a readback match is the
    // contract that lets the tool report success without duplicating edits.
    const filePath = await createTempFile('const value = "foo";\r\n');
    const operations = createEditOperations(async (absolutePath, content) => {
      await fs.writeFile(absolutePath, content, "utf-8");
      throw new Error("Simulated post-write failure");
    });
    tool = createEditTool(tmpDir, { operations });

    const result = await executeEdit(tool, filePath, [
      {
        oldText: 'const value = "foo";\n',
        newText: 'const value = "foobar";\n',
      },
    ]);

    expect(result.content[0]).toEqual({
      type: "text",
      text: `Successfully replaced 1 block(s) in ${filePath}.`,
    });
    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe('const value = "foobar";\r\n');
  });

  it.each<[string, string, string, string | undefined]>([
    [
      "old replacement already present",
      "old",
      "replacement already present",
      "Simulated write failure",
    ],
    ["old\n", "old", "new", undefined],
    ["old content\n", "old", "new", "No changes made to the disk because it is full"],
  ])("rejects unpersisted edits to %j (%j -> %j)", async (original, oldText, newText, failure) => {
    const filePath = await createTempFile(original);
    tool = createEditTool(tmpDir, {
      operations: createEditOperations(async () => {
        if (failure) {
          throw new Error(failure);
        }
      }),
    });
    await expect(executeEdit(tool, filePath, [{ oldText, newText }])).rejects.toThrow(
      failure ?? "Edit verification failed",
    );
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe(original);
  });

  it("preserves untouched lines during fuzzy multi-edits", async () => {
    const original =
      "keep before  \nfirst target  \nfirst after\nkeep middle   \nsecond target  \nsecond after\nkeep after  \n";
    const expected =
      "keep before  \nFIRST\nFIRST2\nkeep middle   \nSECOND\nSECOND2\nkeep after  \n";
    const result = await expectEdit(
      original,
      [
        { oldText: "first target\nfirst after", newText: "FIRST\nFIRST2" },
        { oldText: "second target\nsecond after", newText: "SECOND\nSECOND2" },
      ],
      expected,
    );
    expectPatch(result, original, expected);
  });

  it("preserves the correct duplicate line after a fuzzy replacement", async () => {
    const original = "replace me   \nafter   \n";
    const expected = "after\nafter   \n";
    const result = await expectEdit(
      original,
      [{ oldText: "replace me\n", newText: "after\n" }],
      expected,
    );
    expectPatch(result, original, expected);
  });

  it("accepts and strips model-added metadata while keeping required fields strict", async () => {
    const filePath = await createTempFile("before\n");
    const raw = {
      path: filePath,
      reason: "model explanation",
      edits: [{ oldText: "before", newText: "after", reason: "why" }],
    };
    const prepared = tool.prepareArguments?.(raw);

    expect(Value.Check(tool.parameters, raw)).toBe(true);
    expect(Value.Check(tool.parameters, { edits: raw.edits })).toBe(false);
    expect(Value.Check(tool.parameters, { path: filePath, edits: [{ oldText: "before" }] })).toBe(
      false,
    );
    expect(prepared).toEqual({
      path: filePath,
      edits: [{ oldText: "before", newText: "after" }],
    });
    expect(Value.Check(tool.parameters, prepared)).toBe(true);
    await tool.execute("call-metadata", prepared as never, undefined);
    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("after\n");
  });

  it("repairs string edits without reinterpreting valid control escapes", async () => {
    const filePath = await createTempFile("alpha\nbeta\nC:\npath\nliteral\\n\n");
    const prepared = tool.prepareArguments?.({
      path: filePath,
      edits: `[{"oldText":"alpha\nbeta","newText":"ALPHA\nBETA"},${JSON.stringify({ oldText: "C:\npath", newText: "C:\nPATH" })},${JSON.stringify({ oldText: "literal\\n", newText: "LITERAL\\n" })}]`,
    });
    if (!Value.Check(tool.parameters, prepared)) {
      throw new Error("Prepared replacements did not satisfy the edit schema");
    }
    await tool.execute("call-repaired-string", prepared, undefined);
    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(
      "ALPHA\nBETA\nC:\nPATH\nLITERAL\\n\n",
    );
  });

  it("returns a non-terminal no-op when oldText equals newText", async () => {
    const filePath = await createTempFile("unchanged content\n");

    const result = await executeEdit(tool, filePath, [
      { oldText: "unchanged", newText: "unchanged" },
    ]);

    const tc0 = expectDefined(result.content[0], "result.content[0] test invariant");
    expect("text" in tc0 ? tc0.text : "").toContain("No changes made");
    expect((result as { terminate?: boolean }).terminate).toBeUndefined();
    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("unchanged content\n");
  });

  it.each([
    { name: "alone", siblings: [] },
    { name: "beside a real edit", siblings: [{ oldText: "actual", newText: "changed" }] },
  ])("does not hide a mismatched no-op edit $name", async ({ siblings }) => {
    const filePath = await createTempFile("actual content\n");

    await expect(
      executeEdit(tool, filePath, [{ oldText: "missing", newText: "missing" }, ...siblings]),
    ).rejects.toThrow(/Current file contents:\nactual content/);
    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("actual content\n");
  });

  it("does not rewrite fuzzy-matched no-op text", async () => {
    const filePath = await createTempFile("foo\n");

    const result = await executeEdit(tool, filePath, [{ oldText: "foo ", newText: "foo " }]);

    expect((result as { terminate?: boolean }).terminate).toBeUndefined();
    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("foo\n");
  });

  it("preserves real sibling edits beside a fuzzy no-op", async () => {
    await expectEdit(
      "foo\u00a0bar\n",
      [
        { oldText: "foo bar", newText: "foo bar" },
        { oldText: "foo\u00a0", newText: "baz" },
      ],
      "bazbar\n",
    );
  });

  it("applies exact formatting beside a disjoint content replacement", async () => {
    await expectEdit(
      "foo  \nkeep  \n",
      [
        { oldText: "foo  ", newText: "foo" },
        { oldText: "keep", newText: "changed" },
      ],
      "foo\nchanged  \n",
    );
  });

  it("rejects duplicate no-op entries", async () => {
    const filePath = await createTempFile("foo\n");

    await expect(
      executeEdit(tool, filePath, [
        { oldText: "foo", newText: "foo" },
        { oldText: "foo", newText: "foo" },
      ]),
    ).rejects.toThrow(/overlap/);
  });

  it("rejects an exact no-op overlapping a real edit", async () => {
    const filePath = await createTempFile("foo\n");

    await expect(
      executeEdit(tool, filePath, [
        { oldText: "foo", newText: "foo" },
        { oldText: "foo", newText: "bar" },
      ]),
    ).rejects.toThrow(/overlap/);
  });

  it("preserves valid sibling edits when batch contains a no-op entry", async () => {
    const filePath = await createTempFile("alpha beta gamma\n");

    const result = await executeEdit(tool, filePath, [
      { oldText: "alpha", newText: "alpha" }, // no-op
      { oldText: "gamma", newText: "GAMMA" }, // real change
    ]);

    const tcText = expectDefined(result.content[0], "result.content[0] test invariant");
    expect("text" in tcText ? tcText.text : "").toContain("Successfully replaced");
    expect((result as { terminate?: boolean }).terminate).toBeFalsy();
    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("alpha beta GAMMA\n");
  });

  it.each<[string, string, string, string]>([
    ["a\rb\rc\nf\n", "b", "B", "a\rB\rc\nf\n"],
    ["a\rb\nf\n", "a", "a1\na2", "a1\ra2\rb\nf\n"],
    ["a\r", "a", "A", "A\r"],
    ["a\rb\r", "a", "p\na", "p\ra\rb\r"],
    ["a\r\nb\nc\n", "b", "p\nb", "a\r\np\nb\nc\n"],
    ["a\r\nb\n", "a", "a\ns", "a\r\ns\r\nb\n"],
    ["A\r\nB\nC\r", "A", "B", "B\r\nB\nC\r"],
    ["keep\r\ntarget   \nafter\r\n", "target\nafter", "T\nA", "keep\r\nT\nA\r\n"],
    ["a\r\nb\nc\n", "a\nb", "m", "m\nc\n"],
    ["a\r\nb\nc\n", "a\nb\n", "m\n", "m\nc\n"],
    ["h1\r\nh2\r\na\nb", "a\nb", "x\ny", "h1\r\nh2\r\nx\ny"],
    ["a\r\nb\r\nc\r\n", "b", "b1\nb2", "a\r\nb1\r\nb2\r\nc\r\n"],
  ])(
    "preserves source terminators in %j replacing %j with %j",
    async (original, oldText, newText, expected) => {
      await expectEdit(original, [{ oldText, newText }], expected);
    },
  );

  it("keeps untouched mixed terminators between separate edits", async () => {
    await expectEdit(
      "one\r\ntwo\nthree\r75%\rfour\nfive\r\n",
      [
        { oldText: "one", newText: "ONE" },
        { oldText: "five", newText: "FIVE" },
      ],
      "ONE\r\ntwo\nthree\r75%\rfour\nFIVE\r\n",
    );
  });
});
