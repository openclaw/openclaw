import { vi } from "vitest";
import { retainCodexAppServerLiveThread } from "./client-runtime.js";
import type { CodexAppServerClient } from "./client.js";
import * as sessionBinding from "./session-binding.js";

export function retainWarmThread(
  client: CodexAppServerClient,
  binding: { threadId: string; liveThreadConfigFingerprint?: string },
) {
  return retainCodexAppServerLiveThread(
    client,
    binding.threadId,
    undefined,
    binding.liveThreadConfigFingerprint,
  );
}

export function warmPluginConfig(fingerprint: () => string, provisionalAppIds: string[] = []) {
  const inputFingerprint = "stable-plugin-input";
  return {
    enabled: true,
    requiresCurrentPolicyCheck: true,
    inputFingerprint,
    build: async () => ({
      enabled: true,
      fingerprint: fingerprint(),
      inputFingerprint,
      diagnostics: [],
      configPatch: {},
      policyContext: { fingerprint: "empty-app-policy", apps: {}, pluginAppIds: {} },
      provisionalAppIds,
    }),
  };
}

export function failNextWarmPublication(error: Error) {
  const resolveBinding = sessionBinding.resolveCodexSessionBinding;
  return vi
    .spyOn(sessionBinding, "resolveCodexSessionBinding")
    .mockImplementationOnce(async (input) => {
      const resolved = await resolveBinding(input);
      const withCurrent = resolved.authority.withCurrent;
      return {
        ...resolved,
        authority: {
          ...resolved.authority,
          withCurrent: async (consume) => {
            const result = await withCurrent(consume);
            // Fail reader release only after binding publication, not admission.
            if (
              result !== null &&
              typeof result === "object" &&
              "liveThreadOwnership" in result &&
              result.liveThreadOwnership
            ) {
              throw error;
            }
            return result;
          },
        },
      };
    });
}
