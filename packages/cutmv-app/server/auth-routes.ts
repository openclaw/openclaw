/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Authentication Routes
 * Magic link authentication endpoints
 */

import { Router } from 'express';
import { authService } from './auth-service';
import { insertUserSchema } from '@shared/schema';
import { z } from 'zod';
import Stripe from 'stripe';
import passport from './passport-config';

// Initialize Stripe
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2025-07-30.basil' })
  : null;

const router = Router();

// Request magic link with referral support
router.post('/signin', async (req, res) => {
  try {
    const { email, callbackUrl, ref } = req.body;
    
    // Validate email
    const validatedData = insertUserSchema.parse({ email });
    
    await authService.sendMagicLink(validatedData.email, callbackUrl, ref);
    
    res.json({ 
      success: true, 
      message: 'Login link sent to your email' 
    });
  } catch (error) {
    console.error('❌ Signin error:', error);
    res.status(400).json({ 
      error: error instanceof Error ? error.message : 'Failed to send login link' 
    });
  }
});

// Verify 6-digit code and create session
router.post('/verify-code', async (req, res) => {
  try {
    const { email, code } = req.body;

    // Validate inputs
    if (!email || !code) {
      return res.status(400).json({ error: 'Email and code are required' });
    }

    // Validate email format
    const validatedData = insertUserSchema.parse({ email });

    // Verify the 6-digit code
    const { user, session } = await authService.verifyCode(validatedData.email, code);

    // Set session cookie with matching name and settings as magic link verification
    const isProduction = process.env.NODE_ENV === 'production' || !!process.env.REPLIT_DEPLOYMENT;

    res.cookie('cutmv-session', session.token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      maxAge: 90 * 24 * 60 * 60 * 1000, // 90 days (persistent login)
    });

    console.log('✅ 6-digit code verified and session created:', {
      userId: user.id,
      email: user.email,
    });

    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        onboardingCompleted: user.onboardingCompleted,
      },
    });
  } catch (error) {
    console.error('❌ Code verification error:', error);
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Invalid verification code',
    });
  }
});

