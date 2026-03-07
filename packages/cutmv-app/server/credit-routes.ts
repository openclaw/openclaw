/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Credit System API Routes
 * Complete credit wallet management and usage tracking
 */

import { Router } from 'express';
import { creditService } from './services/credit-service';
import { requireAuth } from './auth-middleware';
import Stripe from 'stripe';

const router = Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2025-07-30.basil',
});

/**
 * Get user's current credit balance
 */
router.get('/balance', requireAuth, async (req, res) => {
  try {
    const credits = await creditService.getUserCredits(req.user!.id);
    
    res.json({
      success: true,
      credits,
      userId: req.user!.id
    });
  } catch (error) {
    console.error('Error getting credit balance:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get credit balance'
    });
  }
});

/**
 * Get user's credit transaction history
 */
router.get('/history', requireAuth, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const history = await creditService.getCreditHistory(req.user!.id, limit);
    
    res.json({
      success: true,
      history,
      total: history.length
    });
  } catch (error) {
    console.error('Error getting credit history:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get credit history'
    });
  }
});

/**
 * Check if user can afford export
 */
router.get('/can-afford/:cost?', requireAuth, async (req, res) => {
  try {
    const cost = parseInt(req.params.cost || '1');
    const canAfford = await creditService.canAffordExport(req.user!.id, cost);
    const currentCredits = await creditService.getUserCredits(req.user!.id);
    
    res.json({
      success: true,
      canAfford,
      currentCredits,
      requiredCredits: cost,
      shortfall: canAfford ? 0 : Math.max(0, cost - currentCredits)
    });
  } catch (error) {
    console.error('Error checking affordability:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check affordability'
    });
  }
});

/**
 * Process export payment with credits
 */
router.post('/pay-for-export', requireAuth, async (req, res) => {
  try {
    const { cost = 1, note } = req.body;
    
    const success = await creditService.processExportPayment(req.user!.id, cost);
    
    if (success) {
      const remainingCredits = await creditService.getUserCredits(req.user!.id);
      
      res.json({
        success: true,
        message: `Successfully deducted ${cost} credit(s)`,
        remainingCredits,
        deductedAmount: cost
      });
    } else {
      res.status(400).json({
        success: false,
        error: 'Insufficient credits for export'
      });
    }
  } catch (error) {
    console.error('Error processing credit payment:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process credit payment'
    });
  }
});

/**
 * Process first export bonus (one-time only)
 */
router.post('/first-export-bonus', requireAuth, async (req, res) => {
  try {
    const success = await creditService.processFirstExportBonus(req.user!.id);

    if (success) {
      const currentCredits = await creditService.getUserCredits(req.user!.id);

      res.json({
        success: true,
        message: 'First export bonus granted!',
        bonusAmount: 1,
        currentCredits
      });
    } else {
      res.json({
        success: false,
        message: 'First export bonus already claimed or not eligible'
      });
    }
  } catch (error) {
    console.error('Error processing first export bonus:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process first export bonus'
    });
  }
});

/**
 * Calculate credit cost for processing options
 * Returns subscriber-aware pricing with both rates
 */
router.post('/calculate-cost', requireAuth, async (req, res) => {
  try {
    const { timestampText, aspectRatios = [], generateGif = false, generateThumbnails = false, generateCanvas = false } = req.body;

    // Count timestamps
    const timestampCount = timestampText
      ? timestampText.split('\n').filter((line: string) => line.trim() && line.match(/\d+:\d+\s*-\s*\d+:\d+/)).length
      : 0;

    // Use async method with subscriber awareness
    const costResult = await creditService.calculateProcessingCost(req.user!.id, {
      timestampCount,
      aspectRatios,
      generateGif,
      generateThumbnails,
      generateCanvas
    });

    const { cost, isSubscriber, savings, subscriberCost } = costResult;
    const currentCredits = await creditService.getUserCredits(req.user!.id);
    const canAfford = currentCredits >= cost;

    // Calculate breakdown with subscriber-aware rates
    const cutdownRate = isSubscriber ? 50 : 100;
    const gifRate = isSubscriber ? 90 : 180;
    const thumbRate = isSubscriber ? 90 : 180;
    const canvasRate = isSubscriber ? 225 : 450;

    res.json({
      success: true,
      cost,
      currentCredits,
      canAfford,
      shortfall: canAfford ? 0 : cost - currentCredits,

      // Subscriber info
      isSubscriber,
      subscriberCost,
      potentialSavings: isSubscriber ? 0 : subscriberCost,

      breakdown: {
        cutdowns: timestampCount > 0 && aspectRatios.length > 0 ? timestampCount * aspectRatios.length * cutdownRate : 0,
        gifPack: generateGif ? gifRate : 0,
        thumbnailPack: generateThumbnails ? thumbRate : 0,
        canvas: generateCanvas ? canvasRate : 0
      }
    });
  } catch (error) {
    console.error('Error calculating credit cost:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to calculate credit cost'
    });
  }
});

// Credit refill packages - tiered pricing with bonus credits at higher tiers
const CREDIT_PACKAGES: Record<number, number> = {
  5: 500,    // $5 = 500 credits
  10: 1000,  // $10 = 1,000 credits
  25: 3000,  // $25 = 3,000 credits (20% bonus)
};

/**
 * Create Stripe checkout session for credit purchase
 */
router.post('/purchase', requireAuth, async (req, res) => {
  try {
    const { amount } = req.body; // Amount in dollars (e.g., 5, 10, 25)

    if (!amount || amount < 5) {
      return res.status(400).json({
        success: false,
        error: 'Minimum purchase amount is $5'
      });
    }

    // Calculate credits based on package or linear rate
    let credits: number;
    if (CREDIT_PACKAGES[amount]) {
      credits = CREDIT_PACKAGES[amount];
    } else {
      // Linear rate for other amounts: $1 = 100 credits
      credits = amount * 100;
    }

    // Create Stripe checkout session for credit purchase
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `${credits.toLocaleString()} CUTMV Credits`,
            description: `Credit package: $${amount} = ${credits.toLocaleString()} credits`,
          },
          unit_amount: amount * 100, // Convert to cents
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${req.headers.origin}/dashboard?purchase=success&credits=${credits}`,
      cancel_url: `${req.headers.origin}/dashboard?purchase=cancelled`,
      customer_email: req.user!.email,
      metadata: {
        type: 'credit_purchase',
        userId: req.user!.id,
        credits: credits.toString(),
        amountDollars: amount.toString()
      }
    });

    console.log(`💳 Credit purchase checkout created: ${credits} credits for user ${req.user!.id}`);

    res.json({
      success: true,
      sessionId: session.id,
      checkoutUrl: session.url,
      credits
    });
  } catch (error) {
    console.error('Error creating credit purchase checkout:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create checkout session'
    });
  }
});

/**
 * Get available credit packages
 */
router.get('/packages', requireAuth, async (req, res) => {
  res.json({
    success: true,
    packages: Object.entries(CREDIT_PACKAGES).map(([amount, credits]) => ({
      amount: parseInt(amount),
      credits,
      popular: amount === '10'
    }))
  });
});

export default router;