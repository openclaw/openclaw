import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareSystemRunMutableFileApproval } from "../infra/system-run-approval-binding.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { validateScriptFileForShellBleed } from "./bash-tools.exec-script-preflight.js";
import type { ExecToolApprovalReview, ExecToolDetails } from "./bash-tools.exec-types.js";
import type { AgentToolResult } from "./runtime/index.js";

const processGatewayAllowlistMock = vi.hoisted(() =>
  vi.fn(
    async (_params?: {
      onApprovalReview?: (review: ExecToolApprovalReview) => void;
    }): Promise<{
      allowWithoutEnforcedCommand: boolean;
      revalidateBeforeExecution?: () => Promise<AgentToolResult<ExecToolDetails> | undefined>;
    }> => ({ allowWithoutEnforcedCommand: true }),
  ),
);
vi.mock("./bash-tools.exec-host-gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bash-tools.exec-host-gateway.js")>()),
  processGatewayAllowlist: processGatewayAllowlistMock,
}));
vi.mock("./bash-tools.exec-host-node.js", () => ({
  executeNodeHostCommand: async () => {
    throw new Error("node host execution is not used by script preflight tests");
  },
}));
vi.mock("../utils/delivery-context.shared.js", () => ({
  normalizeDeliveryContext: (value: unknown) => value,
}));

const isWin = process.platform === "win32";
const describeNonWin = isWin ? describe.skip : describe;
const describeWin = isWin ? describe : describe.skip;
// Commands settle before their fixture cwd is removed.
const createPreflightTool = (ask: "on-miss" | "off" = "on-miss") =>
  createExecTool({ host: "gateway", security: "full", ask, allowBackground: false });
const runExecPreflight = (command: string, workdir = process.cwd()) =>
  createPreflightTool().execute("call-script-preflight", { command, workdir });
const injection = /exec preflight: detected likely shell variable injection \(\$DM_JSON\)/;
const changedScript = "approval script operand changed before execution";
const withScripts = <T>(files: Record<string, string>, run: (workdir: string) => Promise<T>) =>
  withTempDir("openclaw-exec-preflight-", async (workdir) => {
    for (const [name, source] of Object.entries(files)) {
      const file = path.join(workdir, name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, source, "utf-8");
    }
    return await run(workdir);
  });
const execScripts = (command: string, files: Record<string, string>) =>
  withScripts(files, (workdir) => runExecPreflight(command, workdir));

afterEach(() => __setFsSafeTestHooksForTest());
beforeEach(() => {
  processGatewayAllowlistMock.mockReset();
  processGatewayAllowlistMock.mockResolvedValue({ allowWithoutEnforcedCommand: true });
});

it("blocks interactive channel login commands from exec", async () => {
  for (const command of [
    "openclaw channels login --channel whatsapp --verbose",
    "pnpm exec openclaw channels login --channel whatsapp",
    "sudo -u openclaw bash -lc 'openclaw channels login --channel whatsapp'",
    "sudo -EH bash -lc 'openclaw channels login --channel whatsapp'",
    "env env env env env env openclaw channels login --channel whatsapp",
    "env -S 'openclaw channels' login --channel whatsapp",
  ]) {
    await expect(runExecPreflight(command)).rejects.toThrow(
      /exec cannot run interactive OpenClaw channel login commands/,
    );
  }
});

