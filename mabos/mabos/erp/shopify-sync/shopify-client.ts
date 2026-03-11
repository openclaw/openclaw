/**
 * Shopify Admin API client — cursor-paginated fetcher.
 * Reuses SHOPIFY_STORE + SHOPIFY_ACCESS_TOKEN env vars (same as brand-config.ts).
 */

const API_VERSION = "2024-01";

function getCredentials() {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!store || !token) {
    throw new Error("SHOPIFY_STORE and SHOPIFY_ACCESS_TOKEN env vars are required");
  }
  return { store, token };
}

function baseUrl(): string {
  const { store } = getCredentials();
  return `https://${store}/admin/api/${API_VERSION}`;
}

function headers(): Record<string, string> {
  const { token } = getCredentials();
  return { "X-Shopify-Access-Token": token, "Content-Type": "application/json" };
}

/**
 * Parse Shopify Link header for cursor-based pagination.
 * Returns the next page URL or null.
 */
function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

/**
 * Fetch all pages from a Shopify REST Admin endpoint.
 * Handles Link-header cursor pagination automatically.
 */
export async function fetchAllPages<T>(path: string, key: string, limit = 250): Promise<T[]> {
  const all: T[] = [];
  let url: string | null = `${baseUrl()}${path}${path.includes("?") ? "&" : "?"}limit=${limit}`;

  while (url) {
    const resp = await fetch(url, { headers: headers() });
    if (!resp.ok) {
      throw new Error(`Shopify API error ${resp.status}: ${await resp.text()}`);
    }
    const data = (await resp.json()) as Record<string, T[]>;
    const items = data[key] ?? [];
    all.push(...items);
    url = parseNextLink(resp.headers.get("link"));
  }

  return all;
}

/**
 * Fetch a single resource from Shopify.
 */
export async function fetchOne<T>(path: string, key: string): Promise<T | null> {
  const resp = await fetch(`${baseUrl()}${path}`, { headers: headers() });
  if (!resp.ok) return null;
  const data = (await resp.json()) as Record<string, T>;
  return data[key] ?? null;
}

/**
 * Fetch inventory levels for a batch of inventory item IDs.
 * Shopify limits to 50 IDs per request.
 */
export async function fetchInventoryLevels(
  inventoryItemIds: number[],
): Promise<Array<{ inventory_item_id: number; location_id: number; available: number | null }>> {
  const results: Array<{
    inventory_item_id: number;
    location_id: number;
    available: number | null;
  }> = [];

  for (let i = 0; i < inventoryItemIds.length; i += 50) {
    const batch = inventoryItemIds.slice(i, i + 50);
    const ids = batch.join(",");
    const resp = await fetch(
      `${baseUrl()}/inventory_levels.json?inventory_item_ids=${ids}&limit=250`,
      { headers: headers() },
    );
    if (!resp.ok) {
      console.warn(`Inventory levels fetch failed for batch ${i}: ${resp.status}`);
      continue;
    }
    const data = (await resp.json()) as {
      inventory_levels: Array<{
        inventory_item_id: number;
        location_id: number;
        available: number | null;
      }>;
    };
    results.push(...(data.inventory_levels ?? []));
  }

  return results;
}

/**
 * Fetch all Shopify locations.
 */
export async function fetchLocations(): Promise<
  Array<{ id: number; name: string; address1: string; city: string; country: string }>
> {
  const resp = await fetch(`${baseUrl()}/locations.json`, { headers: headers() });
  if (!resp.ok) return [];
  const data = (await resp.json()) as {
    locations: Array<{ id: number; name: string; address1: string; city: string; country: string }>;
  };
  return data.locations ?? [];
}
