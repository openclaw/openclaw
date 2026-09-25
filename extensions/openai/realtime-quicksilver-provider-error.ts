import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

type OpenAIQuicksilverProviderErrorHandling = {
  fatalAuth: boolean;
  ready: boolean;
  failStartup: () => void;
  failAuthentication: () => void;
  reportEvent: () => void;
  reportError: () => void;
  logger?: Pick<PluginLogger, "warn">;
};

export function handleOpenAIQuicksilverProviderError({
  fatalAuth,
  ready,
  failStartup,
  failAuthentication,
  reportEvent,
  reportError,
  logger,
}: OpenAIQuicksilverProviderErrorHandling): void {
  if (fatalAuth) {
    if (!ready) {
      failStartup();
    } else {
      failAuthentication();
    }
    return;
  }
  reportEvent();
  if (!ready) {
    (logger?.warn ?? console.warn)(
      "OpenAI GPT-Live provider error before session startup; continuing readiness",
    );
    return;
  }
  reportError();
}
