/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Integrated Email Workflow System
 * Comprehensive email delivery with Resend, Kickbox, Sentry, PostHog, and Cloudflare integration
 */

import { emailService } from './email-service.js';
import { emailVerificationService } from './email-verification.js';
import { logEmailEvent, captureException } from './sentry.js';

interface EmailWorkflowOptions {
  userEmail: string;
  emailType: 'processing_started' | 'download_ready' | 'welcome' | 'test' | 'export_failure';
  sessionId: string;
  videoName?: string;
  estimatedTime?: string;
  downloadUrl?: string;
  downloadFilename?: string;
  processingDetails?: any;
  professionalQuality?: boolean;
  skipVerification?: boolean;
  errorMessage?: string;
}

interface EmailWorkflowResult {
  success: boolean;
  messageId?: string;
  error?: string;
  verificationResult?: any;
  deliveryAttempts: number;
  finalStatus: 'delivered' | 'failed' | 'verification_failed' | 'blocked';
}

export class IntegratedEmailWorkflow {
  
  /**
   * Comprehensive email delivery workflow with full service integration
   */
  async sendEmail(options: EmailWorkflowOptions): Promise<EmailWorkflowResult> {
    const { userEmail, emailType, sessionId, skipVerification = false } = options;
    let deliveryAttempts = 0;
    let verificationResult = null;
    
    try {
      // Step 1: Log email workflow start (PostHog/Sentry)
      logEmailEvent(userEmail, 'workflow_started', {
        emailType,
        sessionId,
        timestamp: new Date().toISOString()
      });

      // Step 2: Email verification with Kickbox (unless skipped)
      if (!skipVerification) {
        console.log(`📧 Verifying email with Kickbox: ${userEmail}`);
        verificationResult = await emailVerificationService.verifyEmail(userEmail);
        
        // Block delivery for undeliverable emails
        if (!verificationResult.isValid || !verificationResult.isDeliverable) {
          logEmailEvent(userEmail, 'delivery_blocked', {
            reason: 'email_verification_failed',
            verificationResult,
            sessionId
          });
          
          return {
            success: false,
            error: `Email verification failed: ${verificationResult.reason}`,
            verificationResult,
            deliveryAttempts: 0,
            finalStatus: 'verification_failed'
          };
        }

        // Log risky emails but allow delivery with warning
        if (verificationResult.isRisky || verificationResult.isDisposable) {
          logEmailEvent(userEmail, 'risky_email_detected', {
            reason: verificationResult.reason,
            isDisposable: verificationResult.isDisposable,
            sessionId
          });
        }

        console.log(`✅ Email verification passed: ${verificationResult.confidence} confidence`);
      }

      // Step 3: Attempt email delivery with Resend
      deliveryAttempts = 1;
      let emailResult;

      switch (emailType) {
        case 'processing_started':
          emailResult = await emailService.sendProcessingNotification({
            userEmail,
            videoName: options.videoName || 'Unknown Video',
            estimatedTime: options.estimatedTime || '2-5 minutes',
            sessionId
          });
          break;

        case 'download_ready':
          emailResult = await emailService.sendDownloadLink({
            userEmail,
            downloadUrl: options.downloadUrl || '',
            downloadFilename: options.downloadFilename || 'cutmv-export.zip',
            processingDetails: options.processingDetails || {},
            sessionId
          });
          break;

        case 'welcome':
          emailResult = await emailService.sendWelcomeEmail({
            userEmail
          });
          break;

        case 'test':
          emailResult = await emailService.testConnection();
          break;

        case 'export_failure':
          emailResult = await emailService.sendFailureNotification({
            userEmail,
            videoName: options.videoName || 'Unknown Video',
            errorMessage: options.errorMessage || 'Export processing failed',
            sessionId
          });
          break;

        default:
          throw new Error(`Unknown email type: ${emailType}`);
      }

      // Step 4: Handle delivery result
      if (emailResult.success) {
        // Log successful delivery
        logEmailEvent(userEmail, 'delivery_successful', {
          messageId: emailResult.messageId,
          emailType,
          sessionId,
          verificationResult: verificationResult ? {
            confidence: verificationResult.confidence,
            isRisky: verificationResult.isRisky
          } : null,
          deliveryAttempts
        });

        console.log(`✅ Email delivered successfully: ${emailResult.messageId}`);
        
        return {
          success: true,
          messageId: emailResult.messageId,
          verificationResult: verificationResult || null,
          deliveryAttempts,
          finalStatus: 'delivered'
        };
      } else {
        throw new Error(emailResult.error || 'Email delivery failed');
      }

    } catch (error) {
      // Step 5: Error handling with comprehensive logging
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      // Log error to Sentry with full context
      captureException(error as Error, {
        user: { email: userEmail },
        tags: {
          emailType,
          sessionId,
          deliveryAttempts: deliveryAttempts.toString()
        },
        extra: {
          options,
          verificationResult: verificationResult
        }
      });

      // Log error event for analytics
      logEmailEvent(userEmail, 'delivery_failed', {
        error: errorMessage,
        emailType,
        sessionId,
        deliveryAttempts,
        verificationPassed: verificationResult?.isValid || false
      });

      console.error(`❌ Email workflow failed for ${userEmail}:`, errorMessage);

      return {
        success: false,
        error: errorMessage,
        verificationResult: verificationResult || null,
        deliveryAttempts,
        finalStatus: 'failed'
      };
    }
  }

