import { randomUUID } from "node:crypto";
import path from "node:path";
import { walkRootDirectory } from "openclaw/plugin-sdk/root-walk";
import { root } from "openclaw/plugin-sdk/security-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type ArtifactRoot = Awaited<ReturnType<typeof root>>;
type ApprovalIdentity = { approvalId: string; channelId: string; messageTs: string };

export type SlackDesktopRemoteMetadata = {
  gatewayAlive?: boolean;
  gatewayPid?: string;
  hydrateMode?: string;
  openedUrl?: string;
  qaExitCode?: number;
};

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

function assertApprovalCheckpointBaseJson(params: {
  filePath: string;
  label: string;
  record: Record<string, unknown>;
  scenarioId: string;
  state: MantisApprovalCheckpointState;
}) {
  if (params.record.version !== 1) {
    throw new Error(`${params.label} has unexpected version in ${params.filePath}`);
  }
  if (params.record.scenarioId !== params.scenarioId) {
    throw new Error(`${params.label} has unexpected scenarioId in ${params.filePath}`);
  }
  if (params.record.state !== params.state) {
    throw new Error(`${params.label} has unexpected state in ${params.filePath}`);
  }
}

function assertApprovalCheckpointJson(params: {
  identity?: ApprovalIdentity;
  filePath: string;
  label: string;
  record: Record<string, unknown>;
  scenarioId: string;
  state: MantisApprovalCheckpointState;
}) {
  assertApprovalCheckpointBaseJson(params);
  const expectedKind = params.scenarioId === "slack-approval-exec-native" ? "exec" : "plugin";
  if (params.record.approvalKind !== expectedKind) {
    throw new Error(`${params.label} has an unexpected approval kind.`);
  }
  const { approvalId, channelId, messageTs } = params.record;
  if (
    typeof approvalId !== "string" ||
    !approvalId.trim() ||
    typeof channelId !== "string" ||
    !channelId.trim() ||
    typeof messageTs !== "string" ||
    !messageTs.trim()
  ) {
    throw new Error(`${params.label} is missing its Slack approval interaction identity.`);
  }
  const identity = { approvalId, channelId, messageTs };
  if (
    params.identity &&
    (approvalId !== params.identity.approvalId ||
      channelId !== params.identity.channelId ||
      messageTs !== params.identity.messageTs)
  ) {
    throw new Error(`${params.label} does not match its pending approval interaction.`);
  }
  if (params.record.decision !== (params.state === "pending" ? null : "allow-once")) {
    throw new Error(`${params.label} has an unexpected approval decision.`);
  }
  const message = params.record.message;
  if (!isRecord(message)) {
    throw new Error(`${params.label} is missing Slack message evidence in ${params.filePath}`);
  }
  const candidate = message;
  if (typeof candidate.text !== "string") {
    throw new Error(`${params.label} message evidence is missing text in ${params.filePath}`);
  }
  if (
    !Array.isArray(candidate.blockText) ||
    !candidate.blockText.every((entry) => typeof entry === "string")
  ) {
    throw new Error(`${params.label} message evidence is missing blockText in ${params.filePath}`);
  }
  if (
    !Array.isArray(candidate.actionLabels) ||
    !candidate.actionLabels.every((entry) => typeof entry === "string")
  ) {
    throw new Error(
      `${params.label} message evidence is missing actionLabels in ${params.filePath}`,
    );
  }
  if (typeof candidate.hasNativeActions !== "boolean") {
    throw new Error(
      `${params.label} message evidence is missing hasNativeActions in ${params.filePath}`,
    );
  }
  if (
    (params.state === "pending" &&
      (!candidate.hasNativeActions || !candidate.actionLabels.includes("Allow Once"))) ||
    (params.state === "resolved" && candidate.hasNativeActions)
  ) {
    throw new Error(`${params.label} has unexpected native approval actions in ${params.filePath}`);
  }
  return identity;
}

