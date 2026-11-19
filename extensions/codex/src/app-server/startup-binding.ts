import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  isPathStrictlyInside,
  readFileWindowFully,
  root as openSafeFilesystemRoot,
} from "openclaw/plugin-sdk/file-access-runtime";
import { floorPositiveFiniteNumber } from "openclaw/plugin-sdk/number-runtime";
import { resolveCodexAppServerHomeDir } from "./auth-bridge.js";
import { resolveProjectionPromptBudgetTokens } from "./context-engine-projection.js";
import { isJsonObject, type JsonValue } from "./protocol.js";
import {
  assertCodexBindingMayBeReplaced,
  type CodexBindingAuthority,
  type CodexAppServerBindingIdentity,
  type CodexAppServerBindingStore,
  type CodexAppServerThreadBinding,
} from "./session-binding.js";

// Codex owns proactive auto-compaction, but OpenClaw must not resume a native
// thread that is already too close to the server-side window for the next turn.
const CODEX_APP_SERVER_NATIVE_THREAD_FALLBACK_MAX_TOKENS = 300_000;
const CODEX_APP_SERVER_NATIVE_THREAD_DEFAULT_RESERVE_TOKENS = 20_000;
const CODEX_APP_SERVER_ROLLOUT_TAIL_READ_BYTES = 64 * 1024;
type CodexAppServerRolloutFile = {
  path: string;
  handle?: Awaited<ReturnType<typeof fs.open>>;
};

async function listCodexAppServerRolloutFilesForThread(
  agentDir: string,
  threadId: string,
  codexHome?: string,
  rolloutPath?: string,
): Promise<CodexAppServerRolloutFile[]> {
  const resolvedAgentDir = path.resolve(agentDir);
  const resolvedCodexHome = codexHome?.trim()
    ? path.resolve(codexHome)
    : resolveCodexAppServerHomeDir(resolvedAgentDir);
  const roots = [
    path.join(resolvedCodexHome, "sessions"),
    path.join(resolveCodexAppServerHomeDir(resolvedAgentDir), "sessions"),
    path.join(resolvedAgentDir, "agent", "codex-home", "sessions"),
    path.join(path.dirname(resolvedAgentDir), "codex-home", "sessions"),
  ];
  const rolloutRoot = rolloutPath
    ? roots.find((root) => isPathStrictlyInside(root, rolloutPath))
    : undefined;
  if (
    rolloutPath &&
    rolloutRoot &&
    path.isAbsolute(rolloutPath) &&
    path.extname(rolloutPath) === ".jsonl" &&
    path.basename(rolloutPath).includes(threadId)
  ) {
    try {
      // Pin the verified descriptor: lexical checks or realpath followed by
      // another open would allow a symlinked parent to escape the native root.
      const safeRoot = await openSafeFilesystemRoot(rolloutRoot, {
        hardlinks: "reject",
        // Tail reads stay bounded; the default 16 MiB whole-file cap would
        // send large native rollouts back through recursive discovery.
        maxBytes: Number.MAX_SAFE_INTEGER,
        symlinks: "reject",
      });
      const opened = await safeRoot.open(path.relative(rolloutRoot, rolloutPath));
      return [{ path: opened.realPath, handle: opened.handle }];
    } catch {
      // Older Codex servers and moved rollouts still need root-scoped discovery.
    }
  }
  const files: CodexAppServerRolloutFile[] = [];
  for (const root of new Set(roots)) {
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop();
      if (!dir) {
        continue;
      }
      let entries: Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(file);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".jsonl") || !entry.name.includes(threadId)) {
          continue;
        }
        files.push({ path: file });
      }
    }
  }
  return files;
}

type CodexAppServerRolloutTokenSnapshot = {
  totalTokens?: number;
  modelContextWindow?: number;
  observedInputTokens?: number;
  // A turn started after the latest window was reported and never reported its own.
  windowSupersededByNewerTurn?: boolean;
};

