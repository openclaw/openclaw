/**
 * Case-study brand configuration.
 *
 * Defaults are the VividWalls test case, but can be overridden via:
 * - MABOS_BRAND_NAME
 * - MABOS_BRAND_TAGLINE
 * - MABOS_BRAND_WEBSITE
 * - MABOS_BRAND_PRODUCT_URL_PATTERN
 * - MABOS_BRAND_LOGO_URL
 */

const DEFAULT_BRAND_NAME = "VividWalls";
const DEFAULT_BRAND_TAGLINE = "Transform your space with art that speaks to your soul.";
const DEFAULT_BRAND_WEBSITE = "https://vividwalls.co";
const DEFAULT_PRODUCT_URL_PATTERN = "https://vividwalls.co/products/{handle}";
const DEFAULT_LOGO_URL =
  "https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vividwalls-logo.png";

const brandName = process.env.MABOS_BRAND_NAME || DEFAULT_BRAND_NAME;
const brandTagline = process.env.MABOS_BRAND_TAGLINE || DEFAULT_BRAND_TAGLINE;
const brandWebsite = process.env.MABOS_BRAND_WEBSITE || DEFAULT_BRAND_WEBSITE;
const productUrlPattern =
  process.env.MABOS_BRAND_PRODUCT_URL_PATTERN || DEFAULT_PRODUCT_URL_PATTERN;
const brandLogoUrl = process.env.MABOS_BRAND_LOGO_URL || DEFAULT_LOGO_URL;
const brandHashtag = `#${brandName.replace(/[^A-Za-z0-9]/g, "") || "Brand"}`;

function productUrl(handle: string): string {
  return productUrlPattern.replace("{handle}", handle);
}

const alwaysTags = [brandHashtag, "#WallArt", "#HomeDecor"];
const artTags = ["#ContemporaryArt", "#ArtPrint", "#AbstractArt", "#ModernHome"];
const interiorDesignTags = ["#InteriorDesign", "#RoomStyling", "#ArtForHome"];
const lifestyleTags = ["#CozyVibes", "#StylishSpaces", "#ArtMeetsHome"];

export const BRAND = {
  name: brandName,
  tagline: brandTagline,
  website: brandWebsite,
  productUrlPattern,
  logo_url: brandLogoUrl,

  hashtags: {
    always: alwaysTags,
    art: artTags,
    interiorDesign: interiorDesignTags,
    lifestyle: lifestyleTags,
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
      `${product.description || `Discover "${product.title}" — premium wall art that transforms any space.`}\n\nStarting at $${product.price}\nShop now: ${productUrl(product.handle)}\n\n${[...alwaysTags, ...interiorDesignTags, ...artTags].join(" ")}`,

    adCopy: (product: { title: string; handle: string; price: string }) =>
      `Transform your space with "${product.title}" by ${brandName}. Premium wall art starting at $${product.price}. Shop now!`,

    instagramCaption: (product: {
      title: string;
      handle: string;
      price: string;
      description?: string;
    }) =>
      `${product.description || `"${product.title}" — art that speaks to your soul.`}\n\nAvailable at $${product.price}. Link in bio or shop: ${productUrl(product.handle)}\n\n${[...alwaysTags, ...artTags, ...interiorDesignTags, ...lifestyleTags].join(" ")}`,
  },
} as const;

/**
 * Identifies the original printable artwork image from a product's image gallery.
 *
 * Detection strategy (in priority order):
 * 1. Alt text contains "printable" (explicit tagging — preferred)
 * 2. Filename exclusion — the printable is the ONLY image whose filename does NOT
 *    contain marketing-image keywords (Frame, Mockup, Scene, Rolled, HomeOffice, etc.)
 * 3. Falls back to the first image if no printable can be identified.
 *
 * Marketing images follow predictable filename patterns:
 *   - *_NoFrame-*, *_No_Frame-*, *_White-Frame-*, *_WhiteFrame-* (frame mockups)
 *   - HomeOfficeScene*, HomeSceneLivingRoom* (lifestyle scenes)
 *   - Rolled-Canvas-Mockup-* (rolled canvas mockups)
 */
const PRINTABLE_ALT_KEYWORD = "printable";
const MARKETING_FILENAME_PATTERNS = [
  /frame/i,
  /mockup/i,
  /scene/i,
  /rolled/i,
  /homeoffice/i,
  /homescene/i,
  /lifestyle/i,
];

function isPrintableImage(img: { src: string; alt: string | null }): boolean {
  // Priority 1: explicit alt text tagging
  if (img.alt?.toLowerCase().includes(PRINTABLE_ALT_KEYWORD)) return true;
  return false;
}

function isMarketingImage(src: string): boolean {
  const filename = src.split("/").pop()?.split("?")[0] || "";
  return MARKETING_FILENAME_PATTERNS.some((p) => p.test(filename));
}

function findPrintableImage(images: Array<{ src: string; alt: string | null }>): string {
  // Priority 1: explicit alt text tag
  const byAlt = images.find((i) => isPrintableImage(i));
  if (byAlt) return byAlt.src;

  // Priority 2: the image whose filename has NO marketing keywords
  const nonMarketing = images.filter((i) => !isMarketingImage(i.src));
  if (nonMarketing.length === 1) return nonMarketing[0].src;

  // Priority 2b: if multiple non-marketing images, pick the highest resolution
  if (nonMarketing.length > 1) {
    // Shopify CDN URLs don't encode dimensions, so just return the last non-marketing
    // image (printable is typically added after initial mockup images)
    return nonMarketing[nonMarketing.length - 1].src;
  }

  // Fallback: first image
  return images[0]?.src || "";
}

export async function fetchShopifyProduct(handle: string): Promise<{
  id: number;
  title: string;
  handle: string;
  price: string;
  image_url: string;
  /** The original printable artwork image — use this for lifestyle generation & Pictorem. */
  printable_image_url: string;
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

  const allImages: Array<{ src: string; alt: string | null }> = (product.images || []).map(
    (i: any) => ({ src: i.src as string, alt: i.alt as string | null }),
  );

  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    price: product.variants?.[0]?.price || "50.92",
    image_url: allImages[0]?.src || "",
    printable_image_url: findPrintableImage(allImages),
    images: allImages.map((i) => i.src),
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
    printable_image_url: string;
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
  return (data.products || []).map((p: any) => {
    const imgs: Array<{ src: string; alt: string | null }> = (p.images || []).map((i: any) => ({
      src: i.src as string,
      alt: i.alt as string | null,
    }));
    return {
      id: p.id,
      title: p.title,
      handle: p.handle,
      price: p.variants?.[0]?.price || "50.92",
      image_url: imgs[0]?.src || "",
      printable_image_url: findPrintableImage(imgs),
    };
  });
}
