import process from "node:process";
import { writeLatestNemoClawDigestCache } from "../../extensions/sense-worker/src/latest-digest-cache.js";
import {
  sendNemoClawSlackNotification,
  type NemoClawSlackEvent,
} from "../../extensions/sense-worker/src/slack-notify.js";
import { loadConfig } from "../../src/config/io.js";

function parseArgs(argv: string[]) {
  const options: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      i += 1;
      continue;
    }
    options[key] = "true";
  }
  return options;
}

async function readStdin(): Promise<unknown> {
  if (process.stdin.isTTY) {
    return {};
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const event = args.event as NemoClawSlackEvent | undefined;
  if (event !== "job_done" && event !== "job_failed" && event !== "digest_ready") {
    throw new Error("Pass --event job_done|job_failed|digest_ready");
  }
  const payload = await readStdin();
  if (event === "digest_ready") {
    await writeLatestNemoClawDigestCache({
      payload,
      event,
      jobId: args["job-id"],
    });
  }
  const cfg = loadConfig();
  const result = await sendNemoClawSlackNotification({
    cfg,
    event,
    jobId: args["job-id"],
    payload,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