describeNonWin("exec script preflight", () => {
  it.each([true, false])("revalidates approved bytes before spawn (changed=%s)", async (mutate) => {
    await withScripts({ "script.sh": "#!/bin/sh\necho approved\n" }, async (workdir) => {
      const prepared = await prepareSystemRunMutableFileApproval({
        command: "sh script.sh",
        cwd: workdir,
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) {
        throw new Error(prepared.message);
      }
      const approvalReview: ExecToolApprovalReview = {
        id: "guardian:call-script-preflight",
        label: "Guardian",
        status: "approved",
      };
      processGatewayAllowlistMock.mockImplementationOnce(async (params) => {
        params?.onApprovalReview?.(approvalReview);
        return {
          allowWithoutEnforcedCommand: true,
          revalidateBeforeExecution: async () => {
            const current = await prepared.revalidate();
            return current.ok
              ? undefined
              : {
                  content: [{ type: "text", text: current.message }],
                  details: {
                    status: "failed",
                    exitCode: null,
                    durationMs: 0,
                    aggregated: current.message,
                    timedOut: false,
                    cwd: workdir,
                  },
                };
          },
        };
      });
      if (mutate) {
        await fs.writeFile(path.join(workdir, "script.sh"), "#!/bin/sh\necho mutated\n");
      }
      const result = await runExecPreflight("sh script.sh", workdir);
      expect(result.details).toMatchObject({
        status: mutate ? "failed" : "completed",
        approvalReviewOutcome: "approved",
        approvalReviews: [approvalReview],
        aggregated: mutate ? expect.stringContaining(changedScript) : "approved",
      });
      if (mutate) {
        expect(result.content[0]).toMatchObject({ text: expect.stringContaining(changedScript) });
      }
    });
  });

  it.each([
    ["$A", "payload = $A"],
    ["$P", 'result = f"{ "$A" + $P }"'],
    ["$A", 'result = f"\\{$A}"'],
    ["$F", 'result = f"{lambda value: $F}"'],
    ["$E", 'text = "ok\rpayload = $E'],
    ["$D", 'text = "ok"\r# note\rpayload = $D'],
  ])("blocks Python shell variable %s in %s", async (token, source) => {
    await expect(execScripts("python bad.py", { "bad.py": source })).rejects.toThrow(
      `exec preflight: detected likely shell variable injection (${token})`,
    );
  });

  it("allows dollar text in Python strings, comments, and f-string format text", async () => {
    const result = await execScripts("python3 valid.py", {
      "valid.py": [
        'value = "$A"',
        "other = '''$_'''",
        'raw = r"$Q"',
        'hash_text = "# $R"',
        "nested = f\"{ '$S' }\"",
        'braces = f"{{ $T }}"',
        'continued = "text \\\r\n$U"',
        "class Echo:",
        "    def __format__(self, spec):",
        "        return spec",
        'format_text = f"{Echo():$W}"',
        "élambda = Echo()",
        'unicode_format = f"{élambda:$Y}"',
        "# $P",
        'print(f"{value}:{other}:{raw}:{hash_text}:{nested}:{braces}:{continued}:{format_text}:{unicode_format}")',
      ].join("\n"),
    });
    expect(result.details).toMatchObject({
      status: "completed",
      aggregated: "$A:$_:$Q:# $R:$S:{ $T }:text $U:$W:$Y",
    });
  });

  it("lets Node execute valid dollar identifiers and labels in preloads and entrypoints", async () => {
    const result = await execScripts("env node --require ./bootstrap.js app.js config.js", {
      "bootstrap.js": 'const $VALUE = "preload:"; process.stdout.write($VALUE);',
      "app.js":
        '// $COMMENT\nconst $A = "a", $_ = "b"; NODE: { process.stdout.write($A + $_ + "$HOME" + `$TMPDIR`); }',
      "config.js": 'throw new Error("argument is not a script");',
    });
    expect(result.details).toMatchObject({
      status: "completed",
      exitCode: 0,
      aggregated: "preload:ab$HOME$TMPDIR",
    });
  });

  it("returns native Node diagnostics after preserving preceding output", async () => {
    const result = await execScripts("node bad.js", {
      "bad.js": 'process.stdout.write("before-error\\n"); const value = $DM_JSON;',
    });
    expect(result.details).toMatchObject({ status: "completed", exitCode: 1 });
    const text = result.content.find((c) => c.type === "text")?.text ?? "";
    expect(text).toContain("ReferenceError");
    expect(text).not.toContain("exec preflight:");
    expect(text).toMatch(/^before-error\r?\n/);
  });

  it("returns native preload errors before inline code runs", async () => {
    const result = await execScripts("node --import ./bad.js -e \"console.log('entry-ran')\"", {
      "bad.js": "const value = $DM_JSON;",
    });
    expect(result.details).toMatchObject({ status: "completed", exitCode: 1 });
    const text = result.content.find((c) => c.type === "text")?.text ?? "";
    expect(text).toContain("ReferenceError");
    expect(text).not.toContain("exec preflight:");
    expect(text).not.toContain("entry-ran");
  });

  it("validates the first quoted Python operand behind env despite trailing script arguments", async () => {
    await expect(
      execScripts('/usr/bin/env python "..bad.py" --output out.py', {
        "..bad.py": "payload = $DM_JSON",
        "out.py": "print('ok')",
      }),
    ).rejects.toThrow(injection);
  });

  it("validates symlinked script entrypoints within workdir", async () => {
    await withScripts({ "bad.py": "payload = $DM_JSON" }, async (workdir) => {
      await fs.symlink(path.join(workdir, "bad.py"), path.join(workdir, "link.py"));
      await expect(runExecPreflight("python3 link.py", workdir)).rejects.toThrow(injection);
    });
  });

  it("validates scripts under literal tilde directories", async () => {
    await expect(
      execScripts('python3 "~/bad.py"', { "~/bad.py": "payload = $DM_JSON" }),
    ).rejects.toThrow(injection);
  });

  it("skips script-file preflight in yolo host mode", async () => {
    await withScripts({ "bad.py": "payload = $DM_JSON" }, async (workdir) => {
      const result = await createPreflightTool("off").execute("call-yolo", {
        command: "python3 bad.py",
        workdir,
      });
      const text = result.content.find((c) => c.type === "text")?.text ?? "";
      expect(text).not.toMatch(/exec preflight:/);
      expect(text).toContain("SyntaxError");
      expect(result.details).toMatchObject({ status: "completed", exitCode: 1 });
    });
  });

  it("skips preflight reads outside workdir", async () => {
    await withScripts(
      { "outside.py": "payload = $DM_JSON", "workdir/inside.py": "" },
      async (parent) => {
        await expect(
          runExecPreflight("python3 ../outside.py", path.join(parent, "workdir")),
        ).resolves.toBeDefined();
      },
    );
  });

  it.each(["afterPreOpenLstat", "beforeOpen"] as const)(
    "does not trust symlink swaps at %s",
    async (hookName) => {
      await withScripts(
        { "workdir/script.py": 'print("inside")', "outside.py": "payload = $DM_JSON" },
        async (parent) => {
          const workdir = path.join(parent, "workdir");
          const scriptPath = path.join(workdir, "script.py");
          const scriptRealPath = await fs.realpath(scriptPath);
          let swapped = false;
          __setFsSafeTestHooksForTest({
            [hookName]: async (target: string) => {
              if (swapped || path.resolve(target) !== scriptRealPath) {
                return;
              }
              await fs.rm(scriptPath, { force: true });
              await fs.symlink(path.join(parent, "outside.py"), scriptPath);
              swapped = true;
            },
          });
          await expect(runExecPreflight("python3 script.py", workdir)).resolves.toBeDefined();
          expect(swapped).toBe(true);
        },
      );
    },
  );

  it("opens script reads with O_NONBLOCK to avoid FIFO stalls", async () => {
    await withScripts({ "script.py": 'print("ok")' }, async (workdir) => {
      const scriptRealPath = await fs.realpath(path.join(workdir, "script.py"));
      const scriptOpenFlags: number[] = [];
      __setFsSafeTestHooksForTest({
        beforeOpen: (target, flags) => {
          if (path.resolve(target) === scriptRealPath) {
            scriptOpenFlags.push(flags);
          }
        },
      });
      await expect(runExecPreflight("python3 script.py", workdir)).resolves.toBeDefined();
      expect(scriptOpenFlags).not.toStrictEqual([]);
      expect(scriptOpenFlags.every((flags) => (flags & fsConstants.O_NONBLOCK) !== 0)).toBe(true);
    });
  });

  it.each([
    "cat bad.py | python",
    "cat bad.js | node",
    'bash -c "node bad.js"',
    "node <(cat bad.js)",
    'if true; then\npython "bad.py"\nfi',
    `env /bin/bash --rcfile shell.rc --noprofile --norc -O extglob -ceu "python 'bad.py'"`,
    'bash -c "if true; then python bad.py; fi"',
  ])("fails closed for %s", async (command) => {
    await expect(runExecPreflight(command)).rejects.toThrow(
      /exec preflight: complex interpreter invocation detected/,
    );
  });

  it.each([
    'bash -c "echo python"',
    "echo 'python bad.py | python'",
    "echo bad.py; python --version",
    "node --version && ls *.py",
    "node -e \"console.log('bad.py')\" | cat",
    "echo python bad.py \\| node",
  ])("does not reject non-script interpreter hints in %s", async (command) => {
    await expect(runExecPreflight(command)).resolves.toBeDefined();
  });
});

describeWin("exec script preflight on Windows paths", () => {
  it.each(["relative", "absolute"])("validates Python %s paths", async (kind) => {
    await withScripts({ "subdir/bad.py": "payload = $DM_JSON" }, async (workdir) => {
      const script =
        kind === "relative"
          ? "subdir\\bad.py"
          : path.join(workdir, "subdir", "bad.py").replaceAll("/", "\\");
      await expect(runExecPreflight(`python "${script}"`, workdir)).rejects.toThrow(injection);
    });
  });
  it("runs valid JavaScript through a Windows relative path", async () => {
    const result = await execScripts("node .\\valid.js", {
      "valid.js": 'const $FOO = "ok"; process.stdout.write($FOO);',
    });
    expect(result.details).toMatchObject({
      status: "completed",
      exitCode: 0,
      aggregated: "ok",
    });
  });
});

it("does not hang on assignment prefixes followed by whitespace-heavy text", async () => {
  const htmlBlock = '<section style="padding: 30px 20px; font-family: Arial;">'.repeat(50);
  const command = `ACCESS_TOKEN=$(__openclaw_missing_redos_guard__)\nprintf '%s' '${htmlBlock}' >/dev/null`;
  const start = Date.now();
  await validateScriptFileForShellBleed({ command, workdir: process.cwd() });
  expect(Date.now() - start).toBeLessThan(5000);
});
