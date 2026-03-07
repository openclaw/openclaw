/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Music Video Cut-Down Tool
 * Proprietary software - unauthorized use prohibited
 */

import nodemailer from 'nodemailer';
import { nanoid } from 'nanoid';
import R2Storage from './r2-storage';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import type { Feedback, FeedbackSubmission } from '../shared/feedback-schema';

class FeedbackService {
  private transporter: nodemailer.Transporter | null = null;

  constructor() {
    this.initializeNodemailer();
  }

  private initializeNodemailer() {
    try {
      // Using Resend SMTP for reliable delivery to staff@fulldigitalll.com
      this.transporter = nodemailer.createTransport({
        host: 'smtp.resend.com',
        port: 587,
        secure: false,
        auth: {
          user: 'resend',
          pass: process.env.RESEND_API_KEY
        }
      });
      console.log('📧 Nodemailer initialized for feedback notifications');
    } catch (error) {
      console.error('⚠️ Failed to initialize Nodemailer:', error);
    }
  }

  async submitFeedback(submission: FeedbackSubmission): Promise<{ success: boolean; id: string }> {
    const feedback: Feedback = {
      id: nanoid(),
      ...submission,
      timestamp: new Date().toISOString(),
    };

    try {
      // Save to Cloudflare R2 for backup
      await this.saveToR2(feedback);
      
      // Send email notification
      await this.sendEmailNotification(feedback);

      console.log('✅ Feedback submitted successfully:', feedback.id);
      return { success: true, id: feedback.id };
    } catch (error) {
      console.error('❌ Failed to submit feedback:', error);
      return { success: false, id: feedback.id };
    }
  }

  private async saveToR2(feedback: Feedback): Promise<void> {
    try {
      // Write feedback to a temporary file first
      const fs = await import('fs/promises');
      const path = await import('path');
      const tempDir = 'uploads';
      const tempFilePath = path.join(tempDir, `feedback-${feedback.id}.json`);
      
      await fs.writeFile(tempFilePath, JSON.stringify(feedback, null, 2));
      
      // Upload to R2
      const key = `feedback/${new Date().toISOString().split('T')[0]}/${feedback.id}.json`;
      await R2Storage.uploadFile(tempFilePath, key);
      
      // Clean up temp file
      await fs.unlink(tempFilePath).catch(() => {});
      
      console.log('💾 Feedback saved to R2:', key);
    } catch (error) {
      console.log('⚠️ R2 not configured or failed - skipping feedback backup:', error);
      return;
    }
  }

  private async sendEmailNotification(feedback: Feedback): Promise<void> {
    if (!this.transporter) {
      throw new Error('Nodemailer not initialized');
    }

    const emailBody = this.generateEmailBody(feedback);

    try {
      await this.transporter.sendMail({
        from: 'noreply@delivery.fulldigitalll.com',
        to: 'staff@fulldigitalll.com',
        subject: `CUTMV Feedback Submission - ${feedback.id}`,
        html: emailBody.html,
        text: emailBody.text,
      });

      console.log('📧 Feedback notification sent to staff@fulldigitalll.com');
    } catch (error) {
      console.error('❌ Failed to send feedback email:', error);
      throw error;
    }
  }

  private generateEmailBody(feedback: Feedback): { html: string; text: string } {
    const date = new Date(feedback.timestamp).toLocaleString();
    
    const html = `
<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .header { background: #7ED321; color: #171717; padding: 20px; text-align: center; }
        .content { padding: 20px; }
        .section { margin: 20px 0; padding: 15px; background: #f5f5f5; border-radius: 8px; }
        .label { font-weight: bold; color: #7ED321; }
        .context { background: #e8f5e8; padding: 10px; border-radius: 4px; font-size: 12px; }
        .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
    </style>
</head>
<body>
    <div class="header">
        <h2>CUTMV User Feedback Submission</h2>
        <p>New feedback received from a user</p>
    </div>
    
    <div class="content">
        <div class="section">
            <p><span class="label">Submission ID:</span> ${feedback.id}</p>
            <p><span class="label">Submitted:</span> ${date}</p>
            ${feedback.email ? `<p><span class="label">Contact Email:</span> ${feedback.email}</p>` : ''}
        </div>

        ${feedback.loved ? `
        <div class="section">
            <p class="label">What they loved about CUTMV:</p>
            <p>${feedback.loved}</p>
        </div>
        ` : ''}

        ${feedback.improve ? `
        <div class="section">
            <p class="label">What they would improve:</p>
            <p>${feedback.improve}</p>
        </div>
        ` : ''}

        ${feedback.recommend ? `
        <div class="section">
            <p class="label">Would recommend to others:</p>
            <p><strong>${feedback.recommend.toUpperCase()}</strong></p>
        </div>
        ` : ''}

        ${feedback.sessionContext ? `
        <div class="context">
            <p><strong>Session Context:</strong></p>
            <p>User processed: ${Object.entries(feedback.sessionContext)
              .filter(([_, value]) => value && value > 0)
              .map(([key, value]) => `${value} ${key.replace('total', '').toLowerCase()}`)
              .join(', ') || 'No content generated'}</p>
        </div>
        ` : ''}
    </div>

    <div class="footer">
        <p>This feedback was submitted through CUTMV's internal feedback system.</p>
        <p>© 2026 Full Digital LLC - CUTMV Feedback System</p>
    </div>
</body>
</html>
    `;

    const text = `
CUTMV User Feedback Submission

Submission ID: ${feedback.id}
Submitted: ${date}
${feedback.email ? `Contact Email: ${feedback.email}` : ''}

${feedback.loved ? `What they loved about CUTMV:\n${feedback.loved}\n\n` : ''}
${feedback.improve ? `What they would improve:\n${feedback.improve}\n\n` : ''}
${feedback.recommend ? `Would recommend to others: ${feedback.recommend.toUpperCase()}\n\n` : ''}

${feedback.sessionContext ? `Session Context: User processed ${Object.entries(feedback.sessionContext)
  .filter(([_, value]) => value && value > 0)
  .map(([key, value]) => `${value} ${key.replace('total', '').toLowerCase()}`)
  .join(', ') || 'no content'}\n\n` : ''}

This feedback was submitted through CUTMV's internal feedback system.
© 2026 Full Digital LLC - CUTMV Feedback System
    `;

    return { html, text };
  }
}

export const feedbackService = new FeedbackService();