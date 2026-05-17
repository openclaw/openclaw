#!/usr/bin/env bun

type SectionName = "busqueda" | "ultimos" | "preventas";

type Product = {
  store: string;
  section: SectionName;
  name: string;
  url: string;
  price?: string;
  finalPrice?: string;
  stock?: string;
  image?: string;
  updated?: string;
};

type StoreResult = {
  store: string;
  sections: Record<SectionName, Product[]>;
  warnings: string[];
};

type Options = {
  query: string;
  limit: number;
  json: boolean;
};

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const SECTIONS: SectionName[] = ["busqueda", "ultimos", "preventas"];

function parseArgs(argv: string[]): Options {
  const options: Options = { query: "elite", limit: 5, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--query" || arg === "-q") {
      options.query = argv[index + 1]?.trim() || options.query;
      index += 1;
      continue;
    }
    if (arg === "--limit" || arg === "-n") {
      const parsed = Number.parseInt(argv[index + 1] ?? "", 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        options.limit = Math.min(parsed, 20);
      }
      index += 1;
    }
  }
  return options;
}

async function fetchText(url: string, init: RequestInit = {}): Promise<string> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
      "User-Agent": USER_AGENT,
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}`);
  }
  return response.text();
}

async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const text = await fetchText(url, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.headers ?? {}),
    },
  });
  return JSON.parse(text) as T;
}

function stripHtml(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return (
    decodeHtml(value.replace(/<[^>]*>/g, " "))
      .replace(/\s+/g, " ")
      .trim() || undefined
  );
}

function decodeHtml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_, code: string) =>
      String.fromCharCode(Number.parseInt(code, 16)),
    )
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&ndash;/g, "-")
    .replace(/&mdash;/g, "-")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function parseCopAmount(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const match = value.match(/\$\s*([\d.,]+)/);
  if (!match?.[1]) {
    return undefined;
  }
  const amount = Number.parseInt(match[1].replace(/[^\d]/g, ""), 10);
  return Number.isFinite(amount) ? amount : undefined;
}

function formatCopAmount(amount: number): string {
  return `$${amount.toLocaleString("es-CO")}`;
}

function extractFinalPrice(name: string): string | undefined {
  const patterns = [
    /precio\s+final\s*[-:]*\s*\$?\s*([\d.,]+)/i,
    /preventa\s*\(\s*\$?\s*([\d.,]+)\s*\)/i,
  ];
  for (const pattern of patterns) {
    const match = name.match(pattern);
    if (!match?.[1]) {
      continue;
    }
    const amount = Number.parseInt(match[1].replace(/[^\d]/g, ""), 10);
    if (Number.isFinite(amount)) {
      return formatCopAmount(amount);
    }
  }
  return undefined;
}

function uniqueProducts(products: Product[], limit: number): Product[] {
  const seen = new Set<string>();
  const result: Product[] = [];
  for (const product of products) {
    const key = `${product.name.toLowerCase()}\n${product.url}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(product);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

type WooProduct = {
  name?: string;
  permalink?: string;
  price_html?: string;
  prices?: {
    price?: string;
    currency_symbol?: string;
    currency_minor_unit?: number;
    currency_thousand_separator?: string;
  };
  images?: Array<{ src?: string; thumbnail?: string }>;
  is_in_stock?: boolean;
  stock_availability?: { text?: string };
};

type WooCategory = {
  id: number;
  name: string;
  slug: string;
};

type WpProduct = {
  title?: { rendered?: string };
  link?: string;
  _embedded?: {
    "wp:featuredmedia"?: Array<{
      source_url?: string;
      media_details?: {
        sizes?: Record<string, { source_url?: string }>;
      };
    }>;
  };
};

function formatWooPrice(product: WooProduct): string | undefined {
  const htmlPrice = stripHtml(product.price_html)?.replace(/\s+Price range:.*$/i, "");
  if (htmlPrice) {
    return htmlPrice;
  }
  const raw = product.prices?.price;
  if (!raw) {
    return undefined;
  }
  const amount = Number.parseInt(raw, 10);
  if (!Number.isFinite(amount)) {
    return undefined;
  }
  const symbol = product.prices?.currency_symbol ?? "$";
  return `${symbol}${amount.toLocaleString("es-CO")}`;
}

function wooProductToProduct(store: string, section: SectionName, product: WooProduct): Product {
  const stockText = product.stock_availability?.text?.trim();
  const name = decodeHtml(product.name ?? "Producto sin nombre");
  return {
    store,
    section,
    name,
    url: product.permalink ?? "",
    price: formatWooPrice(product),
    finalPrice: extractFinalPrice(name),
    stock: stockText || (product.is_in_stock ? "Disponible" : "Agotado"),
    image: product.images?.[0]?.src ?? product.images?.[0]?.thumbnail,
  };
}

