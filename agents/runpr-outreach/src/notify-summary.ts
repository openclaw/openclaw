// Post-run iMessage summary via the local `imsg` CLI.

import { spawn } from "node:child_process";
import type { ProspectRun } from "./types.js";

function runImsg(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("imsg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b) => out.push(b));
    child.stderr.on("data", (b) => err.push(b));
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      resolvePromise({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        code: code ?? -1,
      });
    });
  });
}

export function buildSummaryText(runs: ProspectRun[], dryRun: boolean): string {
  const header = dryRun
    ? `RunPR weekly DRY RUN. ${runs.length} drafts simulated.`
    : `RunPR weekly run. ${runs.length} new Gmail drafts in jeff@hypelab.digital.`;

  const lines: string[] = [header, ""];
  const lowConfidence: string[] = [];

  runs.forEach((r, i) => {
    const tool = r.detected.tool;
    const cc = r.contact.confidence;
    const link = r.gmail_draft_url ? ` ${r.gmail_draft_url}` : "";
    lines.push(`${i + 1}. ${r.prospect.name} | tool: ${tool} | contact: ${cc}${link}`);
    if (cc === "LOW") {
      lowConfidence.push(`${r.prospect.name} (${r.contact.email})`);
    }
  });

  if (lowConfidence.length > 0) {
    lines.push("");
    lines.push(`LOW-confidence contacts (verify before sending): ${lowConfidence.join(", ")}`);
  }

  return lines.join("\n");
}

export async function sendSummary(phone: string, runs: ProspectRun[], dryRun: boolean): Promise<void> {
  const text = buildSummaryText(runs, dryRun);
  const { code, stderr } = await runImsg(["send", "--to", phone, "--text", text]);
  if (code !== 0) {
    console.error(`[notify-summary] imsg send exited ${code}: ${stderr.slice(0, 300)}`);
  }
}
