/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Music Video Cut-Down Tool
 * Proprietary software - unauthorized use prohibited
 */

import 'dotenv/config';
import express, { type Request, Response, NextFunction } from "express";
import cookieParser from 'cookie-parser';
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { initializeSentry } from "./sentry";
import authRoutes from "./auth-routes";
import userRoutes from "./user-routes";
import referralRoutes from "./referral-routes";
import creditRoutes from "./credit-routes";
import subscriptionRoutes from "./subscription-routes";
import stripeWebhook from "./stripe-webhook";

import { optionalAuth } from "./auth-middleware";
import { exportCleanupService } from "./export-cleanup-service";
import { AuthService } from "./auth-service";
import passport from "./passport-config";

// Initialize Sentry first
initializeSentry();

const app = express();

// Version identifier for Railway deployment verification
console.log('🚀 CUTMV v3 - Build: 2026-01-23-SUBSCRIPTION-FIX');
console.log('📍 Environment:', process.env.NODE_ENV);
console.log('🌐 Railway Deploy:', process.env.RAILWAY_ENVIRONMENT_NAME || 'Not Railway');

// Request logger to debug routing issues
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) {
    console.log('🌐 Non-API Request:', req.method, req.path);
  }
  next();
});

// IMPORTANT: Stripe webhook MUST come before body parsers
// It needs access to the raw request body
app.use('/api/stripe', stripeWebhook);

// Streamlined Express config for fast uploads - increased limits for video files
app.use(express.json({ limit: '10gb' }));
app.use(express.urlencoded({ extended: false, limit: '10gb' }));
app.use(cookieParser());

// Initialize Passport for OAuth authentication
app.use(passport.initialize());

// Canonical domain redirect middleware - must run before CORS
app.use((req, res, next) => {
  const host = req.get('host');
  const isProduction = process.env.NODE_ENV === 'production' || process.env.REPLIT_DEPLOYMENT;
  
  // Enforce canonical domain in production
  if (isProduction && host) {
    const canonicalHost = 'cutmv.fulldigitalll.com';

    // Redirect ALL non-canonical domains with 301 permanent redirect
    // Do not set cookies or render app on non-canonical domains
    // EXCEPT: Railway healthcheck and internal domains
    const isRailwayInternal = host.includes('railway.app') || host.includes('railway.internal');

    if (host !== canonicalHost && !host.includes('replit.dev') && !host.includes('localhost') && !isRailwayInternal) {
      const redirectUrl = `https://${canonicalHost}${req.originalUrl}`;
      console.log(`🔄 Canonical redirect: ${host} → ${canonicalHost}`);
      // Ensure no cookies are set on non-canonical domains
      res.header('Set-Cookie', '');
      return res.redirect(301, redirectUrl);
    }
  }
  
  next();
});

// CORS and Security Headers configuration
app.use((req, res, next) => {
  const origin = req.get('origin');
  const isProduction = process.env.NODE_ENV === 'production' || process.env.REPLIT_DEPLOYMENT;
  
  // PRODUCTION-ONLY: Secure CORS for canonical domain only
  if (origin && (origin === 'https://cutmv.fulldigitalll.com' || origin.includes('replit.app') || origin.includes('localhost'))) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
  }
  
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Cookie, X-CSRF-Token');
  
  // Content Security Policy - Only load resources that are actually needed
  const cspDirectives = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://us.i.posthog.com https://us-assets.i.posthog.com https://replit.com *.sentry.io https://js.stripe.com https://static.cloudflareinsights.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https: http:",
    "font-src 'self' data:",
    "media-src 'self' https://*.r2.cloudflarestorage.com https://*.r2.dev blob:",  // Allow R2 video/audio previews
    "connect-src 'self' https://us.i.posthog.com https://us-assets.i.posthog.com wss: ws: *.sentry.io https://api.stripe.com https://cloudflareinsights.com https://*.r2.cloudflarestorage.com",  // Allow direct-to-R2 uploads
    "frame-src 'self' https://js.stripe.com https://hooks.stripe.com",
    "object-src 'none'",
    "base-uri 'self'"
  ].join('; ');
  
  res.header('Content-Security-Policy', cspDirectives);
  
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Disable ETags for upload endpoints to prevent caching issues
app.set('etag', false);

// Request timeout handled at server level instead

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

// Set NODE_ENV for production if not already set
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = process.env.REPLIT_DEPLOYMENT === '1' ? 'production' : 'development';
}

// Environment variable validation with warning-only mode for production
function validateRequiredEnvironmentVariables() {
  const required = [
    'DATABASE_URL'
  ];

  const optional = [
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_ENDPOINT',
    'R2_BUCKET_NAME',
    'OPENAI_API_KEY',
    'RESEND_API_KEY',
    'KICKBOX_API_KEY',
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_API_TOKEN',
    'CLOUDFLARE_QUEUE_NAME',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'SENTRY_DSN'
  ];

  const missing = required.filter(key => !process.env[key]);
  const missingOptional = optional.filter(key => !process.env[key]);

  if (missing.length > 0) {
    const message = `Missing required environment variables: ${missing.join(', ')}`;
    if (process.env.NODE_ENV === 'production') {
      // In production, log warning instead of throwing to prevent deployment failures
      console.warn('⚠️ ' + message + ' - Some features may not work properly');
    } else {
      console.error('❌ ' + message);
      throw new Error(message);
    }
  }

  if (missingOptional.length > 0) {
    console.warn('⚠️ Missing optional environment variables (features may be limited):', missingOptional.join(', '));
  }

  console.log('✅ Environment validation completed');
}

