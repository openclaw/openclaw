import Stripe from "stripe";

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2025-02-24.acacia",
  typescript: true,
});

export const PLANS = {
  starter: {
    name: "Starter",
    description: "Get started with AI messaging",
    monthlyPrice: 19,
    yearlyPrice: 190, // ~2 months free
    priceId: process.env.STRIPE_STARTER_PRICE_ID!,
    yearlyPriceId: process.env.STRIPE_STARTER_YEARLY_PRICE_ID!,
    features: [
      "All messaging channels",
      "Claude & GPT-4o access",
      "Pay-as-you-go usage billing",
      "Community support",
    ],
  },
  growth: {
    name: "Growth",
    description: "For power users and small teams",
    monthlyPrice: 49,
    yearlyPrice: 490, // ~2 months free
    priceId: process.env.STRIPE_GROWTH_PRICE_ID!,
    yearlyPriceId: process.env.STRIPE_GROWTH_YEARLY_PRICE_ID!,
    features: [
      "Everything in Starter",
      "Priority support",
      "Custom assistant identity",
      "Voice & TTS",
    ],
  },
  pro: {
    name: "Pro",
    description: "For teams and businesses",
    monthlyPrice: 199,
    yearlyPrice: 1990, // ~2 months free
    priceId: process.env.STRIPE_PRO_PRICE_ID!,
    yearlyPriceId: process.env.STRIPE_PRO_YEARLY_PRICE_ID!,
    features: [
      "Everything in Growth",
      "Up to 10 team members",
      "Shared memory & context",
      "SLA support",
    ],
  },
} as const;

export type PlanKey = keyof typeof PLANS;
export type BillingInterval = "monthly" | "yearly";
