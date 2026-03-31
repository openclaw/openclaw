/**
 * bodhi-precognition hook handler
 *
 * Fires on message:preprocessed — after all media/link understanding,
 * before the agent sees the message.
 *
 * Runs the Python pre-cognition pipeline as a subprocess.
 * Non-blocking: spawns, fire-and-forgets for non-crisis tiers.
 * For RED tier: waits for result and pushes a system notice.
 */

import { spawn } from "child_process";
import * as os from "os";
import * as path from "path";

const OPENBODHI_PATH = process.env.OPENBODHI_PATH || path.join(os.homedir(), "openbodhi");
const TIMEOUT_MS = 3000; // 3 second hard timeout — never block the gateway

const handler = async (event: any): Promise<void> => {
  if (event.type !== "message" || event.action !== "preprocessed") {
    return;
  }

  const body: string = event.context?.bodyForAgent || event.context?.body || "";
  const channel: string = event.context?.channelId || "telegram";
  const timestamp = new Date().toISOString();

  try {
    const result = await runPrecognition(body, timestamp, channel);

    if (result.startsWith("CRISIS:red")) {
      // RED tier: push system notice to messages so it appears before Bo responds
      event.messages.push(
        "[SYSTEM] Crisis signals detected in this message. " +
        "bodhi-safety SKILL.md RED tier protocol is active. " +
        "Presence only. No counseling. Human escalation."
      );
    }
    // Other tiers: silent — SOMATIC_CONTEXT.md is injected at bootstrap
  } catch (err) {
    // Never crash the gateway. Log and continue.
    console.error(
      "[bodhi-precognition] Pipeline error:",
      err instanceof Error ? err.message : String(err)
    );
  }
};

function runPrecognition(
  body: string,
  timestamp: string,
  channel: string
): Promise<string> {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      BODHI_MSG_BODY: body,
      BODHI_MSG_TIMESTAMP: timestamp,
      BODHI_MSG_CHANNEL: channel,
    };

    const child = spawn(
      "python3",
      ["-m", "bodhi_vault.precognition.cli"],
      {
        cwd: OPENBODHI_PATH,
        env,
        timeout: TIMEOUT_MS,
      }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code: number | null) => {
      if (code !== 0 && stderr) {
        console.error(`[bodhi-precognition] stderr: ${stderr.trim()}`);
      }
      resolve(stdout.trim() || `OK:unknown`);
    });

    child.on("error", (err: Error) => {
      console.error("[bodhi-precognition] spawn error:", err.message);
      resolve("OK:unknown"); // fail open, never crash
    });
  });
}

export default handler;
