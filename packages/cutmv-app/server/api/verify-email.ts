/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Music Video Cut-Down Tool
 * Proprietary software - unauthorized use prohibited
 */

import { Request, Response } from 'express';
import { emailVerificationService } from '../email-verification';
import { logEmailEvent, captureException } from '../sentry';

export async function verifyEmailEndpoint(req: Request, res: Response) {
  try {
    const { email } = req.body;
    
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ 
        error: 'Email address is required',
        isValid: false 
      });
    }

    // Basic email format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      logEmailEvent(email, 'format_validation_failed');
      return res.status(400).json({
        error: 'Invalid email format',
        isValid: false
      });
    }

    // Verify email with Kickbox
    const result = await emailVerificationService.verifyEmail(email);
    
    // Return verification result
    res.json({
      email,
      isValid: result.isValid,
      isDeliverable: result.isDeliverable,
      isRisky: result.isRisky,
      isDisposable: result.isDisposable,
      isFree: result.isFree,
      suggestion: result.suggestion,
      confidence: result.confidence,
      reason: result.reason
    });

  } catch (error) {
    console.error('Email verification endpoint error:', error);
    captureException(error instanceof Error ? error : new Error(String(error)), {
      endpoint: '/api/verify-email',
      email: req.body?.email ? req.body.email.replace(/(.{2}).*(@.*)/, '$1***$2') : 'unknown'
    });

    res.status(500).json({
      error: 'Email verification service unavailable',
      isValid: true, // Allow emails when service fails
      reason: 'Service temporarily unavailable'
    });
  }
}