async function readCodexAppServerRolloutTokenSnapshot(
  file: string,
  openedHandle?: Awaited<ReturnType<typeof fs.open>>,
): Promise<CodexAppServerRolloutTokenSnapshot | undefined> {
  let handle = openedHandle;
  try {
    handle ??= await fs.open(file, "r");
  } catch {
    return undefined;
  }
  let snapshot: CodexAppServerRolloutTokenSnapshot | undefined;
  try {
    let position = (await handle.stat()).size;
    const partialLineFragments: Buffer[] = [];
    let completedTurnId: string | undefined;
    let observedResponse = false;
    let confirmedInputTokens: number | undefined;
    const hasTokenSnapshot = () =>
      snapshot?.totalTokens !== undefined && snapshot.modelContextWindow !== undefined;
    const applySnapshotLine = (line: string): boolean => {
      const record = readCodexAppServerRolloutRecord(line);
      const payload = isJsonObject(record?.payload) ? record.payload : undefined;
      if (payload?.type === "task_complete" && typeof payload.turn_id === "string" && !snapshot) {
        completedTurnId ??= payload.turn_id;
      }
      if (
        record?.type === "turn_context" ||
        payload?.type === "task_started" ||
        payload?.type === "turn_aborted"
      ) {
        completedTurnId = undefined;
        observedResponse = false;
      }
      const lineSnapshot = readCodexAppServerRolloutTokenSnapshotLine(record);
      if (lineSnapshot === undefined) {
        if (
          completedTurnId &&
          snapshot?.observedInputTokens &&
          record?.type === "token_usage_record"
        ) {
          observedResponse =
            payload?.turn_id === completedTurnId &&
            isJsonObject(payload?.usage) &&
            payload.usage.input_tokens === snapshot.observedInputTokens;
          if (!observedResponse) {
            completedTurnId = undefined;
          }
        } else if (record?.type === "response_item" || record?.type === "compacted") {
          // A standalone compaction response is measured too, but did not
          // necessarily carry the model's eager tool catalog.
          if (
            observedResponse &&
            payload?.role === "assistant" &&
            payload.phase === "final_answer"
          ) {
            confirmedInputTokens = snapshot?.observedInputTokens;
          }
          observedResponse = false;
          completedTurnId = undefined;
        }
        return hasTokenSnapshot() && completedTurnId === undefined;
      }
      snapshot ??= {};
      // A newer turn without a window must not borrow an earlier model's observation.
      if (snapshot.modelContextWindow === undefined && lineSnapshot.windowSupersededByNewerTurn) {
        snapshot.windowSupersededByNewerTurn = true;
      }
      snapshot.totalTokens ??= lineSnapshot.totalTokens;
      if (
        snapshot.modelContextWindow === undefined &&
        lineSnapshot.modelContextWindow !== undefined
      ) {
        snapshot.modelContextWindow = lineSnapshot.modelContextWindow;
        snapshot.observedInputTokens = lineSnapshot.observedInputTokens;
      }
      return hasTokenSnapshot() && (!completedTurnId || !snapshot.observedInputTokens);
    };
    const result = () => snapshot && { ...snapshot, observedInputTokens: confirmedInputTokens };

    // Codex appends token snapshots to its rollout. Walk backward so a growing
    // thread does not reparse its entire conversation before every new turn.
    while (position > 0) {
      const bytesToRead = Math.min(position, CODEX_APP_SERVER_ROLLOUT_TAIL_READ_BYTES);
      const nextPosition = position - bytesToRead;
      const chunk = Buffer.allocUnsafe(bytesToRead);
      const bytesRead = await readFileWindowFully(handle, chunk, nextPosition);
      if (bytesRead < bytesToRead) {
        return result();
      }
      let lineEnd = bytesRead;
      // Negative Buffer offsets wrap from the end, so stop when byte zero is consumed.
      while (lineEnd > 0) {
        const index = chunk.lastIndexOf(0x0a, lineEnd - 1);
        if (index < 0) {
          break;
        }
        const lineFragment = chunk.subarray(index + 1, lineEnd);
        const line =
          partialLineFragments.length === 0
            ? lineFragment.toString("utf8")
            : Buffer.concat([lineFragment, ...partialLineFragments.toReversed()]).toString("utf8");
        partialLineFragments.length = 0;
        if (applySnapshotLine(line)) {
          return result();
        }
        lineEnd = index;
      }
      if (lineEnd > 0) {
        partialLineFragments.push(chunk.subarray(0, lineEnd));
      }
      // Observation is optional. It must not extend the rollout scan beyond
      // the chunk that already supplied the rotation facts.
      if (nextPosition > 0 && hasTokenSnapshot()) {
        return result();
      }
      position = nextPosition;
    }
    if (partialLineFragments.length > 0) {
      applySnapshotLine(Buffer.concat(partialLineFragments.toReversed()).toString("utf8"));
    }
    return result();
  } finally {
    await handle.close();
  }
}

