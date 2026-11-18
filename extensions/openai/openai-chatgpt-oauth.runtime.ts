import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import type { OAuthCredentials } from "openclaw/plugin-sdk/provider-oauth-runtime";
import { ensureGlobalUndiciEnvProxyDispatcher } from "openclaw/plugin-sdk/runtime-env";
import { formatCliCommand } from "openclaw/plugin-sdk/setup-tools";
import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";
import { loginOpenAICodex } from "./openai-chatgpt-oauth-flow.runtime.js";
import { runOpenAIOAuthTlsPreflight } from "./openai-chatgpt-oauth-preflight.runtime.js";

// Setup screens show these to people who never saw a redirect URL: say what to copy, not why.
const manualInputPromptMessage = "Paste the address from your browser's address bar:";
const callbackStillOpenMessage =
  "Signed in, but nothing happened? Paste the address from your browser's address bar.";
const openAICodexOAuthOriginator = "openclaw";
const callbackUnavailableMessage =
  "Sign in in your browser, then paste the address from its address bar.";
// A normal browser sign-in, including two-factor steps, finishes well inside this window.
const localManualFallbackDelayMs = 60_000;
const localManualFallbackGraceMs = 1_000;
type OpenAICodexOAuthFailureCode = "callback_validation_failed" | "unsupported_region";

function createOpenAICodexOAuthError(
  code: OpenAICodexOAuthFailureCode,
  message: string,
  cause?: unknown,
): Error & { code: OpenAICodexOAuthFailureCode } {
  return Object.assign(new Error(`OpenAI Codex OAuth failed (${code}): ${message}`, { cause }), {
    code,
  });
}

function rewriteOpenAICodexOAuthError(error: unknown): Error {
  const message = formatErrorMessage(error);
  if (/unsupported_country_region_territory/i.test(message)) {
    return createOpenAICodexOAuthError(
      "unsupported_region",
      [
        "OpenAI rejected the token exchange for this country, region, or network route.",
        "If you normally use a proxy, verify HTTPS_PROXY, HTTP_PROXY, or ALL_PROXY is set for the OpenClaw process and then retry `openclaw models auth login --provider openai`.",
      ].join(" "),
      error,
    );
  }
  if (/state mismatch|missing authorization code/i.test(message)) {
    return createOpenAICodexOAuthError("callback_validation_failed", message, error);
  }
  return error instanceof Error ? error : new Error(message);
}

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

  const preflight = await runOpenAIOAuthTlsPreflight({
    signal: params.signal,
    assertCurrent: params.assertCurrent,
  });
  params.assertCurrent?.();
  if (!preflight.ok && preflight.kind === "tls-cert") {
    const execPath = process.execPath;
    const marker = `${path.sep}Cellar${path.sep}`;
    const idx = execPath.indexOf(marker);
    const prefix = idx > 0 ? execPath.slice(0, idx) : process.env.HOMEBREW_PREFIX?.trim() || null;
    const certBundlePath = prefix ? path.join(prefix, "etc", "openssl@3", "cert.pem") : null;
    const lines = [
      "OpenAI OAuth prerequisites check failed: Node/OpenSSL cannot validate TLS certificates.",
      `Cause: ${preflight.code ? `${preflight.code} (${preflight.message})` : preflight.message}`,
      "",
      "Fix (Homebrew Node/OpenSSL):",
      `- ${formatCliCommand("brew postinstall ca-certificates")}`,
      `- ${formatCliCommand("brew postinstall openssl@3")}`,
    ];
    if (certBundlePath) {
      lines.push(`- Verify cert bundle exists: ${certBundlePath}`);
    }
    lines.push("- Retry the OAuth login flow.");
    const hint = lines.join("\n");
    await prompter.note(hint, "OAuth prerequisites");
    runtime.error(hint);
    throw new Error(`OpenAI Codex OAuth prerequisites failed: ${preflight.message}`);
  }

  if (isRemote) {
    // On this computer the browser just opens and finishes sign-in; only a remote host needs a walkthrough.
    await prompter.note(
      [
        "You are running in a remote/VPS environment.",
        "A URL will be shown for you to open in your LOCAL browser.",
        "Open it, sign in, then paste the redirect URL here.",
        "If this OpenClaw process can receive the browser callback, sign-in may finish automatically before you paste.",
      ].join("\n"),
      "OpenAI Codex OAuth",
    );
  }

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
      onPrompt,
      originator: openAICodexOAuthOriginator,
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
    return creds ?? null;
  } catch (err) {
    stopProgress("OpenAI OAuth failed");
    const rewrittenError = rewriteOpenAICodexOAuthError(err);
    runtime.error(String(rewrittenError));
    await prompter.note(
      "Trouble signing in? See https://docs.openclaw.ai/start/faq",
      "Sign-in help",
    );
    throw rewrittenError;
  } finally {
    manualPromptAbort.abort();
    markLoginSettled();
  }
}