// Verify magic link and create session
router.get('/verify', async (req, res) => {
  try {
    const { auth, token, email, callbackUrl } = req.query;
    
    let actualEmail, actualToken, actualCallbackUrl;
    
    // Handle new encrypted auth format or legacy format
    if (auth) {
      try {
        const { urlSecurity } = await import('./url-security.js');
        const authData = urlSecurity.decodeSessionToken(auth as string);
        actualEmail = authData.email;
        actualToken = authData.sessionId;
        actualCallbackUrl = authData.videoName;
      } catch (error) {
        console.error('Failed to decrypt auth token:', error);
        return res.status(400).json({ error: 'Invalid authentication token' });
      }
    } else {
      // Legacy format for backward compatibility
      actualEmail = email as string;
      actualToken = token as string;
      actualCallbackUrl = callbackUrl as string;
    }
    
    console.log('🔗 Magic link verification attempt:', {
      token: actualToken ? `${actualToken.toString().substring(0, 8)}...` : 'missing',
      email: actualEmail,
      callbackUrl: actualCallbackUrl,
      authFormat: auth ? 'encrypted' : 'legacy',
      host: req.get('host'),
      userAgent: req.get('user-agent')
    });
    
    if (!actualToken || !actualEmail) {
      console.log('❌ Missing token or email in magic link');
      return res.status(400).json({ error: 'Missing token or email' });
    }

    const { user, session } = await authService.verifyMagicLink(
      actualToken, 
      actualEmail
    );
    
    console.log('✅ Magic link verified successfully for:', actualEmail);
    console.log('🔄 Setting up session and redirecting to dashboard...');

    // Set session cookie with flexible domain strategy
    const isProduction = process.env.NODE_ENV === 'production' || process.env.REPLIT_DEPLOYMENT;
    const host = req.get('host') || '';
    const isCanonicalDomain = host === 'cutmv.fulldigitalll.com';
    const isRailwayDomain = host.includes('railway.app');

    const cookieOptions: any = {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 90 * 24 * 60 * 60 * 1000, // 90 days (persistent login)
    };

    // Apply secure settings based on environment
    if (isProduction) {
      cookieOptions.secure = true; // HTTPS required in production

      // Only set domain for canonical domain to enable subdomain sharing
      // For Railway domain, don't set domain so cookie works on that specific host
      if (isCanonicalDomain) {
        cookieOptions.domain = '.fulldigitalll.com'; // Domain scope for subdomain sharing
      } else if (isRailwayDomain) {
        // Railway domain - don't set domain, cookie will be host-specific
        console.log('🍪 Setting cookie for Railway domain (host-specific):', host);
      } else {
        console.warn('⚠️ Unknown production domain:', host);
      }
    } else {
      // Development settings - don't use secure or domain restrictions
      cookieOptions.secure = false;
      // No domain restriction for development
    }
    
    res.cookie('cutmv-session', session.token, cookieOptions);

    console.log('🍪 Session cookie set:', {
      tokenPreview: session.token.substring(0, 8) + '...',
      secure: cookieOptions.secure,
      domain: cookieOptions.domain || 'browser-default (no explicit domain)',
      sameSite: cookieOptions.sameSite,
      maxAge: cookieOptions.maxAge,
      httpOnly: cookieOptions.httpOnly,
      environment: process.env.NODE_ENV,
      deployment: !!process.env.REPLIT_DEPLOYMENT,
      host: req.get('host'),
      isCanonicalDomain,
      isRailwayDomain,
      userAgent: req.get('user-agent'),
      referer: req.get('referer')
    });

    // Redirect to app after successful login
    const redirectUrl = actualCallbackUrl || '/app';
    console.log('🔄 Redirecting authenticated user to:', redirectUrl);
    res.redirect(redirectUrl);
  } catch (error) {
    console.error('❌ Verify error:', error);
    res.redirect(`/login?error=${encodeURIComponent('Invalid or expired login link')}`);
  }
});

// Logout
router.post('/logout', async (req, res) => {
  try {
    const sessionToken = req.cookies['cutmv-session'];
    
    if (sessionToken) {
      await authService.logout(sessionToken);
    }
    
    // Clear cookie with canonical domain strategy
    const host = req.get('host') || '';
    const isProduction = process.env.NODE_ENV === 'production' || process.env.REPLIT_DEPLOYMENT;
    const isCanonicalDomain = host === 'cutmv.fulldigitalll.com';
    
    if (isProduction) {
      // Clear cookie with matching domain scope for proper cleanup
      res.clearCookie('cutmv-session', { 
        secure: true, 
        domain: '.fulldigitalll.com',
        sameSite: 'lax'
      });
      // Also clear consent cookie if needed
      res.clearCookie('cutmv-consent', {
        secure: true,
        domain: '.fulldigitalll.com',
        sameSite: 'lax'
      });
    } else {
      // Development - clear without domain restrictions
      res.clearCookie('cutmv-session');
      res.clearCookie('cutmv-consent');
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Logout error:', error);
    res.status(500).json({ error: 'Failed to logout' });
  }
});

// Complete onboarding
router.post('/complete-onboarding', async (req, res) => {
  try {
    const sessionToken = req.cookies['cutmv-session'];
    
    if (!sessionToken) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const auth = await authService.verifySession(sessionToken);
    if (!auth) {
      return res.status(401).json({ error: 'Invalid session' });
    }

    const { name, marketingConsent } = req.body;
    
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'Name is required' });
    }

    const updatedUser = await authService.completeOnboarding(
      auth.user.id, 
      name.trim(), 
      marketingConsent === true
    );

    res.json({ 
      success: true, 
      user: updatedUser 
    });
  } catch (error) {
    console.error('❌ Complete onboarding error:', error);
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Failed to complete onboarding' 
    });
  }
});

