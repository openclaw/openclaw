import type { StripeClient } from "../types.js";

type Env = NodeJS.ProcessEnv;

function requireEnv(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function toFormData(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

export function createStripeClient(env: Env = process.env): StripeClient {
  const apiKey = requireEnv(env, "OPENCLAW_REVENUE_STRIPE_API_KEY");
  const successUrl =
    env.OPENCLAW_REVENUE_STRIPE_SUCCESS_URL?.trim() || "https://example.com/success";

  return {
    async createPaymentLink({ amount, currency, productName, metadata }) {
      const response = await fetch("https://api.stripe.com/v1/payment_links", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: toFormData({
          "line_items[0][price_data][currency]": currency.toLowerCase(),
          "line_items[0][price_data][unit_amount]": String(Math.round(amount * 100)),
          "line_items[0][price_data][product_data][name]": productName,
          "line_items[0][quantity]": "1",
          "after_completion[type]": "redirect",
          "after_completion[redirect][url]": successUrl,
          "metadata[contact_id]": metadata.contactId || "",
          "metadata[product_type]": metadata.productType || "",
          "metadata[opportunity_name]": metadata.opportunityName || "",
        }),
      });

      const payload = (await response.json().catch(() => null)) as
        | { url?: string; error?: { message?: string } }
        | null;

      if (!response.ok) {
        throw new Error(payload?.error?.message || `Stripe request failed (${response.status})`);
      }

      if (!payload?.url) {
        throw new Error("Stripe createPaymentLink response missing url");
      }

      return { url: payload.url };
    },
  };
}
