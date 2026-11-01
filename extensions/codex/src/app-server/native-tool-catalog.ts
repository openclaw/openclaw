import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { resolveCodexAppServerLocalHomeDir } from "./auth-start-options.js";
import { readCodexClientSessionMeta } from "./client-runtime.js";
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
import { codexDynamicToolsFingerprint } from "./thread-fingerprints.js";
import type { CodexStartOrResumeThreadParams } from "./thread-lifecycle-types.js";

export function hasCodexNativeToolCatalog(
  binding: CodexAppServerThreadBinding | undefined,
): binding is CodexAppServerThreadBinding {
  return binding?.connectionScope === "supervision" && !binding.pendingSupervisionBranch;
}

/** Only a settled foreground binding may keep its immutable catalog after an addition. */
function mayRetainSettledCodexCatalog(binding: CodexAppServerThreadBinding): boolean {
  return (
    !binding.connectionScope &&
    !binding.turnRecovery &&
    binding.dynamicToolHandoff === undefined &&
    !binding.pendingResumeConfiguration &&
    !binding.pendingSupervisionBranch &&
    !binding.preserveNativeModel
  );
}

/** Old names, namespaces, schemas, loading and descriptions must all still be available. */
function codexCurrentCatalogContains(
  old: readonly CodexDynamicToolSpec[],
  current: readonly CodexDynamicToolSpec[],
): boolean {
  const byName = new Map(current.map((spec) => [spec.name, spec]));
  return old.every((before) => {
    const after = byName.get(before.name);
    if (!after || before.type !== after.type) {
      return false;
    }
    if (before.type !== "namespace" || after.type !== "namespace") {
      return isDeepStrictEqual(before, after);
    }
    return (
      before.description === after.description &&
      codexCurrentCatalogContains(before.tools, after.tools)
    );
  });
}

/** Pinned serde omits empty catalogs and false deferLoading; declarations remain native-owned. */
export function parseCodexNativeToolCatalog(
  metadata: unknown,
  threadId: string,
  fingerprint?: string,
): CodexDynamicToolSpec[] {
  const fail = () =>
    new Error(
      "The canonical Codex native tool catalog is missing, corrupt, or changed; the thread is preserved. Reconnect and inspect its native metadata before retrying.",
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
      inputSchema: structuredClone(value.inputSchema),
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
  settledForeground?: true;
}): Promise<CodexDynamicToolSpec[]> {
  const { binding, client, appServer, agentDir, assertCurrent } = params;
  assertCurrent();
  const home = resolveCodexAppServerLocalHomeDir(appServer.start, agentDir);
  const runtimeIdentity = client.getRuntimeIdentity();
  const actualHome = runtimeIdentity?.codexHome;
  const settled = params.settledForeground === true && mayRetainSettledCodexCatalog(binding);
  const expectedFingerprint = settled
    ? buildCodexAppServerRuntimeFingerprint({
        appServer,
        appServerVersion: client.getServerVersion(),
        runtimeIdentity,
      })
    : buildCodexAppServerConnectionFingerprint(appServer, agentDir);
  if (
    (!settled && !hasCodexNativeToolCatalog(binding)) ||
    !binding.dynamicToolsFingerprint ||
    (appServer.start.transport !== "stdio" && appServer.start.transport !== "unix") ||
    appServer.remoteWorkspaceRoot ||
    !actualHome ||
    path.resolve(actualHome) !== path.resolve(home) ||
    binding.appServerRuntimeFingerprint !== expectedFingerprint
  ) {
    throw new Error(
      "Canonical Codex declarations require the original verified local binding and selected native connection; the thread is preserved.",
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

function readAttemptCatalog(
  params: CodexStartOrResumeThreadParams,
  binding: CodexAppServerThreadBinding,
  agentDir: string,
  settledForeground?: true,
) {
  return loadCodexNativeToolCatalog({
    binding,
    client: params.client,
    appServer: params.appServer,
    authority: params.authority,
    agentDir,
    settledForeground,
    assertCurrent: () => {
      params.signal?.throwIfAborted();
      params.assertCurrent?.();
    },
  });
}

export async function assertCanonicalCodexAttemptCatalog(
  params: CodexStartOrResumeThreadParams,
  binding: CodexAppServerThreadBinding,
  agentDir: string,
) {
  const native = await readAttemptCatalog(params, binding, agentDir);
  if (!isDeepStrictEqual(params.dynamicTools, native)) {
    throw new Error(
      "Canonical Codex declarations changed after tool preparation; retry the turn on its preserved native thread.",
    );
  }
}

export async function retainCompatibleCodexCatalog(
  params: CodexStartOrResumeThreadParams,
  binding: CodexAppServerThreadBinding,
  nextFingerprint: string,
  agentDir: string,
) {
  if (
    !binding.dynamicToolsFingerprint ||
    binding.dynamicToolsFingerprint === nextFingerprint ||
    !mayRetainSettledCodexCatalog(binding) ||
    !params.availableDynamicTools ||
    (params.appServer.start.transport !== "stdio" && params.appServer.start.transport !== "unix") ||
    params.appServer.remoteWorkspaceRoot
  ) {
    return undefined;
  }
  const old = await readAttemptCatalog(params, binding, agentDir, true).catch(() => undefined);
  // An unavailable declaration is an ordinary mismatch. Cancellation or a retired owner is terminal.
  params.signal?.throwIfAborted();
  params.assertCurrent?.();
  return old &&
    codexCurrentCatalogContains(old, params.dynamicTools) &&
    codexCurrentCatalogContains(old, params.availableDynamicTools)
    ? old
    : undefined;
}
