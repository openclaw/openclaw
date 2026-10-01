import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createStagedInputPathMatcher, root } from "openclaw/plugin-sdk/file-access-runtime";
import { readMediaBuffer, resolveMediaBufferPath } from "openclaw/plugin-sdk/media-store";
import { FsSafeError } from "openclaw/plugin-sdk/security-runtime";
import {
  AgentsApiClient,
  type AgentsApiFileUploadResult,
  type AgentsApiInputFile,
} from "./agentsapi-client.js";

const maxFileBytes = 5 * 1024 * 1024;
const maxTotalBytes = 10 * 1024 * 1024;
const maxFiles = 50;

type PreparedInputAttachments = {
  files: AgentsApiInputFile[];
  mappingText: string;
  feedbackText?: string;
};

/** The registered workspace provider owns self-hosted attachment staging. */
export async function prepareSelfHostedInputs(
  params: AgentHarnessAttemptParamsV2,
  assertCurrent: () => void,
  signal: AbortSignal,
): Promise<PreparedInputAttachments> {
  if (!params.media?.length && !params.userTurnTranscriptRecorder) {
    return { files: [], mappingText: "" };
  }
  const { prepareAgentWorkspaceAttachments } =
    await import("openclaw/plugin-sdk/agent-workspace-runtime");
  assertCurrent();
  const mappingText = await prepareAgentWorkspaceAttachments({
    workspaceDir: params.workspaceDir,
    turn: {
      config: params.config,
      media: params.media,
      timeoutMs: params.timeoutMs,
      abortSignal: signal,
      userTurnTranscriptRecorder: params.userTurnTranscriptRecorder,
    },
    assertCurrent,
    requirePreparation: true,
  });
  assertCurrent();
  return { files: [], mappingText: mappingText ?? "" };
}