// Get current user
router.get('/me', async (req, res) => {
  try {
    const sessionToken = req.cookies['cutmv-session'];

    // Detailed logging for debugging magic link issues
    console.log('🔍 Auth check on /api/auth/me:', {
      hasSession: !!sessionToken,
      tokenPreview: sessionToken ? sessionToken.substring(0, 8) + '...' : 'none',
      allCookies: Object.keys(req.cookies),
      host: req.get('host'),
      origin: req.get('origin'),
      referer: req.get('referer')
    });

    if (!sessionToken) {
      console.log('❌ No session cookie found - returning 401');
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const auth = await authService.verifySession(sessionToken);
    
    if (!auth) {
      res.clearCookie('cutmv-session');
      return res.status(401).json({ error: 'Invalid session' });
    }

    res.json({
      user: auth.user
    });
  } catch (error) {
    console.error('❌ Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// Get user dashboard data
router.get('/dashboard', async (req, res) => {
  try {
    const sessionToken = req.cookies['cutmv-session'];
    
    if (!sessionToken) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const auth = await authService.verifySession(sessionToken);
    
    if (!auth) {
      res.clearCookie('cutmv-session');
      return res.status(401).json({ error: 'Invalid session' });
    }

    // Get comprehensive Supabase data
    let dashboardData: {
      user: any;
      credits: number;
      referralStats: any;
      exports: any[];
    } = {
      user: auth.user,
      credits: 0,
      referralStats: null,
      exports: []
    };

    // Note: Credits and referral stats are now handled by dedicated services
    // This endpoint returns basic dashboard structure
    res.json(dashboardData);
  } catch (error) {
    console.error('❌ Dashboard data error:', error);
    res.status(500).json({ error: 'Failed to get dashboard data' });
  }
});

// Profile management routes
router.patch('/profile', async (req, res) => {
  try {
    const { name, marketingConsent } = req.body;
    const sessionToken = req.cookies['cutmv-session'];

    if (!sessionToken) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const auth = await authService.verifySession(sessionToken);
    if (!auth) {
      return res.status(401).json({ error: 'Invalid session' });
    }

    // Update user in database
    const updatedUser = await authService.updateUserProfile(auth.user.id, {
      name: name?.trim(),
      marketingConsent: Boolean(marketingConsent)
    });

    res.json(updatedUser);
  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Billing info routes for stored payment methods
router.get('/billing/info', async (req, res) => {
  try {
    const sessionToken = req.cookies['cutmv-session'];

    if (!sessionToken) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const auth = await authService.verifySession(sessionToken);
    if (!auth) {
      return res.status(401).json({ error: 'Invalid session' });
    }

    // For now, return empty billing info since we're focusing on checkout flow
    // In the future, this would fetch stored payment methods from Stripe
    res.json({});
  } catch (error) {
    console.error('Billing info error:', error);
    res.status(500).json({ error: 'Failed to fetch billing information' });
  }
});

// Get user's saved payment methods
router.get('/billing/payment-methods', async (req, res) => {
  try {
    if (!stripe) {
      return res.json({ paymentMethods: [] });
    }

    const sessionToken = req.cookies['cutmv-session'];

    if (!sessionToken) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const auth = await authService.verifySession(sessionToken);
    if (!auth) {
      return res.status(401).json({ error: 'Invalid session' });
    }

    const { user } = auth;

    if (!user.stripeCustomerId) {
      return res.json({ paymentMethods: [] });
    }

    // Fetch payment methods from Stripe with auto-heal for invalid customers
    try {
      const paymentMethods = await stripe.paymentMethods.list({
        customer: user.stripeCustomerId,
        type: 'card',
      });

      const formattedMethods = paymentMethods.data.map(pm => ({
        id: pm.id,
        brand: pm.card?.brand || 'unknown',
        last4: pm.card?.last4 || '****',
        expMonth: pm.card?.exp_month || 0,
        expYear: pm.card?.exp_year || 0,
      }));

      res.json({ paymentMethods: formattedMethods });
    } catch (stripeError: any) {
      // AUTO-HEAL: If customer doesn't exist (test→live mode migration), clear stale ID and return empty
      if (stripeError.code === 'resource_missing' || stripeError.statusCode === 404) {
        console.warn(`⚠️ Stripe customer ${user.stripeCustomerId} not found - clearing stale ID and returning empty payment methods`);
        // Clear the stale test-mode customer ID from DB
        await authService.updateUser(user.id, { stripeCustomerId: null });
        return res.json({ paymentMethods: [] });
      }
      throw stripeError;
    }
  } catch (error) {
    console.error('Error fetching payment methods:', error);
    res.status(500).json({ error: 'Failed to fetch payment methods' });
  }
});

// Create Setup Intent for adding a payment method
router.post('/billing/setup-intent', async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: 'Payment processing is not configured' });
    }

    const sessionToken = req.cookies['cutmv-session'];

    if (!sessionToken) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const auth = await authService.verifySession(sessionToken);
    if (!auth) {
      return res.status(401).json({ error: 'Invalid session' });
    }

    const { user } = auth;

    // Get or create Stripe customer with auto-heal for test→live mode migration
    let customerId = user.stripeCustomerId;
    let needsNewCustomer = !customerId;

    // AUTO-HEAL: Verify existing customer is valid (handles test→live mode migration)
    if (customerId) {
      try {
        await stripe.customers.retrieve(customerId);
        console.log(`✅ User ${user.email} has valid Stripe customer: ${customerId}`);
      } catch (stripeError: any) {
        if (stripeError.code === 'resource_missing' || stripeError.statusCode === 404) {
          console.warn(`⚠️ Stripe customer ${customerId} not found (test→live mode migration). Creating new customer...`);
          needsNewCustomer = true;
        } else {
          throw stripeError;
        }
      }
    }

    if (needsNewCustomer) {
      // Create a new Stripe customer
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: {
          userId: user.id,
          migratedFromTestMode: customerId ? 'true' : 'false'
        },
      });
      customerId = customer.id;

      // Save the customer ID to the user
      await authService.updateUser(user.id, { stripeCustomerId: customerId });
      console.log(`✅ Created new Stripe customer ${customerId} for user ${user.email}`);
    }

    // Ensure we have a valid customer ID at this point
    if (!customerId) {
      throw new Error('Failed to get or create Stripe customer');
    }

    // Create a Setup Intent
    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ['card'],
      metadata: {
        userId: user.id,
      },
    });

    console.log(`✅ Created setup intent for user ${user.email}: ${setupIntent.id}`);

    res.json({
      clientSecret: setupIntent.client_secret,
    });
  } catch (error) {
    console.error('Setup intent error:', error);
    res.status(500).json({ error: 'Failed to create setup intent' });
  }
});

