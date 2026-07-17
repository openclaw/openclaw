// Nostr relay publishing keeps connection and publish failures rejectable.
import type { Event, SimplePool } from "nostr-tools";

export async function publishNostrEventToRelay(
  pool: SimplePool,
  relay: string,
  event: Event,
): Promise<string> {
  // SimplePool.publish resolves connection failures as strings, which makes failed
  // relays look successful to callers and prevents sequential failover.
  const connection = await pool.ensureRelay(relay, {
    connectionTimeout: pool.maxWaitForConnection,
  });
  return await connection.publish(event);
}
