import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import type { OAuthCredentials } from "openclaw/plugin-sdk/provider-oauth-runtime";
import { ensureGlobalUndiciEnvProxyDispatcher } from "openclaw/plugin-sdk/runtime-env";
import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";
import { loginOpenAICodex } from "./openai-chatgpt-oauth-flow.runtime.js";

// Setup screens show these to people who never saw a redirect URL: say what to copy, not why.
const manualInputPromptMessage = "Paste the address from your browser's address bar:";
const callbackStillOpenMessage =
  "Signed in, but nothing happened? Paste the address from your browser's address bar.";
const callbackUnavailableMessage =
  "Sign in in your browser, then paste the address from its address bar.";
const localManualFallbackDelayMs = 15_000;
const localManualFallbackGraceMs = 1_000;

export async function loginOpenAICodexOAuth(params: {
  prompter: ProviderAuthContext["prompter"];
  runtime: ProviderAuthContext["runtime"];
  oauth: ProviderAuthContext["oauth"];
  isRemote: boolean;
  openUrl: (url: string) => Promise<void>;
  signal?: AbortSignal;
  assertCurrent?: () => void;
  onManualCodeInput?: () => Promise<string>;
  localBrowserMessage?: string;
}): Promise<OAuthCredentials | null> {
  const { prompter, runtime, isRemote, openUrl, localBrowserMessage } = params;

  ensureGlobalUndiciEnvProxyDispatcher();

  const spin = prompter.progress("Starting sign-in…");
  let progressActive = true;
  let manualEntryOffered = false;
  const stopProgress = (message?: string) => {
    if (progressActive) {
      progressActive = false;
      spin.stop(message);
    }
  };
  let markLoginSettled!: () => void;
  const waitForLoginToSettle = new Promise<void>((resolve) => {
    markLoginSettled = resolve;
  });
  const manualPromptAbort = new AbortController();
  try {
    const { onAuth, onPrompt } = params.oauth.createVpsAwareHandlers({
      isRemote,
      prompter,
      runtime,
      spin,
      openUrl,
      localBrowserMessage: localBrowserMessage ?? "Sign in to ChatGPT in your browser…",
      manualPromptMessage: manualInputPromptMessage,
      manualPromptSignal: manualPromptAbort.signal,
    });
    const promptForManualCode = () => onPrompt({ message: manualInputPromptMessage });
    // Setup apps show only the newest step, so the reason belongs in the prompt itself.
    const offerManualEntry = async (message: string) => {
      stopProgress();
      manualEntryOffered = true;
      return await onPrompt({ message });
    };

    const runLocalManualFallback = async (callback: { listening: boolean }) => {
      if (!callback.listening) {
        return await offerManualEntry(callbackUnavailableMessage);
      }
      for (const delayMs of [localManualFallbackDelayMs, localManualFallbackGraceMs]) {
        const outcome = await raceWithTimeout(
          waitForLoginToSettle.then(
            () => "settled" as const,
            () => "settled" as const,
          ),
          delayMs,
          () => "delay" as const,
        );
        if (outcome === "settled") {
          return await new Promise<string>(() => {});
        }
      }
      // The browser callback keeps racing this prompt, so sign-in may still finish on its own.
      return await offerManualEntry(callbackStillOpenMessage);
    };
    const creds = await loginOpenAICodex({
      onAuth,
      // A failure reason still reaches the paste prompt after the progress line ended.
      onProgress: (message, reason) => {
        if (progressActive || reason) {
          spin.update(message, reason);
        }
      },
      onManualCodeInput:
        params.onManualCodeInput ?? (isRemote ? promptForManualCode : runLocalManualFallback),
      signal: params.signal,
      assertCurrent: params.assertCurrent,
    });
    stopProgress("OpenAI OAuth complete");
    if (manualEntryOffered) {
      // The progress line already ended at the offer; close the prompt before confirming.
      manualPromptAbort.abort();
      runtime.log("OpenAI OAuth complete");
    }
    return creds;
  } finally {
    stopProgress();
    manualPromptAbort.abort();
    markLoginSettled();
  }
}
