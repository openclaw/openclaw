import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it } from "vitest";
import { collectCrabboxNodeEnrollmentEvidence } from "./crabbox-worker-node-enrollment-diagnostics.js";

const require = createRequire(import.meta.url);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["utf8", "utf16le"] as const)(
  "keeps the newest %s log line within the redacted evidence budget",
  async (encoding) => {
    const home = tempDirs.make("crabbox-evidence-");
    const state = path.join(home, ".openclaw", "cloud-workers", "cbx_evidence");
    fs.mkdirSync(state, { recursive: true });
    const secret = "synthetic-evidence-secret-0123456789";
    const log = Buffer.from(
      `older output 😀\n`.repeat(300) + `fatal: connection refused token=${secret}`,
      encoding,
    );
    fs.writeFileSync(
      path.join(state, "node.log"),
      encoding === "utf16le" ? Buffer.concat([Buffer.from([0xff, 0xfe]), log]) : log,
    );
    const evidence = await collectCrabboxNodeEnrollmentEvidence({
      binary: "crabbox",
      provider: "aws",
      id: "cbx_evidence",
      runCommand: async (_argv, options) => {
        let stdout = "";
        const script = String(options.input).split("\n").slice(2, -1).join("\n");
        runInNewContext(script, {
          Buffer,
          require: (name: string) =>
            name === "node:os"
              ? { homedir: () => home }
              : name === "node:fs"
                ? {
                    ...fs,
                    readlinkSync: () => `/runtime/${"long-directory/".repeat(80)}`,
                  }
                : require(name),
          process: {
            stdout: {
              write: (text: string) => {
                stdout += text;
              },
            },
          },
        });
        return { stdout, stderr: "", code: 0, signal: null, killed: false, termination: "exit" };
      },
    });
    expect(evidence).toContain("node-runtime=");
    expect(evidence).toContain("node-pid=dead-or-absent");
    expect(evidence).toContain("fatal: connection refused");
    expect(evidence).not.toContain(secret);
    expect(evidence).not.toContain("�");
    expect(Buffer.byteLength(evidence)).toBeLessThanOrEqual(2_048);
  },
);
