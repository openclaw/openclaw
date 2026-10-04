/**
 * Guards Codex app-server thread reuse during startup by rotating bindings when
 * native transcripts exceed byte or token budgets.
 */
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
const CODEX_APP_SERVER_BYTE_UNITS: Record<string, number> = {
  b: 1,
  k: 1024,
  kb: 1024,
  kib: 1024,
  m: 1024 * 1024,
  mb: 1024 * 1024,
  mib: 1024 * 1024,
  g: 1024 * 1024 * 1024,
  gb: 1024 * 1024 * 1024,
  gib: 1024 * 1024 * 1024,
  t: 1024 * 1024 * 1024 * 1024,
  tb: 1024 * 1024 * 1024 * 1024,
  tib: 1024 * 1024 * 1024 * 1024,
};
type CodexAppServerRolloutFile = {
  path: string;
  bytes: number;
  handle?: Awaited<ReturnType<typeof fs.open>>;
};

function parseCodexAppServerByteLimit(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*([a-z]+)?$/i);
  if (!match) {
    return undefined;
  }
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return undefined;
  }
  const unit = (match[2] ?? "b").toLowerCase();
  const multiplier = CODEX_APP_SERVER_BYTE_UNITS[unit];
  if (multiplier === undefined) {
    return undefined;
  }
  return Math.max(1, Math.round(amount * multiplier));
}

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
      return [{ path: opened.realPath, bytes: opened.stat.size, handle: opened.handle }];
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
        try {
          files.push({ path: file, bytes: (await fs.stat(file)).size });
        } catch {
          // Ignore rollout files that disappeared while the guard was scanning.
        }
      }
    }
  }
  return files;
}

type CodexAppServerRolloutTokenSnapshot = {
  totalTokens?: number;
  modelContextWindow?: number;
};

async function readCodexAppServerRolloutTokenSnapshot(
  file: string,
  openedHandle?: Awaited<ReturnType<typeof fs.open>>,
): Promise<CodexAppServerRolloutTokenSnapshot | undefined> {
  let handle = openedHandle;
  if (!handle) {
    try {
      handle = await fs.open(file, "r");
    } catch {
      return undefined;
    }
  }
  let snapshot: CodexAppServerRolloutTokenSnapshot | undefined;
  try {
    let position = (await handle.stat()).size;
    const partialLineFragments: Buffer[] = [];
    const applySnapshotLine = (line: string): boolean => {
      const lineSnapshot = readCodexAppServerRolloutTokenSnapshotLine(line);
      if (lineSnapshot === undefined) {
        return false;
      }
      snapshot ??= {};
      snapshot.totalTokens ??= lineSnapshot.totalTokens;
      snapshot.modelContextWindow ??= lineSnapshot.modelContextWindow;
      return snapshot.totalTokens !== undefined && snapshot.modelContextWindow !== undefined;
    };

    // Codex appends token snapshots to its rollout. Walk backward so a growing
    // thread does not reparse its entire conversation before every new turn.
    while (position > 0) {
      const bytesToRead = Math.min(position, CODEX_APP_SERVER_ROLLOUT_TAIL_READ_BYTES);
      const nextPosition = position - bytesToRead;
      const chunk = Buffer.allocUnsafe(bytesToRead);
      const bytesRead = await readFileWindowFully(handle, chunk, nextPosition);
      if (bytesRead < bytesToRead) {
        return snapshot;
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
          return snapshot;
        }
        lineEnd = index;
      }
      if (lineEnd > 0) {
        partialLineFragments.push(chunk.subarray(0, lineEnd));
      }
      position = nextPosition;
    }
    if (partialLineFragments.length > 0) {
      applySnapshotLine(Buffer.concat(partialLineFragments.toReversed()).toString("utf8"));
    }
  } finally {
    await handle.close();
  }
  return snapshot;
}

function readCodexAppServerRolloutTokenSnapshotLine(
  line: string,
): CodexAppServerRolloutTokenSnapshot | undefined {
  if (!line.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(line) as JsonValue;
    const payload = isJsonObject(parsed) ? parsed.payload : undefined;
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
    const modelContextWindow =
      typeof windowValue === "number" && Number.isFinite(windowValue) && windowValue > 0
        ? Math.floor(windowValue)
        : undefined;
    const snapshot: CodexAppServerRolloutTokenSnapshot = {};
    if (totalTokens !== undefined) {
      snapshot.totalTokens = totalTokens;
    }
    if (modelContextWindow !== undefined) {
      snapshot.modelContextWindow = modelContextWindow;
    }
    return snapshot.totalTokens !== undefined || snapshot.modelContextWindow !== undefined
      ? snapshot
      : undefined;
  } catch {
    return undefined;
  }
}

function resolveCodexAppServerNativeThreadTokenFuse(params: {
  modelContextWindow: number | undefined;
  reserveTokens: number;
  projectedTurnTokens?: number;
}): number {
  const projectedTurnTokens =
    typeof params.projectedTurnTokens === "number" &&
    Number.isFinite(params.projectedTurnTokens) &&
    params.projectedTurnTokens > 0
      ? Math.floor(params.projectedTurnTokens)
      : 0;
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

/** Clears and drops a binding when the native Codex thread is too large to resume safely. */
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
  const compaction = params.config?.agents?.defaults?.compaction;
  const maxBytes = parseCodexAppServerByteLimit(compaction?.maxActiveTranscriptBytes);
  const shouldDeferByteGuard =
    maxBytes !== undefined &&
    params.contextEngineActive === true &&
    binding.contextEngine?.projection?.mode === "thread_bootstrap";
  if (shouldDeferByteGuard) {
    embeddedAgentLog.debug(
      "codex app-server deferring native transcript byte guard for context-engine thread bootstrap",
      {
        threadId: binding.threadId,
        engineId: binding.contextEngine?.engineId,
        epoch: binding.contextEngine?.projection?.epoch,
        fingerprint: binding.contextEngine?.projection?.fingerprint,
      },
    );
  } else if (maxBytes !== undefined) {
    const oversizedFiles = rolloutFiles.filter((file) => file.bytes >= maxBytes);
    if (oversizedFiles.length > 0) {
      await Promise.all(
        rolloutFiles.map(async (file) => {
          await file.handle?.close();
        }),
      );
      assertCodexBindingMayBeReplaced(
        binding,
        "rotating an oversized native transcript",
        params.expectedSessionRuntimeOwnership,
      );
      embeddedAgentLog.warn(
        "codex app-server native transcript exceeded active byte limit; starting a fresh thread",
        {
          threadId: binding.threadId,
          maxBytes,
          files: oversizedFiles.map((file) => ({ path: file.path, bytes: file.bytes })),
        },
      );
      return await clearBinding();
    }
  }
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
  return {
    binding,
    ...(nativeModelContextWindow ? { startupContextTokens: nativeModelContextWindow } : {}),
  };
}
