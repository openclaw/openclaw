import { randomUUID } from "node:crypto";
import path from "node:path";
import { isStringArray } from "openclaw/plugin-sdk/collection-input-runtime";
import { walkRootDirectory } from "openclaw/plugin-sdk/root-walk";
import { root } from "openclaw/plugin-sdk/security-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type ArtifactRoot = Awaited<ReturnType<typeof root>>;
type ApprovalIdentity = { approvalId: string; channelId: string; messageTs: string };

type MantisApprovalCheckpointState = "pending" | "resolved";

type MantisApprovalCheckpointScreenshot = {
  ackPath: string;
  checkpointPath: string;
  scenarioId: string;
  screenshotPath: string;
  state: MantisApprovalCheckpointState;
};

export type MantisApprovalCheckpointArtifacts = {
  directoryPath: string;
  screenshots: MantisApprovalCheckpointScreenshot[];
};

async function assertNonEmptyFile(owner: ArtifactRoot, filePath: string, label: string) {
  let opened;
  try {
    opened = await owner.open(filePath);
  } catch (error) {
    throw new Error(`${label} is missing: ${filePath}`, { cause: error });
  }
  try {
    if (opened.stat.size <= 0) {
      throw new Error(`${label} is empty: ${filePath}`);
    }
  } finally {
    await opened.handle.close();
  }
}

