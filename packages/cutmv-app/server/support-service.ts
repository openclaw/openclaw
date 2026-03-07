/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Music Video Cut-Down Tool
 * Proprietary software - unauthorized use prohibited
 */

import nodemailer from 'nodemailer';
import { nanoid } from 'nanoid';
import R2Storage from './r2-storage';
import type { SupportRequest, SupportSubmission } from '../shared/support-schema';

class SupportService {
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
      console.log('📧 Support Nodemailer initialized');
    } catch (error) {
      console.error('⚠️ Failed to initialize Support Nodemailer:', error);
    }
  }

  async submitSupportRequest(submission: SupportSubmission): Promise<{ success: boolean; id: string }> {
    const supportRequest: SupportRequest = {
      id: nanoid(),
      ...submission,
      timestamp: new Date().toISOString(),
    };

    try {
      // Save to Cloudflare R2 for backup
      await this.saveToR2(supportRequest);
      
      // Send email notification to support team
      await this.sendSupportNotification(supportRequest);

      console.log('✅ Support request submitted successfully:', supportRequest.id);
      return { success: true, id: supportRequest.id };
    } catch (error) {
      console.error('❌ Failed to submit support request:', error);
      return { success: false, id: supportRequest.id };
    }
  }

  private async saveToR2(supportRequest: SupportRequest): Promise<void> {
    try {
      // Write support request to a temporary file first
      const fs = await import('fs/promises');
      const path = await import('path');
      const tempDir = 'uploads';
      const tempFilePath = path.join(tempDir, `support-${supportRequest.id}.json`);
      
      await fs.writeFile(tempFilePath, JSON.stringify(supportRequest, null, 2));
      
      // Upload to R2
      const key = `support/${new Date().toISOString().split('T')[0]}/${supportRequest.id}.json`;
      await R2Storage.uploadFile(tempFilePath, key);
      
      // Clean up temp file
      await fs.unlink(tempFilePath).catch(() => {});
      
      console.log('💾 Support request saved to R2:', key);
    } catch (error) {
      console.log('⚠️ R2 not configured or failed - skipping support backup:', error);
      return;
    }
  }

  private async sendSupportNotification(supportRequest: SupportRequest): Promise<void> {
    if (!this.transporter) {
      throw new Error('Support Nodemailer not initialized');
    }

    const emailBody = this.generateSupportEmailBody(supportRequest);

    try {
      await this.transporter.sendMail({
        from: 'noreply@delivery.fulldigitalll.com',
        to: 'staff@fulldigitalll.com',
        subject: `CUTMV Support Request - ${supportRequest.subject}`,
        html: emailBody.html,
        text: emailBody.text,
        replyTo: supportRequest.email, // Allow direct reply to user
      });

      console.log('📧 Support notification sent to staff@fulldigitalll.com');
    } catch (error) {
      console.error('❌ Failed to send support email:', error);
      throw error;
    }
  }

  private generateSupportEmailBody(supportRequest: SupportRequest): { html: string; text: string } {
    const date = new Date(supportRequest.timestamp).toLocaleString();
    
    const html = `
<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .header { background: #dc2626; color: white; padding: 20px; text-align: center; }
        .content { padding: 20px; }
        .section { margin: 20px 0; padding: 15px; background: #f5f5f5; border-radius: 8px; }
        .label { font-weight: bold; color: #dc2626; }
        .urgent { background: #fee2e2; border-left: 4px solid #dc2626; padding: 10px; }
        .context { background: #f3f4f6; padding: 10px; border-radius: 4px; font-size: 12px; }
        .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
    </style>
</head>
<body>
    <div class="header">
        <h2>🆘 CUTMV Support Request</h2>
        <p>User needs assistance with CUTMV</p>
    </div>
    
    <div class="content">
        <div class="urgent">
          <p><strong>⚠️ PRIORITY:</strong> User is requesting support - please respond promptly</p>
          <p><strong>Reply directly to this email to respond to the user</strong></p>
        </div>

        <div class="section">
            <p><span class="label">Request ID:</span> ${supportRequest.id}</p>
            <p><span class="label">User Email:</span> ${supportRequest.email}</p>
            <p><span class="label">Submitted:</span> ${date}</p>
            <p><span class="label">Subject:</span> ${supportRequest.subject}</p>
        </div>

        <div class="section">
            <p class="label">User's Message:</p>
            <p style="white-space: pre-wrap; background: white; padding: 15px; border-radius: 4px; border-left: 3px solid #7ED321;">${supportRequest.message}</p>
        </div>

        ${supportRequest.sessionContext ? `
        <div class="context">
            <p><strong>Session Context:</strong></p>
            ${supportRequest.sessionContext.currentPage ? `<p>Current Page: ${supportRequest.sessionContext.currentPage}</p>` : ''}
            ${supportRequest.sessionContext.videoId ? `<p>Video ID: ${supportRequest.sessionContext.videoId}</p>` : ''}
            ${supportRequest.sessionContext.errorContext ? `<p>Error Context: ${supportRequest.sessionContext.errorContext}</p>` : ''}
            ${supportRequest.userAgent ? `<p>Browser: ${supportRequest.userAgent}</p>` : ''}
        </div>
        ` : ''}
    </div>

    <div class="footer">
        <p><strong>Reply to this email to respond directly to the user</strong></p>
        <p>© 2026 Full Digital LLC - CUTMV Support System</p>
    </div>
</body>
</html>
    `;

    const text = `
CUTMV SUPPORT REQUEST - URGENT

Request ID: ${supportRequest.id}
User Email: ${supportRequest.email}
Submitted: ${date}
Subject: ${supportRequest.subject}

USER'S MESSAGE:
${supportRequest.message}

${supportRequest.sessionContext ? `
SESSION CONTEXT:
${supportRequest.sessionContext.currentPage ? `Current Page: ${supportRequest.sessionContext.currentPage}` : ''}
${supportRequest.sessionContext.videoId ? `Video ID: ${supportRequest.sessionContext.videoId}` : ''}
${supportRequest.sessionContext.errorContext ? `Error Context: ${supportRequest.sessionContext.errorContext}` : ''}
${supportRequest.userAgent ? `Browser: ${supportRequest.userAgent}` : ''}
` : ''}

Reply to this email to respond directly to the user.
© 2026 Full Digital LLC - CUTMV Support System
    `;

    return { html, text };
  }
}

export const supportService = new SupportService();