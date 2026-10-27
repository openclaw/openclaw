import "../test-utils/prepare-compiled-subprocesses.js";
import fs, { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { waitForExecScope } from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import type { ExecToolDefaults, ExecToolDetails } from "./bash-tools.exec-types.js";
import { createProcessTool } from "./bash-tools.process.js";
import type { AgentToolResult } from "./runtime/index.js";
import { capToolResultForPersistence } from "./session-tool-result-guard.payload.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let workdir: string;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, mkdtemp: vi.fn(actual.mkdtemp) };
});

beforeEach(() => {
  workdir = tempDirs.make("openclaw-exec-output-log-");
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(workdir, "state"));
  resetProcessRegistryForTests();
});

afterEach(() => {
  resetProcessRegistryForTests();
  vi.unstubAllEnvs();
});

function execTool(defaults: ExecToolDefaults = {}) {
  return createExecTool({
    host: "gateway",
    mode: "full",
    bypassHostApprovalFloors: true,
    preparedStoreEnvironment: {},
    preparedSubagentExecution: false,
    notifyOnExit: false,
    cwd: workdir,
    scopeKey: workdir,
    ...defaults,
  });
}

async function command(source: string): Promise<string> {
  const scriptPath = path.join(workdir, "command.cjs");
  await fs.writeFile(scriptPath, source);
  const quote = (value: string) =>
    `'${value.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;
  const invocation = `${quote(process.execPath)} ${quote(scriptPath)}`;
  return process.platform === "win32" ? `& ${invocation}` : invocation;
}

function outputPath(details: ExecToolDetails): string {
  const filePath = expectDefined(details.fullOutputPath, "saved exec output path");
  expect(path.dirname(path.dirname(filePath))).toBe(workdir);
  return filePath;
}

async function artifacts(): Promise<string[]> {
  return (await fs.readdir(workdir)).filter((name) => name.startsWith(".openclaw-exec-"));
}

function persistedText(toolName: string, result: AgentToolResult<unknown>): string {
  const message = capToolResultForPersistence(
    {
      role: "toolResult",
      toolCallId: "saved-output",
      toolName,
      content: result.content,
      details: result.details,
      isError: false,
      timestamp: 0,
    },
    8_000,
  );
  return message.role === "toolResult"
    ? message.content.flatMap((block) => (block.type === "text" ? block.text : [])).join("\n")
    : "";
}

describe("exec saved output artifacts", () => {
  it("rejects caller Git configuration before starting a saved-output command", async () => {
    const launchMarker = path.join(workdir, "launched");
    const invocation = await command(
      `require("node:fs").writeFileSync(${JSON.stringify(launchMarker)}, "started");`,
    );
    for (const name of ["GIT_CONFIG_PARAMETERS", " git_config_parameters "]) {
      await expect(
        execTool().execute("rejected-git-override", {
          command: invocation,
          env: { [name]: "'core.hooksPath=untrusted'" },
          saveOutput: true,
        }),
      ).rejects.toThrow(
        /Security Violation: Environment variable 'GIT_CONFIG_PARAMETERS' is forbidden/,
      );
    }
    expect(await fs.readdir(workdir)).not.toContain("launched");
    expect(await artifacts()).toEqual([]);
  });

  it("keeps the saved-output reference visible through the session persistence cap", async () => {
    const result = await execTool().execute("saved-long-output", {
      command: await command('process.stdout.write("x".repeat(80000));'),
      saveOutput: true,
    });
    const filePath = outputPath(result.details);
    const visible = persistedText("exec", result);
    expect(visible.length).toBeLessThan(80_000);
    expect(visible).toContain(filePath);
    expect(await fs.readFile(filePath, "utf8")).toBe("x".repeat(80_000));
  });
  it("preserves failed-command output beyond memory retention as an explicit incognito artifact", async () => {
    const result = await execTool({
      sessionKey: "agent:main:dashboard:incognito-output-artifact",
    }).execute("saved-failure", {
      command: await command(
        'process.stdout.write("\u001b[31mOUTPUT_START\u001b[0m\\n" + "x".repeat(250000) + "\\nOUTPUT_END\\n");' +
          'process.stderr.write("ERROR_MARKER\\n"); process.exitCode = 1;',
      ),
      saveOutput: true,
    });

    expect(result.details).toMatchObject({
      status: "completed",
      exitCode: 1,
      spillTruncated: false,
    });
    const filePath = outputPath(result.details);
    const saved = await fs.readFile(filePath, "utf8");
    expect(saved).toContain("ERROR_MARKER\n");
    expect(saved.replace("ERROR_MARKER\n", "")).toBe(
      "OUTPUT_START\n" + "x".repeat(250000) + "\nOUTPUT_END\n",
    );
    expect(saved).not.toContain("\u001b");
    expect(result.details).toHaveProperty("spilledChars", saved.length);
    if (result.details.status === "completed") {
      expect(result.details.aggregated.length).toBeLessThan(saved.length);
    }
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: expect.stringContaining(filePath) }),
      ]),
    );
    expect(JSON.stringify(result.content)).not.toContain("cannot be recovered");
    if (process.platform !== "win32") {
      expect((await fs.stat(filePath)).mode & 0o077).toBe(0);
      expect((await fs.stat(path.dirname(filePath))).mode & 0o077).toBe(0);
    }
  });

  it("retains a background timeout log through process collection and registry cleanup", async ({
    signal,
  }) => {
    const processTool = createProcessTool({ scopeKey: workdir });
    const started = await execTool().execute("saved-timeout", {
      command: await command(
        'process.stdout.write("BEFORE_TIMEOUT\\n"); setInterval(() => {}, 1000);',
      ),
      background: true,
      timeoutSeconds: 1,
      saveOutput: true,
    });
    expect(started.details.status).toBe("running");
    if (started.details.status !== "running") {
      throw new Error("expected background exec handle");
    }
    const filePath = outputPath(started.details);
    try {
      // A real supervisor deadline proves that output survives timeout finalization.
      await withinTest(waitForExecScope(workdir), signal);
      const polled = await processTool.execute("collect-timeout", {
        action: "poll",
        sessionId: started.details.sessionId,
      });
      expect(polled.details).toMatchObject({
        status: "failed",
        timedOut: true,
        fullOutputPath: filePath,
      });
      const logged = await processTool.execute("inspect-timeout", {
        action: "log",
        sessionId: started.details.sessionId,
      });
      expect(logged.details).toMatchObject({ fullOutputPath: filePath });
      for (const collected of [polled, logged]) {
        expect(Value.Check(processTool.outputSchema!, collected.details)).toBe(true);
        expect(collected.content).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "text", text: expect.stringContaining(filePath) }),
          ]),
        );
      }
      expect(await fs.readFile(filePath, "utf8")).toBe("BEFORE_TIMEOUT\n");
      resetProcessRegistryForTests();
      expect(await fs.readFile(filePath, "utf8")).toBe("BEFORE_TIMEOUT\n");
    } finally {
      await processTool.execute("stop-timeout-fixture", {
        action: "kill",
        sessionId: started.details.sessionId,
      });
      await withinTest(waitForExecScope(workdir), signal);
    }
  });

  it.each([
    { outputChars: 800_000, hasGap: false },
    { outputChars: 1_000_000, hasGap: true },
  ])(
    "bounds UTF-8 output and discloses uncovered loss ($outputChars chars)",
    async ({ outputChars, hasGap }) => {
      const result = await execTool().execute("saved-large-unicode", {
        command: await command(`process.stdout.write("界".repeat(${outputChars}));`),
        saveOutput: true,
      });
      expect(result.details).toMatchObject({ status: "completed", spillTruncated: true });
      const saved = await fs.readFile(outputPath(result.details));
      expect(saved.length).toBeGreaterThan(2 * 1024 * 1024 - 3);
      expect(saved.length).toBeLessThanOrEqual(2 * 1024 * 1024);
      expect(saved.toString("utf8")).toBe("界".repeat(Math.floor((2 * 1024 * 1024) / 3)));
      expect(result.details).toHaveProperty("spilledChars", saved.toString("utf8").length);
      const visible = persistedText("exec", result);
      expect(visible.startsWith("[earlier output was discarded at the retention cap")).toBe(hasGap);
      expect(visible).toContain(outputPath(result.details));
      expect(visible).toContain("Only the first 2 MiB");
    },
  );

  it("leaves command output on disk only when saving is requested", async () => {
    const result = await execTool().execute("unsaved-output", {
      command: await command('process.stdout.write("UNSAVED_MARKER");'),
    });
    expect(result.details).toMatchObject({ status: "completed", aggregated: "UNSAVED_MARKER" });
    expect(result.details).not.toHaveProperty("fullOutputPath");
    expect(await artifacts()).toEqual([]);
  });

  it.for(["foreground", "process"] as const)(
    "discloses irreversible output loss after capture fails (%s)",
    async (mode, { signal }) => {
      vi.mocked(mkdtemp).mockRejectedValueOnce(new Error("EACCES: artifact directory denied"));
      const result = await execTool().execute("capture-unavailable", {
        command: await command('process.stdout.write("x".repeat(250000) + "COMMAND_STILL_RAN");'),
        background: mode === "process",
        saveOutput: true,
      });
      const results: AgentToolResult<unknown>[] = [];
      if (mode === "process") {
        if (result.details.status !== "running") {
          throw new Error("expected background exec handle");
        }
        await withinTest(waitForExecScope(workdir), signal);
        const processTool = createProcessTool({ scopeKey: workdir });
        for (const action of ["poll", "log"] as const) {
          results.push(
            await processTool.execute("collect-capture-failure", {
              action,
              sessionId: result.details.sessionId,
            }),
          );
        }
      } else {
        expect(result.details).toMatchObject({
          status: "completed",
          exitCode: 0,
          aggregated: expect.stringContaining("COMMAND_STILL_RAN"),
        });
        results.push(result);
      }
      for (const collected of results) {
        expect(collected.details).toMatchObject({
          outputLogError: expect.stringContaining("Output capture failed"),
        });
        expect(collected.details).not.toHaveProperty("fullOutputPath");
        const visible = persistedText(mode === "process" ? "process" : "exec", collected);
        expect(visible).toMatch(
          /^\[earlier output was discarded at the retention cap and cannot be recovered\]/,
        );
        expect(visible).toContain("Output capture failed");
      }
      expect(await artifacts()).toEqual([]);
    },
  );

  it.each(["node", "sandbox"] as const)(
    "rejects unsupported %s capture without creating artifacts",
    async (host) => {
      const tool = execTool({
        host,
        ...(host === "sandbox"
          ? {
              sandbox: {
                containerName: "output-log-test",
                workspaceDir: workdir,
                containerWorkdir: "/workspace",
              },
            }
          : {}),
      });
      await expect(
        tool.execute("unsupported-output", { command: "exit 99", saveOutput: true }),
      ).rejects.toThrow(/saveOutput.*gateway/i);
      expect(await artifacts()).toEqual([]);
    },
  );
});
