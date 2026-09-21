import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createStagedInputPathMatcher, root } from "openclaw/plugin-sdk/file-access-runtime";
import {
  readMediaBuffer,
  resolveMediaBufferPath,
  saveMediaBuffer,
} from "openclaw/plugin-sdk/media-store";
import { AgentsApiClient, type AgentsApiInputFile } from "./agentsapi-client.js";

const maxFileBytes = 5 * 1024 * 1024;
const maxTotalBytes = 10 * 1024 * 1024;
const maxFiles = 50;

/** Only host-prepared attachments are copied into the hosted workspace. */
export async function prepareInputs(
  media: AgentHarnessAttemptParamsV2["media"],
  workspaceDir: string,
  assertCurrent: () => void,
  signal: AbortSignal,
): Promise<{ files: AgentsApiInputFile[]; mappingText: string }> {
  assertCurrent();
  signal.throwIfAborted();
  if ((media?.length ?? 0) > maxFiles) {
    throw new Error("Agents API accepts at most 50 input attachments per turn");
  }
  const files: AgentsApiInputFile[] = [];
  const mapping: { attachment: number; name: string; path: string }[] = [];
  let staged: Awaited<ReturnType<typeof preparedWorkspaceReader>> | undefined;
  let totalBytes = 0;
  for (const [index, fact] of (media ?? []).entries()) {
    assertCurrent();
    signal.throwIfAborted();
    if (
      fact.sizeBytes !== undefined &&
      (!Number.isSafeInteger(fact.sizeBytes) || fact.sizeBytes < 0 || fact.sizeBytes > maxFileBytes)
    ) {
      throw new Error("Agents API input attachment exceeds the 5 MiB file limit");
    }
    const managed = managedMediaIdentity(fact);
    const maxBytes = Math.min(maxFileBytes, maxTotalBytes - totalBytes);
    let saved: Pick<Awaited<ReturnType<typeof readMediaBuffer>>, "buffer" | "path" | "size">;
    if (managed) {
      const resolved = await resolveMediaBufferPath(managed.id, managed.subdir);
      assertCurrent();
      signal.throwIfAborted();
      if (fact.path && path.isAbsolute(fact.path) && path.resolve(fact.path) !== resolved) {
        throw new Error("Agents API input attachment does not match its managed media identity");
      }
      saved = await readMediaBuffer(managed.id, managed.subdir, maxBytes);
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
      const read = await staged.root.read(relativePath, { maxBytes });
      saved = { buffer: read.buffer, path: read.realPath, size: read.buffer.length };
    }
    assertCurrent();
    signal.throwIfAborted();
    totalBytes += saved.size;
    if (totalBytes > maxTotalBytes) {
      throw new Error("Agents API input attachments exceed the 10 MiB total limit");
    }
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
  };
}

/** Reused sessions accept new files only through their connected native environment. */
export async function uploadInputs(
  client: AgentsApiClient,
  remoteSessionId: string,
  files: AgentsApiInputFile[],
  assertCurrent: () => void,
  signal: AbortSignal,
): Promise<void> {
  for (const file of files) {
    assertCurrent();
    signal.throwIfAborted();
    await client.uploadFile(remoteSessionId, file, signal);
    assertCurrent();
  }
}

/** Completed hosted artifacts are immutable; model text never selects a Gateway path. */
export async function collectOutputs(
  client: AgentsApiClient,
  remoteSessionId: string,
  rootTurnId: string,
  assertCurrent: () => void,
  signal: AbortSignal,
): Promise<{
  toolMediaUrls: string[];
  hostOwnedToolMediaUrls: string[];
  toolTrustedLocalMedia?: true;
}> {
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
    const buffer = await client.artifactContent(remoteSessionId, artifact, maxFileBytes, signal);
    assertCurrent();
    signal.throwIfAborted();
    const saved = await saveMediaBuffer(
      buffer,
      undefined,
      "outbound",
      maxFileBytes,
      path.posix.basename(artifact.path),
    );
    assertCurrent();
    signal.throwIfAborted();
    toolMediaUrls.push(saved.path);
  }
  return {
    toolMediaUrls,
    hostOwnedToolMediaUrls: [...toolMediaUrls],
    ...(toolMediaUrls.length ? { toolTrustedLocalMedia: true as const } : {}),
  };
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