async function readJsonObject(
  owner: ArtifactRoot,
  filePath: string,
  label: string,
): Promise<Record<string, unknown>> {
  await assertNonEmptyFile(owner, filePath, label);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await owner.readText(filePath));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${filePath}`, { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new Error(`${label} must be a JSON object: ${filePath}`);
  }
  return parsed;
}

const reportFile = "mantis-slack-desktop-smoke-report.md";
const summaryFile = "mantis-slack-desktop-smoke-summary.json";

export async function createSlackDesktopArtifactOwner(params: {
  outputDir: string;
  approvalCheckpoints: boolean;
  scenarioIds: readonly string[];
}) {
  const destination = await root(params.outputDir, { symlinks: "reject" });
  const runId = randomUUID();
  const stagingName = `.slack-run-${runId}`;
  await destination.mkdir(stagingName);
  const stagingDir = path.join(params.outputDir, stagingName);
  const evidence = await root(stagingDir, { symlinks: "reject" });
  const ownedFiles = [
    summaryFile,
    reportFile,
    "error.txt",
    "slack-desktop-smoke.png",
    "slack-desktop-smoke.mp4",
    "remote-metadata.json",
    ...(params.approvalCheckpoints ? params.scenarioIds : []).flatMap((scenarioId) =>
      (["pending", "resolved"] as const).flatMap((state) => [
        `approval-checkpoints/${scenarioId}.${state}.json`,
        `approval-checkpoints/${scenarioId}.${state}.ack.json`,
        `approval-checkpoints/${scenarioId}-${state}.png`,
      ]),
    ),
  ];
  return {
    runId,
    stagingDir,
    async readMetadata() {
      const metadataPath = "remote-metadata.json";
      if (!(await evidence.exists(metadataPath))) {
        return undefined;
      }
      try {
        const candidate: unknown = JSON.parse(await evidence.readText(metadataPath));
        if (!isRecord(candidate)) {
          return undefined;
        }
        return {
          gatewayAlive:
            typeof candidate.gatewayAlive === "boolean" ? candidate.gatewayAlive : undefined,
          hydrateMode:
            typeof candidate.hydrateMode === "string" ? candidate.hydrateMode : undefined,
          openedUrl: typeof candidate.openedUrl === "string" ? candidate.openedUrl : undefined,
          qaExitCode: typeof candidate.qaExitCode === "number" ? candidate.qaExitCode : undefined,
        };
      } catch {
        return undefined;
      }
    },
    assertScreenshot: () =>
      assertNonEmptyFile(evidence, "slack-desktop-smoke.png", "Slack desktop screenshot"),
    hasVideo: async () =>
      (await evidence.exists("slack-desktop-smoke.mp4")) &&
      (await evidence.stat("slack-desktop-smoke.mp4")).isFile,
    async collectCheckpoints(): Promise<MantisApprovalCheckpointArtifacts | undefined> {
      const { approvalCheckpoints, outputDir, scenarioIds } = params;
      if (!approvalCheckpoints) {
        return undefined;
      }
      const directoryPath = path.join(outputDir, "approval-checkpoints");
      const screenshots: MantisApprovalCheckpointScreenshot[] = [];
      const seenApprovals = new Set<string>();
      const seenMessages = new Set<string>();
      for (const scenarioId of scenarioIds) {
        let identity: ApprovalIdentity | undefined;
        for (const state of ["pending", "resolved"] as const) {
          const checkpointPath = path.join(directoryPath, `${scenarioId}.${state}.json`);
          const ackPath = path.join(directoryPath, `${scenarioId}.${state}.ack.json`);
          const screenshotPath = path.join(directoryPath, `${scenarioId}-${state}.png`);
          const checkpointLabel = `Approval checkpoint ${scenarioId}.${state}`;
          const ackLabel = `Approval checkpoint ack ${scenarioId}.${state}`;
          function assertBase(record: Record<string, unknown>, filePath: string, label: string) {
            for (const [field, expected] of [
              ["version", 1],
              ["scenarioId", scenarioId],
              ["state", state],
            ] as const) {
              if (record[field] !== expected) {
                throw new Error(`${label} has unexpected ${field} in ${filePath}`);
              }
            }
          }
          const checkpoint = await readJsonObject(
            evidence,
            path.relative(outputDir, checkpointPath),
            checkpointLabel,
          );
          assertBase(checkpoint, checkpointPath, checkpointLabel);
          const expectedKind = scenarioId.endsWith("-approval-exec-native") ? "exec" : "plugin";
          if (checkpoint.approvalKind !== expectedKind) {
            throw new Error(`${checkpointLabel} has an unexpected approval kind.`);
          }
          const { approvalId, channelId, messageTs } = checkpoint;
          if (
            typeof approvalId !== "string" ||
            !approvalId.trim() ||
            typeof channelId !== "string" ||
            !channelId.trim() ||
            typeof messageTs !== "string" ||
            !messageTs.trim()
          ) {
            throw new Error(
              `${checkpointLabel} is missing its Slack approval interaction identity.`,
            );
          }
          const checkpointIdentity = { approvalId, channelId, messageTs };
          if (
            identity &&
            (approvalId !== identity.approvalId ||
              channelId !== identity.channelId ||
              messageTs !== identity.messageTs)
          ) {
            throw new Error(`${checkpointLabel} does not match its pending approval interaction.`);
          }
          if (checkpoint.decision !== (state === "pending" ? null : "allow-once")) {
            throw new Error(`${checkpointLabel} has an unexpected approval decision.`);
          }
          const candidate = checkpoint.message;
          if (!isRecord(candidate)) {
            throw new Error(
              `${checkpointLabel} is missing Slack message evidence in ${checkpointPath}`,
            );
          }
          if (typeof candidate.text !== "string") {
            throw new Error(
              `${checkpointLabel} message evidence is missing text in ${checkpointPath}`,
            );
          }
          if (!isStringArray(candidate.blockText)) {
            throw new Error(
              `${checkpointLabel} message evidence is missing blockText in ${checkpointPath}`,
            );
          }
          if (!isStringArray(candidate.actionLabels)) {
            throw new Error(
              `${checkpointLabel} message evidence is missing actionLabels in ${checkpointPath}`,
            );
          }
          if (typeof candidate.hasNativeActions !== "boolean") {
            throw new Error(
              `${checkpointLabel} message evidence is missing hasNativeActions in ${checkpointPath}`,
            );
          }
          if (
            (state === "pending" &&
              (!candidate.hasNativeActions || !candidate.actionLabels.includes("Allow Once"))) ||
            (state === "resolved" && candidate.hasNativeActions)
          ) {
            throw new Error(
              `${checkpointLabel} has unexpected native approval actions in ${checkpointPath}`,
            );
          }
          identity = checkpointIdentity;
          if (state === "pending") {
            const messageIdentity = JSON.stringify([identity.channelId, identity.messageTs]);
            if (seenApprovals.has(identity.approvalId) || seenMessages.has(messageIdentity)) {
              throw new Error(`${checkpointLabel} reuses another scenario's approval interaction.`);
            }
            seenApprovals.add(identity.approvalId);
            seenMessages.add(messageIdentity);
          }
          const ack = await readJsonObject(evidence, path.relative(outputDir, ackPath), ackLabel);
          assertBase(ack, ackPath, ackLabel);
          if (typeof ack.screenshotPath !== "string" || !ack.screenshotPath.trim()) {
            throw new Error(`${ackLabel} is missing screenshotPath in ${ackPath}`);
          }
          if (path.basename(ack.screenshotPath) !== path.basename(screenshotPath)) {
            throw new Error(`${ackLabel} screenshotPath does not match ${screenshotPath}`);
          }
          await assertNonEmptyFile(
            evidence,
            path.relative(outputDir, screenshotPath),
            `Approval checkpoint screenshot ${scenarioId}.${state}`,
          );
          screenshots.push({
            ackPath,
            checkpointPath,
            scenarioId,
            screenshotPath,
            state,
          });
        }
      }
      return {
        directoryPath,
        screenshots,
      };
    },
    async publish() {
      // Verdicts use each run's staging area. Shared published paths can interleave
      // across runs; coherent concurrent bundles need separate output directories.
      for (const file of ownedFiles) {
        if (await destination.exists(file)) {
          if (!(await destination.stat(file)).isFile) {
            throw new Error(`Artifact destination is not a regular file: ${file}`);
          }
          await destination.remove(file);
        }
      }
      for await (const entry of walkRootDirectory(stagingDir, ".", {
        symlinkPolicy: "skip",
        limitBehavior: "throw",
        entryFilter: (candidate) =>
          [summaryFile, reportFile, "error.txt"].includes(candidate.relativePath)
            ? "skip-subtree"
            : "include",
      })) {
        if (entry.kind === "directory") {
          await destination.mkdir(entry.relativePath);
        } else if (entry.kind === "file") {
          await destination.copyIn(
            entry.relativePath,
            { root: evidence, relativePath: entry.relativePath },
            { maxBytes: entry.size },
          );
        }
      }
    },
    async writeSummary(summary: unknown, report: string, error?: string) {
      if (error) {
        await destination.write("error.txt", `${error}\n`);
      }
      await destination.write(reportFile, report);
      await destination.writeJson(summaryFile, summary, { space: 2 });
    },
    cleanup: () => destination.remove(stagingName, { recursive: true }),
  };
}
