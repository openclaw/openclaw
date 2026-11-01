import path from "node:path";
import { resolveCodexAppServerLocalHomeDir } from "./auth-start-options.js";
import {
  isCodexAppServerLiveThreadProtected,
  readCodexClientSessionMeta,
} from "./client-runtime.js";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import {
  buildCodexAppServerConnectionFingerprint,
  buildCodexAppServerRuntimeFingerprint,
} from "./plugin-app-cache-key.js";
import {
  isJsonObject,
  type CodexDynamicToolFunctionSpec,
  type CodexDynamicToolSpec,
} from "./protocol.js";
import type { CodexBindingAuthority, CodexAppServerThreadBinding } from "./session-binding.js";
import { retainSharedCodexAppServerClientByInstanceId } from "./shared-client-lifecycle.js";
import { codexDynamicToolsFingerprint } from "./thread-fingerprints.js";

export function hasCodexNativeToolCatalog(
  binding: CodexAppServerThreadBinding | undefined,
): binding is CodexAppServerThreadBinding & { connectionScope: "supervision" } {
  return binding?.connectionScope === "supervision" && !binding.pendingSupervisionBranch;
}

function hasProtectedManagedCatalog(
  binding: CodexAppServerThreadBinding,
  client: CodexAppServerClient,
): boolean {
  return (
    binding.connectionScope !== "supervision" &&
    !binding.pendingSupervisionBranch &&
    binding.clientId === client.getInstanceId() &&
    isCodexAppServerLiveThreadProtected(client, binding.threadId)
  );
}

/** Native declarations outlive a caller's executors while its children still own the parent. */
export async function loadCodexAttemptNativeToolCatalog(
  params: Omit<Parameters<typeof loadCodexNativeToolCatalog>[0], "binding" | "client"> & {
    binding: CodexAppServerThreadBinding | undefined;
    ephemeral?: boolean;
    signal: AbortSignal;
    acquireClient: () => Promise<CodexAppServerClient>;
    releaseClient: (client: CodexAppServerClient) => void | Promise<void>;
  },
): Promise<CodexDynamicToolSpec[] | undefined> {
  const { binding } = params;
  if (!binding) {
    return undefined;
  }
  params.signal.throwIfAborted();
  params.assertCurrent();
  if (hasCodexNativeToolCatalog(binding)) {
    const client = await params.acquireClient();
    try {
      return await loadCodexNativeToolCatalog({ ...params, binding, client });
    } finally {
      await params.releaseClient(client);
    }
  }
  // Managed ephemeral threads have no rollout. Their retained live owner already
  // enforces creation-policy stability without recovering declarations from disk.
  // Restricted discovery threads may not have accepted a turn or materialized
  // metadata yet; the lifecycle owns their transition to a normal conversation.
  if (
    binding.restrictedThreadConfigFingerprint ||
    params.ephemeral ||
    (params.appServer.start.transport !== "stdio" && params.appServer.start.transport !== "unix") ||
    params.appServer.remoteWorkspaceRoot
  ) {
    return undefined;
  }
  const retained = await retainSharedCodexAppServerClientByInstanceId(binding.clientId, {
    signal: params.signal,
    waitForExit: false,
  });
  try {
    params.signal.throwIfAborted();
    params.assertCurrent();
    if (!retained || !hasProtectedManagedCatalog(binding, retained.client)) {
      return undefined;
    }
    return await loadCodexNativeToolCatalog({ ...params, binding, client: retained.client });
  } finally {
    await retained?.release();
  }
}

