/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Stripe Webhook Handler
 * Handles subscription events and credit allocation
 */

import { Router, raw } from 'express';
import Stripe from 'stripe';
import { subscriptionService, SUBSCRIPTION_PLANS } from './services/subscription-service';
import { creditService } from './services/credit-service';
import { emailService } from './email-service';
import { db } from './db';
import { users } from '@shared/schema';
import { eq } from 'drizzle-orm';

const router = Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-07-30.basil',
});

// Webhook endpoint - must use raw body parser
router.post(
  '/webhook',
  raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];

    if (!sig) {
      console.error('❌ No Stripe signature found');
      return res.status(400).send('No signature');
    }

    let event: Stripe.Event;

    try {
      // Verify webhook signature
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

      if (!webhookSecret) {
        console.warn('⚠️ No STRIPE_WEBHOOK_SECRET set - webhook signature verification disabled');
        // In development, parse without verification
        event = JSON.parse(req.body.toString());
      } else {
        event = stripe.webhooks.constructEvent(
          req.body,
          sig,
          webhookSecret
        );
      }
    } catch (err) {
      console.error('❌ Webhook signature verification failed:', err);
      return res.status(400).send(`Webhook Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }

    console.log(`🎣 Received Stripe webhook: ${event.type}`);

    try {
      // Handle the event
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object as Stripe.Checkout.Session;

          // Handle credit purchases
          if (session.metadata?.type === 'credit_purchase') {
            console.log(`💳 Credit purchase completed: ${session.id}`);

            const userId = session.metadata.userId;
            const credits = parseInt(session.metadata.credits || '0');
            const amountInCents = session.amount_total || 0;

            if (userId && credits > 0) {
              const success = await creditService.processCreditPurchase(
                userId,
                amountInCents,
                session.id
              );

              if (success) {
                console.log(`✅ Added ${credits} credits to user ${userId}`);
              } else {
                console.error(`❌ Failed to add credits to user ${userId}`);
              }
            }
          }
          // Handle subscription checkouts
          else if (session.mode === 'subscription' && session.subscription) {
            console.log(`✅ Checkout completed for subscription: ${session.subscription}`);

            // The subscription.created event will handle credit allocation
            // We just log this for tracking
          }
          break;
        }

        case 'customer.subscription.created': {
          const subscription = event.data.object as Stripe.Subscription;
          console.log(`📝 Subscription created: ${subscription.id}`);

          // Grant initial credits
          await subscriptionService.handleSubscriptionPaymentSuccess(
            subscription.id,
            subscription.customer as string
          );
          break;
        }

        case 'invoice.payment_succeeded': {
          const invoice = event.data.object as any; // Type assertion for Stripe API compatibility

          // Only handle subscription invoices
          if (invoice.subscription) {
            console.log(`💳 Subscription payment succeeded: ${invoice.subscription}`);

            // Clear failed payment count on successful payment
            const [user] = await db
              .select()
              .from(users)
              .where(eq(users.stripeSubscriptionId, invoice.subscription as string));

            if (user) {
              await db
                .update(users)
                .set({
                  paymentFailedCount: 0,
                  lastPaymentFailedAt: null,
                })
                .where(eq(users.id, user.id));
              console.log(`✅ Cleared payment failed count for user ${user.id}`);
            }

            // Grant monthly credits for subscription cycle payments
            if (invoice.billing_reason === 'subscription_cycle') {
              await subscriptionService.handleSubscriptionPaymentSuccess(
                invoice.subscription as string,
                invoice.customer as string
              );
            }
          }
          break;
        }

        case 'invoice.payment_failed': {
          const invoice = event.data.object as any;

          // Only handle subscription invoice failures
          if (invoice.subscription) {
            console.log(`❌ Subscription payment failed: ${invoice.subscription}`);

            // Find user by subscription ID
            const [user] = await db
              .select()
              .from(users)
              .where(eq(users.stripeSubscriptionId, invoice.subscription as string));

            if (user) {
              // Increment failed payment count
              const newFailedCount = (user.paymentFailedCount || 0) + 1;
              const daysRemaining = 6 - newFailedCount; // 5 days of reminders, then cancel

              await db
                .update(users)
                .set({
                  paymentFailedCount: newFailedCount,
                  lastPaymentFailedAt: new Date(),
                })
                .where(eq(users.id, user.id));

              console.log(`📊 User ${user.id} payment failed count: ${newFailedCount}`);

              // Get subscription plan name
              const subscription = await stripe.subscriptions.retrieve(invoice.subscription as string);
              const priceId = (subscription as any).items?.data?.[0]?.price?.id;
              const plan = SUBSCRIPTION_PLANS.find(p => p.priceId === priceId);
              const planName = plan?.name || 'Subscription';

              if (daysRemaining > 0) {
                // Send payment failure reminder email
                const updatePaymentUrl = 'https://cutmv.fulldigitalll.com/app/subscription';

                await emailService.sendPaymentFailedNotification({
                  userEmail: user.email,
                  userName: user.name || undefined,
                  planName,
                  daysRemaining,
                  updatePaymentUrl,
                });

                console.log(`📧 Sent payment failure reminder to ${user.email} (${daysRemaining} days remaining)`);
              } else {
                // 5 days have passed, cancel the subscription
                console.log(`⏰ 5 days passed, canceling subscription for user ${user.id}`);

                await stripe.subscriptions.cancel(invoice.subscription as string);

                // Clear subscription data
                await db
                  .update(users)
                  .set({
                    stripeSubscriptionId: null,
                    subscriptionCredits: 0,
                    subscriptionCreditResetDate: null,
                    paymentFailedCount: 0,
                    lastPaymentFailedAt: null,
                  })
                  .where(eq(users.id, user.id));

                // Send final cancellation email
                await emailService.sendEmail({
                  to: user.email,
                  subject: 'Your CUTMV subscription has been paused',
                  html: `
                    <p>Hi ${user.name || 'there'},</p>
                    <p>Unfortunately, we were unable to process your payment after multiple attempts.</p>
                    <p>Your <strong>${planName}</strong> subscription has been paused.</p>
                    <p>You can resubscribe anytime at <a href="https://cutmv.fulldigitalll.com/app/subscription">https://cutmv.fulldigitalll.com/app/subscription</a> to restore your 50% subscriber discount and monthly credits.</p>
                    <p>If you have any questions, please contact us at staff@fulldigitalll.com.</p>
                    <p>- The CUTMV Team</p>
                  `,
                  text: `Hi ${user.name || 'there'},\n\nUnfortunately, we were unable to process your payment after multiple attempts.\n\nYour ${planName} subscription has been paused.\n\nYou can resubscribe anytime at https://cutmv.fulldigitalll.com/app/subscription to restore your 50% subscriber discount and monthly credits.\n\nIf you have any questions, please contact us at staff@fulldigitalll.com.\n\n- The CUTMV Team`,
                });

                console.log(`✅ Subscription canceled and user notified for ${user.id}`);
              }
            }
          }
          break;
        }

        case 'customer.subscription.deleted': {
          const subscription = event.data.object as Stripe.Subscription;
          console.log(`❌ Subscription deleted: ${subscription.id}`);

          // Handle subscription cancellation
          await subscriptionService.handleSubscriptionCanceled(subscription.id);
          break;
        }

        case 'customer.subscription.updated': {
          const subscription = event.data.object as Stripe.Subscription;
          console.log(`🔄 Subscription updated: ${subscription.id}`);

          // Could handle plan changes here if needed
          break;
        }

        default:
          console.log(`ℹ️ Unhandled event type: ${event.type}`);
      }

      // Return a 200 response to acknowledge receipt
      res.json({ received: true });
    } catch (error) {
      console.error('❌ Error processing webhook:', error);
      res.status(500).json({
        error: 'Webhook processing failed',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
);

export default router;