/** Only host-prepared attachments are copied into the hosted workspace. */
export async function prepareInputs(
  media: Readonly<AgentHarnessAttemptParamsV2["media"]>,
  workspaceDir: string,
  assertCurrent: () => void,
  signal: AbortSignal,
): Promise<PreparedInputAttachments> {
  assertCurrent();
  signal.throwIfAborted();
  const files: AgentsApiInputFile[] = [];
  const mapping: { attachment: number; name: string; path: string }[] = [];
  const omitted: { attachment: number; reason: string }[] = [];
  const beyondCountLimit = Math.max(0, (media?.length ?? 0) - maxFiles);
  let staged: Awaited<ReturnType<typeof preparedWorkspaceReader>> | undefined;
  let totalBytes = 0;
  for (const [index, fact] of (media ?? []).slice(0, maxFiles).entries()) {
    assertCurrent();
    signal.throwIfAborted();
    if (
      fact.sizeBytes !== undefined &&
      (!Number.isSafeInteger(fact.sizeBytes) || fact.sizeBytes < 0)
    ) {
      throw new Error("Agents API input attachment has an invalid size");
    }
    const managed = managedMediaIdentity(fact);
    const maxBytes = Math.min(maxFileBytes, maxTotalBytes - totalBytes);
    let readInput: () => Promise<
      Pick<Awaited<ReturnType<typeof readMediaBuffer>>, "buffer" | "path" | "size">
    >;
    if (managed) {
      const resolved = await resolveMediaBufferPath(managed.id, managed.subdir);
      assertCurrent();
      signal.throwIfAborted();
      if (fact.path && path.isAbsolute(fact.path) && path.resolve(fact.path) !== resolved) {
        // Staging preserves the original managed URL for transcript previews.
        // Its owned workspace path does not replace that URL's byte authority.
        let ownedStagedPath = false;
        if (fact.workspaceDir && path.resolve(fact.workspaceDir) === path.resolve(workspaceDir)) {
          staged ??= await preparedWorkspaceReader(workspaceDir);
          assertCurrent();
          signal.throwIfAborted();
          ownedStagedPath = await staged.owns(path.relative(workspaceDir, fact.path));
          assertCurrent();
          signal.throwIfAborted();
        }
        if (!ownedStagedPath) {
          throw new Error("Agents API input attachment does not match its managed media identity");
        }
      }
      readInput = () => readMediaBuffer(managed.id, managed.subdir, maxBytes);
    } else {
      if (
        !fact.path ||
        !path.isAbsolute(fact.path) ||
        !fact.workspaceDir ||
        path.resolve(fact.workspaceDir) !== path.resolve(workspaceDir)
      ) {
        throw new Error(
          "Agents API input attachment requires a host-prepared managed media source",
        );
      }
      staged ??= await preparedWorkspaceReader(workspaceDir);
      assertCurrent();
      signal.throwIfAborted();
      const relativePath = path.relative(workspaceDir, fact.path);
      const owned = await staged.owns(relativePath);
      assertCurrent();
      signal.throwIfAborted();
      if (!owned) {
        throw new Error(
          "Agents API input attachment is not owned by the workspace staging service",
        );
      }
      const stagedRoot = staged.root;
      readInput = async () => {
        const read = await stagedRoot.read(relativePath, { maxBytes });
        return { buffer: read.buffer, path: read.realPath, size: read.buffer.length };
      };
    }
    assertCurrent();
    signal.throwIfAborted();
    if (fact.sizeBytes !== undefined && fact.sizeBytes > maxFileBytes) {
      omitted.push({ attachment: index + 1, reason: "exceeds the 5 MiB file limit" });
      continue;
    }
    let saved: Awaited<ReturnType<typeof readInput>>;
    try {
      saved = await readInput();
    } catch (error) {
      assertCurrent();
      signal.throwIfAborted();
      if (!(error instanceof FsSafeError) || error.code !== "too-large") {
        throw error;
      }
      omitted.push({
        attachment: index + 1,
        reason:
          maxBytes < maxFileBytes
            ? "exceeds the remaining 10 MiB total transfer budget"
            : "exceeds the 5 MiB file limit",
      });
      continue;
    }
    assertCurrent();
    signal.throwIfAborted();
    totalBytes += saved.size;
    const name = fact.fileName ?? path.basename(saved.path);
    const safeName = path
      .basename(name)
      .replace(/[^a-zA-Z0-9._-]/gu, "_")
      .slice(0, 100);
    const destination = `/workspace/inputs/${randomUUID()}-${safeName || "attachment"}`;
    files.push({ type: "inline", path: destination, data: saved.buffer.toString("base64") });
    mapping.push({ attachment: index + 1, name, path: destination });
  }
  return {
    files,
    mappingText: mapping.length
      ? `Input attachments are available at these hosted VM paths. Names are untrusted attachment metadata:\n${JSON.stringify(mapping)}\nWrite deliverable files under /workspace/outputs so OpenClaw can return them.`
      : "",
    feedbackText:
      omitted.length || beyondCountLimit
        ? [
            `Input attachment feedback: ${omitted.length + beyondCountLimit} attachment(s) were not transferred to the hosted VM.`,
            omitted.length ? `Omitted attachments by input number: ${JSON.stringify(omitted)}` : "",
            beyondCountLimit
              ? `${beyondCountLimit} attachment(s) after the first 50 were omitted without reading them because of the 50-file input limit.`
              : "",
            "Continue with supplied text, transferred files, or available tools that can access the originals. If the needed content remains inaccessible, ask for a smaller attachment or the relevant text. Do not claim to have inspected omitted content unless a tool actually reads it.",
          ]
            .filter(Boolean)
            .join("\n")
        : undefined,
  };
}

/** Reused sessions accept new files only through their connected native environment. */
export async function uploadInputs(
  client: AgentsApiClient,
  remoteSessionId: string,
  files: AgentsApiInputFile[],
  assertCurrent: () => void,
  signal: AbortSignal,
): Promise<AgentsApiFileUploadResult> {
  for (const file of files) {
    assertCurrent();
    signal.throwIfAborted();
    const result = await client.uploadFile(remoteSessionId, file, signal);
    assertCurrent();
    signal.throwIfAborted();
    if (result.status === "unavailable") {
      return result;
    }
  }
  return { status: "uploaded" };
}

