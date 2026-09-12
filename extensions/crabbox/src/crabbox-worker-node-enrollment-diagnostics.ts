import { redactToolPayloadText } from "openclaw/plugin-sdk/logging-core";
import { truncateUtf8Prefix } from "openclaw/plugin-sdk/text-utility-runtime";
import { crabboxCommandError } from "./crabbox-worker-command-error.js";
import { runCrabboxCommand, type CrabboxCommandRunner } from "./crabbox-worker-command.js";
import type { CrabboxOperatingSystem } from "./crabbox-worker-profile.js";
import { wrapCrabboxNodeScript } from "./crabbox-worker-script.js";
import { CRABBOX_NODE_ENROLLMENT_DIAGNOSTIC_TIMEOUT_MS } from "./crabbox-worker-timeouts.js";

const MAX_NODE_ENROLLMENT_EVIDENCE_BYTES = 2_048;

export async function collectCrabboxNodeEnrollmentEvidence(params: {
  args: string[];
  binary: string;
  id: string;
  target?: CrabboxOperatingSystem;
  runCommand: CrabboxCommandRunner;
  signal?: AbortSignal;
}): Promise<string> {
  let label = "box evidence";
  let detail: string;
  try {
    const result = await runCrabboxCommand({
      action: "enrollment diagnostics",
      args: params.args,
      binary: params.binary,
      input: wrapCrabboxNodeScript(
        `const fs = require("node:fs");
const path = require("node:path");
const state = path.join(require("node:os").homedir(), ".openclaw", ${JSON.stringify(`cloud-workers/${params.id}`)});
let runtime = "absent";
let alive = false;
let tail = "absent";
try { runtime = fs.readlinkSync(path.join(state, "runtime")); } catch {}
try {
  const text = fs.readFileSync(path.join(state, "node.pid"), "utf8").trim();
  if (/^[1-9][0-9]*$/.test(text)) { process.kill(Number(text), 0); alive = true; }
} catch {}
try {
  const fd = fs.openSync(path.join(state, "node.log"), "r");
  try {
    const size = fs.fstatSync(fd).size;
    const bom = Buffer.alloc(2);
    fs.readSync(fd, bom, 0, 2, 0);
    // Windows PowerShell 5.1 redirects to UTF-16LE, POSIX Node writes UTF-8.
    const utf16 = bom[0] === 0xff && bom[1] === 0xfe;
    const start = Math.max(0, size - 2000);
    const buffer = Buffer.alloc(Math.min(2000, size));
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, utf16 ? start - start % 2 : start);
    tail = buffer.subarray(0, bytes).toString(utf16 ? "utf16le" : "utf8");
  } finally { fs.closeSync(fd); }
} catch {}
process.stdout.write("node-runtime=" + runtime + " node-pid=" + (alive ? "alive" : "dead-or-absent") + " node.log tail: " + tail);`,
        params.target,
      ),
      runCommand: params.runCommand,
      ...(params.signal ? { signal: params.signal } : {}),
      // The enrollment deadline has already elapsed; diagnostics need their own bounded budget.
      timeoutMs: CRABBOX_NODE_ENROLLMENT_DIAGNOSTIC_TIMEOUT_MS,
    });
    if (result.termination !== "exit" || result.code !== 0) {
      throw crabboxCommandError("enrollment diagnostics", result);
    }
    detail = result.stdout.trim();
    if (!detail) {
      throw new Error("diagnostic command returned no output");
    }
  } catch (error) {
    label = "box evidence unavailable";
    detail = error instanceof Error ? error.message : "diagnostic command failed";
  }
  const prefix = `${label}: `;
  const safeDetail = redactToolPayloadText(detail).replace(/\s+/gu, " ").trim();
  return `${prefix}${truncateUtf8Prefix(safeDetail, MAX_NODE_ENROLLMENT_EVIDENCE_BYTES - prefix.length)}`;
}