function readCodexAppServerRolloutRecord(line: string) {
  if (!line.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(line) as JsonValue;
    return isJsonObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readCodexAppServerRolloutTokenSnapshotLine(
  record: ReturnType<typeof readCodexAppServerRolloutRecord>,
): CodexAppServerRolloutTokenSnapshot | undefined {
  if (record?.type === "turn_context") {
    return { windowSupersededByNewerTurn: true };
  }
  const payload = record?.payload;
  const info =
    isJsonObject(payload) && payload.type === "token_count" && isJsonObject(payload.info)
      ? payload.info
      : undefined;
  if (!info) {
    return undefined;
  }
  const usage = isJsonObject(info.last_token_usage)
    ? info.last_token_usage
    : isJsonObject(info.total_token_usage)
      ? info.total_token_usage
      : undefined;
  const value = usage?.total_tokens ?? usage?.totalTokens;
  const totalTokens = typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const windowValue = info.model_context_window ?? info.modelContextWindow;
  const modelContextWindow = floorPositiveFiniteNumber(windowValue);
  // Codex's local compaction estimate sets input_tokens to zero. The
  // cumulative fallback is useful for rotation, but is not a request sample.
  const observedInputTokens = isJsonObject(info.last_token_usage)
    ? floorPositiveFiniteNumber(info.last_token_usage.input_tokens)
    : undefined;
  return totalTokens !== undefined || modelContextWindow !== undefined
    ? { totalTokens, modelContextWindow, observedInputTokens }
    : undefined;
}

function resolveCodexAppServerNativeThreadTokenFuse(params: {
  modelContextWindow: number | undefined;
  reserveTokens: number;
  projectedTurnTokens?: number;
}): number {
  const projectedTurnTokens = params.projectedTurnTokens ?? 0;
  const contextWindow =
    params.modelContextWindow ?? CODEX_APP_SERVER_NATIVE_THREAD_FALLBACK_MAX_TOKENS;
  const promptBudget = resolveProjectionPromptBudgetTokens({
    contextTokenBudget: contextWindow,
    reserveTokens: params.reserveTokens,
  });
  return Math.max(1, promptBudget - projectedTurnTokens);
}

function maxDefinedNumber(values: Array<number | undefined>): number | undefined {
  const nums = values.filter((value) => value !== undefined);
  return nums.length ? Math.max(...nums) : undefined;
}

export async function rotateOversizedCodexAppServerStartupBinding(params: {
  assertCurrent?: () => void;
  authority?: CodexBindingAuthority;
  binding: CodexAppServerThreadBinding | undefined;
  bindingStore: CodexAppServerBindingStore;
  identity: CodexAppServerBindingIdentity;
  agentDir: string;
  codexHome?: string;
  config: EmbeddedRunAttemptParams["config"] | undefined;
  contextEngineActive?: boolean;
  projectedTurnTokens?: number;
  expectedSessionRuntimeOwnership?: EmbeddedRunAttemptParams["expectedSessionRuntimeOwnership"];
}): Promise<{
  binding: CodexAppServerThreadBinding | undefined;
  startupContextTokens?: number;
  startupObservedInputTokens?: number;
}> {
  const binding = params.binding;
  if (!binding?.threadId) {
    return { binding };
  }
  // Native Codex owns compaction for supervised threads. Clearing this private
  // scope marker would silently move the next turn back to the agent runtime.
  if (binding.connectionScope === "supervision") {
    return { binding };
  }
  const clearBinding = async () => {
    const cleared = await params.bindingStore.mutate(
      params.identity,
      { kind: "clear", threadId: binding.threadId, clientId: binding.clientId },
      params.assertCurrent,
      params.authority,
    );
    if (!cleared) {
      throw new Error(
        "Codex startup binding changed during rotation; retry with its current owner.",
      );
    }
    return { binding: undefined };
  };
  const rolloutFiles = await listCodexAppServerRolloutFilesForThread(
    params.agentDir,
    binding.threadId,
    params.codexHome,
    binding.rolloutPath,
  );
  // Saved rollouts include history that Codex has already compacted. Their disk size
  // is not active context pressure; maxActiveTranscriptBytes bounds fresh-thread seeds.
  const nativeTokenSnapshots = await Promise.all(
    rolloutFiles.map(async (file) =>
      readCodexAppServerRolloutTokenSnapshot(file.path, file.handle),
    ),
  );
  const nativeTokens = maxDefinedNumber(
    nativeTokenSnapshots.map((snapshot) => snapshot?.totalTokens),
  );
  const nativeModelContextWindow = maxDefinedNumber(
    nativeTokenSnapshots.map((snapshot) => snapshot?.modelContextWindow),
  );
  const reserveTokens = CODEX_APP_SERVER_NATIVE_THREAD_DEFAULT_RESERVE_TOKENS;
  const maxTokens = resolveCodexAppServerNativeThreadTokenFuse({
    modelContextWindow: nativeModelContextWindow,
    reserveTokens,
    projectedTurnTokens: params.projectedTurnTokens,
  });
  if (nativeTokens !== undefined && nativeTokens >= maxTokens) {
    assertCodexBindingMayBeReplaced(
      binding,
      "rotating a full native context",
      params.expectedSessionRuntimeOwnership,
    );
    embeddedAgentLog.warn(
      "codex app-server native transcript exceeded active token limit; starting a fresh thread",
      {
        threadId: binding.threadId,
        maxTokens,
        nativeTokens,
        nativeModelContextWindow,
        reserveTokens,
        projectedTurnTokens: params.projectedTurnTokens,
      },
    );
    return await clearBinding();
  }
  const startupObservedInputTokens = maxDefinedNumber(
    nativeTokenSnapshots
      .filter((snapshot) => snapshot?.modelContextWindow === nativeModelContextWindow)
      .map((snapshot) => snapshot?.observedInputTokens),
  );
  return {
    binding,
    ...(nativeModelContextWindow &&
    !nativeTokenSnapshots.some((snapshot) => snapshot?.windowSupersededByNewerTurn)
      ? {
          startupContextTokens: nativeModelContextWindow,
          ...(startupObservedInputTokens ? { startupObservedInputTokens } : {}),
        }
      : {}),
  };
}
