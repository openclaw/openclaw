import path from "node:path";
import { resolveCodexAppServerLocalHomeDir } from "./auth-start-options.js";
import { readCodexClientSessionMeta } from "./client-runtime.js";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import { isJsonObject, type CodexDynamicToolSpec } from "./protocol.js";
import type { CodexBindingAuthority, CodexAppServerThreadBinding } from "./session-binding.js";
import {
  areCodexDynamicToolFingerprintsCompatible,
  codexDynamicToolsFingerprint,
  codexLegacyDynamicToolsFingerprint,
} from "./thread-fingerprints.js";
import { parseCodexToolDeclarations } from "./tool-declarations.js";

export function hasCodexNativeToolCatalog(
  binding: CodexAppServerThreadBinding | undefined,
): binding is CodexAppServerThreadBinding {
  return binding?.connectionScope === "supervision" && !binding.pendingSupervisionBranch;
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
  const tools = parseCodexToolDeclarations(metadata.dynamic_tools ?? [], fail);
  if (
    fingerprint !== undefined &&
    !areCodexDynamicToolFingerprintsCompatible({
      previous: fingerprint,
      next: codexDynamicToolsFingerprint(tools),
      nextLegacy: codexLegacyDynamicToolsFingerprint(tools),
    })
  ) {
    throw fail();
  }
  return tools;
}

/** Exact native binding metadata identifies declarations, never execution authority. */
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
  const actualHome = client.getRuntimeIdentity()?.codexHome;
  if (
    binding.pendingSupervisionBranch ||
    !binding.dynamicToolsFingerprint ||
    (appServer.start.transport !== "stdio" && appServer.start.transport !== "unix") ||
    appServer.remoteWorkspaceRoot ||
    !actualHome ||
    path.resolve(actualHome) !== path.resolve(home) ||
    binding.appServerRuntimeFingerprint !==
      buildCodexAppServerConnectionFingerprint(appServer, agentDir)
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
