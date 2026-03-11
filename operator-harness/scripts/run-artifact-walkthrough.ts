import fs from "node:fs/promises";
import path from "node:path";
import { runArtifactWalkthrough } from "../../src/operator-harness/browser-runtime.js";
import type { TaskPacket } from "../../src/operator-harness/types.js";

function usage(): never {
  throw new Error(
    "Usage: node --import tsx operator-harness/scripts/run-artifact-walkthrough.ts --task <task-packet.json> [--session <name>]",
  );
}

function readArg(name: string) {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return null;
  }
  return process.argv[index + 1] ?? null;
}

function buildSessionName(task: TaskPacket) {
  return `${task.externalTicketId.toLowerCase()}-${task.role}-${process.pid}`;
}

async function main() {
  const taskPath = readArg("--task");
  if (!taskPath) {
    usage();
  }
  const taskPacketPath = path.resolve(taskPath);
  const task = JSON.parse(await fs.readFile(taskPacketPath, "utf8")) as TaskPacket;
  const sessionName = readArg("--session") ?? buildSessionName(task);
  await fs.mkdir(task.artifactDir, { recursive: true });
  await runArtifactWalkthrough({
    artifactDir: task.artifactDir,
    sessionName,
    packet: task,
  });
  const files = await fs.readdir(task.artifactDir);
  const present = files.filter((name) => task.requiredArtifacts.includes(name)).toSorted();
  process.stdout.write(
    JSON.stringify(
      {
        task: task.externalTicketId,
        role: task.role,
        sessionName,
        artifactDir: task.artifactDir,
        presentArtifacts: present,
      },
      null,
      2,
    ) + "\n",
  );
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
