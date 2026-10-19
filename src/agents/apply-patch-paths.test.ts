import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractApplyPatchTargetPaths,
  extractResolvedApplyPatchTargetPaths,
} from "./apply-patch-paths.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";

const defaultCwd = process.cwd();
const cwdPath = (...segments: string[]) => path.join(defaultCwd, ...segments);
const envelope = (...hunks: string[]) => ["*** Begin Patch", ...hunks, "*** End Patch"].join("\n");

describe("extractApplyPatchTargetPaths", () => {
  it("returns an empty array for non-string input", () => {
    for (const input of [undefined, null, 42, {}, { input: 7 }]) {
      expect(extractApplyPatchTargetPaths(input)).toEqual([]);
    }
  });

  it("returns an empty array for an empty patch", () => {
    expect(extractApplyPatchTargetPaths("")).toEqual([]);
    expect(extractApplyPatchTargetPaths({ input: "" })).toEqual([]);
  });

  it("extracts Update File and Delete File markers", () => {
    const patch = envelope("*** Update File: a.ts\n@@\n context\n+added", "*** Delete File: b.ts");
    expect(extractApplyPatchTargetPaths(patch)).toEqual([cwdPath("a.ts"), cwdPath("b.ts")]);
  });

  it("tolerates blank lines between Update File and Move to", () => {
    const patch = envelope("*** Update File: a.ts\n\n*** Move to: b.ts");
    expect(extractApplyPatchTargetPaths(patch)).toEqual([cwdPath("a.ts"), cwdPath("b.ts")]);
  });

  it("accepts the wrapper object form used by the apply_patch tool", () => {
    const patch = envelope("*** Add File: foo.ts\n+x");
    expect(extractApplyPatchTargetPaths({ input: patch })).toEqual([cwdPath("foo.ts")]);
  });

  it("normalizes derived paths before de-duplicating them", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: safe/../secret.ts",
      "+x",
      "*** Update File: ./src//old.ts",
      "*** Move to: src/temp/../renamed.ts",
      "@@",
      "+y",
      "*** Delete File: secret.ts",
      "*** End Patch",
    ].join("\n");
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

  it("handles CRLF line endings", () => {
    const patch = ["*** Begin Patch", "*** Add File: crlf.ts", "+x", "*** End Patch"].join("\r\n");
    expect(extractApplyPatchTargetPaths(patch)).toEqual([cwdPath("crlf.ts")]);
  });

  it("matches indented hunk headers the same way as the apply_patch executor", () => {
    const patch = [
      "  *** Begin Patch",
      "  *** Add File: src/new.ts",
      "+x",
      "  *** Delete File: src/dead.ts",
      "  *** Update File: src/old.ts",
      "  *** Move to: src/renamed.ts",
      "@@",
      "-old",
      "+new",
      "  *** End Patch",
    ].join("\n");
    expect(extractApplyPatchTargetPaths(patch)).toEqual([
      cwdPath("src/new.ts"),
      cwdPath("src/dead.ts"),
      cwdPath("src/old.ts"),
      cwdPath("src/renamed.ts"),
    ]);
  });

  it("matches single-space-indented top-level headers the same way as the executor", () => {
    const patch = [
      "*** Begin Patch",
      " *** Add File: src/new.ts",
      "+x",
      " *** Delete File: src/dead.ts",
      "*** End Patch",
    ].join("\n");
    expect(extractApplyPatchTargetPaths(patch)).toEqual([
      cwdPath("src/new.ts"),
      cwdPath("src/dead.ts"),
    ]);
  });

  it("ignores markers outside of the envelope grammar", () => {
    expect(
      extractApplyPatchTargetPaths(
        ["nothing here", "*** Random Marker: x", "+a", "context"].join("\n"),
      ),
    ).toEqual([]);
  });

  it("ignores marker-like context and body lines inside update hunks", () => {
    const patch = envelope(
      "*** Update File: real.ts",
      "@@",
      " *** Add File: fake-context.ts",
      "  *** Delete File: fake-indented-context.ts",
      "-*** Delete File: fake-remove.ts",
      "+*** Add File: fake-add.ts",
    );
    expect(extractApplyPatchTargetPaths(patch)).toEqual([cwdPath("real.ts")]);
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

  it("does not require the begin/end envelope markers to be present", () => {
    const patch = ["*** Add File: loose.ts", "+x"].join("\n");
    expect(extractApplyPatchTargetPaths(patch)).toEqual([cwdPath("loose.ts")]);
  });
});
