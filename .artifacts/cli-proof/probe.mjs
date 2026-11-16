// Shipped trajectory export path (built dist loader) behaviour probe.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const mode = process.argv[2];
const root = fs.mkdtempSync(path.join(os.tmpdir(), `cli-probe-${mode}-`));
const workspaceDir = path.join(root, "ws");
fs.mkdirSync(workspaceDir, { recursive: true });
const sessionFile = path.join(root, "session-1.jsonl");
const now = Date.now();
const header = { type: "session", version: 3, id: "session-1", timestamp: new Date(now).toISOString(), cwd: workspaceDir };
const entries = [
  { type: "message", id: "e1", parentId: null, timestamp: new Date(now).toISOString(), message: { role: "user", content: "hello", timestamp: now } },
  { type: "message", id: "e2", parentId: "e1", timestamp: new Date(now).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "world" }], api: "openai-responses", provider: "openai", model: "gpt-5.4", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: now } },
];
fs.writeFileSync(sessionFile, [header, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n");
const outputDir = path.join(root, "bundle");

process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
const modPath = `/media/vdc/oc-tools/cli-probe/${mode}/export-trajectory-Cdb4Fp_K.mjs`;
let src = fs.readFileSync(modPath, "utf8");
const marker = fs.readFileSync("/media/vdc/oc-tools/cli-probe/EXPORT_MARKER", "utf8");
const start = src.indexOf(marker);
const end = src.indexOf("//!src/commands/export-trajectory.ts", start);
src = src.slice(0, end) + "\nexport { exportTrajectoryBundle };\n";
const localPath = `/media/vdc/oc-tools/cli-probe/${mode}/export-bundle-${process.pid}.mjs`;
fs.writeFileSync(localPath, src);
const { exportTrajectoryBundle } = await import(localPath);

// Inject a disk-full style failure on the transcript .jsonl bundle file write.
const realWriteFile = fsp.writeFile;
let injected = false;
fsp.writeFile = async (target, data, options) => {
  const p = String(target);
  if (!injected && p.endsWith(".jsonl") && p.includes(path.basename(outputDir))) {
    injected = true;
    await realWriteFile(p, String(data).slice(0, 5), options);
    throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
  }
  return realWriteFile(target, data, options);
};

let firstError = null;
try {
  await exportTrajectoryBundle({ outputDir, sessionFile, sessionId: "session-1", workspaceDir });
} catch (e) { firstError = e.code ?? e.message; }
fsp.writeFile = realWriteFile;

const listTree = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).sort() : null;
const afterFailure = listTree(outputDir);
let retryError = null;
let files = null;
try {
  const bundle = await exportTrajectoryBundle({ outputDir, sessionFile, sessionId: "session-1", workspaceDir });
  files = bundle.files;
} catch (e) { retryError = e.code ?? e.message; }
const manifest = fs.existsSync(path.join(outputDir, "manifest.json"))
  ? JSON.parse(fs.readFileSync(path.join(outputDir, "manifest.json"), "utf8")) : null;

console.log(JSON.stringify({
  mode,
  FIRST_ERROR: firstError,
  LEFTOVER_AFTER_FAILURE: afterFailure,
  RETRY_ERROR: retryError,
  RETRY_OK: retryError === null,
  MANIFEST_AFTER_RETRY: manifest && { traceSchema: manifest.traceSchema, sessionId: manifest.sessionId },
  FILES: files,
}, null, 2));
fs.rmSync(root, { recursive: true, force: true });
