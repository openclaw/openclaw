/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Subscription Service
 * Stripe subscription management with credit allocation
 */

import Stripe from 'stripe';
import { db } from '../db';
import { users } from '@shared/schema';
import { eq } from 'drizzle-orm';
import { creditService } from './credit-service';

if (!process.env.STRIPE_SECRET_KEY) {
  console.error('⚠️ STRIPE_SECRET_KEY is not set!');
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2025-07-30.basil',
});

// Log subscription plan configuration at startup
console.log('📋 Subscription plans configured:', {
  starter: process.env.STRIPE_STARTER_PRICE_ID || '⚠️ NOT SET (using fallback)',
  pro: process.env.STRIPE_PRO_PRICE_ID || '⚠️ NOT SET (using fallback)',
  enterprise: process.env.STRIPE_ENTERPRISE_PRICE_ID || '⚠️ NOT SET (using fallback)'
});

// Subscription plan configuration
export interface SubscriptionPlan {
  id: string;
  name: string;
  priceId: string;
  monthlyCredits: number;
  price: number; // in cents
  description: string;
  hasBulkDownload: boolean; // Pro+ feature: download all exports as ZIP
}

export const SUBSCRIPTION_PLANS: SubscriptionPlan[] = [
  {
    id: 'starter',
    name: 'Starter',
    priceId: process.env.STRIPE_STARTER_PRICE_ID || 'price_starter',
    monthlyCredits: 1000,
    price: 1000, // $10/month
    description: '1,000 credits per month + 50% off all processing',
    hasBulkDownload: false
  },
  {
    id: 'pro',
    name: 'Pro',
    priceId: process.env.STRIPE_PRO_PRICE_ID || 'price_pro',
    monthlyCredits: 3000,
    price: 2500, // $25/month
    description: '3,000 credits per month + 50% off all processing + bulk ZIP downloads',
    hasBulkDownload: true
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    priceId: process.env.STRIPE_ENTERPRISE_PRICE_ID || 'price_enterprise',
    monthlyCredits: 10000,
    price: 7500, // $75/month
    description: '10,000 credits per month + 50% off all processing + bulk ZIP downloads + priority support',
    hasBulkDownload: true
  }
];

export class SubscriptionService {
  /**
   * Get or create Stripe customer for user with auto-heal for test/live mode mismatch
   * This handles the case where a user has a test-mode customer ID but we're now in live mode
   */
  async getOrCreateCustomer(userId: string, email: string, name?: string): Promise<string> {
    try {
      // Check if user already has a Stripe customer ID
      const [user] = await db
        .select({ stripeCustomerId: users.stripeCustomerId })
        .from(users)
        .where(eq(users.id, userId));

      if (user?.stripeCustomerId) {
        // AUTO-HEAL: Verify the customer exists in Stripe (handles test→live mode migration)
        try {
          await stripe.customers.retrieve(user.stripeCustomerId);
          console.log(`✅ User ${userId} has valid Stripe customer: ${user.stripeCustomerId}`);
          return user.stripeCustomerId;
        } catch (stripeError: any) {
          // Customer doesn't exist (likely test mode ID in live mode)
          // Check multiple error conditions to catch all "customer not found" scenarios
          const isCustomerNotFound = 
            stripeError.code === 'resource_missing' || 
            stripeError.statusCode === 404 ||
            stripeError.type === 'StripeInvalidRequestError' ||
            (stripeError.message && stripeError.message.includes('No such customer')) ||
            (stripeError.raw?.message && stripeError.raw.message.includes('No such customer'));
          
          if (isCustomerNotFound) {
            console.warn(`⚠️ Stripe customer ${user.stripeCustomerId} not found (test→live mode migration). Creating new customer...`);
            // Clear the stale customer ID from database first
            await db
              .update(users)
              .set({ stripeCustomerId: null, stripeSubscriptionId: null })
              .where(eq(users.id, userId));
            // Fall through to create new customer
          } else {
            throw stripeError;
          }
        }
      }

      // Create new Stripe customer
      const customer = await stripe.customers.create({
        email,
        name: name || email,
        metadata: {
          userId,
          migratedFromTestMode: user?.stripeCustomerId ? 'true' : 'false'
        }
      });

      // Save customer ID to database
      await db
        .update(users)
        .set({ stripeCustomerId: customer.id })
        .where(eq(users.id, userId));

      console.log(`✅ Created Stripe customer ${customer.id} for user ${userId}`);
      return customer.id;
    } catch (error) {
      console.error('Error getting or creating Stripe customer:', error);
      throw new Error('Failed to create Stripe customer');
    }
  }

