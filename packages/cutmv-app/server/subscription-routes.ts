/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Subscription API Routes
 * Subscription management endpoints
 */

import { Router } from 'express';
import { subscriptionService } from './services/subscription-service';
import { requireAuth } from './auth-middleware';

const router = Router();

/**
 * Get available subscription plans
 */
router.get('/plans', async (req, res) => {
  try {
    const plans = subscriptionService.getPlans();

    res.json({
      success: true,
      plans
    });
  } catch (error) {
    console.error('Error getting plans:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get subscription plans'
    });
  }
});

/**
 * Get user's current subscription status
 */
router.get('/status', requireAuth, async (req, res) => {
  try {
    const status = await subscriptionService.getSubscriptionStatus(req.user!.id);

    res.json({
      success: true,
      ...status
    });
  } catch (error) {
    console.error('Error getting subscription status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get subscription status'
    });
  }
});

/**
 * Create a subscription checkout session
 */
router.post('/create-checkout', requireAuth, async (req, res) => {
  try {
    const { planId } = req.body;

    console.log('📦 Create checkout request:', {
      planId,
      userId: req.user!.id,
      email: req.user!.email
    });

    if (!planId) {
      return res.status(400).json({
        success: false,
        error: 'Plan ID is required'
      });
    }

    const baseUrl = process.env.NODE_ENV === 'production'
      ? 'https://cutmv.fulldigitalll.com'
      : `http://localhost:${process.env.PORT || 3000}`;

    const checkoutUrl = await subscriptionService.createCheckoutSession(
      req.user!.id,
      req.user!.email,
      planId,
      `${baseUrl}/app/subscription/success`,
      `${baseUrl}/app/subscription`
    );

    console.log('✅ Checkout URL created:', checkoutUrl);

    res.json({
      success: true,
      checkoutUrl
    });
  } catch (error) {
    console.error('❌ Error creating checkout session:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create checkout session'
    });
  }
});

/**
 * Cancel subscription (at period end)
 */
router.post('/cancel', requireAuth, async (req, res) => {
  try {
    const success = await subscriptionService.cancelSubscription(req.user!.id);

    if (success) {
      res.json({
        success: true,
        message: 'Subscription will be canceled at the end of the billing period'
      });
    } else {
      res.status(400).json({
        success: false,
        error: 'Failed to cancel subscription'
      });
    }
  } catch (error) {
    console.error('Error canceling subscription:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to cancel subscription'
    });
  }
});

/**
 * Reactivate a canceled subscription
 */
router.post('/reactivate', requireAuth, async (req, res) => {
  try {
    const success = await subscriptionService.reactivateSubscription(req.user!.id);

    if (success) {
      res.json({
        success: true,
        message: 'Subscription reactivated successfully'
      });
    } else {
      res.status(400).json({
        success: false,
        error: 'Failed to reactivate subscription'
      });
    }
  } catch (error) {
    console.error('Error reactivating subscription:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to reactivate subscription'
    });
  }
});

export default router;
