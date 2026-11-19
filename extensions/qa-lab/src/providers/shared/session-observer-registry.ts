export const QA_SESSION_OBSERVER_HEADER = "x-openclaw-qa-session-observer";

const sessionObservers = new Map<string, string>();

function providerEndpoint(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function registerQaSessionObserver(baseUrl: string, sessionObserverUrl: string): () => void {
  const endpoint = providerEndpoint(baseUrl);
  sessionObservers.set(endpoint, sessionObserverUrl);
  return () => {
    sessionObservers.delete(endpoint);
  };
}

export function resolveQaSessionObserverUrl(providerBaseUrl: string): string | undefined {
  return sessionObservers.get(providerEndpoint(providerBaseUrl));
}