// ============================================================================
// Google OAuth Routes
// ============================================================================

// Google OAuth - Initiate authentication
router.get('/google', (req, res, next) => {
  const { ref } = req.query; // Referral code if present

  passport.authenticate('google', {
    scope: ['profile', 'email'],
    session: false,
    state: ref as string | undefined, // Pass referral code via state
  })(req, res, next);
});

// Google OAuth - Callback handler
router.get(
  '/google/callback',
  passport.authenticate('google', {
    session: false,
    failureRedirect: '/login?error=oauth_failed',
  }),
  async (req, res) => {
    try {
      const user = req.user as any;

      if (!user) {
        console.error('❌ No user returned from Google OAuth');
        return res.redirect('/login?error=oauth_no_user');
      }

      console.log('✅ Google OAuth successful, creating session for:', user.email);

      // Create session using existing auth service method
      const sessionToken = await authService.createSession(user.id);

      // Set cookie with same settings as magic link auth
      const isProduction = process.env.NODE_ENV === 'production' || process.env.REPLIT_DEPLOYMENT;
      const host = req.get('host') || '';
      const isCanonicalDomain = host === 'cutmv.fulldigitalll.com';
      const isRailwayDomain = host.includes('railway.app');

      const cookieOptions: any = {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 90 * 24 * 60 * 60 * 1000, // 90 days (persistent login)
      };

      // Apply secure settings based on environment (match magic link logic)
      if (isProduction) {
        cookieOptions.secure = true; // HTTPS required in production

        if (isCanonicalDomain) {
          cookieOptions.domain = '.fulldigitalll.com'; // Domain scope for subdomain sharing
        } else if (isRailwayDomain) {
          console.log('🍪 Setting cookie for Railway domain (host-specific):', host);
        } else {
          console.warn('⚠️ Unknown production domain:', host);
        }
      } else {
        // Development settings
        cookieOptions.secure = false;
      }

      res.cookie('cutmv-session', sessionToken, cookieOptions);

      console.log('🍪 OAuth session cookie set:', {
        tokenPreview: sessionToken.substring(0, 8) + '...',
        secure: cookieOptions.secure,
        domain: cookieOptions.domain || 'browser-default',
        maxAge: cookieOptions.maxAge,
        userId: user.id,
      });

      // Redirect to app (or onboarding if needed)
      const redirectUrl = user.onboardingCompleted ? '/app' : '/app';
      console.log('🔄 Redirecting OAuth user to:', redirectUrl);
      res.redirect(redirectUrl);
    } catch (error) {
      console.error('❌ OAuth callback error:', error);
      res.redirect('/login?error=session_failed');
    }
  }
);

