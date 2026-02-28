import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function getAuditLogPath() {
  return path.join(os.homedir(), ".openclaw", "psd-automator", "audit.log");
}

export function appendAudit(entry) {
  const logPath = getAuditLogPath();
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
  fs.appendFileSync(logPath, line, "utf8");
  return logPath;
}
