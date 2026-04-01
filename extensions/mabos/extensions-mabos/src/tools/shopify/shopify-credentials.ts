/**
 * Shopify credential resolution.
 *
 * Reads SHOPIFY_STORE + SHOPIFY_ACCESS_TOKEN from environment variables.
 */

export type ShopifyCredentials = {
  accessToken: string;
  shop: string;
};

export async function resolveShopifyCredentials(): Promise<ShopifyCredentials | null> {
  const envToken = process.env.SHOPIFY_ACCESS_TOKEN;
  const envStore = process.env.SHOPIFY_STORE;
  if (envToken && envStore) {
    return { accessToken: envToken, shop: envStore };
  }

  return null;
}
