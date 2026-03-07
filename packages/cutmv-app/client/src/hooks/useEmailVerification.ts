/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Music Video Cut-Down Tool
 * Proprietary software - unauthorized use prohibited
 */

import { useState } from 'react';
import { apiRequest } from '@/lib/queryClient';
import { logUserEvent, captureException } from '@/lib/sentry';

interface EmailVerificationResult {
  isValid: boolean;
  isDeliverable: boolean;
  isRisky: boolean;
  isDisposable: boolean;
  isFree: boolean;
  suggestion?: string;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

interface UseEmailVerificationReturn {
  verifyEmail: (email: string) => Promise<EmailVerificationResult>;
  isVerifying: boolean;
  lastResult: EmailVerificationResult | null;
}

export function useEmailVerification(): UseEmailVerificationReturn {
  const [isVerifying, setIsVerifying] = useState(false);
  const [lastResult, setLastResult] = useState<EmailVerificationResult | null>(null);

  const verifyEmail = async (email: string): Promise<EmailVerificationResult> => {
    if (!email || !email.trim()) {
      const result: EmailVerificationResult = {
        isValid: false,
        isDeliverable: false,
        isRisky: false,
        isDisposable: false,
        isFree: false,
        confidence: 'low',
        reason: 'Email address is required'
      };
      setLastResult(result);
      return result;
    }

    setIsVerifying(true);
    logUserEvent('email_verification_started', { email: email.replace(/(.{2}).*(@.*)/, '$1***$2') });

    try {
      const response = await apiRequest("POST", "/api/verify-email", { email });
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Email verification failed');
      }

      const verificationResult: EmailVerificationResult = {
        isValid: result.isValid,
        isDeliverable: result.isDeliverable,
        isRisky: result.isRisky,
        isDisposable: result.isDisposable,
        isFree: result.isFree,
        suggestion: result.suggestion,
        confidence: result.confidence,
        reason: result.reason
      };

      setLastResult(verificationResult);
      
      logUserEvent('email_verification_completed', {
        isValid: result.isValid,
        isDeliverable: result.isDeliverable,
        isRisky: result.isRisky,
        confidence: result.confidence
      });

      return verificationResult;

    } catch (error) {
      console.error('Email verification error:', error);
      captureException(error instanceof Error ? error : new Error(String(error)), {
        component: 'useEmailVerification',
        email: email.replace(/(.{2}).*(@.*)/, '$1***$2')
      });

      // Fallback result when verification fails
      const fallbackResult: EmailVerificationResult = {
        isValid: true, // Allow emails when service fails
        isDeliverable: true,
        isRisky: false,
        isDisposable: false,
        isFree: false,
        confidence: 'low',
        reason: 'Verification service temporarily unavailable'
      };

      setLastResult(fallbackResult);
      return fallbackResult;

    } finally {
      setIsVerifying(false);
    }
  };

  return {
    verifyEmail,
    isVerifying,
    lastResult
  };
}