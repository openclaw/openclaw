/**
 * Smoke tests for the `openclaw path` CLI handlers.
 *
 * Tests invoke each subcommand through the retained Commander registration.
 * Assertions inspect captured process output and the resulting exit code.
 */
import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  openSync,
  promises as fs,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { Command, CommanderError } from "commander";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { registerOcPathCli } from "../cli-registration.js";
import { registerPathCli } from "./cli.js";

const JSONC_INPUT_LIMIT_BYTES = 16 * 1024 * 1024;
type RegisterCli = Parameters<typeof registerOcPathCli>[0]["registerCli"];
type CliRegistrar = Parameters<RegisterCli>[0];
type CliRegistrationOptions = Parameters<RegisterCli>[1];

function resolvePathMachineOutput() {
  let resolver:
    | ((params: { argv: readonly string[]; stdoutIsTTY: boolean }) => boolean)
    | undefined;
  registerOcPathCli({
    registerCli(_registrar: CliRegistrar, options?: CliRegistrationOptions) {
      const descriptor = options?.descriptors?.[0];
      resolver = descriptor && "machineOutput" in descriptor ? descriptor.machineOutput : undefined;
    },
  } as unknown as Parameters<typeof registerOcPathCli>[0]);
  if (!resolver) {
    throw new Error("oc-path CLI descriptor is missing its machine-output resolver");
  }
  return resolver;
}

const isPathMachineOutput = resolvePathMachineOutput();

type PathCommandOptions = {
  readonly json?: boolean;
  readonly human?: boolean;
  readonly valueJson?: boolean;
  readonly cwd?: string;
  readonly file?: string;
  readonly dryRun?: boolean;
  readonly diff?: boolean;
};

interface TestRuntime {
  readonly stdout: string[];
  readonly stderr: string[];
  exitCode: number;
  error(value: string): void;
  writeStdout(value: string): void;
  exit(code: number): void;
}

function createTestRuntime(): TestRuntime {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const runtime: TestRuntime = {
    stdout,
    stderr,
    exitCode: 0,
    error: (value) => {
      stderr.push(value);
    },
    writeStdout: (value) => {
      stdout.push(value);
    },
    exit: (code) => {
      runtime.exitCode = code;
    },
  };
  return runtime;
}

const stdoutText = (rt: TestRuntime): string => rt.stdout.join("");
const stderrText = (rt: TestRuntime): string => rt.stderr.join("");

function optionArgs(options: PathCommandOptions): string[] {
  const args: string[] = [];
  if (options.json === true) {
    args.push("--json");
  }
  if (options.human === true) {
    args.push("--human");
  }
  if (options.valueJson === true) {
    args.push("--value-json");
  }
  if (options.cwd !== undefined) {
    args.push("--cwd", options.cwd);
  }
  if (options.file !== undefined) {
    args.push("--file", options.file);
  }
  if (options.dryRun === true) {
    args.push("--dry-run");
  }
  if (options.diff === true) {
    args.push("--diff");
  }
  return args;
}

async function invokePathCli(args: string[], runtime: TestRuntime): Promise<void> {
  const previousExitCode = process.exitCode;
  process.exitCode = 0;
  const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    runtime.writeStdout(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    runtime.error(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  try {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeOut: (value) => runtime.writeStdout(value),
      writeErr: (value) => runtime.error(value),
    });
    registerPathCli(program);
    await program.parseAsync(["node", "openclaw", "path", ...args]);
    runtime.exitCode = process.exitCode ?? 0;
  } catch (error) {
    if (!(error instanceof CommanderError)) {
      throw error;
    }
    runtime.exitCode = error.exitCode;
  } finally {
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
    // oxlint-disable-next-line no-warning-comments -- replace the pending link after Bun ships the fix.
    // TODO(bun#42607): Assign undefined once Bun clears a nonzero process.exitCode.
    process.exitCode = previousExitCode ?? 0;
  }
}

async function pathResolveCommand(
  path: string | undefined,
  options: PathCommandOptions,
  runtime: TestRuntime,
): Promise<void> {
  await invokePathCli(
    ["resolve", ...(path === undefined ? [] : [path]), ...optionArgs(options)],
    runtime,
  );
}