  /**
   * Create a subscription checkout session
   */
  async createCheckoutSession(
    userId: string,
    email: string,
    planId: string,
    successUrl: string,
    cancelUrl: string
  ): Promise<string> {
    const plan = SUBSCRIPTION_PLANS.find(p => p.id === planId);
    if (!plan) {
      throw new Error(`Invalid plan ID: ${planId}`);
    }

    try {

      // Get or create customer
      const customerId = await this.getOrCreateCustomer(userId, email);

      // Create Checkout session
      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: 'subscription',
        payment_method_types: ['card'],
        line_items: [
          {
            price: plan.priceId,
            quantity: 1,
          },
        ],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: {
          userId,
          planId: plan.id,
          monthlyCredits: plan.monthlyCredits.toString()
        },
        subscription_data: {
          metadata: {
            userId,
            planId: plan.id,
            monthlyCredits: plan.monthlyCredits.toString()
          }
        }
      });

      console.log(`✅ Created checkout session ${session.id} for user ${userId}`);
      return session.url!;
    } catch (error: any) {
      console.error('Error creating checkout session:', {
        message: error?.message,
        type: error?.type,
        code: error?.code,
        param: error?.param,
        planId,
        priceId: plan.priceId
      });
      throw new Error(error?.message || 'Failed to create checkout session');
    }
  }

  /**
   * Get user's current subscription status
   */
  async getSubscriptionStatus(userId: string): Promise<{
    hasActiveSubscription: boolean;
    subscriptionId?: string;
    customerId?: string;
    status?: string;
    currentPeriodEnd?: Date;
    plan?: SubscriptionPlan;
    cancelAtPeriodEnd?: boolean;
  }> {
    try {
      const [user] = await db
        .select({
          stripeCustomerId: users.stripeCustomerId,
          stripeSubscriptionId: users.stripeSubscriptionId
        })
        .from(users)
        .where(eq(users.id, userId));

      let subscriptionId = user?.stripeSubscriptionId;

      // If no subscription ID stored but user has customer ID, check Stripe directly
      // This handles cases where webhook hasn't processed yet
      if (!subscriptionId && user?.stripeCustomerId) {
        console.log(`🔍 No stored subscription for user ${userId}, checking Stripe customer ${user.stripeCustomerId}`);

        try {
          const subscriptions = await stripe.subscriptions.list({
            customer: user.stripeCustomerId,
            status: 'active',
            limit: 1
          });

          if (subscriptions.data.length > 0) {
            const activeSubscription = subscriptions.data[0];
            subscriptionId = activeSubscription.id;

            // Update the user's record with the subscription ID
            console.log(`✅ Found active subscription ${subscriptionId}, updating user record`);

            const priceId = activeSubscription.items?.data?.[0]?.price?.id;
            const plan = SUBSCRIPTION_PLANS.find(p => p.priceId === priceId);

            const periodEnd = (activeSubscription as any).current_period_end;
            await db
              .update(users)
              .set({
                stripeSubscriptionId: subscriptionId,
                subscriptionCredits: plan?.monthlyCredits || 0,
                subscriptionCreditResetDate: periodEnd ? new Date(periodEnd * 1000) : null
              })
              .where(eq(users.id, userId));
          }
        } catch (stripeError: any) {
          // AUTO-HEAL: If customer doesn't exist (test→live mode migration), clear stale ID
          if (stripeError.code === 'resource_missing' || stripeError.statusCode === 404 || 
              (stripeError.message && stripeError.message.includes('No such customer'))) {
            console.warn(`⚠️ Stripe customer ${user.stripeCustomerId} not found (test→live mode migration). Clearing stale ID.`);
            await db
              .update(users)
              .set({ stripeCustomerId: null, stripeSubscriptionId: null })
              .where(eq(users.id, userId));
            // No subscription since customer doesn't exist
          } else {
            throw stripeError;
          }
        }
      }

      if (!subscriptionId) {
        return { hasActiveSubscription: false };
      }

      // Get subscription from Stripe
      const subscriptionResponse = await stripe.subscriptions.retrieve(subscriptionId);
      const subscription = subscriptionResponse as any; // Type assertion for compatibility

      const isActive = subscription.status === 'active' || subscription.status === 'trialing';

      // Find matching plan
      const priceId = subscription.items?.data?.[0]?.price?.id;
      const plan = SUBSCRIPTION_PLANS.find(p => p.priceId === priceId);

      return {
        hasActiveSubscription: isActive,
        subscriptionId: subscription.id,
        customerId: user?.stripeCustomerId || undefined,
        status: subscription.status,
        currentPeriodEnd: subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : undefined,
        plan,
        cancelAtPeriodEnd: subscription.cancel_at_period_end
      };
    } catch (error) {
      console.error('Error getting subscription status:', error);
      return { hasActiveSubscription: false };
    }
  }

  /**
   * Cancel a subscription (at period end)
   */
  async cancelSubscription(userId: string): Promise<boolean> {
    try {
      const [user] = await db
        .select({ stripeSubscriptionId: users.stripeSubscriptionId })
        .from(users)
        .where(eq(users.id, userId));

      if (!user?.stripeSubscriptionId) {
        throw new Error('No active subscription found');
      }

      // Cancel at period end
      await stripe.subscriptions.update(user.stripeSubscriptionId, {
        cancel_at_period_end: true
      });

      console.log(`✅ Scheduled subscription ${user.stripeSubscriptionId} for cancellation`);
      return true;
    } catch (error) {
      console.error('Error canceling subscription:', error);
      return false;
    }
  }

  /**
   * Reactivate a canceled subscription
   */
  async reactivateSubscription(userId: string): Promise<boolean> {
    try {
      const [user] = await db
        .select({ stripeSubscriptionId: users.stripeSubscriptionId })
        .from(users)
        .where(eq(users.id, userId));

      if (!user?.stripeSubscriptionId) {
        throw new Error('No subscription found');
      }

      // Remove cancellation
      await stripe.subscriptions.update(user.stripeSubscriptionId, {
        cancel_at_period_end: false
      });

      console.log(`✅ Reactivated subscription ${user.stripeSubscriptionId}`);
      return true;
    } catch (error) {
      console.error('Error reactivating subscription:', error);
      return false;
    }
  }

  /**
   * Handle successful subscription payment - grant credits
   */
  async handleSubscriptionPaymentSuccess(
    subscriptionId: string,
    customerId: string
  ): Promise<void> {
    try {
      console.log(`💳 Processing subscription payment success: ${subscriptionId}`);

      // Get subscription details
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);

      // Get user ID from metadata
      const userId = subscription.metadata.userId;
      const planId = subscription.metadata.planId;
      const monthlyCredits = parseInt(subscription.metadata.monthlyCredits || '0');

      if (!userId || !monthlyCredits) {
        console.error('Missing metadata in subscription:', subscription.metadata);
        throw new Error('Invalid subscription metadata');
      }

      // Calculate next reset date (30 days from now)
      const nextResetDate = new Date();
      nextResetDate.setDate(nextResetDate.getDate() + 30);

      // Update user's subscription ID, reset subscription credits, and set reset date
      await db
        .update(users)
        .set({
          stripeSubscriptionId: subscriptionId,
          stripeCustomerId: customerId,
          subscriptionCredits: monthlyCredits, // Reset to plan amount monthly
          subscriptionCreditResetDate: nextResetDate
        })
        .where(eq(users.id, userId));

      // Log transaction for tracking
      const plan = SUBSCRIPTION_PLANS.find(p => p.id === planId);
      const planName = plan?.name || 'Subscription';

      await creditService.grantSubscriptionCredits(userId, monthlyCredits, planName);

      console.log(`✅ Granted ${monthlyCredits} subscription credits to user ${userId} for ${planName} subscription (resets ${nextResetDate.toLocaleDateString()})`);
    } catch (error) {
      console.error('Error handling subscription payment success:', error);
      throw error;
    }
  }

  /**
   * Handle subscription cancellation
   */
  async handleSubscriptionCanceled(subscriptionId: string): Promise<void> {
    try {
      console.log(`❌ Processing subscription cancellation: ${subscriptionId}`);

      // Find user by subscription ID
      const [user] = await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.stripeSubscriptionId, subscriptionId));

      if (user) {
        // Clear subscription ID and subscription credits
        await db
          .update(users)
          .set({
            stripeSubscriptionId: null,
            subscriptionCredits: 0,
            subscriptionCreditResetDate: null
          })
          .where(eq(users.id, user.id));

        console.log(`✅ Cleared subscription and subscription credits for user ${user.id}`);
      }
    } catch (error) {
      console.error('Error handling subscription cancellation:', error);
    }
  }

  /**
   * Get available subscription plans
   */
  getPlans(): SubscriptionPlan[] {
    return SUBSCRIPTION_PLANS;
  }

  /**
   * Check if user has Pro or higher subscription (for bulk download feature)
   */
  async hasProOrHigher(userId: string): Promise<boolean> {
    const status = await this.getSubscriptionStatus(userId);
    if (!status.hasActiveSubscription || !status.plan) {
      return false;
    }
    return status.plan.id === 'pro' || status.plan.id === 'enterprise';
  }

  /**
   * Check if user can use bulk ZIP download feature
   */
  async canBulkDownload(userId: string): Promise<boolean> {
    const status = await this.getSubscriptionStatus(userId);
    if (!status.hasActiveSubscription || !status.plan) {
      return false;
    }
    return status.plan.hasBulkDownload;
  }
}

export const subscriptionService = new SubscriptionService();