async function fetchWooProducts(params: {
  store: string;
  baseUrl: string;
  section: SectionName;
  query?: string;
  categorySlug?: string;
  limit: number;
  referer?: string;
}): Promise<Product[]> {
  const searchParams = new URLSearchParams({
    per_page: String(params.limit),
    orderby: "date",
    order: "desc",
  });
  if (params.query) {
    searchParams.set("search", params.query);
  }
  if (params.categorySlug) {
    const categories = await fetchJson<WooCategory[]>(
      `${params.baseUrl}/wp-json/wc/store/v1/products/categories?per_page=100`,
      params.referer ? { headers: { Referer: params.referer } } : {},
    );
    const category = categories.find((entry) => entry.slug === params.categorySlug);
    if (category) {
      searchParams.set("category", String(category.id));
    }
  }
  const products = await fetchJson<WooProduct[]>(
    `${params.baseUrl}/wp-json/wc/store/v1/products?${searchParams}`,
    params.referer ? { headers: { Referer: params.referer } } : {},
  );
  return products.map((product) => wooProductToProduct(params.store, params.section, product));
}

function wpProductToUpcomingProduct(
  store: string,
  section: SectionName,
  product: WpProduct,
): Product {
  const media = product._embedded?.["wp:featuredmedia"]?.[0];
  const name = stripHtml(product.title?.rendered) ?? "Producto sin nombre";
  return {
    store,
    section,
    name,
    url: product.link ?? "",
    finalPrice: extractFinalPrice(name),
    stock: "Disponible Próximamente",
    image: media?.media_details?.sizes?.woocommerce_thumbnail?.source_url ?? media?.source_url,
  };
}

async function fetchWpProductsByCategorySlug(params: {
  store: string;
  baseUrl: string;
  section: SectionName;
  categorySlug: string;
  limit: number;
}): Promise<Product[]> {
  const categories = await fetchJson<WooCategory[]>(
    `${params.baseUrl}/wp-json/wp/v2/product_cat?slug=${encodeURIComponent(params.categorySlug)}&per_page=1`,
  );
  const category = categories[0];
  if (!category) {
    return [];
  }
  const searchParams = new URLSearchParams({
    product_cat: String(category.id),
    per_page: String(params.limit),
    orderby: "date",
    order: "desc",
    _embed: "wp:featuredmedia",
  });
  const products = await fetchJson<WpProduct[]>(
    `${params.baseUrl}/wp-json/wp/v2/product?${searchParams}`,
  );
  return uniqueProducts(
    products.map((product) => wpProductToUpcomingProduct(params.store, params.section, product)),
    params.limit,
  );
}

async function fetchAvalon(options: Options): Promise<StoreResult> {
  const store = "Avalon Gaming";
  const baseUrl = "https://avalongaming.com.co";
  const warnings: string[] = [];
  const sections = await fetchSections(store, warnings, {
    busqueda: () =>
      fetchWooProducts({
        store,
        baseUrl,
        section: "busqueda",
        query: options.query,
        limit: options.limit,
      }),
    ultimos: () => fetchWooProducts({ store, baseUrl, section: "ultimos", limit: options.limit }),
    preventas: () =>
      fetchWpProductsByCategorySlug({
        store,
        baseUrl,
        section: "preventas",
        categorySlug: "chaos-rising",
        limit: options.limit,
      }),
  });
  return { store, sections, warnings };
}

async function fetchLx(options: Options): Promise<StoreResult> {
  const store = "LX Store Colombia";
  const baseUrl = "https://lxstore.com.co";
  const referer = `${baseUrl}/`;
  const warnings: string[] = [];
  const sections = await fetchSections(store, warnings, {
    busqueda: () =>
      fetchWooProducts({
        store,
        baseUrl,
        section: "busqueda",
        query: options.query,
        limit: options.limit,
        referer,
      }),
    ultimos: () =>
      fetchWooProducts({ store, baseUrl, section: "ultimos", limit: options.limit, referer }),
    preventas: () =>
      fetchWooProducts({
        store,
        baseUrl,
        section: "preventas",
        categorySlug: "preventas",
        limit: options.limit,
        referer: `${baseUrl}/product-category/cartas-y-albumes/preventas/`,
      }),
  });
  return { store, sections, warnings };
}

