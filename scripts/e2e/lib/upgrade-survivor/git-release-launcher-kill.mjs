// Preloaded (`node --import`) into one launcher start: SIGKILL the launcher right after it
// records `restoring` in the trial record, before it restores state or switches the link.
import fs from "node:fs";

const marker = process.env.OPENCLAW_UPGRADE_SURVIVOR_LAUNCHER_KILL_MARKER;
const rename = fs.renameSync;
fs.renameSync = function renameSync(from, to) {
  rename.call(this, from, to);
  if (!marker || !String(to).endsWith("/releases/.trial") || fs.existsSync(marker)) {
    return;
  }
  let record;
  try {
    record = JSON.parse(fs.readFileSync(to, "utf8"));
  } catch {
    return;
  }
  if (record?.restoring) {
    fs.writeFileSync(
      marker,
      JSON.stringify({ pid: process.pid, at: new Date().toISOString(), record }),
    );
    process.kill(process.pid, "SIGKILL");
  }
};