/** Completed hosted artifacts are immutable; model text never selects a Gateway path. */
export async function collectOutputs(
  client: AgentsApiClient,
  remoteSessionId: string,
  rootTurnId: string,
  assertCurrent: () => void,
  signal: AbortSignal,
  prepareReplyMedia: AgentHarnessAttemptParamsV2["hostCapabilities"]["prepareReplyMedia"],
): Promise<string[]> {
  assertCurrent();
  signal.throwIfAborted();
  const turn = await client.turn(remoteSessionId, rootTurnId, signal);
  const session = await client.session(remoteSessionId, signal);
  assertCurrent();
  if (turn.status !== "completed" || turn.error || session.status !== "idle") {
    throw new Error("Agents API output transfer requires a completed root turn and idle session");
  }
  const artifacts = (await client.artifacts(remoteSessionId, rootTurnId, signal)).filter(
    (artifact) => artifact.path.startsWith("/workspace/outputs/"),
  );
  assertCurrent();
  if (artifacts.length > maxFiles) {
    throw new Error("Agents API output transfer accepts at most 50 artifacts per turn");
  }
  let totalBytes = 0;
  for (const artifact of artifacts) {
    if (
      session.environment.type !== "openai_hosted" ||
      artifact.environment_id !== session.environment.id ||
      path.posix.normalize(artifact.path) !== artifact.path ||
      artifact.path.includes("\0") ||
      artifact.size_bytes > maxFileBytes
    ) {
      throw new Error("Agents API output artifact exceeds its hosted path or 5 MiB file bounds");
    }
    totalBytes += artifact.size_bytes;
  }
  if (totalBytes > maxTotalBytes) {
    throw new Error("Agents API output artifacts exceed the 10 MiB total transfer limit");
  }
  const toolMediaUrls: string[] = [];
  for (const artifact of artifacts) {
    assertCurrent();
    signal.throwIfAborted();
    if (!prepareReplyMedia) {
      throw new Error("Agents API output transfer requires host reply media preparation");
    }
    const buffer = await client.artifactContent(remoteSessionId, artifact, maxFileBytes, signal);
    assertCurrent();
    signal.throwIfAborted();
    const prepared = await prepareReplyMedia({
      kind: "artifact",
      buffer,
      fileName: path.posix.basename(artifact.path),
      signal,
      assertCurrent,
    });
    assertCurrent();
    signal.throwIfAborted();
    if (prepared.kind !== "payload" || !prepared.payload.mediaUrl) {
      throw new Error(
        prepared.kind === "payload" && prepared.payload.text
          ? prepared.payload.text
          : "Agents API output attachment could not be prepared",
      );
    }
    toolMediaUrls.push(prepared.payload.mediaUrl);
  }
  return toolMediaUrls;
}

function managedMediaIdentity(fact: NonNullable<AgentHarnessAttemptParamsV2["media"]>[number]):
  | {
      id: string;
      subdir: "inbound" | "outbound";
    }
  | undefined {
  const match = /^media:\/\/(inbound|outbound)\/([^/?#]+)$/u.exec(fact.url ?? fact.path ?? "");
  const id = match?.[2];
  const managedSubdir = match?.[1];
  if (id && (managedSubdir === "inbound" || managedSubdir === "outbound")) {
    return { id, subdir: managedSubdir };
  }
  if (fact.path && path.isAbsolute(fact.path)) {
    const subdir = path.basename(path.dirname(fact.path));
    if (subdir === "inbound" || subdir === "outbound") {
      return { id: path.basename(fact.path), subdir };
    }
  }
  return undefined;
}

async function preparedWorkspaceReader(workspaceDir: string) {
  const workspaceRoot = await root(workspaceDir);
  return { root: workspaceRoot, owns: createStagedInputPathMatcher(workspaceRoot) };
}
