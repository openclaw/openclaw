/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Music Video Cut-Down Tool
 * Proprietary software - unauthorized use prohibited
 */

import axios from 'axios';
import { logEmailEvent, captureException } from './sentry';

interface KickboxResponse {
  result: 'deliverable' | 'undeliverable' | 'risky' | 'unknown';
  reason: string;
  role: boolean;
  free: boolean;
  disposable: boolean;
  accept_all: boolean;
  did_you_mean?: string;
  sendex: number;
  email: string;
  user: string;
  domain: string;
  success: boolean;
  message?: string;
}

export interface EmailVerificationResult {
  isValid: boolean;
  isDeliverable: boolean;
  isRisky: boolean;
  isDisposable: boolean;
  isFree: boolean;
  suggestion?: string;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
}

class EmailVerificationService {
  private apiKey: string;
  private baseUrl = 'https://api.kickbox.com/v2';

  constructor() {
    this.apiKey = process.env.KICKBOX_API_KEY || '';
    if (!this.apiKey) {
      console.log('⚠️ Kickbox API key not found - email verification disabled');
    } else {
      console.log('✅ Kickbox email verification service initialized');
    }
  }

  async verifyEmail(email: string): Promise<EmailVerificationResult> {
    if (!this.apiKey) {
      logEmailEvent(email, 'verification_skipped', { reason: 'no_api_key' });
      return {
        isValid: true, // Allow emails when service unavailable
        isDeliverable: true,
        isRisky: false,
        isDisposable: false,
        isFree: false,
        reason: 'Service unavailable - verification skipped',
        confidence: 'low'
      };
    }

    try {
      logEmailEvent(email, 'verification_started');
      
      const response = await axios.get<KickboxResponse>(
        `${this.baseUrl}/verify`,
        {
          params: {
            email: email,
            apikey: this.apiKey
          },
          timeout: 10000 // 10 second timeout
        }
      );

      const data = response.data;
      
      if (!data.success) {
        throw new Error(data.message || 'Kickbox API returned unsuccessful response');
      }

      const result: EmailVerificationResult = {
        isValid: data.result === 'deliverable' || data.result === 'risky',
        isDeliverable: data.result === 'deliverable',
        isRisky: data.result === 'risky',
        isDisposable: data.disposable,
        isFree: data.free,
        suggestion: data.did_you_mean,
        reason: data.reason,
        confidence: this.getConfidenceLevel(data)
      };

      logEmailEvent(email, 'verification_completed', {
        result: data.result,
        reason: data.reason,
        isDeliverable: result.isDeliverable,
        isRisky: result.isRisky,
        sendex: data.sendex
      });

      return result;

    } catch (error) {
      console.error('Email verification failed:', error);
      captureException(error instanceof Error ? error : new Error(String(error)), {
        service: 'kickbox',
        email: email.replace(/(.{2}).*(@.*)/, '$1***$2'),
      });

      logEmailEvent(email, 'verification_failed', { 
        error: error instanceof Error ? error.message : String(error) 
      });

      // Fallback: allow email when verification fails
      return {
        isValid: true,
        isDeliverable: true,
        isRisky: false,
        isDisposable: false,
        isFree: false,
        reason: 'Verification service unavailable',
        confidence: 'low'
      };
    }
  }

  private getConfidenceLevel(data: KickboxResponse): 'high' | 'medium' | 'low' {
    if (data.result === 'deliverable' && data.sendex >= 0.7) {return 'high';}
    if (data.result === 'deliverable' && data.sendex >= 0.3) {return 'medium';}
    if (data.result === 'risky') {return 'medium';}
    return 'low';
  }

  // Bulk verification for batch processing
  async verifyEmails(emails: string[]): Promise<Map<string, EmailVerificationResult>> {
    const results = new Map<string, EmailVerificationResult>();
    
    // Process in batches of 10 to avoid rate limiting
    const batchSize = 10;
    for (let i = 0; i < emails.length; i += batchSize) {
      const batch = emails.slice(i, i + batchSize);
      const promises = batch.map(email => 
        this.verifyEmail(email).then(result => ({ email, result }))
      );
      
      const batchResults = await Promise.allSettled(promises);
      batchResults.forEach(promiseResult => {
        if (promiseResult.status === 'fulfilled') {
          results.set(promiseResult.value.email, promiseResult.value.result);
        }
      });
      
      // Small delay between batches
      if (i + batchSize < emails.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    return results;
  }
}

export const emailVerificationService = new EmailVerificationService();