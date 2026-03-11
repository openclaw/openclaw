/**
 * Pure mapping functions: Shopify API responses → ERP row shapes.
 * No side effects, no DB access.
 */

// ── Shopify Types (subset of Admin API response shapes) ──────

export interface ShopifyProduct {
  id: number;
  title: string;
  handle: string;
  body_html: string | null;
  product_type: string;
  status: string;
  variants: ShopifyVariant[];
}

export interface ShopifyVariant {
  id: number;
  product_id: number;
  title: string;
  sku: string | null;
  price: string;
  inventory_item_id: number;
  inventory_quantity: number;
}

export interface ShopifyOrder {
  id: number;
  order_number: number;
  financial_status: string;
  fulfillment_status: string | null;
  current_total_price: string;
  current_subtotal_price: string;
  total_tax: string;
  currency: string;
  customer: { id: number } | null;
  line_items: Array<{
    variant_id: number | null;
    quantity: number;
    price: string;
  }>;
  shipping_address: Record<string, unknown> | null;
  created_at: string;
}

export interface ShopifyCustomer {
  id: number;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  default_address?: { company: string | null } | null;
}

// ── ERP Row Shapes ───────────────────────────────────────────

export interface ErpProductRow {
  shopify_product_id: number;
  shopify_variant_id: number;
  shopify_handle: string;
  sku: string;
  name: string;
  description: string;
  price: number;
  currency: string;
  category: string | null;
  stock_qty: number;
  status: string;
}

export interface ErpContactRow {
  shopify_customer_id: number;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
}

export interface ErpOrderRow {
  shopify_order_id: number;
  shopify_order_number: string;
  status: string;
  total: number;
  subtotal: number;
  tax: number;
  currency: string;
  line_items: Array<{ variant_id: number | null; quantity: number; unit_price: number }>;
  shipping_address: Record<string, unknown> | null;
  shopify_customer_id: number | null;
  created_at: string;
}

export interface ErpStockItemRow {
  shopify_inventory_item_id: number;
  shopify_location_id: number;
  quantity: number;
  sku: string;
  name: string;
}

// ── Mappers ──────────────────────────────────────────────────

function stripHtml(html: string | null): string {
  if (!html) return "";
  return html.replace(/<[^>]+>/g, "").trim();
}

/**
 * Map one Shopify product + variant → one ERP product row.
 * Called once per variant (one ERP row per variant).
 */
export function mapProductVariant(product: ShopifyProduct, variant: ShopifyVariant): ErpProductRow {
  const isMultiVariant = product.variants.length > 1;
  const variantSuffix =
    isMultiVariant && variant.title !== "Default Title" ? ` - ${variant.title}` : "";

  return {
    shopify_product_id: product.id,
    shopify_variant_id: variant.id,
    shopify_handle: product.handle,
    sku: variant.sku || `${product.handle}-${variant.id}`,
    name: `${product.title}${variantSuffix}`,
    description: stripHtml(product.body_html),
    price: parseFloat(variant.price),
    currency: "USD",
    category: product.product_type || null,
    stock_qty: variant.inventory_quantity ?? 0,
    status: product.status === "active" ? "active" : "draft",
  };
}

/**
 * Map Shopify financial_status + fulfillment_status → ERP order status.
 */
function mapOrderStatus(financial: string, fulfillment: string | null): string {
  if (financial === "voided" || financial === "refunded") return "cancelled";
  if (fulfillment === "fulfilled") return "delivered";
  if (fulfillment === "partial") return "shipped";
  if (financial === "paid") return "processing";
  return "pending";
}

export function mapOrder(order: ShopifyOrder): ErpOrderRow {
  return {
    shopify_order_id: order.id,
    shopify_order_number: String(order.order_number),
    status: mapOrderStatus(order.financial_status, order.fulfillment_status),
    total: parseFloat(order.current_total_price),
    subtotal: parseFloat(order.current_subtotal_price || order.current_total_price),
    tax: parseFloat(order.total_tax || "0"),
    currency: order.currency || "USD",
    line_items: order.line_items.map((li) => ({
      variant_id: li.variant_id,
      quantity: li.quantity,
      unit_price: parseFloat(li.price),
    })),
    shipping_address: order.shipping_address ?? null,
    shopify_customer_id: order.customer?.id ?? null,
    created_at: order.created_at,
  };
}

export function mapCustomer(customer: ShopifyCustomer): ErpContactRow {
  const first = customer.first_name || "";
  const last = customer.last_name || "";
  const name = `${first} ${last}`.trim() || "Unknown";

  return {
    shopify_customer_id: customer.id,
    name,
    email: customer.email ?? null,
    phone: customer.phone ?? null,
    company: customer.default_address?.company ?? null,
  };
}

export function mapInventoryLevel(
  level: { inventory_item_id: number; location_id: number; available: number | null },
  sku: string,
  name: string,
): ErpStockItemRow {
  return {
    shopify_inventory_item_id: level.inventory_item_id,
    shopify_location_id: level.location_id,
    quantity: level.available ?? 0,
    sku,
    name,
  };
}
