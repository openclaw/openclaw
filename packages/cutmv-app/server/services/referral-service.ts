/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Referral Service
 * Complete DIY referral system with credit tracking and abuse prevention
 */

import { db } from '../db';
import { users, referralEvents, creditTransactions, referralTracking } from '@shared/schema';
import { eq, and, desc, gte, count, sum } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import crypto from 'crypto';
import { creditService } from './credit-service';

export interface ReferralStats {
  totalReferrals: number;
  creditsEarned: number;
  creditsSpent: number;
  creditsAvailable: number;
  recentReferrals: Array<{
    email: string;
    eventType: string;
    createdAt: Date;
    creditsEarned: number;
  }>;
  creditHistory: Array<{
    type: string;
    amount: number;
    note: string;
    createdAt: Date;
    expiresAt?: Date;
  }>;
}

export interface ReferralRewards {
  referrerCredits: number;
  referredBonus?: string;
  requiresFirstExport?: boolean;
}

class ReferralService {
  // Generate unique referral code for user
  async generateReferralCode(userId: string): Promise<string> {
    const baseCode = nanoid(8).toLowerCase();
    
    // Ensure uniqueness
    const existing = await db.select().from(users).where(eq(users.referralCode, baseCode));
    if (existing.length > 0) {
      return this.generateReferralCode(userId); // Recursively try again
    }
    
    // Update user with referral code
    await db.update(users)
      .set({ referralCode: baseCode })
      .where(eq(users.id, userId));
      
    console.log(`🎁 Generated referral code '${baseCode}' for user ${userId}`);
    return baseCode;
  }

  // Generate referral URL for a given code - PRODUCTION ONLY
  generateReferralUrl(referralCode: string): string {
    const customDomain = process.env.CUSTOM_DOMAIN || process.env.DOMAIN || 'cutmv.fulldigitalll.com';
    
    // Always use secure HTTPS production domain
    const baseUrl = customDomain.startsWith('http') ? customDomain : `https://${customDomain}`;
    
    return `${baseUrl}/referral/${referralCode}`;
  }

  // Update referral code (allow customization)
  async updateReferralCode(userId: string, newCode: string): Promise<boolean> {
    try {
      // Validate code format (alphanumeric, 3-15 characters)
      if (!/^[a-zA-Z0-9]{3,15}$/.test(newCode)) {
        throw new Error('Invalid code format');
      }
      
      // Check if code is already taken
      const existing = await db.select().from(users).where(eq(users.referralCode, newCode.toLowerCase()));
      if (existing.length > 0) {
        throw new Error('Code already taken');
      }
      
      // Update user's referral code
      await db.update(users)
        .set({ referralCode: newCode.toLowerCase() })
        .where(eq(users.id, userId));
        
      console.log(`🔄 Updated referral code to '${newCode}' for user ${userId}`);
      return true;
    } catch (error) {
      console.error('❌ Error updating referral code:', error);
      return false;
    }
  }

