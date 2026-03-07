/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Credit Wallet Service
 * Complete credit system for referral rewards and usage tracking
 */

import { db } from '../db';
import { users } from '@shared/schema';
import { eq, sql } from 'drizzle-orm';

// Credit costs - SUBSCRIBER rates (non-subscribers pay 2×)
// Based on CUTMV Pricing & Monetization Strategy v2
export const CREDIT_COSTS = {
  // Subscriber rates
  CUTDOWN: 50,           // 50 credits per cutdown (was 99)
  GIF_PACK: 90,          // 90 credits for GIF pack (was 199)
  THUMBNAIL_PACK: 90,    // 90 credits for thumbnail pack (was 199)
  CANVAS_PACK: 225,      // 225 credits for Spotify Canvas pack (was 499)

  // Non-subscriber multiplier
  NON_SUBSCRIBER_MULTIPLIER: 2
} as const;

export interface CreditTransaction {
  id: number;
  userId: string;
  amount: number;
  transactionType: 'referral_signup' | 'first_export_bonus' | 'export_usage' | 'admin_grant' | 'expiration' | 'subscription_monthly' | 'subscription_bonus' | 'credit_purchase' | 'video_processing';
  note?: string;
  referralEventId?: number;
  createdAt: Date;
  expiresAt?: Date;
}

export class CreditService {
  /**
   * Get user's current credit balance
   */
  async getUserCredits(userId: string): Promise<number> {
    try {
      const [user] = await db
        .select({ credits: users.credits })
        .from(users)
        .where(eq(users.id, userId));
      
      return user?.credits || 0;
    } catch (error) {
      console.error('Error getting user credits:', error);
      return 0;
    }
  }

  /**
   * Add credits to user account with transaction record
   */
  async addCredits(
    userId: string, 
    amount: number, 
    type: CreditTransaction['transactionType'],
    note?: string,
    referralEventId?: number,
    expiresAt?: Date
  ): Promise<boolean> {
    try {
      // Start transaction
      await db.transaction(async (tx) => {
        // Update user credits
        await tx
          .update(users)
          .set({ 
            credits: sql`credits + ${amount}`,
            lastCreditGrantAt: new Date()
          })
          .where(eq(users.id, userId));

        // Record transaction
        await tx.execute(sql`
          INSERT INTO credit_transactions (user_id, amount, transaction_type, note, referral_event_id, expires_at)
          VALUES (${userId}, ${amount}, ${type}, ${note || null}, ${referralEventId || null}, ${expiresAt || null})
        `);
      });

      console.log(`✅ Added ${amount} credits to user ${userId} for ${type}`);
      return true;
    } catch (error) {
      console.error('Error adding credits:', error);
      return false;
    }
  }

  /**
   * Deduct credits from user account
   */
  async deductCredits(
    userId: string, 
    amount: number, 
    note?: string
  ): Promise<boolean> {
    try {
      // Check if user has enough credits
      const currentCredits = await this.getUserCredits(userId);
      if (currentCredits < amount) {
        console.log(`❌ User ${userId} has insufficient credits: ${currentCredits} < ${amount}`);
        return false;
      }

      // Start transaction
      await db.transaction(async (tx) => {
        // Update user credits
        await tx
          .update(users)
          .set({ credits: sql`credits - ${amount}` })
          .where(eq(users.id, userId));

        // Record transaction
        await tx.execute(sql`
          INSERT INTO credit_transactions (user_id, amount, transaction_type, note)
          VALUES (${userId}, ${-amount}, 'export_usage', ${note || 'Export processing'})
        `);
      });

      console.log(`✅ Deducted ${amount} credits from user ${userId}`);
      return true;
    } catch (error) {
      console.error('Error deducting credits:', error);
      return false;
    }
  }

  /**
   * Get user's credit transaction history
   */
  async getCreditHistory(userId: string, limit: number = 50): Promise<CreditTransaction[]> {
    try {
      const transactions = await db.execute(sql`
        SELECT id, user_id, amount, transaction_type, note, referral_event_id, created_at, expires_at
        FROM credit_transactions
        WHERE user_id = ${userId}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `);

      return transactions.rows.map(row => ({
        id: row.id as number,
        userId: row.user_id as string,
        amount: row.amount as number,
        transactionType: row.transaction_type as CreditTransaction['transactionType'],
        note: row.note as string,
        referralEventId: row.referral_event_id as number,
        createdAt: new Date(row.created_at as string),
        expiresAt: row.expires_at ? new Date(row.expires_at as string) : undefined
      }));
    } catch (error) {
      console.error('Error getting credit history:', error);
      return [];
    }
  }

