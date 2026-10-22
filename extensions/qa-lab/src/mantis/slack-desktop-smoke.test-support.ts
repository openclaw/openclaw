import fs from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import type { CommandRunner } from "./crabbox-runtime.js";

export const SLACK_ARTIFACT_TEST_CHANNEL = "C123456789";

export function createSlackRunner(
  id: string,
  options: {
    details?: { slug?: string; state?: string; provider?: string; sshKey?: string };
    created?: boolean;
    metadata?: Record<string, unknown>;
    files?: Record<string, string>;
    copy?: (outputDir: string) => Promise<void>;
    beforeCommand?: (command: string, args: readonly string[]) => void;
  } = {},
) {
  const commands: { command: string; args: readonly string[]; env?: NodeJS.ProcessEnv }[] = [];
  const runner = vi.fn<CommandRunner>(async (command, args, { env }) => {
    commands.push({ command, args, env });
    options.beforeCommand?.(command, args);
    if (options.created && command === "/tmp/crabbox" && args[0] === "warmup") {
      return { stdout: `ready lease ${id}\n`, stderr: "" };
    }
    if (command === "/tmp/crabbox" && args[0] === "inspect") {
      return {
        stdout: JSON.stringify({
          host: "203.0.113.10",
          id,
          provider: "hetzner",
          sshKey: "/tmp/key",
          sshPort: "2222",
          sshUser: "crabbox",
          ...options.details,
        }),
        stderr: "",
      };
    }
    if (command === "rsync") {
      const outputDir = args.at(-1);
      if (!outputDir) {
        throw new Error("Missing artifact copy destination");
      }
      await fs.mkdir(outputDir, { recursive: true });
      for (const [file, content] of Object.entries(options.files ?? {})) {
        await fs.writeFile(path.join(outputDir, file), content);
      }
      await options.copy?.(outputDir);
    }
    return { stdout: "", stderr: "" };
  });
  return { runner, commands };
}

export async function writeApprovalCheckpointArtifacts(
  outputDir: string,
  scenarioIds: readonly string[],
  omitCheckpoint?: string,
) {
  const checkpointDir = path.join(outputDir, "approval-checkpoints");
  await fs.mkdir(checkpointDir, { recursive: true });
  for (const [index, scenarioId] of scenarioIds.entries()) {
    for (const state of ["pending", "resolved"] as const) {
      if (omitCheckpoint !== `${scenarioId}.${state}.json`) {
        await fs.writeFile(
          path.join(checkpointDir, `${scenarioId}.${state}.json`),
          `${JSON.stringify({
            version: 1,
            scenarioId,
            approvalKind: scenarioId.endsWith("-approval-exec-native") ? "exec" : "plugin",
            state,
            approvalId: `${scenarioId}:approval`,
            channelId: SLACK_ARTIFACT_TEST_CHANNEL,
            messageTs: `${index + 1}.000000`,
            threadTs: null,
            decision: state === "resolved" ? "allow-once" : null,
            observedAt: "2026-05-04T13:00:29.000Z",
            message: {
              actionLabels: state === "pending" ? ["Allow Once", "Allow Always", "Deny"] : [],
              blockText:
                state === "pending"
                  ? ["Plugin approval required", "Slack plugin approval QA marker"]
                  : ["Plugin approval: Allowed once", "Slack plugin approval QA marker"],
              hasNativeActions: state === "pending",
              text:
                state === "pending" ? "Plugin approval required" : "Plugin approval: Allowed once",
            },
          })}\n`,
        );
      }
      await fs.writeFile(
        path.join(checkpointDir, `${scenarioId}.${state}.ack.json`),
        `${JSON.stringify({
          version: 1,
          capturedAt: "2026-05-04T13:00:30.000Z",
          scenarioId,
          screenshotPath: `${checkpointDir}/${scenarioId}-${state}.png`,
          state,
        })}\n`,
      );
      await fs.writeFile(path.join(checkpointDir, `${scenarioId}-${state}.png`), "png");
    }
  }
}