async function fetchSections(
  store: string,
  warnings: string[],
  tasks: Record<SectionName, () => Promise<Product[]>>,
): Promise<Record<SectionName, Product[]>> {
  const entries = await Promise.all(
    SECTIONS.map(async (section) => {
      try {
        const products = await tasks[section]();
        return [section, products] as const;
      } catch (error) {
        warnings.push(`${section}: ${error instanceof Error ? error.message : String(error)}`);
        return [section, []] as const;
      }
    }),
  );
  return Object.fromEntries(entries) as Record<SectionName, Product[]>;
}

function extractJsonScript(html: string, id: string): unknown | undefined {
  const pattern = new RegExp(`<script[^>]+id=["']${id}["'][^>]*>([\\s\\S]*?)<\\/script>`, "i");
  const match = html.match(pattern);
  if (!match?.[1]) {
    return undefined;
  }
  const body = match[1].trim();
  try {
    return JSON.parse(body);
  } catch {
    return JSON.parse(decodeHtml(body));
  }
}

function walkObjects(value: unknown, visit: (entry: Record<string, unknown>) => void): void {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      walkObjects(item, visit);
    }
    return;
  }
  const record = value as Record<string, unknown>;
  visit(record);
  for (const nested of Object.values(record)) {
    walkObjects(nested, visit);
  }
}

function wixRecordToProduct(
  store: string,
  section: SectionName,
  record: Record<string, unknown>,
): Product | undefined {
  const name =
    typeof record.name === "string"
      ? record.name
      : typeof record.title === "string"
        ? record.title
        : "";
  const isStoreProduct =
    record.documentType === "public/stores/products" ||
    record.productType === "physical" ||
    typeof record.formattedPrice === "string" ||
    typeof record.currency === "string";
  if (!name || !isStoreProduct) {
    return undefined;
  }
  const url =
    typeof record.url === "string"
      ? record.url
      : typeof record.urlPart === "string"
        ? `https://www.walkergoldencards.com/product-page/${record.urlPart}`
        : "";
  if (!url) {
    return undefined;
  }
  const inventory =
    record.inventory && typeof record.inventory === "object" ? record.inventory : undefined;
  const quantity =
    inventory && "quantity" in inventory && typeof inventory.quantity === "number"
      ? inventory.quantity
      : undefined;
  const inStock =
    typeof record.inStock === "boolean"
      ? record.inStock
      : typeof record.isInStock === "boolean"
        ? record.isInStock
        : undefined;
  const media = Array.isArray(record.media)
    ? (record.media[0] as Record<string, unknown> | undefined)
    : undefined;
  return {
    store,
    section,
    name: decodeHtml(name),
    url,
    finalPrice: extractFinalPrice(name),
    price:
      typeof record.formattedPrice === "string"
        ? record.formattedPrice
        : typeof record.price === "string"
          ? record.price
          : typeof record.price === "number"
            ? `$${record.price.toLocaleString("es-CO")}`
            : undefined,
    stock:
      quantity !== undefined
        ? `${quantity} disponibles`
        : inStock === undefined
          ? undefined
          : inStock
            ? "Disponible"
            : "Agotado",
    image:
      media && typeof media.fullUrl === "string"
        ? media.fullUrl
        : record.image && typeof record.image === "object" && "name" in record.image
          ? `https://static.wixstatic.com/media/${String(record.image.name)}`
          : undefined,
  };
}

function extractWixProductsFromWarmup(
  html: string,
  store: string,
  section: SectionName,
  limit: number,
): Product[] {
  const json = extractJsonScript(html, "wix-warmup-data");
  const products: Product[] = [];
  walkObjects(json, (record) => {
    const product = wixRecordToProduct(store, section, record);
    if (product) {
      products.push(product);
    }
  });
  return uniqueProducts(products, limit);
}

function extractProductJsonLd(html: string): Record<string, unknown> | undefined {
  const scripts =
    html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) ?? [];
  for (const script of scripts) {
    const body = script
      .replace(/^<script[^>]*>/i, "")
      .replace(/<\/script>$/i, "")
      .trim();
    try {
      const parsed = JSON.parse(body);
      if (
        parsed &&
        typeof parsed === "object" &&
        (parsed as Record<string, unknown>)["@type"] === "Product"
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Ignore non-product structured data.
    }
  }
  return undefined;
}