// ============================================================================
// Microsoft OAuth Routes
// ============================================================================

// Microsoft OAuth - Initiate authentication
router.get('/microsoft', (req, res, next) => {
  const { ref } = req.query; // Referral code if present

  passport.authenticate('microsoft', {
    session: false,
    state: ref as string | undefined, // Pass referral code via state
  })(req, res, next);
});

// Microsoft OAuth - Callback handler
router.get(
  '/microsoft/callback',
  passport.authenticate('microsoft', {
    session: false,
    failureRedirect: '/login?error=oauth_failed',
  }),
  async (req, res) => {
    try {
      const user = req.user as any;

      if (!user) {
        console.error('❌ No user returned from Microsoft OAuth');
        return res.redirect('/login?error=oauth_no_user');
      }

      console.log('✅ Microsoft OAuth successful, creating session for:', user.email);

      // Create session using existing auth service method
      const sessionToken = await authService.createSession(user.id);

      // Set cookie with same settings as magic link auth
      const isProduction = process.env.NODE_ENV === 'production' || process.env.REPLIT_DEPLOYMENT;
      const host = req.get('host') || '';
      const isCanonicalDomain = host === 'cutmv.fulldigitalll.com';
      const isRailwayDomain = host.includes('railway.app');

      const cookieOptions: any = {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 90 * 24 * 60 * 60 * 1000, // 90 days (persistent login)
      };

      // Apply secure settings based on environment
      if (isProduction) {
        cookieOptions.secure = true;

        if (isCanonicalDomain) {
          cookieOptions.domain = '.fulldigitalll.com';
        } else if (isRailwayDomain) {
          console.log('🍪 Setting cookie for Railway domain (host-specific):', host);
        } else {
          console.warn('⚠️ Unknown production domain:', host);
        }
      } else {
        cookieOptions.secure = false;
      }

      res.cookie('cutmv-session', sessionToken, cookieOptions);

      console.log('🍪 OAuth session cookie set:', {
        tokenPreview: sessionToken.substring(0, 8) + '...',
        secure: cookieOptions.secure,
        domain: cookieOptions.domain || 'browser-default',
        maxAge: cookieOptions.maxAge,
        userId: user.id,
      });

      // Redirect to app
      const redirectUrl = user.onboardingCompleted ? '/app' : '/app';
      console.log('🔄 Redirecting OAuth user to:', redirectUrl);
      res.redirect(redirectUrl);
    } catch (error) {
      console.error('❌ OAuth callback error:', error);
      res.redirect('/login?error=session_failed');
    }
  }
);

export default router;