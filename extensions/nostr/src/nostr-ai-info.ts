/**
 * Nostr AI Info (NIP-XX kind:31340)
 *
 * AI info events are replaceable and unencrypted. We publish a canonical
 * capability payload with a fixed d-tag ("agent-info") for stable discovery.
 */

import { createHash } from "node:crypto";
import { finalizeEvent, SimplePool, type Event } from "nostr-tools";

// ============================================================================
// Types
// ============================================================================

export interface AiInfoContent {
  ver: number;
  supports_streaming?: boolean;
  supports_nip59?: boolean;
  dvm_compatible?: boolean;
  encryption?: string[];
  supported_models?: string[];
  default_model?: string;
  tool_names?: string[];
  tool_schema_version?: number;
  max_prompt_bytes?: number;
  max_context_tokens?: number;
  pricing_hints?: {
    currency?: string;
    per_1k_prompt_tokens?: number;
    per_1k_output_tokens?: number;
  };
  personas?: Array<{
    account_id: string;
    pubkey: string;
    name?: string;
    enabled?: boolean;
    configured?: boolean;
    relays?: string[];
    profile?: {
      name?: string;
      display_name?: string;
      picture?: string;
      about?: string;
    };
  }>;
}

export interface AiInfoPublishResult {
  eventId: string;
  successes: string[];
  failures: Array<{ relay: string; error: string }>;
  createdAt: number;
}

// ============================================================================
// Constants
// ============================================================================

const AI_INFO_KIND = 31340;
const AI_INFO_D_TAG = "agent-info";
const RELAY_PUBLISH_TIMEOUT_MS = 5000;

// ============================================================================
// Canonicalization / Fingerprint
// ============================================================================

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortObjectKeys(entry));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    const out: Record<string, unknown> = {};
    for (const [key, child] of entries) {
      out[key] = sortObjectKeys(child);
    }
    return out;
  }
  return value;
}

export function buildAiInfoFingerprint(payload: AiInfoContent): string {
  const canonical = JSON.stringify(sortObjectKeys(payload));
  return createHash("sha256").update(canonical).digest("hex");
}

// ============================================================================
// Event creation / publish
// ============================================================================

export function createAiInfoEvent(
  sk: Uint8Array,
  payload: AiInfoContent,
  lastPublishedAt?: number,
): Event {
  const now = Math.floor(Date.now() / 1000);
  const createdAt = lastPublishedAt !== undefined ? Math.max(now, lastPublishedAt + 1) : now;
  const content = JSON.stringify(sortObjectKeys(payload));

  return finalizeEvent(
    {
      kind: AI_INFO_KIND,
      tags: [["d", AI_INFO_D_TAG]],
      content,
      created_at: createdAt,
    },
    sk,
  );
}

export async function publishAiInfoEvent(
  pool: SimplePool,
  relays: string[],
  event: Event,
): Promise<AiInfoPublishResult> {
  const successes: string[] = [];
  const failures: Array<{ relay: string; error: string }> = [];

  const publishPromises = relays.map(async (relay) => {
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("timeout")), RELAY_PUBLISH_TIMEOUT_MS);
      });

      const publishResult = await pool.publish([relay], event);
      await Promise.race([
        Promise.all(Array.isArray(publishResult) ? publishResult : [publishResult]),
        timeoutPromise,
      ]);
      successes.push(relay);
    } catch (err) {
      failures.push({
        relay,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  await Promise.all(publishPromises);

  return {
    eventId: event.id,
    successes,
    failures,
    createdAt: event.created_at,
  };
}

export async function publishAiInfo(
  pool: SimplePool,
  sk: Uint8Array,
  relays: string[],
  payload: AiInfoContent,
  lastPublishedAt?: number,
): Promise<AiInfoPublishResult> {
  const event = createAiInfoEvent(sk, payload, lastPublishedAt);
  return publishAiInfoEvent(pool, relays, event);
}