function productFromJsonLd(
  store: string,
  section: SectionName,
  url: string,
  updated: string | undefined,
  data: Record<string, unknown>,
): Product | undefined {
  const name = typeof data.name === "string" ? data.name : "";
  if (!name) {
    return undefined;
  }
  const offer =
    data.Offers && typeof data.Offers === "object"
      ? (data.Offers as Record<string, unknown>)
      : undefined;
  const price =
    offer && typeof offer.price === "string" ? Number.parseInt(offer.price, 10) : undefined;
  const availability = typeof offer?.Availability === "string" ? offer.Availability : undefined;
  const images = Array.isArray(data.image) ? data.image : [];
  const firstImage =
    images[0] && typeof images[0] === "object" ? (images[0] as Record<string, unknown>) : undefined;
  return {
    store,
    section,
    name: decodeHtml(name),
    url,
    finalPrice: extractFinalPrice(name),
    price: Number.isFinite(price) ? `$${price.toLocaleString("es-CO")}` : undefined,
    stock: availability?.includes("InStock")
      ? "Disponible"
      : availability?.includes("OutOfStock")
        ? "Agotado"
        : undefined,
    image: typeof firstImage?.contentUrl === "string" ? firstImage.contentUrl : undefined,
    updated,
  };
}

async function fetchWalkerLatest(limit: number): Promise<Product[]> {
  const sitemap = await fetchText("https://www.walkergoldencards.com/store-products-sitemap.xml");
  const entries = [
    ...sitemap.matchAll(/<url>\s*<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/g),
  ]
    .map((match) => ({ url: decodeHtml(match[1] ?? ""), updated: match[2] ?? "" }))
    .sort((left, right) => right.updated.localeCompare(left.updated));
  const products: Product[] = [];
  for (const entry of entries.slice(0, Math.max(limit * 3, limit))) {
    try {
      const html = await fetchText(entry.url);
      const data = extractProductJsonLd(html);
      const product = data
        ? productFromJsonLd("Walker Golden Cards", "ultimos", entry.url, entry.updated, data)
        : undefined;
      if (product) {
        products.push(product);
      }
      if (products.length >= limit) {
        break;
      }
    } catch {
      // Keep trying newer sitemap entries.
    }
  }
  return products;
}

async function fetchWalker(options: Options): Promise<StoreResult> {
  const store = "Walker Golden Cards";
  const warnings: string[] = [];
  const sections = await fetchSections(store, warnings, {
    busqueda: async () => {
      const html = await fetchText(
        `https://www.walkergoldencards.com/search?q=${encodeURIComponent(options.query)}`,
      );
      return extractWixProductsFromWarmup(html, store, "busqueda", options.limit);
    },
    ultimos: () => fetchWalkerLatest(options.limit),
    preventas: async () => {
      const html = await fetchText("https://www.walkergoldencards.com/preventa");
      return extractWixProductsFromWarmup(html, store, "preventas", options.limit);
    },
  });
  return { store, sections, warnings };
}

function renderProduct(product: Product, index: number): string {
  const reservationPrice =
    product.finalPrice &&
    product.price &&
    parseCopAmount(product.finalPrice) !== parseCopAmount(product.price)
      ? `reserva ${product.price}`
      : product.price;
  const details = [
    product.finalPrice ? `final ${product.finalPrice}` : undefined,
    reservationPrice,
    product.stock,
    product.updated ? `actualizado ${product.updated}` : undefined,
  ]
    .filter(Boolean)
    .join(" | ");
  return `${index + 1}. [${product.name}](${product.url})${details ? ` - ${details}` : ""}`;
}

function renderMarkdown(results: StoreResult[], options: Options): string {
  const lines = [
    `# Productos Pokemon Colombia`,
    "",
    `Query: \`${options.query}\` | limite: ${options.limit}`,
    "",
  ];
  for (const result of results) {
    lines.push(`## ${result.store}`, "");
    for (const section of SECTIONS) {
      const products = result.sections[section];
      lines.push(`### ${section} (${products.length}/${options.limit})`);
      if (products.length === 0) {
        lines.push("- Sin resultados.");
      } else {
        lines.push(...products.map(renderProduct));
      }
      lines.push("");
    }
    if (result.warnings.length > 0) {
      lines.push("Warnings:");
      lines.push(...result.warnings.map((warning) => `- ${warning}`));
      lines.push("");
    }
  }
  return lines.join("\n").trimEnd();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const results = await Promise.all([fetchAvalon(options), fetchLx(options), fetchWalker(options)]);
  if (options.json) {
    console.log(
      JSON.stringify({ query: options.query, limit: options.limit, stores: results }, null, 2),
    );
    return;
  }
  console.log(renderMarkdown(results, options));
}

await main();