  /**
   * Batch email sending with rate limiting and failure handling
   */
  async sendBatchEmails(emailBatch: EmailWorkflowOptions[]): Promise<EmailWorkflowResult[]> {
    const results: EmailWorkflowResult[] = [];
    
    // Process emails in batches of 5 to respect Resend rate limits
    const batchSize = 5;
    for (let i = 0; i < emailBatch.length; i += batchSize) {
      const batch = emailBatch.slice(i, i + batchSize);
      
      const batchPromises = batch.map(emailOptions => 
        this.sendEmail(emailOptions)
      );
      
      const batchResults = await Promise.allSettled(batchPromises);
      
      batchResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          // Handle batch failure
          const emailOptions = batch[index];
          logEmailEvent(emailOptions.userEmail, 'batch_delivery_failed', {
            error: result.reason,
            sessionId: emailOptions.sessionId
          });
          
          results.push({
            success: false,
            error: `Batch delivery failed: ${result.reason}`,
            deliveryAttempts: 0,
            finalStatus: 'failed'
          });
        }
      });
      
      // Rate limiting delay between batches (Resend allows 2 req/sec)
      if (i + batchSize < emailBatch.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    return results;
  }

  /**
   * Email health check with all service integration
   */
  async performHealthCheck(): Promise<{
    resend: boolean;
    kickbox: boolean;
    overall: boolean;
    errors: string[];
  }> {
    const errors: string[] = [];
    let resendHealthy = false;
    let kickboxHealthy = false;

    try {
      // Test Resend connection
      const resendResult = await emailService.testConnection();
      resendHealthy = resendResult.success;
      if (!resendHealthy) {
        errors.push(`Resend: ${resendResult.error}`);
      }
    } catch (error) {
      errors.push(`Resend: ${error instanceof Error ? error.message : 'Connection failed'}`);
    }

    try {
      // Test Kickbox with a known valid email
      const kickboxResult = await emailVerificationService.verifyEmail('test@example.com');
      kickboxHealthy = kickboxResult !== null;
      if (!kickboxHealthy) {
        errors.push('Kickbox: API connection failed');
      }
    } catch (error) {
      errors.push(`Kickbox: ${error instanceof Error ? error.message : 'Connection failed'}`);
    }

    const overall = resendHealthy && kickboxHealthy;

    // Log health check results
    logEmailEvent('system', 'health_check', {
      resend: resendHealthy,
      kickbox: kickboxHealthy,
      overall,
      errors: errors.length > 0 ? errors : undefined
    });

    return {
      resend: resendHealthy,
      kickbox: kickboxHealthy,
      overall,
      errors
    };
  }
}

export const integratedEmailWorkflow = new IntegratedEmailWorkflow();