import type { DingTalkConfig } from "openclaw/plugin-sdk";
import { formatUnknownError } from "./errors.js";
import { resolveDingTalkCredentials } from "./token.js";

export type ProbeDingTalkResult = {
  ok: boolean;
  error?: string;
  appKey?: string;
};

export async function probeDingTalk(cfg?: DingTalkConfig): Promise<ProbeDingTalkResult> {
  const creds = resolveDingTalkCredentials(cfg);
  if (!creds) {
    return {
      ok: false,
      error: "missing credentials (appKey, appSecret)",
    };
  }

  try {
    // TODO: Implement actual probe logic using DingTalk Stream SDK
    // For now, just verify credentials are present
    return { ok: true, appKey: creds.appKey };
  } catch (err) {
    return {
      ok: false,
      appKey: creds.appKey,
      error: formatUnknownError(err),
    };
  }
}
