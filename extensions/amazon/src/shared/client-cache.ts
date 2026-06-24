/** Shared lazy client cache keyed by service+region. */
const clients = new Map<string, unknown>();

export function getAwsClient<T>(key: string, factory: () => T): T {
  let client = clients.get(key) as T | undefined;
  if (!client) {
    client = factory();
    clients.set(key, client);
  }
  return client;
}
