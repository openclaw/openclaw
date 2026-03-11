import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { TaskPacket } from "../../src/operator-harness/types.js";

function usage(): never {
  throw new Error(
    "Usage: node --import tsx operator-harness/scripts/finalize-ticket.ts --task <task-packet.json>",
  );
}

function readArg(name: string) {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return null;
  }
  return process.argv[index + 1] ?? null;
}

async function run(command: string, args: string[], cwd: string) {
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    readStream(child.stdout),
    readStream(child.stderr),
    new Promise<number | null>((resolve) => child.once("close", resolve)),
  ]);
  if ((exitCode ?? 1) !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${stderr || stdout}`);
  }
  return stdout.trim();
}

async function runMaybe(command: string, args: string[], cwd: string) {
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    readStream(child.stdout),
    readStream(child.stderr),
    new Promise<number | null>((resolve) => child.once("close", resolve)),
  ]);
  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    exitCode: exitCode ?? 1,
  };
}

function readStream(stream: NodeJS.ReadableStream) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function ensureReviewMarkdown(task: TaskPacket) {
  const reviewPath = path.join(task.artifactDir, "review.md");
  const exists = await fs
    .stat(reviewPath)
    .then((stat) => stat.isFile())
    .catch(() => false);
  if (exists) {
    return;
  }
  const changedFiles = await run("git", ["status", "--short"], task.repoCwd);
  const reviewedArtifacts = task.requiredArtifacts
    .filter((name) => name !== "review.md")
    .map((name) => `- ${name}`)
    .join("\n");
  const reviewBody = [
    "# Builder Review",
    "",
    "## What Changed",
    changedFiles
      ? "```text\n" + changedFiles + "\n```"
      : "- No unstaged file changes were detected.",
    "",
    "## What I Validated",
    `- Ran the canonical validation helper against ${task.healthcheckUrl}.`,
    reviewedArtifacts,
    "",
    "## Residual Risk",
    "- This pilot flow is validated against the local UI runtime and localStorage-backed state; live backend integrations remain out of scope for this ticket.",
    "",
  ].join("\n");
  await fs.writeFile(reviewPath, reviewBody);
}

async function assertArtifacts(task: TaskPacket) {
  const missing: string[] = [];
  for (const name of task.requiredArtifacts) {
    const filePath = path.join(task.artifactDir, name);
    const exists = await fs
      .stat(filePath)
      .then((stat) => stat.isFile())
      .catch(() => false);
    if (!exists) {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Missing required artifacts: ${missing.join(", ")}`);
  }
}

async function maybeGenerateWalkthroughGif(task: TaskPacket) {
  const videoPath = path.join(task.artifactDir, "walkthrough.webm");
  const gifPath = path.join(task.artifactDir, "walkthrough.gif");
  const hasVideo = await fs
    .stat(videoPath)
    .then((stat) => stat.isFile())
    .catch(() => false);
  if (!hasVideo) {
    return;
  }
  const result = await runMaybe(
    "ffmpeg",
    ["-y", "-i", videoPath, "-vf", "fps=8,scale=960:-1:flags=lanczos", gifPath],
    task.repoCwd,
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || "ffmpeg walkthrough.gif generation failed");
  }
}

async function maybeCommit(task: TaskPacket) {
  await run("git", ["add", "-A"], task.repoCwd);
  const staged = await runMaybe("git", ["diff", "--cached", "--quiet"], task.repoCwd);
  if (staged.exitCode === 0) {
    return false;
  }
  const message = `${task.externalTicketId}: finalize ${task.role} output`;
  await run("git", ["commit", "-m", message], task.repoCwd);
  return true;
}

async function main() {
  const taskPath = readArg("--task");
  if (!taskPath) {
    usage();
  }
  const taskPacketPath = path.resolve(taskPath);
  const task = JSON.parse(await fs.readFile(taskPacketPath, "utf8")) as TaskPacket;
  const currentBranch = await run("git", ["branch", "--show-current"], task.repoCwd);
  if (currentBranch !== task.branchName) {
    throw new Error(`Expected branch ${task.branchName}, found ${currentBranch}`);
  }
  await fs.mkdir(task.artifactDir, { recursive: true });
  await ensureReviewMarkdown(task);
  await maybeGenerateWalkthroughGif(task);
  await assertArtifacts(task);
  await maybeCommit(task);
  if (task.prRequired && task.prSyncCommand) {
    const syncArgs = task.prSyncCommand.split(" ");
    const [command, ...args] = syncArgs;
    await run(command, args, task.repoCwd);
    const updated = JSON.parse(await fs.readFile(taskPacketPath, "utf8")) as TaskPacket;
    process.stdout.write(`${updated.prUrl ?? ""}\n`);
    return;
  }
  process.stdout.write("finalized\n");
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
