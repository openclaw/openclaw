/**
 * VividWalls Brand Configuration — single source of truth for
 * branding applied to all social posts, ads, and marketing content.
 */

export const BRAND = {
  name: "VividWalls",
  tagline: "Transform your space with art that speaks to your soul.",
  website: "https://vividwalls.co",
  productUrlPattern: "https://vividwalls.co/products/{handle}",
  logo_url: "https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vividwalls-logo.png",

  hashtags: {
    always: ["#VividWalls", "#WallArt", "#HomeDecor"],
    art: ["#ContemporaryArt", "#ArtPrint", "#AbstractArt", "#ModernHome"],
    interiorDesign: ["#InteriorDesign", "#RoomStyling", "#ArtForHome"],
    lifestyle: ["#CozyVibes", "#StylishSpaces", "#ArtMeetsHome"],
  },

  palette: {
    primary: "#0061FF",
    secondary: "#1A1A2E",
    accent: "#E94560",
    background: "#FFFFFF",
    text: "#1A1A2E",
  },

  typography: {
    heading: "Playfair Display",
    body: "Inter",
  },

  templates: {
    socialPost: (product: { title: string; handle: string; price: string; description?: string }) =>
      `${product.description || `Discover "${product.title}" — premium wall art that transforms any space.`}\n\nStarting at $${product.price}\nShop now: https://vividwalls.co/products/${product.handle}\n\n${["#VividWalls", "#WallArt", "#HomeDecor", "#InteriorDesign", "#ArtPrint", "#ModernHome"].join(" ")}`,

    adCopy: (product: { title: string; handle: string; price: string }) =>
      `Transform your space with "${product.title}" by VividWalls. Premium wall art starting at $${product.price}. Shop now!`,

    instagramCaption: (product: {
      title: string;
      handle: string;
      price: string;
      description?: string;
    }) =>
      `${product.description || `"${product.title}" — art that speaks to your soul.`}\n\nAvailable at $${product.price}. Link in bio or shop: vividwalls.co/products/${product.handle}\n\n${["#VividWalls", "#WallArt", "#ContemporaryArt", "#HomeDecor", "#InteriorDesign", "#ArtPrint", "#AbstractArt", "#ModernHome", "#RoomStyling", "#ArtForHome", "#CozyVibes", "#StylishSpaces"].join(" ")}`,
  },
} as const;

export async function fetchShopifyProduct(handle: string): Promise<{
  id: number;
  title: string;
  handle: string;
  price: string;
  image_url: string;
  images: string[];
  description: string;
} | null> {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!store || !token) return null;

  const resp = await fetch(
    `https://${store}/admin/api/2024-01/products.json?handle=${handle}&fields=id,title,handle,body_html,variants,images`,
    { headers: { "X-Shopify-Access-Token": token } },
  );
  if (!resp.ok) return null;
  const data = (await resp.json()) as any;
  const product = data.products?.[0];
  if (!product) return null;

  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    price: product.variants?.[0]?.price || "50.92",
    image_url: product.images?.[0]?.src || "",
    images: (product.images || []).map((i: any) => i.src),
    description: (product.body_html || "").replace(/<[^>]+>/g, "").slice(0, 200),
  };
}

export async function listShopifyProducts(limit = 50): Promise<
  Array<{
    id: number;
    title: string;
    handle: string;
    price: string;
    image_url: string;
  }>
> {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!store || !token) return [];

  const resp = await fetch(
    `https://${store}/admin/api/2024-01/products.json?limit=${limit}&fields=id,title,handle,variants,images`,
    { headers: { "X-Shopify-Access-Token": token } },
  );
  if (!resp.ok) return [];
  const data = (await resp.json()) as any;
  return (data.products || []).map((p: any) => ({
    id: p.id,
    title: p.title,
    handle: p.handle,
    price: p.variants?.[0]?.price || "50.92",
    image_url: p.images?.[0]?.src || "",
  }));
}
