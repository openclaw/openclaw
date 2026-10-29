import type { EmbeddedRunAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexStartOrResumeThreadParams } from "./thread-lifecycle-types.js";

export function resolveCodexNativeModelAdmission(
  nativeToolSurfaceEnabled: boolean,
  hostCapabilities: Pick<EmbeddedRunAttemptParamsV2["hostCapabilities"], "retainSourceAuthority">,
  hooksEnabled: boolean | undefined,
): CodexStartOrResumeThreadParams["nativeModelAdmission"] {
  if (!nativeToolSurfaceEnabled || !hostCapabilities.retainSourceAuthority) {
    return undefined;
  }
  const source = hostCapabilities.retainSourceAuthority();
  try {
    // Private completions keep optional hooks without inheriting the owner's source grant.
    return source && source.modelPolicyRequired !== false
      ? "required"
      : hooksEnabled === false
        ? "disabled"
        : "optional";
  } finally {
    source?.release();
  }
}
