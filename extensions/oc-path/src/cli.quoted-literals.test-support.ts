/**
 * Quoted-literal key handling shared by the `resolve` / `find` / `set` verbs.
 *
 * Split out of `cli.test.ts` so that file stays under the max-lines cap; the
 * owning suite registers these cases from its own `describe` block.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  createTestRuntime,
  pathFindCommand,
  pathResolveCommand,
  pathSetCommand,
  stdoutText,
} from "./cli.test-support.js";

export function registerQuotedLiteralTests(): void {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.each(["jsonc", "jsonl", "yaml"])(
    "keeps quoted special and escaped keys literal in %s CLI reads, writes, and find",
    async (kind) => {
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filename = `config.${kind}`;
      const filePath = join(workspaceDir, filename);
      const literals = [
        ["$first", '"$first"', 7],
        ["$last", '"$last"', 9],
        ["*", '"*"', 11],
        ["**", '"**"', 12],
        ["#0", '"#0"', 13],
        ["+", '"+"', 14],
        ["+key", '"+key"', 15],
        ["+1", '"+1"', 16],
        ["{a,b}", '"{a,b}"', 17],
        ["[k=v]", '"[k=v]"', 18],
        ['a"b\\c/d.e?f', String.raw`"a\"b\\c/d.e?f"`, 19],
        ['"$first"', String.raw`"\"$first\""`, 20],
      ] as const;
      const expected: { items: Record<string, string | number> } = {
        items: {
          head: "keep-first",
          ...Object.fromEntries(literals.map(([key, , value]) => [key, value])),
          tail: "keep-last",
        },
      };
      writeFileSync(
        filePath,
        kind === "yaml" ? stringifyYaml(expected) : JSON.stringify(expected),
        "utf-8",
      );
      const options = { cwd: workspaceDir, json: true };
      const prefix = `oc://${filename}/${kind === "jsonl" ? "L1/" : ""}items`;
      const readSaved = (raw: string) => (kind === "yaml" ? parseYaml(raw) : JSON.parse(raw));

      for (const [token, value] of [
        ["$first", "keep-first"],
        ["$last", "keep-last"],
      ]) {
        const rt = createTestRuntime();
        await pathResolveCommand(`${prefix}/${token}`, options, rt);
        expect(rt.exitCode).toBe(0);
        expect(JSON.parse(stdoutText(rt)).match).toMatchObject({ valueText: value });
      }
      for (const [key, quoted, value] of literals) {
        const path = `${prefix}.${quoted}`;
        const rt = createTestRuntime();
        await pathResolveCommand(path, options, rt);
        expect(rt.exitCode).toBe(0);
        expect(JSON.parse(stdoutText(rt)).match).toMatchObject({
          kind: "leaf",
          valueText: String(value),
          leafType: "number",
        });
        const nestedFind = createTestRuntime();
        await pathFindCommand(
          `oc://${filename}/${kind === "jsonl" ? "L1/" : ""}*/${quoted}`,
          options,
          nestedFind,
        );
        expect(nestedFind.exitCode).toBe(0);
        expect(JSON.parse(stdoutText(nestedFind)).matches).toMatchObject([
          { path: `${prefix}/${quoted}`, match: { valueText: String(value), leafType: "number" } },
        ]);
        const before = readFileSync(filePath, "utf-8");
        expected.items[key] = 42;
        const preview = createTestRuntime();
        await pathSetCommand(path, "42", { ...options, dryRun: true }, preview);
        expect(preview.exitCode).toBe(0);
        expect(readSaved(JSON.parse(stdoutText(preview)).bytes)).toEqual(expected);
        expect(readFileSync(filePath, "utf-8")).toBe(before);
        const written = createTestRuntime();
        await pathSetCommand(path, "42", options, written);
        expect(written.exitCode).toBe(0);
        expect(readSaved(readFileSync(filePath, "utf-8"))).toEqual(expected);
      }

      const found = createTestRuntime();
      await pathFindCommand(`${prefix}/*`, options, found);
      expect(found.exitCode).toBe(0);
      expect(JSON.parse(stdoutText(found)).matches).toMatchObject([
        { path: `${prefix}/head`, match: { valueText: "keep-first" } },
        ...literals.map(([, quoted]) => ({
          path: `${prefix}/${quoted}`,
          match: { valueText: "42", leafType: "number" },
        })),
        { path: `${prefix}/tail`, match: { valueText: "keep-last" } },
      ]);

      writeFileSync(filePath, JSON.stringify({ items: { $last: 10, '"$first"': 20 } }), "utf-8");
      for (const [selector, quoted, value] of [
        ["$first", '"$last"', 10],
        ["$last", String.raw`"\"$first\""`, 20],
      ] as const) {
        const positional = createTestRuntime();
        await pathFindCommand(`${prefix}/${selector}`, options, positional);
        expect(positional.exitCode).toBe(0);
        expect(JSON.parse(stdoutText(positional)).matches).toMatchObject([
          { path: `${prefix}/${quoted}`, match: { valueText: String(value), leafType: "number" } },
        ]);
        const written = createTestRuntime();
        await pathSetCommand(`${prefix}/${selector}`, "42", options, written);
        expect(written.exitCode).toBe(0);
      }
      expect(readSaved(readFileSync(filePath, "utf-8"))).toEqual({
        items: { $last: 42, '"$first"': 42 },
      });
    },
  );
}