async function pathSetCommand(
  path: string | undefined,
  value: string | undefined,
  options: PathCommandOptions,
  runtime: TestRuntime,
): Promise<void> {
  await invokePathCli(
    [
      "set",
      ...(path === undefined ? [] : [path]),
      ...(value === undefined ? [] : [value]),
      ...optionArgs(options),
    ],
    runtime,
  );
}

async function pathFindCommand(
  path: string | undefined,
  options: PathCommandOptions,
  runtime: TestRuntime,
): Promise<void> {
  await invokePathCli(
    ["find", ...(path === undefined ? [] : [path]), ...optionArgs(options)],
    runtime,
  );
}

async function pathValidateCommand(
  path: string | undefined,
  options: PathCommandOptions,
  runtime: TestRuntime,
): Promise<void> {
  await invokePathCli(
    ["validate", ...(path === undefined ? [] : [path]), ...optionArgs(options)],
    runtime,
  );
}

async function pathEmitCommand(
  file: string | undefined,
  options: PathCommandOptions,
  runtime: TestRuntime,
): Promise<void> {
  await invokePathCli(
    ["emit", ...(file === undefined ? [] : [file]), ...optionArgs(options)],
    runtime,
  );
}

describe("openclaw path CLI", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
      expect(rt.exitCode).toBe(1);
      const out = JSON.parse(stdoutText(rt));
      expect(out.valid).toBe(false);
    });
  });

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

  describe("resolve", () => {
    it("CLI-R04 finds a leaf in yaml and prints it", async () => {
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filePath = join(workspaceDir, "workflow.yaml");
      writeFileSync(filePath, "name: inbox-triage\nsteps:\n  - id: fetch\n", "utf-8");
      const rt = createTestRuntime();
      await pathResolveCommand(
        "oc://workflow.yaml/steps/0/id",
        { cwd: workspaceDir, json: true },
        rt,
      );
      expect(rt.exitCode).toBe(0);
      const out = JSON.parse(stdoutText(rt));
      expect(out.resolved).toBe(true);
      expect(out.match.kind).toBe("leaf");
      expect(out.match.valueText).toBe("fetch");
    });

    it("CLI-R02 returns 1 for not-found path", async () => {
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filePath = join(workspaceDir, "gateway.jsonc");
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
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filePath = join(workspaceDir, "gateway.jsonc");
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
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filePath = join(workspaceDir, "oversized.json");
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
          expect(stdoutText(rt)).toBe("");
          expect(JSON.parse(stderrText(rt))).toMatchObject({
            error: { code: testCase.code },
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
        expect(JSON.parse(stderrText(rt))).toMatchObject({
          error: { code: "OC_PATH_FILE_NOT_REGULAR" },
        });
      },
    );
  });

  describe("set", () => {
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
        const workspaceDir = tempDirs.make("oc-path-cli-");
        const filePath = join(workspaceDir, "notes.md");
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
        '\uFEFF---\n# Keep the authored metadata.\nname: &shared "example"\ncopy: *shared\nempty: &empty\nempty_copy: *empty\n\ndescription: |\n  First line.\n  Second line.\nmetadata:\n  openclaw:\n    requires:\n      bins: [gh]\n---\n';
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
          before.replace("empty: &empty\n", "empty: &empty filled\n"),
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
          const workspaceDir = tempDirs.make("oc-path-cli-");
          const filePath = join(workspaceDir, "SKILL.md");
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
        const workspaceDir = tempDirs.make("oc-path-cli-");
        const filePath = join(workspaceDir, "events.jsonl");
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
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filePath = join(workspaceDir, "gateway.jsonc");
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
      expect(stderrText(rt)).toContain("OC_PATH_INPUT_NOT_UTF8");
      expect(stderrText(rt)).toContain("the file was left unchanged");
      expect(readFileSync(filePath)).toEqual(before);
    });

    it("CLI-S10 still writes valid non-ASCII values including a literal replacement character", async () => {
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filePath = join(workspaceDir, "gateway.jsonc");
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
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filePath = join(workspaceDir, "gateway.jsonc");
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
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filePath = join(workspaceDir, "gateway.jsonc");
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
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filePath = join(workspaceDir, "AGENTS.md");
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
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filePath = join(workspaceDir, "gateway.jsonc");
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
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filePath = join(workspaceDir, "openclaw.json");
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
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filePath = join(workspaceDir, "AGENTS.md");
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

    it.each([true])(
      "refuses sentinel-bearing Markdown insertion in the CLI (dry-run=%s)",
      async (dryRun) => {
        const workspaceDir = tempDirs.make("oc-path-cli-");
        const filePath = join(workspaceDir, "AGENTS.md");
        const before = "---\nname: x\n---\n";
        writeFileSync(filePath, before, "utf-8");
        const rt = createTestRuntime();

        await pathSetCommand(
          "oc://AGENTS.md/[frontmatter]/+note",
          "before__OPENCLAW_REDACTED__after",
          { cwd: workspaceDir, json: true, dryRun },
          rt,
        );

        expect(rt.exitCode).toBe(1);
        expect(stderrText(rt)).toContain("OC_EMIT_SENTINEL");
        expect(stderrText(rt)).toContain("oc://AGENTS.md/[frontmatter]/+note");
        expect(readFileSync(filePath, "utf-8")).toBe(before);
      },
    );

    it("CLI-S03 sentinel-bearing value is refused at emit", async () => {
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filePath = join(workspaceDir, "gateway.jsonc");
      writeFileSync(filePath, '{ "token": "x" }', "utf-8");
      const rt = createTestRuntime();
      // Sentinel values can enter the AST, but emit must reject them through
      // the structured CLI error boundary instead of escaping Commander.
      await pathSetCommand(
        "oc://gateway.jsonc/token",
        "__OPENCLAW_REDACTED__",
        { cwd: workspaceDir, json: true },
        rt,
      );
      expect(rt.exitCode).toBe(1);
      expect(stderrText(rt)).toContain("OC_EMIT_SENTINEL");
      // Include the actual file in the sentinel error so operators can locate it.
      expect(stderrText(rt)).toContain("gateway.jsonc");
    });

    it("CLI-S05 malformed yaml returns structured parse-error", async () => {
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filePath = join(workspaceDir, "workflow.yaml");
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
  });

  describe("find", () => {
    it("CLI-F01 enumerates wildcard matches", async () => {
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filePath = join(workspaceDir, "config.jsonc");
      writeFileSync(filePath, '{ "items": [ { "id": "a" }, { "id": "b" } ] }', "utf-8");
      const rt = createTestRuntime();
      await pathFindCommand("oc://config.jsonc/items/*/id", { cwd: workspaceDir, json: true }, rt);
      expect(rt.exitCode).toBe(0);
      const out = JSON.parse(stdoutText(rt));
      expect(out.count).toBe(2);
    });

    it("CLI-F02 returns 1 when zero matches", async () => {
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filePath = join(workspaceDir, "gateway.jsonc");
      writeFileSync(filePath, "{}", "utf-8");
      const rt = createTestRuntime();
      await pathFindCommand("oc://gateway.jsonc/nope/*", { cwd: workspaceDir, json: true }, rt);
      expect(rt.exitCode).toBe(1);
    });

    it("CLI-F03 file-slot wildcard rejected with clear error (no ENOENT)", async () => {
      const workspaceDir = tempDirs.make("oc-path-cli-");
      // File-slot wildcards must fail clearly before filesystem access.
      const rt = createTestRuntime();
      await pathFindCommand("oc://*.jsonc/items", { cwd: workspaceDir, json: true }, rt);
      expect(rt.exitCode).toBe(2);
      expect(stderrText(rt)).toContain("OC_PATH_FILE_WILDCARD_UNSUPPORTED");
      expect(stderrText(rt)).toContain("file-slot wildcards are not supported");
    });
  });

  describe("emit", () => {
    it.each([
      ["comments", '// keep this comment\n{\n  "v": 1\n}\n'],
      ["empty file", ""],
    ])("CLI-E01 round-trips jsonc bytes verbatim: %s", async (_label, before) => {
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filePath = join(workspaceDir, "gateway.jsonc");
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
        const workspaceDir = tempDirs.make("oc-path-cli-");
        const filePath = join(workspaceDir, "AGENTS.md");
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