function assertApprovalCheckpointAckJson(params: {
  filePath: string;
  label: string;
  record: Record<string, unknown>;
  scenarioId: string;
  screenshotPath: string;
  state: MantisApprovalCheckpointState;
}) {
  assertApprovalCheckpointBaseJson(params);
  if (typeof params.record.screenshotPath !== "string" || !params.record.screenshotPath.trim()) {
    throw new Error(`${params.label} is missing screenshotPath in ${params.filePath}`);
  }
  if (path.basename(params.record.screenshotPath) !== path.basename(params.screenshotPath)) {
    throw new Error(`${params.label} screenshotPath does not match ${params.screenshotPath}`);
  }
}

async function collectApprovalCheckpointArtifacts(params: {
  owner: ArtifactRoot;
  enabled: boolean;
  outputDir: string;
  scenarioIds: readonly string[];
}): Promise<MantisApprovalCheckpointArtifacts | undefined> {
  if (!params.enabled) {
    return undefined;
  }
  const directoryPath = path.join(params.outputDir, "approval-checkpoints");
  const screenshots: MantisApprovalCheckpointScreenshot[] = [];
  const seenApprovals = new Set<string>();
  const seenMessages = new Set<string>();
  for (const scenarioId of params.scenarioIds) {
    let identity: ApprovalIdentity | undefined;
    for (const state of ["pending", "resolved"] as const) {
      const checkpointPath = path.join(directoryPath, `${scenarioId}.${state}.json`);
      const ackPath = path.join(directoryPath, `${scenarioId}.${state}.ack.json`);
      const screenshotPath = path.join(directoryPath, `${scenarioId}-${state}.png`);
      const checkpointLabel = `Approval checkpoint ${scenarioId}.${state}`;
      const ackLabel = `Approval checkpoint ack ${scenarioId}.${state}`;
      identity = assertApprovalCheckpointJson({
        identity,
        filePath: checkpointPath,
        label: checkpointLabel,
        record: await readJsonObject(
          params.owner,
          path.relative(params.outputDir, checkpointPath),
          checkpointLabel,
        ),
        scenarioId,
        state,
      });
      if (state === "pending") {
        const messageIdentity = JSON.stringify([identity.channelId, identity.messageTs]);
        if (seenApprovals.has(identity.approvalId) || seenMessages.has(messageIdentity)) {
          throw new Error(`${checkpointLabel} reuses another scenario's approval interaction.`);
        }
        seenApprovals.add(identity.approvalId);
        seenMessages.add(messageIdentity);
      }
      assertApprovalCheckpointAckJson({
        filePath: ackPath,
        label: ackLabel,
        record: await readJsonObject(
          params.owner,
          path.relative(params.outputDir, ackPath),
          ackLabel,
        ),
        scenarioId,
        screenshotPath,
        state,
      });
      await assertNonEmptyFile(
        params.owner,
        path.relative(params.outputDir, screenshotPath),
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
}

async function readRemoteMetadata(
  owner: ArtifactRoot,
): Promise<SlackDesktopRemoteMetadata | undefined> {
  const metadataPath = "remote-metadata.json";
  if (!(await owner.exists(metadataPath))) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(await owner.readText(metadataPath));
    if (!isRecord(parsed)) {
      return undefined;
    }
    const candidate = parsed;
    return {
      gatewayAlive:
        typeof candidate.gatewayAlive === "boolean" ? candidate.gatewayAlive : undefined,
      gatewayPid: typeof candidate.gatewayPid === "string" ? candidate.gatewayPid : undefined,
      hydrateMode: typeof candidate.hydrateMode === "string" ? candidate.hydrateMode : undefined,
      openedUrl: typeof candidate.openedUrl === "string" ? candidate.openedUrl : undefined,
      qaExitCode: typeof candidate.qaExitCode === "number" ? candidate.qaExitCode : undefined,
    };
  } catch {
    return undefined;
  }
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
    readMetadata: () => readRemoteMetadata(evidence),
    assertScreenshot: () =>
      assertNonEmptyFile(evidence, "slack-desktop-smoke.png", "Slack desktop screenshot"),
    hasVideo: async () =>
      (await evidence.exists("slack-desktop-smoke.mp4")) &&
      (await evidence.stat("slack-desktop-smoke.mp4")).isFile,
    collectCheckpoints: () =>
      collectApprovalCheckpointArtifacts({
        owner: evidence,
        enabled: params.approvalCheckpoints,
        outputDir: params.outputDir,
        scenarioIds: params.scenarioIds,
      }),
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
