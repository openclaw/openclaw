import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";

// DELETE /api/user/delete — permanently delete the account
export async function DELETE(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { password } = await req.json();

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    include: { subscription: true },
  });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  // Verify password if the account uses one
  if (user.password) {
    if (!password) {
      return NextResponse.json({ error: "Password required to delete account" }, { status: 400 });
    }
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return NextResponse.json({ error: "Incorrect password" }, { status: 400 });
    }
  }

  // Cancel active Stripe subscription before deleting
  if (user.subscription?.stripeSubscriptionId) {
    try {
      await stripe.subscriptions.cancel(user.subscription.stripeSubscriptionId);
    } catch {
      // Non-fatal — still delete the account
    }
  }

  // Cascade delete handled by Prisma (Account, Session, Subscription)
  await prisma.user.delete({ where: { id: session.user.id } });

  return NextResponse.json({ success: true });
}