  /**
   * Process referral signup rewards
   */
  async processReferralSignup(referrerId: string, referredId: string, referralEventId: number): Promise<boolean> {
    console.log(`🎁 Processing referral signup rewards: ${referrerId} -> ${referredId}`);
    
    // Grant 1 credit to referrer for successful signup
    const success = await this.addCredits(
      referrerId,
      1,
      'referral_signup',
      `Referral signup bonus for referring user ${referredId}`,
      referralEventId
    );

    return success;
  }

  /**
   * Process first export bonus
   */
  async processFirstExportBonus(userId: string): Promise<boolean> {
    try {
      // Check if user already received first export bonus
      const existingBonus = await db.execute(sql`
        SELECT id FROM credit_transactions 
        WHERE user_id = ${userId} AND transaction_type = 'first_export_bonus'
        LIMIT 1
      `);

      if (existingBonus.rows.length > 0) {
        console.log(`User ${userId} already received first export bonus`);
        return false;
      }

      // Grant 1 credit for first export
      const success = await this.addCredits(
        userId,
        1,
        'first_export_bonus',
        'Bonus credit for first export'
      );

      return success;
    } catch (error) {
      console.error('Error processing first export bonus:', error);
      return false;
    }
  }

  /**
   * Check if user can afford export (has credits or is paying)
   */
  async canAffordExport(userId: string, cost: number = 1): Promise<boolean> {
    const credits = await this.getUserCredits(userId);
    return credits >= cost;
  }

  /**
   * Process export payment with credits
   */
  async processExportPayment(userId: string, cost: number = 1): Promise<boolean> {
    const canAfford = await this.canAffordExport(userId, cost);
    if (!canAfford) {
      return false;
    }

    return await this.deductCredits(userId, cost, 'Export processing fee');
  }

  /**
   * Grant monthly subscription credits
   */
  async grantSubscriptionCredits(userId: string, amount: number, planName: string): Promise<boolean> {
    console.log(`💳 Granting ${amount} subscription credits to user ${userId} for plan ${planName}`);

    const success = await this.addCredits(
      userId,
      amount,
      'subscription_monthly',
      `Monthly credits for ${planName} plan`
    );

    return success;
  }

  /**
   * Grant bonus credits (for promotions, etc.)
   */
  async grantBonusCredits(userId: string, amount: number, note: string): Promise<boolean> {
    console.log(`🎁 Granting ${amount} bonus credits to user ${userId}`);

    const success = await this.addCredits(
      userId,
      amount,
      'subscription_bonus',
      note
    );

    return success;
  }

  /**
   * Process credit purchase from Stripe
   * $10 = 1000 credits conversion
   */
  async processCreditPurchase(userId: string, amountInCents: number, stripeSessionId: string): Promise<boolean> {
    // Convert dollars to credits: $10 = 1000 credits, so $1 = 100 credits
    const credits = Math.floor((amountInCents / 100) * 100);

    console.log(`💳 Processing credit purchase: $${amountInCents / 100} = ${credits} credits for user ${userId}`);

    const success = await this.addCredits(
      userId,
      credits,
      'credit_purchase',
      `Credit purchase - Stripe Session: ${stripeSessionId.substring(0, 12)}...`
    );

    return success;
  }

  /**
   * Check if user has an active subscription
   */
  async isActiveSubscriber(userId: string): Promise<boolean> {
    try {
      const [user] = await db
        .select({ stripeSubscriptionId: users.stripeSubscriptionId })
        .from(users)
        .where(eq(users.id, userId));

      if (!user?.stripeSubscriptionId) {
        return false;
      }

      // Import dynamically to avoid circular dependency
      const { subscriptionService } = await import('./subscription-service');
      const status = await subscriptionService.getSubscriptionStatus(userId);
      return status.hasActiveSubscription;
    } catch (error) {
      console.error('Error checking subscriber status:', error);
      return false;
    }
  }

