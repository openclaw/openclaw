export const QA_SESSION_OBSERVER_HEADER = "x-openclaw-qa-session-observer";

const sessionObservers = new Map<string, { url: string }>();

function providerEndpoint(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function registerQaSessionObserver(baseUrl: string, sessionObserverUrl: string): () => void {
  const endpoint = providerEndpoint(baseUrl);
  const registration = { url: sessionObserverUrl };
  sessionObservers.set(endpoint, registration);
  return () => {
    if (sessionObservers.get(endpoint) === registration) {
      sessionObservers.delete(endpoint);
    }
  };
}

export function resolveQaSessionObserverUrl(providerBaseUrl: string): string | undefined {
  return sessionObservers.get(providerEndpoint(providerBaseUrl))?.url;
}