  // Track referral when user visits with ?ref= parameter
  async trackReferralVisit(
    referralCode: string, 
    sessionId: string, 
    ipAddress: string,
    userAgent: string,
    landingPage: string
  ): Promise<boolean> {
    try {
      // Check if referral code exists
      const [referrer] = await db.select()
        .from(users)
        .where(eq(users.referralCode, referralCode));
        
      if (!referrer) {
        console.log(`⚠️ Invalid referral code: ${referralCode}`);
        return false;
      }

      // Check for duplicate tracking (same session or recent IP)
      const recentTracking = await db.select()
        .from(referralTracking)
        .where(
          and(
            eq(referralTracking.referralCode, referralCode),
            gte(referralTracking.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1000)) // 24 hours
          )
        );

      const duplicateSession = recentTracking.find(t => t.sessionId === sessionId);
      const duplicateIP = recentTracking.find(t => t.ipAddress === ipAddress);
      
      if (duplicateSession || duplicateIP) {
        console.log(`⚠️ Duplicate referral tracking blocked for ${referralCode}`);
        return false;
      }

      // Create tracking record
      await db.insert(referralTracking).values({
        sessionId,
        referralCode,
        ipAddress,
        userAgent,
        landingPage,
        converted: false,
      });

      console.log(`📊 Tracked referral visit: ${referralCode} -> ${landingPage}`);
      return true;
    } catch (error) {
      console.error('❌ Error tracking referral visit:', error);
      return false;
    }
  }

  // Process referral when user signs up
  async processReferralSignup(
    userEmail: string,
    userId: string,
    sessionId: string,
    ipAddress: string,
    userAgent: string
  ): Promise<ReferralRewards | null> {
    try {
      // Find active referral tracking for this session
      const [tracking] = await db.select()
        .from(referralTracking)
        .where(
          and(
            eq(referralTracking.sessionId, sessionId),
            eq(referralTracking.converted, false)
          )
        );

      if (!tracking) {
        console.log(`ℹ️ No referral tracking found for signup: ${userEmail}`);
        return null;
      }

      // Find the referrer
      const [referrer] = await db.select()
        .from(users)
        .where(eq(users.referralCode, tracking.referralCode));

      if (!referrer) {
        console.log(`⚠️ Referrer not found for code: ${tracking.referralCode}`);
        return null;
      }

      // Prevent self-referral
      if (referrer.id === userId) {
        console.log(`⚠️ Self-referral blocked for user: ${userEmail}`);
        return null;
      }

      // Check rate limiting (max 5 credits per week)
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const recentCredits = await db.select({ count: count() })
        .from(creditTransactions)
        .where(
          and(
            eq(creditTransactions.userId, referrer.id),
            eq(creditTransactions.transactionType, 'earned'),
            gte(creditTransactions.createdAt, weekAgo)
          )
        );

      if (recentCredits[0].count >= 5) {
        console.log(`⚠️ Rate limit exceeded for referrer: ${referrer.email}`);
        return null;
      }

      // Update user with referral info
      await db.update(users)
        .set({ referredBy: tracking.referralCode })
        .where(eq(users.id, userId));

      // Create referral event
      const [referralEvent] = await db.insert(referralEvents)
        .values({
          referrerId: referrer.id,
          referredId: userId,
          eventType: 'signup',
          ipAddress,
          userAgent,
        })
        .returning();

      // Award signup credit to referrer (1 credit)
      const creditExpiry = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000); // 60 days
      await db.insert(creditTransactions).values({
        userId: referrer.id,
        transactionType: 'earned',
        amount: 1,
        note: `Referral signup: ${userEmail}`,
        referralEventId: referralEvent.id,
        expiresAt: creditExpiry,
      });

      // Update referrer's credit balance and count
      await db.update(users)
        .set({
          credits: (referrer.credits || 0) + 1,
          referralCount: (referrer.referralCount || 0) + 1,
          lastCreditGrantAt: new Date(),
        })
        .where(eq(users.id, referrer.id));

      // Mark tracking as converted
      await db.update(referralTracking)
        .set({
          converted: true,
          convertedUserId: userId,
        })
        .where(eq(referralTracking.id, tracking.id));

      console.log(`🎉 Referral signup processed: ${referrer.email} -> ${userEmail} (+1 credit)`);

      return {
        referrerCredits: 1,
        referredBonus: 'Welcome bonus: First export eligible for premium features',
        requiresFirstExport: true,
      };
    } catch (error) {
      console.error('❌ Error processing referral signup:', error);
      return null;
    }
  }

  // Award bonus credit when referred user completes first export
  async processFirstExport(userId: string, exportId: string): Promise<boolean> {
    try {
      const [user] = await db.select().from(users).where(eq(users.id, userId));
      
      if (!user?.referredBy) {
        return false; // Not a referred user
      }

      // Check if this is actually their first export
      const existingBonus = await db.select()
        .from(referralEvents)
        .where(
          and(
            eq(referralEvents.referredId, userId),
            eq(referralEvents.eventType, 'first_export')
          )
        );

      if (existingBonus.length > 0) {
        return false; // Already awarded first export bonus
      }

      // Find the referrer
      const [referrer] = await db.select()
        .from(users)
        .where(eq(users.referralCode, user.referredBy));

      if (!referrer) {
        console.log(`⚠️ Referrer not found for user: ${user.email}`);
        return false;
      }

      // Create first export event
      const [referralEvent] = await db.insert(referralEvents)
        .values({
          referrerId: referrer.id,
          referredId: userId,
          eventType: 'first_export',
          ipAddress: null,
          userAgent: null,
        })
        .returning();

      // Award bonus credit to referrer (1 additional credit)
      const creditExpiry = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000); // 60 days
      await db.insert(creditTransactions).values({
        userId: referrer.id,
        transactionType: 'earned',
        amount: 1,
        note: `First export bonus: ${user.email}`,
        referralEventId: referralEvent.id,
        expiresAt: creditExpiry,
      });

      // Update referrer's credit balance
      await db.update(users)
        .set({
          credits: (referrer.credits || 0) + 1,
          lastCreditGrantAt: new Date(),
        })
        .where(eq(users.id, referrer.id));

      console.log(`🎉 First export bonus awarded: ${referrer.email} -> ${user.email} (+1 credit)`);
      return true;
    } catch (error) {
      console.error('❌ Error processing first export bonus:', error);
      return false;
    }
  }

  // Redeem credits for watermark-free processing
  async redeemCredits(userId: string, amount: number, purpose: string): Promise<boolean> {
    try {
      const [user] = await db.select().from(users).where(eq(users.id, userId));
      
      if (!user) {
        throw new Error('User not found');
      }

      const currentCredits = user.credits || 0;
      if (currentCredits < amount) {
        throw new Error('Insufficient credits');
      }

      // Create redemption transaction
      await db.insert(creditTransactions).values({
        userId,
        transactionType: 'spent',
        amount: -amount,
        note: purpose,
        referralEventId: null,
        expiresAt: null,
      });

      // Update user's credit balance
      await db.update(users)
        .set({ credits: currentCredits - amount })
        .where(eq(users.id, userId));

      console.log(`💳 Credits redeemed: ${user.email} -${amount} credits for ${purpose}`);
      return true;
    } catch (error) {
      console.error('❌ Error redeeming credits:', error);
      return false;
    }
  }

  // Get referral stats for user dashboard
  async getReferralStats(userId: string): Promise<ReferralStats> {
    try {
      const [user] = await db.select().from(users).where(eq(users.id, userId));
      
      if (!user) {
        throw new Error('User not found');
      }

      // Get recent referrals with credit info
      const recentReferrals = await db.select({
        email: users.email,
        eventType: referralEvents.eventType,
        createdAt: referralEvents.createdAt,
        creditsEarned: creditTransactions.amount,
      })
        .from(referralEvents)
        .leftJoin(users, eq(referralEvents.referredId, users.id))
        .leftJoin(creditTransactions, eq(referralEvents.id, creditTransactions.referralEventId))
        .where(eq(referralEvents.referrerId, userId))
        .orderBy(desc(referralEvents.createdAt))
        .limit(10);

      // Get credit history
      const creditHistory = await db.select({
        type: creditTransactions.transactionType,
        amount: creditTransactions.amount,
        note: creditTransactions.note,
        createdAt: creditTransactions.createdAt,
        expiresAt: creditTransactions.expiresAt,
      })
        .from(creditTransactions)
        .where(eq(creditTransactions.userId, userId))
        .orderBy(desc(creditTransactions.createdAt))
        .limit(20);

      // Calculate totals
      const creditsEarnedResult = await db.select({ total: sum(creditTransactions.amount) })
        .from(creditTransactions)
        .where(
          and(
            eq(creditTransactions.userId, userId),
            eq(creditTransactions.transactionType, 'earned')
          )
        );

      const creditsSpentResult = await db.select({ total: sum(creditTransactions.amount) })
        .from(creditTransactions)
        .where(
          and(
            eq(creditTransactions.userId, userId),
            eq(creditTransactions.transactionType, 'spent')
          )
        );

      const creditsEarned = Number(creditsEarnedResult[0]?.total || 0);
      const creditsSpent = Math.abs(Number(creditsSpentResult[0]?.total || 0));

      return {
        totalReferrals: user.referralCount || 0,
        creditsEarned,
        creditsSpent,
        creditsAvailable: user.credits || 0,
        recentReferrals: recentReferrals.map(r => ({
          email: r.email || 'Unknown',
          eventType: r.eventType,
          createdAt: r.createdAt || new Date(),
          creditsEarned: r.creditsEarned || 0,
        })),
        creditHistory: creditHistory.map(c => ({
          type: c.type,
          amount: c.amount,
          note: c.note || '',
          createdAt: c.createdAt || new Date(),
          expiresAt: c.expiresAt || undefined,
        })),
      };
    } catch (error) {
      console.error('❌ Error getting referral stats:', error);
      throw error;
    }
  }

  // Cleanup expired credits (run as scheduled job)
  async cleanupExpiredCredits(): Promise<number> {
    try {
      const now = new Date();
      
      // Find expired credits
      const expiredCredits = await db.select()
        .from(creditTransactions)
        .where(
          and(
            eq(creditTransactions.transactionType, 'earned'),
            gte(creditTransactions.expiresAt, now)
          )
        );

      let totalExpired = 0;

      for (const credit of expiredCredits) {
        // Create expiration transaction
        await db.insert(creditTransactions).values({
          userId: credit.userId,
          transactionType: 'expired',
          amount: -credit.amount,
          note: `Credit expired: ${credit.note}`,
          referralEventId: credit.referralEventId,
          expiresAt: null,
        });

        // Update user's credit balance
        const [user] = await db.select().from(users).where(eq(users.id, credit.userId));
        if (user) {
          await db.update(users)
            .set({ credits: Math.max(0, (user.credits || 0) - credit.amount) })
            .where(eq(users.id, credit.userId));
        }

        totalExpired += credit.amount;
      }

      console.log(`🧹 Cleaned up ${totalExpired} expired credits`);
      return totalExpired;
    } catch (error) {
      console.error('❌ Error cleaning up expired credits:', error);
      return 0;
    }
  }

  // Get admin analytics
  async getAdminAnalytics(): Promise<{
    totalReferrals: number;
    totalCreditsIssued: number;
    totalCreditsRedeemed: number;
    topReferrers: Array<{ email: string; referrals: number; creditsEarned: number }>;
    conversionRate: number;
  }> {
    try {
      // Total referral events
      const totalReferralsResult = await db.select({ count: count() })
        .from(referralEvents);

      // Total credits issued and redeemed
      const creditsIssuedResult = await db.select({ total: sum(creditTransactions.amount) })
        .from(creditTransactions)
        .where(eq(creditTransactions.transactionType, 'earned'));

      const creditsRedeemedResult = await db.select({ total: sum(creditTransactions.amount) })
        .from(creditTransactions)
        .where(eq(creditTransactions.transactionType, 'spent'));

      // Top referrers
      const topReferrers = await db.select({
        email: users.email,
        referrals: users.referralCount,
        creditsEarned: users.credits,
      })
        .from(users)
        .where(gte(users.referralCount, 1))
        .orderBy(desc(users.referralCount))
        .limit(10);

      // Conversion rate (referral visits vs signups)
      const totalVisitsResult = await db.select({ count: count() })
        .from(referralTracking);
      
      const convertedVisitsResult = await db.select({ count: count() })
        .from(referralTracking)
        .where(eq(referralTracking.converted, true));

      const conversionRate = totalVisitsResult[0].count > 0 
        ? (convertedVisitsResult[0].count / totalVisitsResult[0].count) * 100 
        : 0;

      return {
        totalReferrals: totalReferralsResult[0].count,
        totalCreditsIssued: Number(creditsIssuedResult[0]?.total || 0),
        totalCreditsRedeemed: Math.abs(Number(creditsRedeemedResult[0]?.total || 0)),
        topReferrers: topReferrers.map(r => ({
          email: r.email,
          referrals: r.referrals || 0,
          creditsEarned: r.creditsEarned || 0,
        })),
        conversionRate,
      };
    } catch (error) {
      console.error('❌ Error getting admin analytics:', error);
      throw error;
    }
  }



  // Hash IP for privacy-compliant abuse prevention
  private hashIP(ip: string): string {
    return crypto.createHash('sha256').update(ip + 'cutmv-salt').digest('hex').substring(0, 16);
  }
}

export const referralService = new ReferralService();