import type { EmbeddedRunAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAppServerClient } from "./client.js";
import { fingerprintCodexModelCatalogAttemptAuthority } from "./thread-fingerprints.js";

type StartupModelCatalogAuthorityParams = {
  appServer: { requestTimeoutMs: number };
  assertCurrent?: () => void;
  assertNativeModelSelectionCurrent?: EmbeddedRunAttemptParamsV2["assertNativeModelSelectionCurrent"];
  startupAuthBindingFingerprint: string | undefined;
};

/** Bind selected native model authority after the prepared login's delayed account update. */
export async function bindCodexModelCatalogAttemptAuthority(
  client: CodexAppServerClient,
  params: StartupModelCatalogAuthorityParams,
  signal: AbortSignal,
): Promise<void> {
  const assertSelectionCurrent = params.assertNativeModelSelectionCurrent;
  const authBindingFingerprint = params.startupAuthBindingFingerprint;
  if (!assertSelectionCurrent || !authBindingFingerprint) {
    return;
  }
  await client.request(
    "account/read",
    { refreshToken: false },
    {
      timeoutMs: params.appServer.requestTimeoutMs,
      signal,
      assertCurrent: params.assertCurrent,
    },
  );
  params.assertCurrent?.();
  assertSelectionCurrent({
    phase: "bind",
    authBindingFingerprint,
    attemptFingerprint: fingerprintCodexModelCatalogAttemptAuthority({
      clientInstanceId: client.getInstanceId(),
      modelCatalogRevision: client.getModelCatalogRevision(),
    }),
  });
}
