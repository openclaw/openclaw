import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractApplyPatchTargetPaths,
  extractResolvedApplyPatchTargetPaths,
  toDisplayPath,
} from "./apply-patch-paths.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";

const defaultCwd = process.cwd();
const cwdPath = (...segments: string[]) => path.join(defaultCwd, ...segments);
const envelope = (...hunks: string[]) => ["*** Begin Patch", ...hunks, "*** End Patch"].join("\n");

describe("toDisplayPath", () => {
  const root = path.join(path.parse(defaultCwd).root, "workspace");
  it.each([
    [".", "workspace"],
    ["sub/file.txt", path.join("sub", "file.txt")],
    ["..cache/file.txt", path.join("..cache", "file.txt")],
    ["../outside.txt", path.resolve(root, "../outside.txt")],
  ])("displays %s without disguising paths outside the workspace", (relative, expected) => {
    expect(toDisplayPath(path.resolve(root, relative), root)).toBe(expected);
  });
});

describe("extractApplyPatchTargetPaths", () => {
  it.each([undefined, null, 42, {}, { input: 7 }, "", { input: "" }])(
    "returns no paths for invalid or empty input %j",
    (input) => expect(extractApplyPatchTargetPaths(input)).toEqual([]),
  );
  it.each([
    [
      "update/delete",
      envelope("*** Update File: a.ts\n@@\n context\n+added", "*** Delete File: b.ts"),
      ["a.ts", "b.ts"],
    ],
    [
      "blank lines before move",
      envelope("*** Update File: a.ts\n\n*** Move to: b.ts"),
      ["a.ts", "b.ts"],
    ],
    ["wrapper", { input: envelope("*** Add File: foo.ts\n+x") }, ["foo.ts"]],
    ["CRLF", "*** Begin Patch\r\n*** Add File: crlf.ts\r\n+x\r\n*** End Patch", ["crlf.ts"]],
    [
      "indented headers",
      "  *** Begin Patch\n  *** Add File: src/new.ts\n+x\n  *** Delete File: src/dead.ts\n  *** Update File: src/old.ts\n  *** Move to: src/renamed.ts\n@@\n-old\n+new\n  *** End Patch",
      ["src/new.ts", "src/dead.ts", "src/old.ts", "src/renamed.ts"],
    ],
    [
      "single-space headers",
      envelope(" *** Add File: src/new.ts\n+x", " *** Delete File: src/dead.ts"),
      ["src/new.ts", "src/dead.ts"],
    ],
    ["unrecognized grammar", "nothing here\n*** Random Marker: x\n+a\ncontext", []],
    [
      "marker-like body",
      envelope(
        "*** Update File: real.ts\n@@\n *** Add File: fake-context.ts\n  *** Delete File: fake-indented-context.ts\n-*** Delete File: fake-remove.ts\n+*** Add File: fake-add.ts",
      ),
      ["real.ts"],
    ],
    ["missing envelope", "*** Add File: loose.ts\n+x", ["loose.ts"]],
  ] as const)("extracts %s", (_name, input, expected) => {
    expect(extractApplyPatchTargetPaths(input)).toEqual(expected.map((file) => cwdPath(file)));
  });

  it("normalizes derived paths before de-duplicating them", () => {
    const patch = envelope(
      "*** Add File: safe/../secret.ts\n+x",
      "*** Update File: ./src//old.ts\n*** Move to: src/temp/../renamed.ts\n@@\n+y",
      "*** Delete File: secret.ts",
    );
    expect(extractApplyPatchTargetPaths(patch)).toEqual([
      cwdPath("secret.ts"),
      cwdPath("src/old.ts"),
      cwdPath("src/renamed.ts"),
    ]);
  });

  it("preserves POSIX backslashes to match apply_patch execution", () => {
    const patch = envelope(
      String.raw`*** Add File: src\windows\path.ts`,
      "+x",
      String.raw`*** Add File: safe\evil.ts`,
    );
    expect(extractApplyPatchTargetPaths(patch)).toEqual([
      path.resolve(defaultCwd, String.raw`src\windows\path.ts`),
      path.resolve(defaultCwd, String.raw`safe\evil.ts`),
    ]);
    expect(extractApplyPatchTargetPaths(patch)).not.toContain(cwdPath("safe", "evil.ts"));
  });

  it("can resolve paths with the same cwd semantics as apply_patch execution", () => {
    const cwd = path.join(os.tmpdir(), "openclaw-derived-paths");
    const patch = [
      "*** Begin Patch",
      "*** Add File: @src/../resolved.ts",
      "+x",
      "*** Update File: ~/renamed-source.ts",
      "*** Move to: /tmp/openclaw-target.ts",
      "@@",
      "+y",
      "*** End Patch",
    ].join("\n");
    expect(extractApplyPatchTargetPaths(patch, { cwd })).toEqual([
      path.join(cwd, "resolved.ts"),
      path.join(os.homedir(), "renamed-source.ts"),
      path.join("/tmp", "openclaw-target.ts"),
    ]);
  });

  it.each(["host", "mounted sandbox"])(
    "derives literal @ files and new descendants through the %s path owner",
    async (runtime) => {
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-patch-at-path-"));
      try {
        const literalParent = path.join(cwd, "@notes");
        const siblingParent = path.join(cwd, "notes");
        await fs.mkdir(literalParent);
        await fs.mkdir(siblingParent);
        await fs.writeFile(path.join(literalParent, "existing.md"), "literal");
        await fs.writeFile(path.join(siblingParent, "existing.md"), "sibling");
        await fs.writeFile(path.join(siblingParent, "new.md"), "sibling");
        const patch = envelope(
          "*** Delete File: @notes/existing.md",
          "*** Add File: @notes/new.md\n+literal",
        );
        const options =
          runtime === "mounted sandbox"
            ? { cwd, sandbox: { root: cwd, bridge: createHostSandboxFsBridge(cwd) } }
            : { cwd };

        const expected = [
          path.join(literalParent, "existing.md"),
          path.join(literalParent, "new.md"),
        ];
        expect(extractApplyPatchTargetPaths(patch, options)).toEqual(expected);
        const mentionedPatch = patch.replaceAll("File: @notes/", "File: @@notes/");
        expect(extractApplyPatchTargetPaths(mentionedPatch, options)).toEqual(expected);
        await expect(
          extractResolvedApplyPatchTargetPaths(mentionedPatch, options),
        ).resolves.toEqual(expected);
      } finally {
        await fs.rm(cwd, { recursive: true, force: true });
      }
    },
  );

  it("defaults missing cwd to apply_patch process cwd semantics", () => {
    const patch = envelope(
      "*** Add File: @src/../resolved.ts",
      "+x",
      "*** Update File: ~/source.ts",
      "*** Move to: src/moved.ts",
      "@@",
      "+y",
    );
    expect(extractApplyPatchTargetPaths(patch)).toEqual([
      cwdPath("resolved.ts"),
      path.join(os.homedir(), "source.ts"),
      cwdPath("src/moved.ts"),
    ]);
  });

  it("skips sandbox paths the bridge rejects", () => {
    const patch = envelope(
      "*** Add File: /workspace/src/ok.ts\n+x",
      "*** Add File: /outside.ts\n+y",
    );
    expect(
      extractApplyPatchTargetPaths(patch, {
        cwd: "/workspace",
        sandbox: {
          root: "/workspace",
          bridge: {
            resolvePath: ({ filePath }: { filePath: string }) => {
              if (filePath === "/outside.ts") {
                throw new Error("Path escapes sandbox root");
              }
              return {
                containerPath: filePath,
                hostPath: filePath.replace("/workspace", "/host/workspace"),
                relativePath: filePath.replace("/workspace/", ""),
              };
            },
          } as never,
        },
      }),
    ).toEqual(["/host/workspace/src/ok.ts"]);
  });
});