/** Pinned serde omits empty catalogs and false deferLoading; declarations remain native-owned. */
export function parseCodexNativeToolCatalog(
  metadata: unknown,
  threadId: string,
  fingerprint?: string,
): CodexDynamicToolSpec[] {
  const fail = () =>
    new Error(
      "The saved Codex native tool catalog is missing, corrupt, or changed; the thread is preserved. Reconnect and inspect its native metadata before retrying.",
    );
  if (!isJsonObject(metadata) || metadata.id !== threadId) {
    throw fail();
  }
  const catalog = metadata.dynamic_tools ?? [];
  if (!Array.isArray(catalog) || Buffer.byteLength(JSON.stringify(catalog)) > 1024 * 1024) {
    throw fail();
  }
  const names = new Set<string>();
  const namespaces = new Set<string>();
  const validName = (name: unknown): name is string =>
    typeof name === "string" && /^[a-zA-Z0-9_-]{1,128}$/u.test(name);
  const readFunction = (value: unknown): CodexDynamicToolFunctionSpec => {
    if (
      !isJsonObject(value) ||
      value.type !== "function" ||
      !validName(value.name) ||
      typeof value.description !== "string" ||
      !isJsonObject(value.inputSchema) ||
      (value.deferLoading !== undefined && typeof value.deferLoading !== "boolean") ||
      Object.keys(value).some(
        (key) => !["type", "name", "description", "inputSchema", "deferLoading"].includes(key),
      ) ||
      names.has(value.name) ||
      names.size >= 2000
    ) {
      throw fail();
    }
    names.add(value.name);
    return {
      type: "function",
      name: value.name,
      description: value.description,
      inputSchema: value.inputSchema,
      ...(value.deferLoading === true ? { deferLoading: true } : {}),
    };
  };
  const tools = catalog.map((value): CodexDynamicToolSpec => {
    if (!isJsonObject(value) || value.type !== "namespace") {
      return readFunction(value);
    }
    if (
      !validName(value.name) ||
      namespaces.has(value.name) ||
      typeof value.description !== "string" ||
      !Array.isArray(value.tools) ||
      !value.tools.length ||
      Object.keys(value).some((key) => !["type", "name", "description", "tools"].includes(key))
    ) {
      throw fail();
    }
    namespaces.add(value.name);
    return {
      type: "namespace",
      name: value.name,
      description: value.description,
      tools: value.tools.map(readFunction),
    };
  });
  if (fingerprint !== undefined && codexDynamicToolsFingerprint(tools) !== fingerprint) {
    throw fail();
  }
  return tools;
}

/** Existing supervised bindings identify data, never authorize an executor or a new adoption. */
export async function loadCodexNativeToolCatalog(params: {
  client: CodexAppServerClient;
  binding: CodexAppServerThreadBinding;
  appServer: CodexAppServerRuntimeOptions;
  agentDir: string;
  assertCurrent: () => void;
  authority?: CodexBindingAuthority;
}): Promise<CodexDynamicToolSpec[]> {
  const { binding, client, appServer, agentDir, assertCurrent } = params;
  assertCurrent();
  const home = resolveCodexAppServerLocalHomeDir(appServer.start, agentDir);
  const runtimeIdentity = client.getRuntimeIdentity();
  const actualHome = runtimeIdentity?.codexHome;
  const runtimeFingerprint =
    binding.connectionScope === "supervision"
      ? buildCodexAppServerConnectionFingerprint(appServer, agentDir)
      : buildCodexAppServerRuntimeFingerprint({
          appServer,
          appServerVersion: client.getServerVersion(),
          runtimeIdentity,
        });
  if (
    (!hasCodexNativeToolCatalog(binding) && !hasProtectedManagedCatalog(binding, client)) ||
    !binding.dynamicToolsFingerprint ||
    (appServer.start.transport !== "stdio" && appServer.start.transport !== "unix") ||
    appServer.remoteWorkspaceRoot ||
    !actualHome ||
    path.resolve(actualHome) !== path.resolve(home) ||
    binding.appServerRuntimeFingerprint !== runtimeFingerprint
  ) {
    throw new Error(
      "Saved Codex declarations require the original verified local binding and selected native connection; the thread is preserved.",
    );
  }
  const metadata = await readCodexClientSessionMeta(
    client,
    path.join(home, "sessions"),
    binding.rolloutPath,
    binding.threadId,
  );
  const consume = () => {
    assertCurrent();
    return parseCodexNativeToolCatalog(metadata, binding.threadId, binding.dynamicToolsFingerprint);
  };
  return params.authority ? await params.authority.withCurrent(consume) : consume();
}
