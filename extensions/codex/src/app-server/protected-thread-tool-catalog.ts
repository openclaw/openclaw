import {
  isCodexAppServerLiveThreadClaimed,
  isCodexAppServerLiveThreadProtected,
} from "./client-runtime.js";
import { loadCodexNativeToolCatalog } from "./native-tool-catalog.js";
import type { CodexDynamicToolSpec } from "./protocol.js";
import type { CodexAttemptRuntime } from "./run-attempt-runtime.js";
import {
  releaseLeasedSharedCodexAppServerClient,
  retainSharedCodexAppServerClientByInstanceId,
} from "./shared-client.js";
import {
  areCodexDynamicToolFingerprintsCompatible,
  codexDynamicToolsFingerprint,
  codexLegacyDynamicToolsFingerprint,
} from "./thread-fingerprints.js";
import { readCodexThreadToolCatalog } from "./thread-tool-catalog.js";

/** Native work keeps its acknowledged catalog; fresh executors never inherit authority from it. */
export async function selectCodexProtectedThreadToolCatalog(
  runtime: CodexAttemptRuntime,
  desired: CodexDynamicToolSpec[],
): Promise<CodexDynamicToolSpec[] | undefined> {
  const { connection } = runtime;
  const { mutable, params, runAbortController, agentDir } = connection;
  const binding = mutable.startupBinding;
  if (
    !binding ||
    areCodexDynamicToolFingerprintsCompatible({
      previous: binding.dynamicToolsFingerprint,
      next: codexDynamicToolsFingerprint(desired),
      nextLegacy: codexLegacyDynamicToolsFingerprint(desired),
    })
  ) {
    return undefined;
  }
  const owner = await retainSharedCodexAppServerClientByInstanceId(binding.clientId, {
    signal: runAbortController.signal,
    waitForExit: false,
  });
  const client =
    owner?.client ??
    (await connection.attemptClientFactory({
      assertCurrent: connection.assertLegacyCurrent,
      startOptions: connection.appServer.start,
      authProfileId: connection.startupClientAuthProfileId,
      agentDir,
      config: params.config,
      timeoutMs: connection.appServer.requestTimeoutMs,
    }));
  try {
    runAbortController.signal.throwIfAborted();
    connection.assertCurrent();
    if (
      !isCodexAppServerLiveThreadClaimed(client, binding.threadId) &&
      !isCodexAppServerLiveThreadProtected(client, binding.threadId)
    ) {
      return undefined;
    }
    // Older managed bindings have no host snapshot. Admit only the exact native
    // declarations from their verified original local home; never guess a catalog.
    return (
      readCodexThreadToolCatalog(binding) ??
      (await loadCodexNativeToolCatalog({
        client,
        binding,
        appServer: connection.appServer,
        agentDir,
        authority: connection.authority,
        assertCurrent: () => {
          runAbortController.signal.throwIfAborted();
          connection.assertCurrent();
        },
      }))
    );
  } finally {
    if (owner) {
      await owner.release();
    } else {
      releaseLeasedSharedCodexAppServerClient(client);
    }
  }
}
