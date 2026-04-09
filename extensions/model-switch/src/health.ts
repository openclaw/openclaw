import type { ModelEntry, ModelIdentityResult } from "./types.js";

/**
 * Poll a model's health endpoint until it returns HTTP 200 or timeout.
 * Returns true if healthy, false on timeout.
 */
export async function waitForHealth(
  model: ModelEntry,
  opts: { timeoutMs: number; pollIntervalMs: number; signal?: AbortSignal },
): Promise<boolean> {
  const deadline = Date.now() + opts.timeoutMs;

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) {
      return false;
    }
    try {
      const res = await fetch(model.healthUrl, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        return true;
      }
    } catch {
      // Connection refused, timeout, etc. — model not ready yet.
    }
    await sleep(opts.pollIntervalMs);
  }

  return false;
}

/**
 * Verify the active model's identity by checking /v1/models.
 * Returns whether the expected modelIdentifier is found as a substring
 * in any model's id field.
 */
export async function verifyModelIdentity(model: ModelEntry): Promise<ModelIdentityResult> {
  try {
    const res = await fetch(model.identityUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      return { matched: false, foundId: null, expectedIdentifier: model.modelIdentifier };
    }

    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const models = body.data ?? [];

    for (const m of models) {
      if (m.id && m.id.includes(model.modelIdentifier)) {
        return { matched: true, foundId: m.id, expectedIdentifier: model.modelIdentifier };
      }
    }

    const firstId = models[0]?.id ?? null;
    return { matched: false, foundId: firstId, expectedIdentifier: model.modelIdentifier };
  } catch {
    return { matched: false, foundId: null, expectedIdentifier: model.modelIdentifier };
  }
}

/**
 * Detect which registered model is currently active by probing /v1/models.
 * Returns the model ID from the registry, or null if no match.
 */
export async function detectActiveModel(
  models: Record<string, ModelEntry>,
): Promise<string | null> {
  for (const [id, model] of Object.entries(models)) {
    const result = await verifyModelIdentity(model);
    if (result.matched) {
      return id;
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
