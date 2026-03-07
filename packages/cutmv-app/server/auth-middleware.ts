/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Authentication Middleware
 * Session verification and user context
 */

import { Request, Response, NextFunction } from 'express';
import { AuthService } from './auth-service';
import type { User } from '@shared/schema';

// Create auth service instance
const authService = new AuthService();

// Extend Express Request type to include user
declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

// Middleware to check if user is authenticated (optional)
export async function optionalAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const sessionToken = req.cookies['cutmv-session'];
    
    if (sessionToken) {
      const auth = await authService.verifySession(sessionToken);
      if (auth) {
        req.user = auth.user;
      }
    }
    
    next();
  } catch (error) {
    console.error('❌ Optional auth error:', error);
    next(); // Continue even if auth fails
  }
}

// Middleware to require authentication
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const sessionToken = req.cookies['cutmv-session'];
    
    // Minimal logging for production debugging
    console.log('Auth check:', {
      path: req.path,
      hasSession: !!sessionToken,
      endpoint: req.originalUrl
    });
    
    if (!sessionToken) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const auth = await authService.verifySession(sessionToken);
    
    if (!auth) {
      res.clearCookie('cutmv-session');
      return res.status(401).json({ error: 'Invalid session' });
    }
    req.user = auth.user;
    next();
  } catch (error) {
    console.error('❌ Auth middleware error:', error);
    res.status(500).json({ error: 'Authentication error' });
  }
}

export { authService };