// Server initialization with comprehensive error handling
async function initializeServer() {
  try {
    // Validate environment variables first (non-blocking in production)
    validateRequiredEnvironmentVariables();
    
    // Mount API routes FIRST with explicit ordering to prevent Vite interference
    try {
      app.use('/api/auth', authRoutes);
      app.use('/api/user', userRoutes);
      app.use('/api/referral', referralRoutes);
      app.use('/api/credits', creditRoutes);
      app.use('/api/subscription', subscriptionRoutes);

      console.log('✅ API routes initialized FIRST');
    } catch (routeError) {
      console.error('❌ Failed to initialize API routes:', routeError);
    }

    // Initialize main application routes AFTER API routes
    let server;
    try {
      server = await registerRoutes(app);
      console.log('✅ Registering complete routes with video processing functionality...');
    } catch (registerError) {
      console.error('❌ Failed to register routes:', registerError);
      // Create basic HTTP server as fallback
      const { createServer } = await import("http");
      server = createServer(app);
      console.log('⚠️ Using fallback HTTP server');
    }

    // Apply optional auth AFTER main routes to avoid conflicts  
    try {
      app.use(optionalAuth);
      console.log('✅ Optional auth middleware applied');
    } catch (authError) {
      console.error('❌ Failed to apply auth middleware:', authError);
    }

    // CRITICAL FIX: Add API route protection BEFORE static serving
    app.use('/api/*', (req, res, next) => {
      // If we get here, the API route wasn't found - return JSON error, not HTML
      console.log('🚫 API 404:', req.originalUrl);
      res.status(404).json({
        error: 'API endpoint not found',
        endpoint: req.originalUrl,
        method: req.method
      });
    });

    // DEBUG: Test route to verify Express is receiving requests
    app.get('/test-route-12345', (req, res) => {
      console.log('🧪 TEST ROUTE HIT');
      res.send('TEST ROUTE WORKS - Express is receiving requests');
    });

    // Setup static serving or Vite dev server (AFTER API route protection)
    if (process.env.NODE_ENV === 'production') {
      try {
        serveStatic(app);
        console.log('✅ Production static file serving setup');
      } catch (setupError) {
        console.error('❌ Failed to setup file serving:', setupError);
        // Continue without file serving if necessary
      }
    } else {
      try {
        await setupVite(app, server);
        console.log('✅ Vite dev server setup complete');
      } catch (viteError) {
        console.error('❌ Failed to setup Vite:', viteError);
      }
    }

    // Global error handler (AFTER everything else)
    app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
      const status = err.status || err.statusCode || 500;
      const message = err.message || "Internal Server Error";
      
      console.error('Global error handler:', err);
      res.status(status).json({ message });
      // Don't re-throw in production to prevent server crashes
      if (process.env.NODE_ENV !== 'production') {
        throw err;
      }
    });

    // Start server with enhanced error handling
    const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
    
    return new Promise<void>((resolve, reject) => {
      const serverInstance = server.listen(
        port,
        "0.0.0.0",
        (error?: Error) => {
        if (error) {
          console.error('❌ Failed to start server:', error);
          reject(error);
          return;
        }

        log(`serving on port ${port}`);
        
        // Initialize services with individual error handling
        try {
          const authService = new AuthService();
          
          // Clean up expired sessions every hour
          setInterval(async () => {
            try {
              await authService.cleanupExpiredSessions();
            } catch (error) {
              console.error('Session cleanup error:', error);
            }
          }, 60 * 60 * 1000); // 1 hour
          
          console.log('🔒 Session cleanup service initialized');
          
          // Start job failure monitoring system  
          import('./job-failure-monitor.js').then(async ({ jobFailureMonitor }) => {
            await jobFailureMonitor.start();
            console.log('🏥 Job failure monitoring system started');
          }).catch(error => {
            console.error('❌ Failed to start job failure monitor:', error);
          });
          
        } catch (serviceError) {
          console.error('❌ Failed to initialize auth service:', serviceError);
          // Continue without session cleanup if necessary
        }
        
        resolve();
      });

      // Handle server errors gracefully
      serverInstance.on('error', (error) => {
        console.error('❌ Server error:', error);
        // Only reject if server fails to start, not for runtime errors
        if (!serverInstance.listening) {
          reject(error);
        }
      });
      
      // Handle uncaught exceptions gracefully in production
      process.on('uncaughtException', (error: Error) => {
        console.error('❌ Uncaught exception:', error);
        if (process.env.NODE_ENV === 'production') {
          // Log error but don't exit in production
          console.error('Server continuing despite uncaught exception');
        } else {
          process.exit(1);
        }
      });
      
      process.on('unhandledRejection', (reason, promise) => {
        console.error('❌ Unhandled rejection at:', promise, 'reason:', reason);
        if (process.env.NODE_ENV === 'production') {
          // Log error but don't exit in production
          console.error('Server continuing despite unhandled rejection');
        }
      });
    });
  } catch (error) {
    console.error('❌ Failed to initialize server:', error);
    // In production, try to continue with minimal functionality
    if (process.env.NODE_ENV === 'production') {
      console.warn('⚠️ Attempting minimal server startup');
      // Return a basic server setup
      const { createServer } = await import("http");
      const basicServer = createServer(app);
      return new Promise<void>((resolve) => {
        basicServer.listen(5000, "0.0.0.0", () => {
          console.log('⚠️ Minimal server started on port 5000');
          resolve();
        });
      });
    }
    throw error;
  }
}

// Start server with error handling
initializeServer().catch((error) => {
  console.error('❌ Fatal server initialization error:', error);
  process.exit(1);
});
