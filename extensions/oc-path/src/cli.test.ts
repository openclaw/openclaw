/**
 * Smoke tests for the `openclaw path` CLI handlers.
 *
 * Tests invoke each subcommand through the retained Commander registration.
 * Assertions inspect captured process output and the resulting exit code.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  openSync,
  promises as fs,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import plugin from "../index.js";
import { registerQuotedLiteralTests } from "./cli.quoted-literals.test-support.js";
import {
  createTestRuntime,
  pathEmitCommand,
  pathFindCommand,
  pathResolveCommand,
  pathSetCommand,
  pathValidateCommand,
  stderrText,
  stdoutText,
  type TestRuntime,
} from "./cli.test-support.js";

const JSONC_INPUT_LIMIT_BYTES = 16 * 1024 * 1024;

const isPathMachineOutput = (() => {
  let resolver:
    | ((params: { argv: readonly string[]; stdoutIsTTY: boolean }) => boolean)
    | undefined;
  plugin.register(
    createTestPluginApi({
      registerCli(_registrar, options) {
        const descriptor = options?.descriptors?.[0];
        resolver =
          descriptor && "machineOutput" in descriptor ? descriptor.machineOutput : undefined;
      },
    }),
  );
  if (!resolver) {
    throw new Error("oc-path CLI descriptor is missing its machine-output resolver");
  }
  return resolver;
})();

describe("openclaw path CLI", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  function fileFixture(filename: string) {
    const workspaceDir = tempDirs.make("oc-path-cli-");
    return { workspaceDir, filePath: join(workspaceDir, filename) };
  }

  it("reports its TTY-aware machine-output mode to the CLI", () => {
    const argv = ["node", "openclaw", "path", "validate", "oc://AGENTS.md"];
    expect(isPathMachineOutput({ argv, stdoutIsTTY: false })).toBe(true);
    expect(isPathMachineOutput({ argv, stdoutIsTTY: true })).toBe(false);
    expect(isPathMachineOutput({ argv: [...argv, "--json"], stdoutIsTTY: true })).toBe(true);
    expect(isPathMachineOutput({ argv: [...argv, "--human"], stdoutIsTTY: false })).toBe(false);
  });

  describe("validate", () => {
    it("CLI-V02 rejects a malformed path with code 1", async () => {
      const rt = createTestRuntime();
      await pathValidateCommand("oc://X/a\x00b", { json: true }, rt);
      expect([rt.exitCode, JSON.parse(stdoutText(rt)).valid]).toEqual([1, false]);
    });
  });

  registerQuotedLiteralTests();

  describe("resolve", () => {
    it("CLI-R04 finds a leaf in yaml and prints it", async () => {
      const { workspaceDir, filePath } = fileFixture("workflow.yaml");
      writeFileSync(filePath, "name: inbox-triage\nsteps:\n  - id: fetch\n", "utf-8");
      const rt = createTestRuntime();
      await pathResolveCommand(
        "oc://workflow.yaml/steps/0/id",
        { cwd: workspaceDir, json: true },
        rt,
      );
      expect(rt.exitCode).toBe(0);
      const out = JSON.parse(stdoutText(rt));
      expect(out).toMatchObject({ resolved: true, match: { kind: "leaf", valueText: "fetch" } });
    });

    it("CLI-R02 returns 1 for not-found path", async () => {
      const { workspaceDir, filePath } = fileFixture("gateway.jsonc");
      writeFileSync(filePath, '{ "version": "1.0" }', "utf-8");
      const rt = createTestRuntime();
      await pathResolveCommand("oc://gateway.jsonc/missing", { cwd: workspaceDir, json: true }, rt);
      expect(rt.exitCode).toBe(1);
      const out = JSON.parse(stdoutText(rt));
      expect(out.resolved).toBe(false);
    });

    it("CLI-R05 keeps reading a file whose undecodable byte is outside the resolved leaf", async () => {
      // Strict admission is limited to the editing verb, so read-only inspection
      // keeps its existing contract for files that are not valid UTF-8.
      const { workspaceDir, filePath } = fileFixture("gateway.jsonc");
      const before = Buffer.concat([
        Buffer.from('{ "version": "1.0", "note": "a'),
        Buffer.from([0xff]),
        Buffer.from('b" }'),
      ]);
      writeFileSync(filePath, before);
      const rt = createTestRuntime();
      await pathResolveCommand("oc://gateway.jsonc/version", { cwd: workspaceDir, json: true }, rt);

      expect(rt.exitCode).toBe(0);
      expect(JSON.parse(stdoutText(rt)).match.valueText).toBe("1.0");
      expect(readFileSync(filePath)).toEqual(before);
    });

    it("bounds every file-loading verb before parsing oversized input", async () => {
      const { filePath } = fileFixture("oversized.json");
      const content = `"${"界".repeat(Math.floor(JSONC_INPUT_LIMIT_BYTES / 3) + 1)}"`;
      writeFileSync(filePath, content, "utf-8");
      const unboundedRead = vi
        .spyOn(fs, "readFile")
        .mockRejectedValue(new Error("unbounded file read"));
      // The loader reads through a descriptor stream; count the bytes it pulls.
      const open = fs.open.bind(fs);
      let opens = 0;
      let bytesRead = 0;
      const observedOpen = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (args[0] === filePath) {
          opens += 1;
          const read = handle.read.bind(handle);
          vi.spyOn(handle, "read").mockImplementation(async (...readArgs) => {
            const result = await read(...readArgs);
            bytesRead += result.bytesRead;
            return result;
          });
        }
        return handle;
      });
      const cases: ReadonlyArray<{
        code: string;
        run: (runtime: TestRuntime) => Promise<void>;
      }> = [
        {
          code: "OC_JSONC_INPUT_TOO_LARGE",
          run: (runtime) =>
            pathResolveCommand(
              "oc://oversized.json/value",
              { file: filePath, json: true },
              runtime,
            ),
        },
        {
          code: "OC_JSONC_INPUT_TOO_LARGE",
          run: (runtime) =>
            pathFindCommand("oc://oversized.json/*", { file: filePath, json: true }, runtime),
        },
        {
          code: "OC_JSONC_INPUT_TOO_LARGE",
          run: (runtime) =>
            pathSetCommand(
              "oc://oversized.json/value",
              "next",
              { file: filePath, json: true, dryRun: true },
              runtime,
            ),
        },
        {
          code: "OC_JSONC_INPUT_TOO_LARGE",
          run: (runtime) => pathEmitCommand(filePath, { json: true }, runtime),
        },
        {
          code: "OC_PATH_INPUT_TOO_LARGE",
          run: (runtime) =>
            pathResolveCommand("oc://oversized.md/value", { file: filePath, json: true }, runtime),
        },
      ];

      try {
        for (const testCase of cases) {
          opens = 0;
          bytesRead = 0;
          const rt = createTestRuntime();
          await testCase.run(rt);
          expect(rt.exitCode).toBe(2);
          expect(JSON.parse(stdoutText(rt))).toMatchObject({
            ok: false,
            error: { type: "cli_error", code: testCase.code },
          });
          expect(opens).toBeGreaterThan(0);
          expect(bytesRead).toBeLessThanOrEqual(JSONC_INPUT_LIMIT_BYTES + 1);
        }
        expect(unboundedRead).not.toHaveBeenCalled();
      } finally {
        observedOpen.mockRestore();
        unboundedRead.mockRestore();
      }
    });

    it.runIf(process.platform !== "win32")(
      "rejects a FIFO without waiting for a writer",
      async () => {
        const workspaceDir = tempDirs.make("oc-path-cli-");
        const fifoPath = join(workspaceDir, "input.json");
        execFileSync("mkfifo", [fifoPath]);
        const releaseBlockedReader = setTimeout(() => {
          const fd = openSync(fifoPath, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
          writeSync(fd, '{"ok":true}');
          closeSync(fd);
        }, 250);
        const rt = createTestRuntime();

        try {
          await pathResolveCommand("oc://input.json/ok", { file: fifoPath, json: true }, rt);
        } finally {
          clearTimeout(releaseBlockedReader);
        }

        expect(rt.exitCode).toBe(2);
        expect(JSON.parse(stdoutText(rt))).toMatchObject({
          error: { code: "OC_PATH_FILE_NOT_REGULAR" },
        });
      },
    );

    it.each<[string, { json?: boolean; human?: boolean }]>([
      ["json", { json: true }],
      ["human", { human: true }],
    ])("CLI-R06 reports an unreadable file inside the %s error envelope", async (_mode, mode) => {
      const { workspaceDir } = fileFixture("missing.md");
      const rt = createTestRuntime();
      await pathResolveCommand("oc://missing.md/heading", { cwd: workspaceDir, ...mode }, rt);
      const output = `${stdoutText(rt)}${stderrText(rt)}`;
      expect(rt.exitCode).toBe(2);
      expect(output).toContain("OC_PATH_FILE_UNREADABLE");
      expect(output).toContain("ENOENT");
      if (mode.json === true) {
        expect(JSON.parse(stdoutText(rt))).toMatchObject({
          ok: false,
          error: { type: "cli_error", code: "OC_PATH_FILE_UNREADABLE" },
        });
      }
    });
  });

  describe("set", () => {
    it("preserves an existing quoted frontmatter value when editing another field", async () => {
      const { workspaceDir, filePath } = fileFixture("AGENTS.md");
      const value = String.raw`C:\Tools\bin`;
      writeFileSync(filePath, `---\nname: old\nnote: ${JSON.stringify(value)}\n---\n`);
      const rt = createTestRuntime();
      await pathSetCommand(
        "oc://AGENTS.md/[frontmatter]/name",
        "new",
        { cwd: workspaceDir, json: true },
        rt,
      );
      expect(rt.exitCode, stderrText(rt)).toBe(0);
      const frontmatter = readFileSync(filePath, "utf8").split("---")[1];
      expect(parseYaml(frontmatter ?? "")).toEqual({ name: "new", note: value });
    });

    it.each([
      { label: "quote delimiters", value: '"hello"' },
      { label: "surrounding whitespace", value: "  hello\t" },
    ])("preserves a frontmatter $label across separate CLI reads and edits", async ({ value }) => {
      const { workspaceDir, filePath } = fileFixture("AGENTS.md");
      writeFileSync(
        filePath,
        "---\nnote: old # keep\nother: original\n---\n\n## Tasks\n- Keep this item\n",
      );
      const options = { cwd: workspaceDir, json: true };
      const target = "oc://AGENTS.md/[frontmatter]/note";
      const set = createTestRuntime();
      await pathSetCommand(target, value, options, set);
      expect(set.exitCode, stderrText(set)).toBe(0);

      const read = createTestRuntime();
      await pathResolveCommand(target, options, read);
      expect(read.exitCode, stderrText(read)).toBe(0);
      expect(JSON.parse(stdoutText(read)).match.valueText).toBe(value);

      const other = createTestRuntime();
      await pathSetCommand("oc://AGENTS.md/[frontmatter]/other", "updated", options, other);
      expect(other.exitCode, stderrText(other)).toBe(0);
      const reread = createTestRuntime();
      await pathResolveCommand(target, options, reread);
      expect(reread.exitCode, stderrText(reread)).toBe(0);
      expect(JSON.parse(stdoutText(reread)).match.valueText).toBe(value);
      expect(readFileSync(filePath, "utf8")).toContain("## Tasks\n- Keep this item");
      expect(readFileSync(filePath, "utf8")).toContain(" # keep\nother: updated");
    });

    it.each([
      ["1e-7", "1e-7"],
      ["2.5E+3", "2500"],
      ["1e21", "1e+21"],
    ])("writes YAML numeric value %s without changing its type", async (value, expected) => {
      const { filePath } = fileFixture("workflow.yaml");
      const before = "# settings\nrate: 1e-7\nlabel: keep\n";
      writeFileSync(filePath, before);
      const options = { file: filePath, json: true };
      const address = "oc://workflow.yaml/rate";
      const preview = createTestRuntime();
      await pathSetCommand(address, value, { ...options, dryRun: true }, preview);
      expect(preview.exitCode).toBe(0);
      expect(readFileSync(filePath, "utf8")).toBe(before);

      const write = createTestRuntime();
      await pathSetCommand(address, value, options, write);
      expect(write.exitCode).toBe(0);
      const read = createTestRuntime();
      await pathResolveCommand(address, options, read);
      expect(read.exitCode).toBe(0);
      expect(JSON.parse(stdoutText(read)).match).toMatchObject({
        leafType: "number",
        valueText: expected,
      });
      const after = readFileSync(filePath, "utf8");
      expect(after).toContain("# settings\n");
      expect(after).toContain("label: keep\n");
    });

    it.each(["1e", "1e999", "0x10", "1,5"])(
      "refuses invalid YAML numeric value %s without writing",
      async (value) => {
        const { filePath } = fileFixture("workflow.yaml");
        const before = "rate: 1e-7\n";
        writeFileSync(filePath, before);
        const runtime = createTestRuntime();
        await pathSetCommand(
          "oc://workflow.yaml/rate",
          value,
          { file: filePath, json: true },
          runtime,
        );
        expect(runtime.exitCode).toBe(1);
        expect(JSON.parse(stdoutText(runtime))).toMatchObject({ ok: false, reason: "parse-error" });
        expect(readFileSync(filePath, "utf8")).toBe(before);
      },
    );

    it.each([
      {
        eol: "\n",
        value: " first line\n  second line",
        text: "first line\nsecond line",
        prefix: " ",
      },
      { eol: "\r\n", value: "\n  first line", text: "first line", prefix: "\n  " },
    ])(
      "reads and edits wrapped Markdown item values: $value with $eol",
      async ({ eol, value, text, prefix }) => {
        const { workspaceDir, filePath } = fileFixture("notes.md");
        const before = [
          "## Notes",
          `- description:${value}`,
          "  - child: preserved",
          "- keep: unchanged",
          "",
        ]
          .join("\n")
          .replaceAll("\n", eol);
        writeFileSync(filePath, before, "utf-8");
        const path = "oc://notes.md/notes/description/description";
        const options = { cwd: workspaceDir, json: true };
        const resolved = createTestRuntime();
        await pathResolveCommand(path, options, resolved);
        expect(resolved.exitCode).toBe(0);
        expect(JSON.parse(stdoutText(resolved)).match).toMatchObject({
          kind: "leaf",
          valueText: text,
          leafType: "string",
        });

        const expected = [
          "## Notes",
          `- description:${prefix}updated`,
          "  - child: preserved",
          "- keep: unchanged",
          "",
        ]
          .join("\n")
          .replaceAll("\n", eol);
        const preview = createTestRuntime();
        await pathSetCommand(path, "updated", { ...options, dryRun: true }, preview);
        expect(preview.exitCode).toBe(0);
        expect(JSON.parse(stdoutText(preview)).bytes).toBe(expected);
        expect(readFileSync(filePath, "utf-8")).toBe(before);

        const written = createTestRuntime();
        await pathSetCommand(path, "updated", options, written);
        expect(written.exitCode).toBe(0);
        expect(readFileSync(filePath, "utf-8")).toBe(expected);
        const reread = createTestRuntime();
        await pathResolveCommand(path, options, reread);
        expect(reread.exitCode).toBe(0);
        expect(JSON.parse(stdoutText(reread)).match).toMatchObject({ valueText: "updated" });
      },
    );

    it.each([
      {
        label: "unresolved JSONC leaf",
        file: "config.jsonc",
        before: '{ "count": 1 }\n',
        path: "oc://config.jsonc/missing",
        value: "next",
        expected: { ok: false, reason: "unresolved" },
      },
      {
        label: "non-writable root with human detail",
        file: "config.jsonc",
        before: '{ "count": 1 }\n',
        path: "oc://config.jsonc",
        value: "next",
        expected: "set failed: not-writable — root replacement is not supported via setOcPath",
      },
      {
        label: "numeric coercion refusal",
        file: "config.jsonc",
        before: '{ "count": 1 }\n',
        path: "oc://config.jsonc/count",
        value: "oops",
        expected: { ok: false, reason: "parse-error", detail: 'cannot coerce "oops" to number' },
      },
      ...["jsonc", "jsonl"].flatMap((kind) =>
        ["", " \t\r\n "].map((value) => ({
          label: `blank ${kind} number ${JSON.stringify(value)}`,
          file: `config.${kind}`,
          before: '{"count":1}\n',
          path: `oc://config.${kind}/${kind === "jsonl" ? "L1/" : ""}count`,
          value,
          expected: {
            ok: false,
            reason: "parse-error",
            detail: `cannot coerce "${value}" to number`,
          },
        })),
      ),
      {
        label: "keyed insertion into an array",
        file: "config.jsonc",
        before: '{ "items": [1] }\n',
        path: "oc://config.jsonc/items/+key",
        value: "2",
        expected: {
          ok: false,
          reason: "type-mismatch",
          detail: "cannot insert by key into array",
        },
      },
      {
        label: "wildcard write refusal",
        file: "config.jsonc",
        before: '{ "items": [1] }\n',
        path: "oc://config.jsonc/items/*",
        value: "2",
        expected: {
          ok: false,
          reason: "wildcard-not-allowed",
          detail: "setOcPath requires a concrete path; use findOcPaths to enumerate matches first",
        },
      },
      {
        label: "non-keyed Markdown item with human output",
        file: "AGENTS.md",
        before: "## Tools\n- plain bullet\n",
        path: "oc://AGENTS.md/tools/plain-bullet/plain-bullet",
        value: "next",
        expected: "set failed: no-item-kv",
      },
      {
        label: "malformed JSONL record",
        file: "events.jsonl",
        before: '{"event":"keep"}\nbroken\n',
        path: "oc://events.jsonl/L2",
        value: '"next"',
        expected: { ok: false, reason: "not-a-value-line" },
      },
    ])("preserves CLI rejection output and source bytes for $label", async (testCase) => {
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filePath = join(workspaceDir, testCase.file);
      const before = Buffer.from(testCase.before, "utf8");
      writeFileSync(filePath, before);
      const rt = createTestRuntime();
      const human = typeof testCase.expected === "string";

      await pathSetCommand(
        testCase.path,
        testCase.value,
        { cwd: workspaceDir, human, json: !human },
        rt,
      );

      expect(rt.exitCode).toBe(1);
      expect(stderrText(rt)).toBe("");
      if (human) {
        expect(stdoutText(rt)).toBe(testCase.expected);
      } else {
        expect(JSON.parse(stdoutText(rt))).toEqual(testCase.expected);
      }
      expect(readFileSync(filePath)).toEqual(before);
    });

    describe.each(["\n", "\r\n"])("Markdown source preservation with %j", (ending) => {
      const frontmatter =
        '\uFEFF---\n# Keep the authored metadata.\nname: &shared "example"\ncopy: *shared\nempty: &empty # Keep empty anchor.\nempty_copy: *empty\nvacant: # Keep empty value.\n\ndescription: |\n  First line.\n  Second line.\n# Keep the next-line comment.\nmetadata:\n  openclaw:\n    requires:\n      bins: [gh]\n---\n';
      const body = '\n# Title\n\n## Tools ##\n- command: old\n\n## Other\n* untouched: "quoted"';
      const before = frontmatter + body;
      it.each([
        [
          "body field edit",
          "tools/command/command",
          "new",
          before.replace("command: old", "command: new"),
        ],
        [
          "item insertion",
          "tools/+",
          "added: value",
          before.replace("## Other", "- added: value\n## Other"),
        ],
        ["section insertion", "+", "Added", before + "\n\n## Added"],
        [
          "frontmatter edit",
          "[frontmatter]/name",
          "updated",
          before.replace('name: &shared "example"', "name: &shared updated"),
        ],
        [
          "frontmatter insertion",
          "[frontmatter]/+added",
          "value",
          before.replace("bins: [gh]\n---", "bins: [gh]\nadded: value\n---"),
        ],
        [
          "empty anchored value",
          "[frontmatter]/empty",
          "filled",
          before.replace("empty: &empty #", "empty: &empty filled #"),
        ],
        [
          "empty value with inline comment",
          "[frontmatter]/vacant",
          "has: colon",
          before.replace("vacant: #", 'vacant: "has: colon" #'),
        ],
        [
          "block scalar replacement",
          "[frontmatter]/description",
          "plain",
          before.replace("|\n  First line.\n  Second line.", "plain"),
        ],
        [
          "nested metadata replacement",
          "[frontmatter]/metadata",
          "plain",
          before.replace(
            "metadata:\n  openclaw:\n    requires:\n      bins: [gh]",
            "metadata: plain",
          ),
        ],
      ])(
        "preserves unrelated Markdown bytes during %s",
        async (_label, target, value, expected) => {
          const { workspaceDir, filePath } = fileFixture("SKILL.md");
          const finalNewline = ending === "\n" ? ending : "";
          writeFileSync(filePath, before.replace(/\n/g, ending) + finalNewline);
          const rt = createTestRuntime();
          await pathSetCommand(
            `oc://SKILL.md/${target}`,
            value,
            { cwd: workspaceDir, json: true },
            rt,
          );

          expect(rt.exitCode, stderrText(rt)).toBe(0);
          expect(readFileSync(filePath, "utf8")).toBe(
            expected.replace(/\n/g, ending) + finalNewline,
          );
          if (target === "[frontmatter]/empty" || target === "[frontmatter]/vacant") {
            const fields = parseYaml(readFileSync(filePath, "utf8").split("---")[1] ?? "");
            const key = target === "[frontmatter]/empty" ? "empty" : "vacant";
            expect(fields[key]).toBe(value);
          }
          if (target === "[frontmatter]/metadata") {
            const readback = createTestRuntime();
            await pathResolveCommand(
              `oc://SKILL.md/${target}`,
              { cwd: workspaceDir, json: true },
              readback,
            );
            expect(readback.exitCode, stderrText(readback)).toBe(0);
            expect(JSON.parse(stdoutText(readback)).match.valueText).toBe(value);
          }
        },
      );
    });
    it.each(["\n", "\r\n", "mixed"])(
      "preserves JSONL bytes outside a leaf and across append with %j separators",
      async (ending) => {
        const { filePath } = fileFixture("events.jsonl");
        const firstEnding = ending === "mixed" ? "\r\n" : ending;
        const lastEnding = ending === "mixed" ? "\n" : ending;
        const before =
          '\uFEFF{ "id": 9007199254740993, "ratio": 1.0000000000000001 } // note' +
          firstEnding +
          '{ "items": [{"event":"old", "id":9007199254740993, "ratio":1.0000000000000001}], "literal":"\\u0041" }' +
          lastEnding +
          lastEnding +
          "// keep this comment" +
          lastEnding +
          "broken record" +
          lastEnding;
        const expected = before.replace('"event":"old"', '"event":"updated"');
        writeFileSync(filePath, before, "utf8");
        const address = "oc://events.jsonl/L2/items.$last/event";
        const preview = createTestRuntime();
        await pathSetCommand(
          address,
          "updated",
          { file: filePath, json: true, dryRun: true },
          preview,
        );
        expect(preview.exitCode).toBe(0);
        expect(JSON.parse(stdoutText(preview)).bytes).toBe(expected);
        expect(readFileSync(filePath, "utf8")).toBe(before);

        const write = createTestRuntime();
        await pathSetCommand(address, "updated", { file: filePath, json: true }, write);
        expect(write.exitCode).toBe(0);
        expect(readFileSync(filePath, "utf8")).toBe(expected);

        const append = createTestRuntime();
        await pathSetCommand(
          "oc://events.jsonl/+",
          '{"event":"next"}',
          { file: filePath, json: true, valueJson: true },
          append,
        );
        expect(append.exitCode).toBe(0);
        expect(readFileSync(filePath, "utf8")).toBe(`${expected}{"event":"next"}${lastEnding}`);
      },
    );

    it("CLI-S09 refuses an undecodable file instead of rewriting untouchable bytes", async () => {
      const { workspaceDir, filePath } = fileFixture("gateway.jsonc");
      // The invalid byte sits in a leaf the edit never touches.
      const before = Buffer.concat([
        Buffer.from('{ "version": "1.0", "note": "a'),
        Buffer.from([0xff]),
        Buffer.from('b" }'),
      ]);
      writeFileSync(filePath, before);
      const rt = createTestRuntime();
      await pathSetCommand(
        "oc://gateway.jsonc/version",
        "2.0",
        { cwd: workspaceDir, json: true },
        rt,
      );

      expect(rt.exitCode).toBe(2);
      expect(stdoutText(rt)).toContain("OC_PATH_INPUT_NOT_UTF8");
      expect(stdoutText(rt)).toContain("the file was left unchanged");
      expect(readFileSync(filePath)).toEqual(before);
    });

    it("CLI-S10 still writes valid non-ASCII values including a literal replacement character", async () => {
      const { workspaceDir, filePath } = fileFixture("gateway.jsonc");
      writeFileSync(filePath, '{ "version": "1.0", "note": "合法 😀 �" }', "utf8");
      const rt = createTestRuntime();
      await pathSetCommand(
        "oc://gateway.jsonc/version",
        "2.0",
        { cwd: workspaceDir, json: true },
        rt,
      );

      expect(rt.exitCode).toBe(0);
      const after = readFileSync(filePath, "utf-8");
      expect(after).toContain('"version": "2.0"');
      expect(after).toContain("合法 😀 �");
    });

    it("CLI-S02b --dry-run human output reports the rendered UTF-8 byte count", async () => {
      const { workspaceDir, filePath } = fileFixture("gateway.jsonc");
      const before = '{ "version": "1.0" }';
      writeFileSync(filePath, before, "utf-8");
      const rt = createTestRuntime();
      await pathSetCommand(
        "oc://gateway.jsonc/version",
        "中文",
        { cwd: workspaceDir, human: true, dryRun: true },
        rt,
      );

      const [header, ...bodyLines] = stdoutText(rt).split("\n");
      const body = bodyLines.join("\n");
      expect(header).toBe(
        `--dry-run: would write ${Buffer.byteLength(body, "utf8")} bytes to ${filePath}`,
      );
      expect(readFileSync(filePath, "utf-8")).toBe(before);
    });

    it.runIf(process.platform !== "win32").each([
      { label: "LF", before: '{ "version": "1.0" }\n', json: false },
      { label: "CRLF", before: '{ "version": "1.0" }\r\n', json: true },
      { label: "no final newline", before: '{ "version": "1.0" }', json: true },
      {
        label: "middle-of-file",
        before: `{\n${"  // leading context\n".repeat(5)}  "version": "1.0"\n${"  // trailing context\n".repeat(5)}}\n`,
        json: true,
      },
    ])("emits an applicable $label dry-run patch", async ({ before, json }) => {
      const { workspaceDir, filePath } = fileFixture("gateway.jsonc");
      const patchPath = join(workspaceDir, "preview.patch");
      const after = before.replace('"1.0"', '"2.0"');
      writeFileSync(filePath, before, "utf-8");
      const rt = createTestRuntime();
      await pathSetCommand(
        "oc://gateway.jsonc/version",
        "2.0",
        { cwd: workspaceDir, human: !json, json, dryRun: true, diff: true },
        rt,
      );

      expect(rt.exitCode).toBe(0);
      const output = stdoutText(rt);
      const payload = json ? JSON.parse(output) : undefined;
      const patch = json ? payload.diff : output;
      if (json) {
        expect(payload.bytes).toBe(after);
      }
      writeFileSync(patchPath, patch, "utf-8");
      expect(readFileSync(filePath, "utf-8")).toBe(before);
      execFileSync(
        "git",
        ["apply", "--check", `-p${filePath.split("/").filter(Boolean).length}`, patchPath],
        {
          cwd: workspaceDir,
        },
      );
      execFileSync("patch", ["--dry-run", "--fuzz=0", filePath, patchPath]);
      expect(readFileSync(filePath, "utf-8")).toBe(before);
      execFileSync("patch", ["--fuzz=0", filePath, patchPath]);
      expect(readFileSync(filePath, "utf-8")).toBe(after);
    });

    it("CLI-S05c --dry-run --diff preserves CRLF during a Markdown value change", async () => {
      const { workspaceDir, filePath } = fileFixture("AGENTS.md");
      const before = "---\r\nname: x\r\n---\r\n";
      writeFileSync(filePath, before, "utf-8");
      const rt = createTestRuntime();
      await pathSetCommand(
        "oc://AGENTS.md/[frontmatter]/name",
        "y",
        { cwd: workspaceDir, json: true, dryRun: true, diff: true },
        rt,
      );
      expect(rt.exitCode).toBe(0);
      const out = JSON.parse(stdoutText(rt));
      expect(out.bytes).toBe("---\r\nname: y\r\n---\r\n");
      expect(out.diff).toContain("-name: x\r");
      expect(out.diff).toContain("+name: y\r");
      expect(readFileSync(filePath, "utf-8")).toBe(before);
    });

    it("CLI-S07 rejects --diff without --dry-run", async () => {
      const { workspaceDir, filePath } = fileFixture("gateway.jsonc");
      const before = '{ "version": "1.0" }';
      writeFileSync(filePath, before, "utf-8");
      const rt = createTestRuntime();
      await pathSetCommand(
        "oc://gateway.jsonc/version",
        "2.0",
        { cwd: workspaceDir, json: true, diff: true },
        rt,
      );
      expect(rt.exitCode).toBe(1);
      expect(JSON.parse(stdoutText(rt))).toMatchObject({
        ok: false,
        reason: "--diff requires --dry-run",
      });
      expect(readFileSync(filePath, "utf-8")).toBe(before);
    });

    it("CLI-S08 sets slash-deep JSONC paths and parsed JSON values", async () => {
      const { workspaceDir, filePath } = fileFixture("openclaw.json");
      writeFileSync(
        filePath,
        '{ "agents": { "entries": { "main": { "tools": { "exec": { "security": "deny" } } } } }, "gateway": { "auth": { "token": "${TOKEN}" } } }\n',
        "utf-8",
      );
      const rt = createTestRuntime();

      await pathSetCommand(
        "oc://openclaw.json/gateway/auth/token",
        '{"source":"file","provider":"secrets","id":"/test"}',
        { cwd: workspaceDir, json: true, valueJson: true },
        rt,
      );

      expect(rt.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(filePath, "utf8")).gateway.auth.token).toEqual({
        source: "file",
        provider: "secrets",
        id: "/test",
      });

      const rt2 = createTestRuntime();
      await pathSetCommand(
        "oc://openclaw.json/agents/entries/main/tools/exec/security",
        "allowlist",
        { cwd: workspaceDir, json: true },
        rt2,
      );

      expect(rt2.exitCode).toBe(0);
      expect(
        JSON.parse(readFileSync(filePath, "utf8")).agents.entries.main.tools.exec.security,
      ).toBe("allowlist");
    });

    it("writes literal dollar replacement text through the registered Markdown command", async () => {
      const { workspaceDir, filePath } = fileFixture("AGENTS.md");
      writeFileSync(filePath, "## Tools\n\n- command: old\n- keep: stable\n", "utf-8");
      const value = "literal $$ $& $1 $` $' $HOME";
      const rt = createTestRuntime();

      await pathSetCommand(
        "oc://AGENTS.md/tools/command/command",
        value,
        { cwd: workspaceDir, json: true },
        rt,
      );

      expect(rt.exitCode).toBe(0);
      expect(readFileSync(filePath, "utf-8")).toBe(
        `## Tools\n\n- command: ${value}\n- keep: stable\n`,
      );
    });

    it.each([
      [
        "AGENTS.md",
        "---\nname: x\n---\n",
        "[frontmatter]/+note",
        "before__OPENCLAW_REDACTED__after",
      ],
      ["gateway.jsonc", '{ "token": "x" }', "token", "__OPENCLAW_REDACTED__"],
      ["data.jsonc", '{"items":[]}', "items/+", '{"__OPENCLAW_REDACTED__":1}'],
      ["data.jsonc", '{"items":{}}', "items/+__OPENCLAW_REDACTED__", "1"],
      ["data.jsonc", '{"items":{}}', "items/+pre__OPENCLAW_REDACTED__post", "1"],
      ["data.jsonl", '{"old":1}\n', "+", '{"__OPENCLAW_REDACTED__":1}'],
      ["data.yaml", "items: []\n", "items/+", '{"__OPENCLAW_REDACTED__":1}'],
    ])("CLI-S03 refuses sentinel content for %s at %s", async (file, before, suffix, value) => {
      const { workspaceDir, filePath } = fileFixture(file);
      writeFileSync(filePath, before, "utf-8");
      const rt = createTestRuntime();
      await pathSetCommand(
        `oc://${file}/${suffix}`,
        value,
        { cwd: workspaceDir, json: true, dryRun: file === "AGENTS.md" },
        rt,
      );
      expect(rt.exitCode).toBe(1);
      expect(stdoutText(rt)).toContain("OC_EMIT_SENTINEL");
      expect(stdoutText(rt)).toContain(
        file === "data.jsonl" ? "oc:///L2" : file === "AGENTS.md" ? `oc://${file}/${suffix}` : file,
      );
      expect(readFileSync(filePath, "utf-8")).toBe(before);
    });

    it("CLI-S05 malformed yaml returns structured parse-error", async () => {
      const { workspaceDir, filePath } = fileFixture("workflow.yaml");
      const before = "key: value\n  bad indent: oops\n";
      writeFileSync(filePath, before, "utf-8");
      const rt = createTestRuntime();
      await pathSetCommand(
        "oc://workflow.yaml/key",
        "new-value",
        { cwd: workspaceDir, json: true },
        rt,
      );
      expect(rt.exitCode).toBe(1);
      const out = JSON.parse(stdoutText(rt));
      expect(out).toMatchObject({ ok: false, reason: "parse-error" });
      expect(readFileSync(filePath, "utf-8")).toBe(before);
    });

    // Root and DAC-override containers ignore the 0o444 mode, so the write would
    // succeed; match the permission-fixture guard used by root-memory-files.test.ts.
    const canDenyWrites = process.platform !== "win32" && process.getuid?.() !== 0;
    it.runIf(canDenyWrites).each<[string, { json?: boolean; human?: boolean }]>([
      ["json", { json: true }],
      ["human", { human: true }],
    ])("CLI-S11 reports a failed write inside the %s error envelope", async (_mode, mode) => {
      const { workspaceDir, filePath } = fileFixture("note.md");
      const before = "---\nname: old\n---\n";
      writeFileSync(filePath, before, "utf-8");
      chmodSync(filePath, 0o444);
      const rt = createTestRuntime();
      await pathSetCommand(
        "oc://note.md/[frontmatter]/name",
        "new",
        { cwd: workspaceDir, ...mode },
        rt,
      );
      const output = `${stdoutText(rt)}${stderrText(rt)}`;
      expect(rt.exitCode).toBe(2);
      expect(output).toContain("OC_PATH_WRITE_FAILED");
      expect(output).toContain("The file was left unchanged");
      expect(output).not.toContain("restore it from a backup");
      expect(readFileSync(filePath, "utf-8")).toBe(before);
      if (mode.json === true) {
        expect(JSON.parse(stdoutText(rt))).toMatchObject({
          ok: false,
          error: { type: "cli_error", code: "OC_PATH_WRITE_FAILED" },
        });
      }
    });
  });

  describe("find", () => {
    const findFiles = ["config.jsonc", "config.yaml", "config.jsonl"];
    if (process.platform !== "win32") {
      findFiles.push("report?.jsonc");
    }
    it.each(findFiles)("CLI-F01 finds and round-trips indexes in %s", async (filename) => {
      const options = { cwd: tempDirs.make("oc-path-cli-"), json: true };
      const before = '{ "items": [ { "id": "a" }, { "id": "b" } ] }\n';
      writeFileSync(join(options.cwd, filename), before, "utf-8");
      const file = filename.includes("?") ? JSON.stringify(filename) : filename;
      const prefix = `oc://${file}/${filename.endsWith(".jsonl") ? "L1/" : ""}`;
      for (const [suffix, expected] of [
        ["items.*/id", ["a", "b"]],
        ['items."1"/*', ["b"]],
        ['items.""/*', []],
        ['items."$first"/*', []],
        ['items."2"/*', []],
        ["nope/*", []],
      ] as const) {
        const rt = createTestRuntime();
        await pathFindCommand(prefix + suffix + "?session=proof", options, rt);
        const out = JSON.parse(stdoutText(rt));
        expect([rt.exitCode, out.count]).toEqual([expected.length ? 0 : 1, expected.length]);
        expect(out.matches).toMatchObject(expected.map((valueText) => ({ match: { valueText } })));
        for (const { path, match } of out.matches) {
          expect(path).toMatch(/\?session=proof$/);
          const resolved = createTestRuntime();
          await pathResolveCommand(path, options, resolved);
          expect(resolved.exitCode).toBe(0);
          expect(JSON.parse(stdoutText(resolved))).toMatchObject({ resolved: true, match });
        }
      }
      expect(readFileSync(join(options.cwd, filename), "utf-8")).toBe(before);
    });

    it("CLI-F03 file-slot wildcard rejected with clear error (no ENOENT)", async () => {
      const workspaceDir = tempDirs.make("oc-path-cli-");
      // File-slot wildcards must fail clearly before filesystem access.
      const rt = createTestRuntime();
      await pathFindCommand("oc://*.jsonc/items", { cwd: workspaceDir, json: true }, rt);
      expect(rt.exitCode).toBe(2);
      expect(stdoutText(rt)).toContain("OC_PATH_FILE_WILDCARD_UNSUPPORTED");
      expect(stdoutText(rt)).toContain("file-slot wildcards are not supported");
    });
  });

  describe("emit", () => {
    it.each([
      ["comments", '// keep this comment\n{\n  "v": 1\n}\n'],
      ["empty file", ""],
    ])("CLI-E01 round-trips jsonc bytes verbatim: %s", async (_label, before) => {
      const { filePath } = fileFixture("gateway.jsonc");
      writeFileSync(filePath, before, "utf-8");
      const rt = createTestRuntime();
      await pathEmitCommand(filePath, { json: true }, rt);
      expect(rt.exitCode).toBe(0);
      const out = JSON.parse(stdoutText(rt));
      expect(out.kind).toBe("jsonc");
      expect(out.bytes).toBe(before);
    });

    it.each([["sections", "## Tools\n- gh\n## Boundaries\n- never rm -rf\n"]])(
      "CLI-E02 round-trips md verbatim: %s",
      async (_label, before) => {
        const { filePath } = fileFixture("AGENTS.md");
        writeFileSync(filePath, before, "utf-8");
        const rt = createTestRuntime();
        await pathEmitCommand(filePath, { json: true }, rt);
        expect(rt.exitCode).toBe(0);
        const out = JSON.parse(stdoutText(rt));
        expect(out.kind).toBe("md");
        expect(out.bytes).toBe(before);
      },
    );
  });
});
