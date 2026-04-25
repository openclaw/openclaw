import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { describe, expect, it } from "vitest";
import {
  formatMatrixQaCliCommand,
  redactMatrixQaCliOutput,
  resolveMatrixQaOpenClawCliEntryPath,
  runMatrixQaOpenClawCli,
} from "./scenario-runtime-cli.js";

describe("Matrix QA CLI runtime", () => {
  it("redacts secret CLI arguments in diagnostic command text", () => {
    expect(
      formatMatrixQaCliCommand([
        "matrix",
        "verify",
        "backup",
        "restore",
        "--recovery-key",
        "abcdef1234567890ghij",
      ]),
    ).toBe("openclaw matrix verify backup restore --recovery-key [REDACTED]");
    expect(formatMatrixQaCliCommand(["matrix", "account", "add", "--access-token=token-123"])).toBe(
      "openclaw matrix account add --access-token=[REDACTED]",
    );
    expect(
      formatMatrixQaCliCommand(["matrix", "verify", "device", "abcdef1234567890ghij", "--json"]),
    ).toBe("openclaw matrix verify device [REDACTED] --json");
  });

  it("redacts Matrix token output before diagnostics and artifacts", () => {
    expect(
      redactMatrixQaCliOutput("GET /_matrix/client/v3/sync?access_token=abcdef1234567890ghij"),
    ).toBe("GET /_matrix/client/v3/sync?access_token=abcdef…ghij");
  });

  it("prefers the ESM OpenClaw CLI entrypoint when present", async () => {
    const root = await mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "matrix-qa-cli-entry-"));
    try {
      await mkdir(path.join(root, "dist"));
      await writeFile(path.join(root, "dist", "index.mjs"), "");
      expect(resolveMatrixQaOpenClawCliEntryPath(root)).toBe(path.join(root, "dist", "index.mjs"));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("can preserve expected non-zero CLI output for negative scenarios", async () => {
    const root = await mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "matrix-qa-cli-nonzero-"),
    );
    try {
      await mkdir(path.join(root, "dist"));
      await writeFile(
        path.join(root, "dist", "index.mjs"),
        [
          "process.stdout.write(JSON.stringify({ success: false, error: 'expected failure' }));",
          "process.exit(7);",
        ].join("\n"),
      );
      const result = await runMatrixQaOpenClawCli({
        allowNonZero: true,
        args: ["matrix", "verify", "backup", "restore", "--json"],
        cwd: root,
        env: process.env,
        timeoutMs: 5_000,
      });
      expect(result.exitCode).toBe(7);
      expect(result.stdout).toContain('"success":false');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
