import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { stripe, PLANS, type PlanKey, type BillingInterval } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { plan, interval = "monthly" } = await req.json() as { plan: PlanKey; interval?: BillingInterval };

  if (!PLANS[plan]) {
    return NextResponse.json({ error: "Invalid plan" }, { status: 400 });
  }

  const subscription = await prisma.subscription.findUnique({
    where: { userId: session.user.id },
  });

  let customerId = subscription?.stripeCustomerId;

  try {
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: session.user.email!,
        name: session.user.name ?? undefined,
        metadata: { userId: session.user.id },
      });
      customerId = customer.id;

      await prisma.subscription.upsert({
        where: { userId: session.user.id },
        create: { userId: session.user.id, stripeCustomerId: customerId },
        update: { stripeCustomerId: customerId },
      });
    }

    const origin = req.headers.get("origin") ?? "http://localhost:3000";

    const checkoutSession = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: interval === "yearly" ? PLANS[plan].yearlyPriceId : PLANS[plan].priceId, quantity: 1 }],
      success_url: `${origin}/onboarding?upgraded=true`,
      cancel_url: `${origin}/pricing`,
      metadata: { userId: session.user.id, plan },
      subscription_data: {
        metadata: { userId: session.user.id, plan },
      },
    });

    return NextResponse.json({ url: checkoutSession.url });
  } catch (err) {
    console.error("Stripe checkout error:", err);
    return NextResponse.json({ error: "Failed to create checkout session" }, { status: 500 });
  }
}
