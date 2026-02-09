// Claude Code → MAIBOT Discord DM notification
// Receives hook JSON from stdin, sends Discord DM via openclaw CLI

import { execFile } from "node:child_process";
import { resolve } from "node:path";

const MAIBOT_DIR = resolve("C:/MAIBOT");
const TARGET = "user:1466595769791283282";
const CHANNEL = "discord";

const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    process.exit(0);
  }

  const event = input.hook_event_name || "unknown";

  // Prevent infinite loop on Stop event
  if (event === "Stop" && input.stop_hook_active) {
    process.exit(0);
  }

  const messages = {
    Stop: "Claude Code 응답 완료",
    Notification: "Claude Code 알림: 확인이 필요합니다",
    SessionStart: "Claude Code 세션 시작",
    SessionEnd: "Claude Code 세션 종료",
  };

  const msg = messages[event];
  if (!msg) {
    process.exit(0);
  }

  execFile(
    "node",
    ["openclaw.mjs", "message", "send", "--channel", CHANNEL, "--target", TARGET, "--message", msg],
    { cwd: MAIBOT_DIR },
    () => process.exit(0),
  );

  // Timeout fallback - don't block Claude Code
  setTimeout(() => process.exit(0), 8000);
});
