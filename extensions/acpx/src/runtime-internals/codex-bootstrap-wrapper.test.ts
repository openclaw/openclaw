import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const wrapperPath = path.resolve(
  "extensions/acpx/src/runtime-internals/codex-bootstrap-wrapper.mjs",
);

async function makeTempScript(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-acpx-codex-wrapper-"));
  tempDirs.push(dir);
  const scriptPath = path.join(dir, name);
  await writeFile(scriptPath, content, "utf8");
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

describe("codex-bootstrap-wrapper", () => {
  it("appends Codex CLI config overrides before spawning the target command", async () => {
    const argvPrinterPath = await makeTempScript(
      "argv-printer.cjs",
      String.raw`#!/usr/bin/env node
process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\n");
`,
    );

    const payload = Buffer.from(
      JSON.stringify({
        targetCommand: `${process.execPath} ${argvPrinterPath} --flag`,
        bootstrap: {
          model: "gpt-5.3-codex-spark",
          reasoningEffort: "high",
        },
      }),
      "utf8",
    ).toString("base64url");

    const child = spawn(process.execPath, [wrapperPath, "--payload", payload], {
      stdio: ["pipe", "pipe", "inherit"],
      cwd: process.cwd(),
    });
    child.stdin.end();

    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      child.once("close", (code) => resolve(code));
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual([
      "--flag",
      "-c",
      'model="gpt-5.3-codex-spark"',
      "-c",
      'model_reasoning_effort="high"',
    ]);
  });

  it("preserves backslashes in quoted executable paths", async () => {
    const argvPrinterPath = await makeTempScript(
      String.raw`argv printer\with spaces.cjs`,
      String.raw`#!/usr/bin/env node
process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\n");
`,
    );

    const payload = Buffer.from(
      JSON.stringify({
        targetCommand: `"${argvPrinterPath}" --flag`,
        bootstrap: {
          model: "gpt-5.3-codex-spark",
        },
      }),
      "utf8",
    ).toString("base64url");

    const child = spawn(process.execPath, [wrapperPath, "--payload", payload], {
      stdio: ["pipe", "pipe", "inherit"],
      cwd: process.cwd(),
    });
    child.stdin.end();

    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      child.once("close", (code) => resolve(code));
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual(["--flag", "-c", 'model="gpt-5.3-codex-spark"']);
  });

  it("ignores unsupported reasoningEffort values instead of forwarding invalid Codex CLI overrides", async () => {
    const argvPrinterPath = await makeTempScript(
      "argv-printer-none.cjs",
      String.raw`#!/usr/bin/env node
process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\n");
`,
    );

    const payload = Buffer.from(
      JSON.stringify({
        targetCommand: `${process.execPath} ${argvPrinterPath}`,
        bootstrap: {
          reasoningEffort: "none",
        },
      }),
      "utf8",
    ).toString("base64url");

    const child = spawn(process.execPath, [wrapperPath, "--payload", payload], {
      stdio: ["pipe", "pipe", "inherit"],
      cwd: process.cwd(),
    });
    child.stdin.end();

    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      child.once("close", (code) => resolve(code));
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual([]);
  });
});
