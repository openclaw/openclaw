import { redactToolPayloadText } from "openclaw/plugin-sdk/logging-core";
import { truncateUtf8Prefix } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  crabboxCommandOutput,
  leaseRunArgs,
  runCrabboxCommand,
  type CrabboxCommandRunner,
} from "./crabbox-worker-command.js";
import type { CrabboxOperatingSystem } from "./crabbox-worker-profile.js";
import { wrapCrabboxNodeScript } from "./crabbox-worker-script.js";
import { CRABBOX_NODE_ENROLLMENT_DIAGNOSTIC_TIMEOUT_MS } from "./crabbox-worker-timeouts.js";

const MAX_NODE_ENROLLMENT_EVIDENCE_BYTES = 2_048;

export async function collectCrabboxNodeEnrollmentEvidence(params: {
  provider: string;
  binary: string;
  id: string;
  target?: CrabboxOperatingSystem;
  runCommand: CrabboxCommandRunner;
  signal?: AbortSignal;
  assertCurrent: () => void;
}): Promise<string> {
  let label = "box evidence";
  let detail: string;
  try {
    params.assertCurrent();
    const result = await runCrabboxCommand({
      action: "enrollment diagnostics",
      args: leaseRunArgs(params),
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
    let offset = 0;
    if (utf16 && bytes >= 2 && buffer.readUInt16LE(0) >= 0xdc00 && buffer.readUInt16LE(0) <= 0xdfff) offset = 2;
    if (!utf16) while (offset < bytes && (buffer[offset] & 0xc0) === 0x80) offset++;
    tail = buffer.subarray(offset, bytes).toString(utf16 ? "utf16le" : "utf8");
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
    detail = crabboxCommandOutput("enrollment diagnostics", result).trim();
    if (!detail) {
      throw new Error("diagnostic command returned no output");
    }
  } catch (error) {
    label = "box evidence unavailable";
    detail = error instanceof Error ? error.message : "diagnostic command failed";
  }
  params.assertCurrent();
  let prefix = `${label}: `;
  const safeDetail = redactToolPayloadText(detail).replace(/\s+/gu, " ").trim();
  const evidence =
    label === "box evidence"
      ? /^node-runtime=(.*?) node-pid=(alive|dead-or-absent) node\.log tail: (.*)$/u.exec(
          safeDetail,
        )
      : null;
  if (evidence) {
    // Bound the runtime path independently so process state and the newest log bytes survive.
    prefix += `node-runtime=${truncateUtf8Prefix(evidence[1]!, 256)} node-pid=${evidence[2]} node.log tail: `;
  }
  const bytes = Buffer.from(evidence?.[3] ?? safeDetail);
  let start = Math.max(
    0,
    bytes.length - (MAX_NODE_ENROLLMENT_EVIDENCE_BYTES - Buffer.byteLength(prefix)),
  );
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) {
    start++;
  }
  return `${prefix}${bytes.subarray(start).toString("utf8")}`;
}