  /**
   * Calculate credit cost for video processing options
   * Subscribers get 50% off (pay base rate), non-subscribers pay 2×
   */
  async calculateProcessingCost(
    userId: string | null,
    options: {
      timestampCount: number;
      aspectRatios: string[];
      generateGif: boolean;
      generateThumbnails: boolean;
      generateCanvas: boolean;
    }
  ): Promise<{ cost: number; isSubscriber: boolean; savings: number; subscriberCost: number }> {
    // Check subscription status
    const isSubscriber = userId ? await this.isActiveSubscriber(userId) : false;
    const multiplier = isSubscriber ? 1 : CREDIT_COSTS.NON_SUBSCRIBER_MULTIPLIER;

    let baseCredits = 0;

    // Cutdowns: base 50 credits per cutdown
    if (options.timestampCount > 0 && options.aspectRatios.length > 0) {
      const cutdownsCount = options.timestampCount * options.aspectRatios.length;
      baseCredits += cutdownsCount * CREDIT_COSTS.CUTDOWN;
    }

    // Export options
    if (options.generateGif) {
      baseCredits += CREDIT_COSTS.GIF_PACK;
    }
    if (options.generateThumbnails) {
      baseCredits += CREDIT_COSTS.THUMBNAIL_PACK;
    }
    if (options.generateCanvas) {
      baseCredits += CREDIT_COSTS.CANVAS_PACK;
    }

    const cost = baseCredits * multiplier;
    const subscriberCost = baseCredits; // What a subscriber would pay
    const savings = isSubscriber ? baseCredits : 0; // What they saved by subscribing

    return { cost, isSubscriber, savings, subscriberCost };
  }

  /**
   * Calculate credit cost synchronously (for backwards compatibility)
   * Uses non-subscriber rates by default
   */
  calculateProcessingCostSync(options: {
    timestampCount: number;
    aspectRatios: string[];
    generateGif: boolean;
    generateThumbnails: boolean;
    generateCanvas: boolean;
  }): number {
    let baseCredits = 0;

    // Cutdowns: base 50 credits per cutdown × 2 for non-subscriber
    if (options.timestampCount > 0 && options.aspectRatios.length > 0) {
      const cutdownsCount = options.timestampCount * options.aspectRatios.length;
      baseCredits += cutdownsCount * CREDIT_COSTS.CUTDOWN;
    }

    // Export options
    if (options.generateGif) {
      baseCredits += CREDIT_COSTS.GIF_PACK;
    }
    if (options.generateThumbnails) {
      baseCredits += CREDIT_COSTS.THUMBNAIL_PACK;
    }
    if (options.generateCanvas) {
      baseCredits += CREDIT_COSTS.CANVAS_PACK;
    }

    // Return non-subscriber rate (2×) by default
    return baseCredits * CREDIT_COSTS.NON_SUBSCRIBER_MULTIPLIER;
  }

  /**
   * Process video processing payment with credits
   */
  async processVideoProcessing(
    userId: string,
    options: {
      timestampCount: number;
      aspectRatios: string[];
      generateGif: boolean;
      generateThumbnails: boolean;
      generateCanvas: boolean;
    },
    videoId: number
  ): Promise<{ success: boolean; cost: number; remainingCredits?: number; isSubscriber: boolean; savings: number }> {
    const costResult = await this.calculateProcessingCost(userId, options);
    const { cost, isSubscriber, savings } = costResult;

    // Check if user has enough credits
    const currentCredits = await this.getUserCredits(userId);
    if (currentCredits < cost) {
      console.log(`❌ User ${userId} has insufficient credits: ${currentCredits} < ${cost}`);
      return { success: false, cost, isSubscriber, savings };
    }

    // Deduct credits
    const success = await this.deductCredits(
      userId,
      cost,
      `Video processing (ID: ${videoId})${isSubscriber ? ' - Subscriber rate' : ''}`
    );

    if (success) {
      const remainingCredits = await this.getUserCredits(userId);
      console.log(`✅ Charged ${cost} credits for video ${videoId} (subscriber: ${isSubscriber}, saved: ${savings})`);
      return { success: true, cost, remainingCredits, isSubscriber, savings };
    }

    return { success: false, cost, isSubscriber, savings };
  }

  /**
   * Get pricing info for display (both subscriber and non-subscriber rates)
   */
  getPricingInfo(): {
    subscriberRates: typeof CREDIT_COSTS;
    nonSubscriberMultiplier: number;
  } {
    return {
      subscriberRates: CREDIT_COSTS,
      nonSubscriberMultiplier: CREDIT_COSTS.NON_SUBSCRIBER_MULTIPLIER
    };
  }
}

export const creditService = new CreditService();