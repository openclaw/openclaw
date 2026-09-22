import { isDeepStrictEqual } from "node:util";
import { isMessageOnlyCodexSourceReply } from "./dynamic-tool-profile.js";
import { hasCodexNativeToolCatalog, loadCodexNativeToolCatalog } from "./native-tool-catalog.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";
import { resolveCodexThreadAgentDir } from "./thread-lifecycle-preflight.js";
import type { CodexStartOrResumeThreadParams } from "./thread-lifecycle-types.js";
import { resolveLegacyCodexMessageCatalog } from "./thread-message-catalog.js";

/** Select persisted native catalog data without changing turn executor authority. */
export async function prepareCodexThreadDynamicCatalog(
  params: CodexStartOrResumeThreadParams,
  binding: CodexAppServerThreadBinding | undefined,
  assert: () => void,
): Promise<void> {
  const previousFingerprint = binding?.dynamicToolsFingerprint;
  if (hasCodexNativeToolCatalog(binding)) {
    // A resumed native catalog is immutable data. Run eligibility only changes
    // the bridge's available executors, never this thread's inherited history.
    const nativeCatalog = await loadCodexNativeToolCatalog({
      client: params.client,
      binding,
      appServer: params.appServer,
      agentDir: resolveCodexThreadAgentDir(params),
      assertCurrent: () => {
        params.signal?.throwIfAborted();
        assert();
      },
    });
    if (!isDeepStrictEqual(params.dynamicTools, nativeCatalog)) {
      throw new Error(
        "Canonical Codex declarations changed after tool preparation; retry the turn on its preserved native thread.",
      );
    }
  }
  // Resume cannot refresh a native catalog. Keep the exact legacy catalog and
  // fingerprint; executor authorization remains independently turn-scoped.
  if (
    !hasCodexNativeToolCatalog(binding) &&
    !isMessageOnlyCodexSourceReply(params.params) &&
    params.params.toolsAllow?.length &&
    params.dynamicTools
  ) {
    params.dynamicTools =
      resolveLegacyCodexMessageCatalog(previousFingerprint, params.dynamicTools) ??
      params.dynamicTools;
  }
}
