import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { ensurePullRequest } from "../../src/operator-harness/github-pr.js";
import type { TaskPacket } from "../../src/operator-harness/types.js";

function usage(): never {
  throw new Error(
    "Usage: node --import tsx operator-harness/scripts/sync-pr.ts --task <task-packet.json>",
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

function readStream(stream: NodeJS.ReadableStream) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function parseRepoSlug(repoUrl: string) {
  const match = repoUrl.match(/github\.com[:/](.+?)\/(.+?)(?:\.git)?$/i);
  if (!match?.[1] || !match[2]) {
    throw new Error(`Unsupported GitHub repo URL: ${repoUrl}`);
  }
  return `${match[1]}/${match[2]}`;
}

function repoOwner(repoSlug: string) {
  return repoSlug.split("/")[0] ?? repoSlug;
}

function buildRawGitHubUrl(repoSlug: string, branchName: string, repoRelativePath: string) {
  const normalizedPath = repoRelativePath.replace(/^\/+/, "").split(path.sep).join("/");
  const normalizedBranch = encodeURIComponent(branchName);
  return `https://raw.githubusercontent.com/${repoSlug}/${normalizedBranch}/${normalizedPath}`;
}

function buildBlobGitHubUrl(repoSlug: string, branchName: string, repoRelativePath: string) {
  const normalizedPath = repoRelativePath.replace(/^\/+/, "").split(path.sep).join("/");
  const normalizedBranch = encodeURIComponent(branchName);
  return `https://github.com/${repoSlug}/blob/${normalizedBranch}/${normalizedPath}`;
}

async function collectEvidenceRoles(task: TaskPacket) {
  const absoluteTicketArtifactDir = resolveTicketWorkspaceRoot(task);
  const entries = await fs
    .readdir(absoluteTicketArtifactDir, { withFileTypes: true })
    .catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted((left, right) => {
      const order = ["builder", "qa", "ux", "ai", "spot-check"];
      const leftIndex = order.indexOf(left);
      const rightIndex = order.indexOf(right);
      if (leftIndex >= 0 || rightIndex >= 0) {
        return (
          (leftIndex === -1 ? order.length : leftIndex) -
          (rightIndex === -1 ? order.length : rightIndex)
        );
      }
      return left.localeCompare(right);
    });
}

function resolveTicketWorkspaceRoot(task: TaskPacket) {
  if (task.taskPacketPath) {
    const roleWorkspaceDir = path.dirname(path.dirname(task.taskPacketPath));
    return path.dirname(roleWorkspaceDir);
  }
  return path.resolve(task.repoCwd, "..");
}

function resolveRoleArtifactDir(task: TaskPacket, role: string) {
  const roleArtifactDir = `${path.dirname(task.repoRelativeArtifactDir)}/${role}`;
  return {
    repoRelativeArtifactDir: roleArtifactDir,
    absoluteArtifactDir: path.join(resolveTicketWorkspaceRoot(task), role, roleArtifactDir),
  };
}

async function renderRoleEvidenceSection(task: TaskPacket, repoSlug: string, role: string) {
  const roleArtifactDir = resolveRoleArtifactDir(task, role);
  const images = ["before.png", "after.png", "annotated.png"]
    .map((name) => {
      const rel = `${roleArtifactDir.repoRelativeArtifactDir}/${name}`;
      const rawUrl = buildRawGitHubUrl(repoSlug, task.branchName, rel);
      const blobUrl = buildBlobGitHubUrl(repoSlug, task.branchName, rel);
      return `### ${role}: ${name}\n![${role}-${name}](${rawUrl})\n[Open ${role} ${name}](${blobUrl})`;
    })
    .join("\n\n");
  const videoRel = `${roleArtifactDir.repoRelativeArtifactDir}/walkthrough.webm`;
  const gifRel = `${roleArtifactDir.repoRelativeArtifactDir}/walkthrough.gif`;
  const reviewRel = `${roleArtifactDir.repoRelativeArtifactDir}/review.md`;
  const videoBlobUrl = buildBlobGitHubUrl(repoSlug, task.branchName, videoRel);
  const videoRawUrl = buildRawGitHubUrl(repoSlug, task.branchName, videoRel);
  const gifBlobUrl = buildBlobGitHubUrl(repoSlug, task.branchName, gifRel);
  const gifRawUrl = buildRawGitHubUrl(repoSlug, task.branchName, gifRel);
  const reviewBlobUrl = buildBlobGitHubUrl(repoSlug, task.branchName, reviewRel);
  const hasGif = await fs
    .stat(path.join(roleArtifactDir.absoluteArtifactDir, "walkthrough.gif"))
    .then((stat) => stat.isFile())
    .catch(() => false);
  const hasReview = await fs
    .stat(path.join(roleArtifactDir.absoluteArtifactDir, "review.md"))
    .then((stat) => stat.isFile())
    .catch(() => false);
  return [
    `## ${role.toUpperCase()} Evidence`,
    images,
    hasGif
      ? `### ${role}: walkthrough.gif\n![${role}-walkthrough.gif](${gifRawUrl})\n[Open ${role} walkthrough.gif](${gifBlobUrl})`
      : null,
    `### ${role}: walkthrough.webm\n<video src="${videoRawUrl}" controls muted playsinline width="960"></video>\n[Open ${role} walkthrough.webm](${videoBlobUrl})`,
    hasReview ? `### ${role}: review.md\n[Open ${role} review.md](${reviewBlobUrl})` : null,
  ]
    .filter((section): section is string => Boolean(section))
    .join("\n\n");
}

async function renderPrBody(task: TaskPacket, repoSlug: string) {
  const roles = await collectEvidenceRoles(task);
  const evidenceSections = await Promise.all(
    roles.map((role) => renderRoleEvidenceSection(task, repoSlug, role)),
  );
  return [
    `## Summary`,
    task.summary,
    ``,
    `## Upstream`,
    `- Linear: ${task.upstreamUrl}`,
    ...task.notionUrls.map((url) => `- Notion: ${url}`),
    ``,
    `## Acceptance Criteria`,
    ...task.acceptanceCriteria.map((item) => `- ${item}`),
    ``,
    `## Validation`,
    `- Startup: \`${task.startupCommand}\``,
    `- Healthcheck: ${task.healthcheckUrl}`,
    ...task.browserWalkthrough.map(
      (step, index) =>
        `- ${index + 1}. ${step.action}${step.target ? ` ${step.target}` : ""}${step.value ? ` => ${step.value}` : ""}`,
    ),
    ``,
    `## Evidence Matrix`,
    ...roles.map((role) => `- ${role}`),
    ``,
    ...evidenceSections,
  ].join("\n");
}

async function rebaseOntoRemoteBranch(task: TaskPacket, pushRepoUrl: string) {
  const branchRef = `refs/heads/${task.branchName}`;
  const remoteBranch = await run(
    "git",
    ["ls-remote", "--heads", pushRepoUrl, branchRef],
    task.repoCwd,
  );
  if (!remoteBranch) {
    return;
  }
  await run("git", ["fetch", pushRepoUrl, task.branchName], task.repoCwd);
  await run("git", ["rebase", "FETCH_HEAD"], task.repoCwd);
}

function writeStdoutLine(value: string) {
  process.stdout.write(`${value}\n`);
}

async function main() {
  const taskPath = readArg("--task");
  if (!taskPath) {
    usage();
  }
  const taskPacketPath = path.resolve(taskPath);
  const task = JSON.parse(await fs.readFile(taskPacketPath, "utf8")) as TaskPacket;
  if (!task.prRequired) {
    throw new Error("This task does not require a pull request.");
  }
  const repoUrl = await run("git", ["remote", "get-url", task.gitRemoteName], task.repoCwd);
  const pushRepoUrl = await run(
    "git",
    ["remote", "get-url", "--push", task.gitRemoteName],
    task.repoCwd,
  );
  const baseRepoSlug = parseRepoSlug(repoUrl);
  const pushRepoSlug = parseRepoSlug(pushRepoUrl);
  const headRefName =
    baseRepoSlug === pushRepoSlug
      ? task.branchName
      : `${repoOwner(pushRepoSlug)}:${task.branchName}`;
  await rebaseOntoRemoteBranch(task, pushRepoUrl);
  const body = await renderPrBody(task, pushRepoSlug);
  await fs.mkdir(path.dirname(task.prBodyPath), { recursive: true });
  await fs.writeFile(task.prBodyPath, `${body}\n`);
  await run("git", ["push", "-u", task.gitRemoteName, task.branchName], task.repoCwd);
  const pr = await ensurePullRequest({
    repoUrl,
    branchName: task.branchName,
    headRefName,
    baseBranch: task.baseBranch,
    title: task.prTitle,
    bodyFile: task.prBodyPath,
    cwd: task.repoCwd,
    draft: true,
  });
  const nextTask = { ...task, prUrl: pr.url };
  await fs.writeFile(taskPacketPath, `${JSON.stringify(nextTask, null, 2)}\n`);
  writeStdoutLine(pr.url);
}

void main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  })
  .then(() => {
    process.exit(0);
  });
