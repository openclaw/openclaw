/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Referral Routes
 * API endpoints for referral system functionality
 */

import { Router } from 'express';
import { optionalAuth, requireAuth } from './auth-middleware';
import { referralService } from './services/referral-service';
import { referralCodeSchema, redeemCreditSchema } from '@shared/schema';
import { z } from 'zod';

const router = Router();

// Track referral visit (no auth required)
router.post('/track', optionalAuth, async (req, res) => {
  try {
    const { referralCode, sessionId, landingPage } = req.body;
    
    if (!referralCode || !sessionId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const ipAddress = req.ip || req.connection.remoteAddress || 'unknown';
    const userAgent = req.get('User-Agent') || 'unknown';

    const tracked = await referralService.trackReferralVisit(
      referralCode,
      sessionId,
      ipAddress,
      userAgent,
      landingPage || '/'
    );

    res.json({ 
      success: tracked,
      message: tracked ? 'Referral tracked' : 'Referral tracking failed or duplicate'
    });
  } catch (error) {
    console.error('❌ Error tracking referral:', error);
    res.status(500).json({ error: 'Failed to track referral' });
  }
});

// Process referral signup (called during auth flow)
router.post('/signup', requireAuth, async (req, res) => {
  try {
    const { sessionId } = req.body;
    
    if (!req.user || !sessionId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const ipAddress = req.ip || req.connection.remoteAddress || 'unknown';
    const userAgent = req.get('User-Agent') || 'unknown';

    const rewards = await referralService.processReferralSignup(
      req.user.email,
      req.user.id,
      sessionId,
      ipAddress,
      userAgent
    );

    res.json({ 
      success: !!rewards,
      rewards: rewards || null
    });
  } catch (error) {
    console.error('❌ Error processing referral signup:', error);
    res.status(500).json({ error: 'Failed to process referral signup' });
  }
});

// Process first export bonus
router.post('/first-export', requireAuth, async (req, res) => {
  try {
    const { exportId } = req.body;
    
    if (!req.user) {
      return res.status(401).json({ error: 'User not found' });
    }

    const bonusAwarded = await referralService.processFirstExport(req.user.id, exportId);

    res.json({ 
      success: bonusAwarded,
      message: bonusAwarded ? 'First export bonus awarded to referrer' : 'No bonus applicable'
    });
  } catch (error) {
    console.error('❌ Error processing first export bonus:', error);
    res.status(500).json({ error: 'Failed to process first export bonus' });
  }
});

// Get user's referral stats
router.get('/stats', requireAuth, async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not found' });
    }

    const stats = await referralService.getReferralStats(req.user.id);

    res.json({ stats });
  } catch (error) {
    console.error('❌ Error getting referral stats:', error);
    res.status(500).json({ error: 'Failed to get referral stats' });
  }
});

// Generate or get user's referral code
router.get('/code', requireAuth, async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not found' });
    }

    let referralCode = req.user.referralCode;
    
    // Generate code if user doesn't have one
    if (!referralCode) {
      referralCode = await referralService.generateReferralCode(req.user.id);
    }

    const referralUrl = referralService.generateReferralUrl(referralCode);

    res.json({ 
      referralCode,
      referralUrl,
      shareMessage: `Transform your music videos into viral content with CUTMV! 🎵✨ Join using my referral link and start creating professional clips instantly: ${referralUrl}`,
      socialShareText: `🎬 Discover CUTMV - AI-powered video editing for creators! Transform your music videos into clips, GIFs, and thumbnails in seconds. Sign up with my link: ${referralUrl} #CUTMV #VideoEditing #MusicVideo`,
      emailShareText: `Hey! I wanted to share CUTMV with you - it's an amazing AI-powered video editing platform that helps creators turn music videos into viral content.\n\nWith CUTMV you can:\n• Create perfect video clips from timestamps\n• Generate eye-catching GIFs and thumbnails\n• Export optimized content for all platforms\n• Professional quality with zero watermarks\n\nUse my referral link to get started: ${referralUrl}\n\nThanks!\n`,
      canCustomize: true
    });
  } catch (error) {
    console.error('❌ Error getting referral code:', error);
    res.status(500).json({ error: 'Failed to get referral code' });
  }
});

// Update/customize referral code
router.put('/code', requireAuth, async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not found' });
    }

    const { newCode } = req.body;
    
    if (!newCode || typeof newCode !== 'string') {
      return res.status(400).json({ error: 'New code is required' });
    }

    const success = await referralService.updateReferralCode(req.user.id, newCode);
    
    if (!success) {
      return res.status(400).json({ error: 'Code already taken or invalid format' });
    }

    const referralUrl = referralService.generateReferralUrl(newCode.toLowerCase());

    res.json({ 
      success: true,
      referralCode: newCode.toLowerCase(),
      referralUrl,
      message: 'Referral code updated successfully'
    });
  } catch (error) {
    console.error('❌ Error updating referral code:', error);
    res.status(500).json({ error: 'Failed to update referral code' });
  }
});

// Redeem credits
router.post('/redeem', requireAuth, async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not found' });
    }

    const validation = redeemCreditSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Invalid request data' });
    }

    const { amount, purpose } = validation.data;

    const success = await referralService.redeemCredits(req.user.id, amount, purpose);

    if (!success) {
      return res.status(400).json({ error: 'Failed to redeem credits' });
    }

    res.json({ 
      success: true,
      message: `${amount} credits redeemed for ${purpose}`,
      remainingCredits: (req.user.credits || 0) - amount
    });
  } catch (error) {
    console.error('❌ Error redeeming credits:', error);
    if (error instanceof Error) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to redeem credits' });
    }
  }
});

// Validate referral code
router.post('/validate', async (req, res) => {
  try {
    const validation = referralCodeSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Invalid referral code format' });
    }

    const { code } = validation.data;

    // Check if code exists in database
    const { db } = await import('./db');
    const { users } = await import('@shared/schema');
    const { eq } = await import('drizzle-orm');

    const [user] = await db.select()
      .from(users)
      .where(eq(users.referralCode, code));

    res.json({ 
      valid: !!user,
      message: user ? 'Valid referral code' : 'Invalid referral code'
    });
  } catch (error) {
    console.error('❌ Error validating referral code:', error);
    res.status(500).json({ error: 'Failed to validate referral code' });
  }
});

// Analytics endpoint for referral data
router.get('/admin/analytics', requireAuth, async (req, res) => {
  try {
    // TODO: Add admin role check
    if (!req.user) {
      return res.status(401).json({ error: 'Admin access required' });
    }

    const analytics = await referralService.getAdminAnalytics();

    res.json({ analytics });
  } catch (error) {
    console.error('❌ Error getting admin analytics:', error);
    res.status(500).json({ error: 'Failed to get admin analytics' });
  }
});

export default router;