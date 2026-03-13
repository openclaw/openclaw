import { stripe } from "./stripe";
import { prisma } from "./prisma";
import type { ModelDef } from "./models";

/**
 * Record token usage for a completed request and, when using the platform key,
 * report metered usage to Stripe. Each model carries its own markup multiplier.
 *
 * Set STRIPE_USAGE_PRICE_ID in your env to a Stripe metered price where
 * 1 unit = $0.000001 (one micro-dollar).
 */
export async function recordUsage({
  userId,
  channel,
  model,
  inputTokens,
  outputTokens,
  ownKey,
}: {
  userId: string;
  channel: string;
  model: ModelDef;
  inputTokens: number;
  outputTokens: number;
  /** true when the user supplied their own API key — no Stripe billing */
  ownKey: boolean;
}) {
  const costUsd =
    (inputTokens / 1_000_000) * model.inputPricePerM +
    (outputTokens / 1_000_000) * model.outputPricePerM;

  // Markup only applies when using the platform key (pay-as-you-go)
  const billedUsd = ownKey ? 0 : costUsd * (1 + model.markup);

  let reportedStripe = false;

  // Only charge when: platform key (pay-as-you-go) + Stripe meter configured
  if (!ownKey && billedUsd > 0) {
    try {
      const sub = await prisma.subscription.findUnique({
        where: { userId },
        select: { stripeCustomerId: true },
      });

      if (sub?.stripeCustomerId) {
        // 1 unit = $0.000001; round up so we never undercharge
        const units = Math.ceil(billedUsd * 1_000_000);
        await stripe.billing.meterEvents.create({
          event_name: "ai_usage",
          payload: {
            stripe_customer_id: sub.stripeCustomerId,
            value: String(units),
          },
        });
        reportedStripe = true;
      }
    } catch (err) {
      // Non-fatal: log and continue — the UsageRecord row will have
      // reportedStripe=false so it can be reconciled later
      console.error("[billing] Stripe usage report failed:", err);
    }
  }

  await prisma.usageRecord.create({
    data: {
      userId,
      channel,
      model: model.id,
      provider: model.provider,
      inputTokens,
      outputTokens,
      costUsd,
      billedUsd,
      reportedStripe,
    },
  });
}
