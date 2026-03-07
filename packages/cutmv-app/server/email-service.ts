// Email Delivery Service using Resend API
// Handles background processing notifications and download link delivery with HTML templates

import { Resend } from 'resend';

interface EmailDeliveryOptions {
  userEmail: string;
  downloadUrl: string;
  downloadFilename: string;
  processingDetails: {
    videoName: string;
    clipsGenerated?: number;
    gifsGenerated?: number;
    thumbnailsGenerated?: number;
    canvasGenerated?: number;
    processingTime?: number;
    timestampsUsed?: string;
  };
  sessionId: string;
  expirationHours?: number;
  videoTitle?: string;
  artistInfo?: string;
  professionalQuality?: boolean;
}

interface ProcessingNotificationOptions {
  userEmail: string;
  videoName: string;
  estimatedTime: string;
  sessionId: string;
  videoTitle?: string;
  artistInfo?: string;
}

interface FailureNotificationOptions {
  userEmail: string;
  videoName: string;
  errorMessage: string;
  sessionId: string;
}

export interface PaymentFailedOptions {
  userEmail: string;
  userName?: string;
  planName: string;
  daysRemaining: number;
  updatePaymentUrl: string;
}

export interface WelcomeEmailOptions {
  userEmail: string;
  firstName?: string;
}

interface EmailTemplate {
  subject: string;
  html: string;
  text: string;
}

class EmailService {
  private resend: Resend | null = null;
  private fromEmail: string;
  private baseUrl: string;
  private isConfigured: boolean = false;

  constructor() {
    if (process.env.RESEND_API_KEY) {
      this.resend = new Resend(process.env.RESEND_API_KEY);
      this.isConfigured = true;
      console.log('📧 Email service initialized with Resend');
    } else {
      console.warn('⚠️ RESEND_API_KEY not configured - email service will be disabled');
    }
    this.fromEmail = 'CUTMV <noreply@delivery.fulldigitalll.com>';
    this.baseUrl = 'https://cutmv.fulldigitalll.com';
  }

  async testConnection(): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.isConfigured || !this.resend) {
      return { success: false, error: 'Email service not configured' };
    }
    try {
      const response = await this.resend.emails.send({
        from: this.fromEmail,
        to: 'staff@fulldigitalll.com', // Use verified email for free accounts
        subject: 'CUTMV Email Service Test',
        html: '<p>Email service test - this email can be ignored.</p>'
      });
      
      if (response.data?.id) {
        console.log('Success: Resend API connection successful, messageId:', response.data.id);
        return {
          success: true,
          messageId: response.data.id
        };
      } else {
        console.log('Failed: Resend API test failed, response:', JSON.stringify(response, null, 2));
        return {
          success: false,
          error: 'Resend API test failed'
        };
      }
    } catch (error) {
      console.error('Email service test failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // Generic email sending method
  async sendEmail(options: { to: string; subject: string; html: string; text: string }): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.isConfigured || !this.resend) {
      console.warn('Email service not configured - skipping email send');
      return { success: false, error: 'Email service not configured' };
    }
    try {
      const response = await this.resend.emails.send({
        from: this.fromEmail,
        to: options.to,
        subject: options.subject,
        html: options.html,
        text: options.text
      });

      if (response.data?.id) {
        console.log(`Email sent to ${options.to} via Resend`);
        return {
          success: true,
          messageId: response.data.id
        };
      } else {
        console.error('Failed to send email:', response.error);
        return {
          success: false,
          error: response.error?.message || 'Failed to send email'
        };
      }
    } catch (error) {
      console.error('Error sending email:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // Generate HTML template for processing notification
  private generateProcessingTemplate(options: ProcessingNotificationOptions): EmailTemplate {
    const { videoName, estimatedTime } = options;
    const contentType = 'Professional Export';
    const qualityStatus = '<div style="background: #8cc63f; color: white; padding: 12px 16px; border-radius: 8px; margin: 16px 0; text-align: center; font-weight: 600;">✅ Professional Quality - Clean & Watermark-Free</div>';

    const subject = `Your CUTMV processing has started - ${videoName}`;
    
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Processing Started - CUTMV</title>
        </head>
        <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333;">
          <div style="max-width: 600px; margin: 0 auto; padding: 20px; background: #ffffff;">
            <!-- Header -->
            <div style="text-align: center; margin-bottom: 30px; padding: 20px 0; border-bottom: 2px solid #8cc63f;">
              <!-- Logo and Brand centered using table layout for email compatibility -->
              <table style="margin: 0 auto 8px auto; border: 0; border-spacing: 0;">
                <tr>
                  <td style="vertical-align: middle; padding-right: 12px;">
                <!-- Professional Full Digital logo -->
                    <svg width="28" height="28" viewBox="0 0 200 200" version="1.1" xmlns="http://www.w3.org/2000/svg">
                    <g id="#94f33fff">
                    <path fill="#94f33f" opacity="1.00" d=" M 71.13 0.00 L 128.25 0.00 C 128.25 19.04 128.25 38.08 128.25 57.13 C 109.21 57.12 90.17 57.12 71.13 57.13 C 71.13 38.09 71.13 19.04 71.13 0.00 Z" />
                    <path fill="#94f33f" opacity="1.00" d=" M 142.25 0.00 L 199.38 0.00 C 199.37 19.04 199.38 38.08 199.37 57.12 C 180.33 57.10 161.29 57.16 142.25 57.09 C 142.25 38.06 142.26 19.03 142.25 0.00 Z" />
                    <path fill="#94f33f" opacity="1.00" d=" M 0.00 71.13 C 19.04 71.13 38.09 71.12 57.13 71.13 C 57.11 90.17 57.15 109.21 57.11 128.24 C 38.07 128.25 19.04 128.25 0.00 128.24 L 0.00 71.13 Z" />
                    <path fill="#94f33f" opacity="1.00" d=" M 71.13 71.13 C 90.16 71.12 109.19 71.13 128.22 71.13 C 128.28 90.17 128.23 109.21 128.25 128.24 C 109.21 128.27 90.17 128.22 71.13 128.27 C 71.13 109.22 71.12 90.18 71.13 71.13 Z" />
                    <path fill="#94f33f" opacity="1.00" d=" M 142.23 71.12 C 161.28 71.14 180.32 71.12 199.36 71.13 C 199.39 90.16 199.38 109.20 199.37 128.23 C 180.33 128.27 161.29 128.24 142.25 128.25 C 142.24 109.20 142.28 90.16 142.23 71.12 Z" />
                    <path fill="#94f33f" opacity="1.00" d=" M 71.14 142.27 C 90.18 142.24 109.21 142.26 128.25 142.26 C 128.26 161.30 128.23 180.34 128.26 199.38 C 109.22 199.36 90.17 199.39 71.13 199.36 C 71.13 180.33 71.11 161.30 71.14 142.27 Z" />
                    </g>
                    <g id="#ffffffff">
                    <path fill="#ffffff" opacity="1.00" d=" M 0.00 142.25 C 19.05 142.25 38.10 142.25 57.14 142.25 C 57.10 161.29 57.13 180.33 57.13 199.38 C 38.09 199.37 19.04 199.38 0.00 199.37 L 0.00 142.25 Z" />
                    </g>
                    </svg>
                    
                  </td>
                  <td style="vertical-align: middle;">
                    <h1 style="margin: 0; color: #8cc63f; font-size: 28px; font-weight: 700; line-height: 1;">CUTMV</h1>
                  </td>
                </tr>
              </table>
              <p style="margin: 0; color: #666; font-size: 14px;">AI-Powered Video Creation Platform</p>
            </div>

            <!-- Main Content -->
            <div style="background: #f8fafc; padding: 30px; border-radius: 12px; margin-bottom: 30px;">
              <h2 style="margin: 0 0 20px 0; color: #1f2937; font-size: 24px; text-align: center;">🚀 Processing Started!</h2>
              
              <div style="background: white; padding: 24px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #8cc63f;">
                <h3 style="margin: 0 0 12px 0; color: #1f2937; font-size: 18px;">Video Details</h3>
                <p style="margin: 0 0 8px 0;"><strong>Video:</strong> ${videoName}</p>
                <p style="margin: 0 0 8px 0;"><strong>Estimated Time:</strong> ${estimatedTime}</p>
                <p style="margin: 0;"><strong>Content Type:</strong> ${contentType}</p>
              </div>

              ${qualityStatus}

              <div style="text-align: center; margin: 24px 0;">
                <p style="font-size: 16px; color: #4b5563; margin: 0;">We'll email you when your content is ready!</p>
                <p style="font-size: 14px; color: #6b7280; margin: 8px 0 0 0;">You can safely close this page while we work on your video.</p>
              </div>
            </div>

            <!-- Footer -->
            <div style="text-align: center; padding-top: 20px; border-top: 1px solid #e5e7eb; color: #6b7280; font-size: 14px;">
              <p style="margin: 0 0 8px 0;">Made with ❤️ by <strong>Full Digital</strong></p>
              <p style="margin: 0;">Questions? Contact us at <a href="mailto:staff@fulldigitalll.com" style="color: #8cc63f;">staff@fulldigitalll.com</a></p>
            </div>
          </div>
        </body>
      </html>
    `;

    const text = `
CUTMV - Processing Started

Your video processing has started!

Video: ${videoName}
Estimated Time: ${estimatedTime}
Content Type: ${contentType}

✅ Professional Quality - Clean & Watermark-Free

We'll email you when your content is ready! You can safely close this page while we work on your video.

Made with ❤️ by Full Digital
Questions? Contact us at staff@fulldigitalll.com
    `;

    return { subject, html, text };
  }

  // Generate HTML template for download ready notification
  private generateDownloadTemplate(options: EmailDeliveryOptions): EmailTemplate {
    const { 
      downloadUrl, 
      downloadFilename, 
      processingDetails, 
      // professionalQuality: true, // All exports are professional quality
      expirationHours = 24 
    } = options;

    const { videoName, clipsGenerated = 0, gifsGenerated = 0, thumbnailsGenerated = 0, canvasGenerated = 0, timestampsUsed } = processingDetails;
    
    const professionalQualityStatus = '<div style="background: #8cc63f; color: white; padding: 12px 16px; border-radius: 8px; margin: 16px 0; text-align: center; font-weight: 600;">✅ Professional Quality - Clean & Commercial-Ready</div>';

    const upgradeSection = ''; // No upgrade needed - all exports are professional quality

    const subject = `Your CUTMV Clip Pack is Ready`;
    
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Download Ready - CUTMV</title>
        </head>
        <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333;">
          <div style="max-width: 600px; margin: 0 auto; padding: 20px; background: #ffffff;">
            <!-- Header -->
            <div style="text-align: center; margin-bottom: 30px; padding: 20px 0; border-bottom: 2px solid #8cc63f;">
              <!-- Logo and Brand centered using table layout for email compatibility -->
              <table style="margin: 0 auto 8px auto; border: 0; border-spacing: 0;">
                <tr>
                  <td style="vertical-align: middle; padding-right: 12px;">
                <!-- Professional Full Digital logo -->
                    <svg width="28" height="28" viewBox="0 0 200 200" version="1.1" xmlns="http://www.w3.org/2000/svg">
                    <g id="#94f33fff">
                    <path fill="#94f33f" opacity="1.00" d=" M 71.13 0.00 L 128.25 0.00 C 128.25 19.04 128.25 38.08 128.25 57.13 C 109.21 57.12 90.17 57.12 71.13 57.13 C 71.13 38.09 71.13 19.04 71.13 0.00 Z" />
                    <path fill="#94f33f" opacity="1.00" d=" M 142.25 0.00 L 199.38 0.00 C 199.37 19.04 199.38 38.08 199.37 57.12 C 180.33 57.10 161.29 57.16 142.25 57.09 C 142.25 38.06 142.26 19.03 142.25 0.00 Z" />
                    <path fill="#94f33f" opacity="1.00" d=" M 0.00 71.13 C 19.04 71.13 38.09 71.12 57.13 71.13 C 57.11 90.17 57.15 109.21 57.11 128.24 C 38.07 128.25 19.04 128.25 0.00 128.24 L 0.00 71.13 Z" />
                    <path fill="#94f33f" opacity="1.00" d=" M 71.13 71.13 C 90.16 71.12 109.19 71.13 128.22 71.13 C 128.28 90.17 128.23 109.21 128.25 128.24 C 109.21 128.27 90.17 128.22 71.13 128.27 C 71.13 109.22 71.12 90.18 71.13 71.13 Z" />
                    <path fill="#94f33f" opacity="1.00" d=" M 142.23 71.12 C 161.28 71.14 180.32 71.12 199.36 71.13 C 199.39 90.16 199.38 109.20 199.37 128.23 C 180.33 128.27 161.29 128.24 142.25 128.25 C 142.24 109.20 142.28 90.16 142.23 71.12 Z" />
                    <path fill="#94f33f" opacity="1.00" d=" M 71.14 142.27 C 90.18 142.24 109.21 142.26 128.25 142.26 C 128.26 161.30 128.23 180.34 128.26 199.38 C 109.22 199.36 90.17 199.39 71.13 199.36 C 71.13 180.33 71.11 161.30 71.14 142.27 Z" />
                    </g>
                    <g id="#ffffffff">
                    <path fill="#ffffff" opacity="1.00" d=" M 0.00 142.25 C 19.05 142.25 38.10 142.25 57.14 142.25 C 57.10 161.29 57.13 180.33 57.13 199.38 C 38.09 199.37 19.04 199.38 0.00 199.37 L 0.00 142.25 Z" />
                    </g>
                    </svg>
                    
                  </td>
                  <td style="vertical-align: middle;">
                    <h1 style="margin: 0; color: #8cc63f; font-size: 28px; font-weight: 700; line-height: 1;">CUTMV</h1>
                  </td>
                </tr>
              </table>
              <p style="margin: 0; color: #666; font-size: 14px;">AI-Powered Video Creation Platform</p>
            </div>

            <!-- Success Message -->
            <div style="background: #f0fdf4; padding: 30px; border-radius: 12px; margin-bottom: 20px; border: 1px solid #bbf7d0;">
              <h2 style="margin: 0 0 16px 0; color: #166534; font-size: 24px; text-align: center;">🎉 Your Content is Ready!</h2>
              
              ${professionalQualityStatus}
              
              <div style="text-align: center; margin: 24px 0;">
                <a href="${downloadUrl}" style="display: inline-block; background: #8cc63f; color: white; padding: 16px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 18px; box-shadow: 0 4px 6px rgba(140, 198, 63, 0.3);">Download Your Files</a>
              </div>
              
              <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
                <h3 style="margin: 0 0 16px 0; color: #1f2937; font-size: 18px;">Export Summary</h3>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                  <div style="text-align: center; padding: 12px; background: #f8fafc; border-radius: 6px;">
                    <div style="font-size: 24px; font-weight: 700; color: #8cc63f;">${clipsGenerated}</div>
                    <div style="font-size: 14px; color: #6b7280;">Video Clips</div>
                  </div>
                  <div style="text-align: center; padding: 12px; background: #f8fafc; border-radius: 6px;">
                    <div style="font-size: 24px; font-weight: 700; color: #8cc63f;">${gifsGenerated}</div>
                    <div style="font-size: 14px; color: #6b7280;">GIFs Created</div>
                  </div>
                  <div style="text-align: center; padding: 12px; background: #f8fafc; border-radius: 6px;">
                    <div style="font-size: 24px; font-weight: 700; color: #8cc63f;">${thumbnailsGenerated}</div>
                    <div style="font-size: 14px; color: #6b7280;">Thumbnails</div>
                  </div>
                  <div style="text-align: center; padding: 12px; background: #f8fafc; border-radius: 6px;">
                    <div style="font-size: 24px; font-weight: 700; color: #8cc63f;">${canvasGenerated}</div>
                    <div style="font-size: 14px; color: #6b7280;">Canvas Loops</div>
                  </div>
                </div>
              </div>
            </div>

            ${upgradeSection}

            <!-- Additional Actions -->
            <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0; text-align: center;">
              <h3 style="margin: 0 0 16px 0; color: #1f2937;">Try Another Video</h3>
              <p style="margin: 0 0 16px 0; color: #6b7280;">Ready to create more content?</p>
              <a href="${this.baseUrl}" style="display: inline-block; background: #374151; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">Upload Another Video</a>
            </div>

            <!-- Important Info -->
            <div style="background: #fef3c7; padding: 16px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #f59e0b;">
              <p style="margin: 0; color: #92400e; font-size: 14px;">
                <strong>⏰ Download expires in ${expirationHours} hours</strong><br>
                File: ${downloadFilename}
              </p>
            </div>

            <!-- Support -->
            <div style="background: #eff6ff; padding: 16px; border-radius: 8px; margin: 20px 0; text-align: center;">
              <p style="margin: 0 0 8px 0; color: #1e40af; font-weight: 600;">Need help?</p>
              <a href="mailto:staff@fulldigitalll.com" style="color: #2563eb; text-decoration: none;">Click here to contact support</a>
            </div>

            <!-- Footer -->
            <div style="text-align: center; padding-top: 20px; border-top: 1px solid #e5e7eb; color: #6b7280; font-size: 14px;">
              <p style="margin: 0 0 8px 0;">Made with ❤️ by <strong>Full Digital</strong></p>
              <p style="margin: 0;">Questions? Contact us at <a href="mailto:staff@fulldigitalll.com" style="color: #8cc63f;">staff@fulldigitalll.com</a></p>
            </div>
          </div>
        </body>
      </html>
    `;

    const text = `
CUTMV - Your Clip Pack is Ready!

✅ Professional Quality - Clean & Commercial-Ready

Download your files: ${downloadUrl}

Export Summary:
- ${clipsGenerated} Video Clips
- ${gifsGenerated} GIFs Created  
- ${thumbnailsGenerated} Thumbnails
- ${canvasGenerated} Canvas Loops

✅ All exports are professional quality and commercial-ready

Try Another Video: ${this.baseUrl}

⏰ Download expires in ${expirationHours} hours
File: ${downloadFilename}

Need help? Contact support at staff@fulldigitalll.com

Made with ❤️ by Full Digital
    `;

    return { subject, html, text };
  }

  // Generate HTML template for welcome email
  private generateWelcomeTemplate(options: WelcomeEmailOptions): EmailTemplate {
    const { userEmail, firstName = 'Creator' } = options;
    
    const subject = `Welcome to CUTMV, ${firstName}! 🎬`;
    
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Welcome to CUTMV</title>
        </head>
        <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; background: #f5f5f5;">
          <div style="max-width: 600px; margin: 0 auto; background: #ffffff;">
            <!-- Header Banner -->
            <div style="background: #2d2d2d; color: white; padding: 30px 20px; text-align: center;">
              <!-- Logo and Brand centered using table layout for email compatibility -->
              <table style="margin: 0 auto 8px auto; border: 0; border-spacing: 0;">
                <tr>
                  <td style="vertical-align: middle; padding-right: 12px;">
                <!-- Professional Full Digital logo -->
                    <svg width="32" height="32" viewBox="0 0 200 200" version="1.1" xmlns="http://www.w3.org/2000/svg">
                    <g id="#94f33fff">
                    <path fill="#94f33f" opacity="1.00" d=" M 71.13 0.00 L 128.25 0.00 C 128.25 19.04 128.25 38.08 128.25 57.13 C 109.21 57.12 90.17 57.12 71.13 57.13 C 71.13 38.09 71.13 19.04 71.13 0.00 Z" />
                    <path fill="#94f33f" opacity="1.00" d=" M 142.25 0.00 L 199.38 0.00 C 199.37 19.04 199.38 38.08 199.37 57.12 C 180.33 57.10 161.29 57.16 142.25 57.09 C 142.25 38.06 142.26 19.03 142.25 0.00 Z" />
                    <path fill="#94f33f" opacity="1.00" d=" M 0.00 71.13 C 19.04 71.13 38.09 71.12 57.13 71.13 C 57.11 90.17 57.15 109.21 57.11 128.24 C 38.07 128.25 19.04 128.25 0.00 128.24 L 0.00 71.13 Z" />
                    <path fill="#94f33f" opacity="1.00" d=" M 71.13 71.13 C 90.16 71.12 109.19 71.13 128.22 71.13 C 128.28 90.17 128.23 109.21 128.25 128.24 C 109.21 128.27 90.17 128.22 71.13 128.27 C 71.13 109.22 71.12 90.18 71.13 71.13 Z" />
                    <path fill="#94f33f" opacity="1.00" d=" M 142.23 71.12 C 161.28 71.14 180.32 71.12 199.36 71.13 C 199.39 90.16 199.38 109.20 199.37 128.23 C 180.33 128.27 161.29 128.24 142.25 128.25 C 142.24 109.20 142.28 90.16 142.23 71.12 Z" />
                    <path fill="#94f33f" opacity="1.00" d=" M 71.14 142.27 C 90.18 142.24 109.21 142.26 128.25 142.26 C 128.26 161.30 128.23 180.34 128.26 199.38 C 109.22 199.36 90.17 199.39 71.13 199.36 C 71.13 180.33 71.11 161.30 71.14 142.27 Z" />
                    </g>
                    <g id="#ffffffff">
                    <path fill="#ffffff" opacity="1.00" d=" M 0.00 142.25 C 19.05 142.25 38.10 142.25 57.14 142.25 C 57.10 161.29 57.13 180.33 57.13 199.38 C 38.09 199.37 19.04 199.38 0.00 199.37 L 0.00 142.25 Z" />
                    </g>
                    </svg>
                    
                  </td>
                  <td style="vertical-align: middle;">
                    <h1 style="margin: 0; color: #8cc63f; font-size: 32px; font-weight: 700; line-height: 1;">CUTMV</h1>
                  </td>
                </tr>
              </table>
              <p style="margin: 0; color: #cccccc; font-size: 14px;">Music Video Cut-Down Tool</p>
            </div>

            <!-- Content -->
            <div style="padding: 30px 20px;">
              <h2 style="margin: 0 0 20px 0; color: #333; font-size: 24px; font-weight: 600;">Welcome to CUTMV!</h2>
              
              <p style="margin: 0 0 20px 0; color: #555; font-size: 16px; line-height: 1.5;">
                Thank you for joining CUTMV - the AI-powered platform that transforms your music videos into viral-ready content for today's social media landscape.
              </p>

              <h3 style="margin: 30px 0 15px 0; color: #333; font-size: 18px; font-weight: 600;">🚀 What You Can Do With CUTMV:</h3>

              <div style="margin-bottom: 20px;">
                <p style="margin: 0 0 8px 0; color: #333; font-size: 16px; font-weight: 600;">Smart Video Cutdowns</p>
                <p style="margin: 0; color: #666; font-size: 14px;">AI analyzes your music video and creates perfectly timed clips from your timestamps - perfect for social media and Spotify for Artists</p>
              </div>

              <div style="margin-bottom: 20px;">
                <p style="margin: 0 0 8px 0; color: #333; font-size: 16px; font-weight: 600;">GIF Generation</p>
                <p style="margin: 0; color: #666; font-size: 14px;">Create engaging 6-second GIFs for social media promotion</p>
              </div>

              <div style="margin-bottom: 20px;">
                <p style="margin: 0 0 8px 0; color: #333; font-size: 16px; font-weight: 600;">High-Quality Thumbnails</p>
                <p style="margin: 0; color: #666; font-size: 14px;">Extract perfect still frames for covers and promotional content</p>
              </div>

              <div style="margin-bottom: 30px;">
                <p style="margin: 0 0 8px 0; color: #333; font-size: 16px; font-weight: 600;">Multiple Formats</p>
                <p style="margin: 0; color: #666; font-size: 14px;">Get both horizontal (16:9) and vertical (9:16) versions instantly</p>
              </div>

              <p style="margin: 0 0 30px 0; color: #555; font-size: 16px; line-height: 1.5;">
                We'll keep you updated when your videos are processed and ready for download. Plus, you'll receive exclusive tips, creative insights, and special offers to help maximize your music's reach.
              </p>

              <!-- CTA Button -->
              <div style="text-align: center; margin: 30px 0;">
                <a href="${this.baseUrl}" style="display: inline-block; background: #8cc63f; color: white; padding: 16px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 18px; box-shadow: 0 4px 6px rgba(140, 198, 63, 0.3);">Start Creating Now →</a>
              </div>

              <p style="margin: 30px 0 0 0; color: #666; font-size: 14px;">
                <strong>Questions?</strong> Reply to this email anytime - we're here to help you create amazing content!
              </p>

              <p style="margin: 15px 0 0 0; color: #666; font-size: 14px;">
                Best,<br>
                The CUTMV Team<br>
                <em style="color: #8cc63f;">Powered by Full Digital - Multi-Platinum Design Agency</em>
              </p>
            </div>

            <!-- Footer -->
            <div style="background: #f8f8f8; padding: 20px; text-align: center; border-top: 1px solid #eee;">
              <p style="margin: 0; color: #999; font-size: 12px;">
                You're receiving this because you opted in for CUTMV updates and download delivery.
              </p>
            </div>
          </div>
        </body>
      </html>
    `;

    const text = `
Welcome to CUTMV!

Thank you for joining CUTMV - the AI-powered platform that transforms your music videos into viral-ready content for today's social media landscape.

🚀 What You Can Do With CUTMV:

Smart Video Cutdowns - AI analyzes your music video and creates perfectly timed clips from your timestamps - perfect for social media and Spotify for Artists

GIF Generation - Create engaging 6-second GIFs for social media promotion

High-Quality Thumbnails - Extract perfect still frames for covers and promotional content

Multiple Formats - Get both horizontal (16:9) and vertical (9:16) versions instantly

We'll keep you updated when your videos are processed and ready for download. Plus, you'll receive exclusive tips, creative insights, and special offers to help maximize your music's reach.

Start Creating Now: ${this.baseUrl}

Questions? Reply to this email anytime - we're here to help you create amazing content!

Best,
The CUTMV Team
Powered by Full Digital - Multi-Platinum Design Agency

You're receiving this because you opted in for CUTMV updates and download delivery.
    `;

    return { subject, html, text };
  }

  // Send processing started notification
  async sendProcessingNotification(options: ProcessingNotificationOptions): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.isConfigured || !this.resend) {
      console.warn('Email service not configured - skipping processing notification');
      return { success: false, error: 'Email service not configured' };
    }
    try {
      const template = this.generateProcessingTemplate(options);
      
      const response = await this.resend.emails.send({
        from: this.fromEmail,
        to: options.userEmail,
        subject: template.subject,
        html: template.html,
        text: template.text,
      });

      if (response.data?.id) {
        console.log(`Processing notification sent to ${options.userEmail} via Resend`);
        return {
          success: true,
          messageId: response.data.id
        };
      } else {
        console.error('Failed to send processing notification:', response.error);
        return {
          success: false,
          error: response.error?.message || 'Failed to send email'
        };
      }
    } catch (error) {
      console.error('Error sending processing notification:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // Send download ready notification
  async sendDownloadLink(options: EmailDeliveryOptions): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.isConfigured || !this.resend) {
      console.warn('Email service not configured - skipping download link email');
      return { success: false, error: 'Email service not configured' };
    }
    try {
      const template = this.generateDownloadTemplate(options);
      
      const response = await this.resend.emails.send({
        from: this.fromEmail,
        to: options.userEmail,
        subject: template.subject,
        html: template.html,
        text: template.text,
      });

      if (response.data?.id) {
        console.log(`Success: Download link sent to ${options.userEmail} via Resend`);
        return {
          success: true,
          messageId: response.data.id
        };
      } else {
        console.error('Failed to send download link:', response.error);
        return {
          success: false,
          error: response.error?.message || 'Failed to send email'
        };
      }
    } catch (error) {
      console.error('Error sending download link:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // Send welcome email
  async sendWelcomeEmail(options: WelcomeEmailOptions): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.isConfigured || !this.resend) {
      console.warn('Email service not configured - skipping welcome email');
      return { success: false, error: 'Email service not configured' };
    }
    try {
      const template = this.generateWelcomeTemplate(options);
      
      const response = await this.resend.emails.send({
        from: this.fromEmail,
        to: options.userEmail,
        subject: template.subject,
        html: template.html,
        text: template.text,
      });

      if (response.data?.id) {
        console.log(`Success: Welcome email sent to ${options.userEmail} via Resend`);
        return {
          success: true,
          messageId: response.data.id
        };
      } else {
        console.error('Failed to send welcome email:', response.error);
        return {
          success: false,
          error: 'Failed to send email'
        };
      }
    } catch (error) {
      console.error('Error sending welcome email:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // Send failure notification email
  async sendFailureNotification(options: FailureNotificationOptions): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.isConfigured || !this.resend) {
      console.warn('Email service not configured - skipping failure notification');
      return { success: false, error: 'Email service not configured' };
    }
    try {
      const template = this.generateFailureTemplate(options);
      
      const response = await this.resend.emails.send({
        from: this.fromEmail,
        to: options.userEmail,
        subject: template.subject,
        html: template.html,
        text: template.text,
      });

      if (response.data?.id) {
        console.log(`Success: Failure notification sent to ${options.userEmail} via Resend`);
        return {
          success: true,
          messageId: response.data.id
        };
      } else {
        console.error('Failed to send failure notification:', response.error);
        return {
          success: false,
          error: response.error?.message || 'Failed to send email'
        };
      }
    } catch (error) {
      console.error('Error sending failure notification:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // Generate HTML template for failure notification
  private generateFailureTemplate(options: FailureNotificationOptions): EmailTemplate {
    const { videoName, errorMessage } = options;
    
    const subject = `Export Failed - ${videoName}`;
    
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Export Failed - CUTMV</title>
        </head>
        <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333;">
          <div style="max-width: 600px; margin: 0 auto; padding: 20px; background: #ffffff;">
            <!-- Header -->
            <div style="text-align: center; margin-bottom: 30px; padding: 20px 0; border-bottom: 2px solid #8cc63f;">
              <!-- Logo and Brand centered using table layout for email compatibility -->
              <table style="margin: 0 auto 8px auto; border: 0; border-spacing: 0;">
                <tr>
                  <td style="vertical-align: middle; padding-right: 12px;">
                <!-- Professional Full Digital logo -->
                    <svg width="28" height="28" viewBox="0 0 200 200" version="1.1" xmlns="http://www.w3.org/2000/svg">
                    <g id="#94f33fff">
                    <path fill="#94f33f" opacity="1.00" d=" M 71.13 0.00 L 128.25 0.00 C 128.25 19.04 128.25 38.08 128.25 57.13 C 109.21 57.12 90.17 57.12 71.13 57.13 C 71.13 38.09 71.13 19.04 71.13 0.00 Z" />
                    <path fill="#94f33f" opacity="1.00" d=" M 142.25 0.00 L 199.38 0.00 C 199.37 19.04 199.38 38.08 199.37 57.12 C 180.33 57.10 161.29 57.16 142.25 57.09 C 142.25 38.06 142.26 19.03 142.25 0.00 Z" />
                    <path fill="#94f33f" opacity="1.00" d=" M 0.00 71.13 C 19.04 71.13 38.09 71.12 57.13 71.13 C 57.11 90.17 57.15 109.21 57.11 128.24 C 38.07 128.25 19.04 128.25 0.00 128.24 L 0.00 71.13 Z" />
                    <path fill="#94f33f" opacity="1.00" d=" M 71.13 71.13 C 90.16 71.12 109.19 71.13 128.22 71.13 C 128.28 90.17 128.23 109.21 128.25 128.24 C 109.21 128.27 90.17 128.22 71.13 128.27 C 71.13 109.22 71.12 90.18 71.13 71.13 Z" />
                    <path fill="#94f33f" opacity="1.00" d=" M 142.23 71.12 C 161.28 71.14 180.32 71.12 199.36 71.13 C 199.39 90.16 199.38 109.20 199.37 128.23 C 180.33 128.27 161.29 128.24 142.25 128.25 C 142.24 109.20 142.28 90.16 142.23 71.12 Z" />
                    <path fill="#94f33f" opacity="1.00" d=" M 71.14 142.27 C 90.18 142.24 109.21 142.26 128.25 142.26 C 128.26 161.30 128.23 180.34 128.26 199.38 C 109.22 199.36 90.17 199.39 71.13 199.36 C 71.13 180.33 71.11 161.30 71.14 142.27 Z" />
                    </g>
                    <g id="#ffffffff">
                    <path fill="#ffffff" opacity="1.00" d=" M 0.00 142.25 C 19.05 142.25 38.10 142.25 57.14 142.25 C 57.10 161.29 57.13 180.33 57.13 199.38 C 38.09 199.37 19.04 199.38 0.00 199.37 L 0.00 142.25 Z" />
                    </g>
                    </svg>
                  </td>
                  <td style="vertical-align: middle;">
                    <h1 style="margin: 0; color: #8cc63f; font-size: 28px; font-weight: 700; line-height: 1;">CUTMV</h1>
                  </td>
                </tr>
              </table>
              <p style="margin: 0; color: #666; font-size: 14px;">AI-Powered Video Creation Platform</p>
            </div>

            <!-- Failure Message -->
            <div style="background: #fef2f2; padding: 30px; border-radius: 12px; margin-bottom: 20px; border: 1px solid #fecaca;">
              <h2 style="margin: 0 0 20px 0; color: #dc2626; font-size: 24px; text-align: center;">❌ Export Failed</h2>
              
              <div style="background: white; padding: 24px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #dc2626;">
                <h3 style="margin: 0 0 12px 0; color: #1f2937; font-size: 18px;">Video Details</h3>
                <p style="margin: 0 0 8px 0;"><strong>Video:</strong> ${videoName}</p>
                <p style="margin: 0 0 8px 0;"><strong>Error:</strong> ${errorMessage}</p>
              </div>

              <div style="text-align: center; margin: 24px 0;">
                <p style="font-size: 16px; color: #991b1b; margin: 0 0 16px 0;">We're sorry your export failed. Please try again or contact support if this continues.</p>
                <a href="${this.baseUrl}" style="display: inline-block; background: #8cc63f; color: white; padding: 16px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 18px; box-shadow: 0 4px 6px rgba(140, 198, 63, 0.3);">Try Again</a>
              </div>
            </div>

            <!-- Support -->
            <div style="background: #eff6ff; padding: 20px; border-radius: 8px; margin: 20px 0; text-align: center;">
              <h3 style="margin: 0 0 16px 0; color: #1e40af;">Need Help?</h3>
              <p style="margin: 0 0 16px 0; color: #3730a3;">If this error persists, please contact our support team with the details above.</p>
              <a href="mailto:staff@fulldigitalll.com" style="display: inline-block; background: #2563eb; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">Contact Support</a>
            </div>

            <!-- Footer -->
            <div style="text-align: center; padding-top: 20px; border-top: 1px solid #e5e7eb; color: #6b7280; font-size: 14px;">
              <p style="margin: 0 0 8px 0;">Made with ❤️ by <strong>Full Digital</strong></p>
              <p style="margin: 0;">Questions? Contact us at <a href="mailto:staff@fulldigitalll.com" style="color: #8cc63f;">staff@fulldigitalll.com</a></p>
            </div>
          </div>
        </body>
      </html>
    `;

    const text = `
CUTMV - Export Failed

Your video export has failed.

Video: ${videoName}
Error: ${errorMessage}

We're sorry your export failed. Please try again or contact support if this continues.

Try Again: ${this.baseUrl}

Need Help? Contact support at staff@fulldigitalll.com

Made with ❤️ by Full Digital
    `;

    return { subject, html, text };
  }

  // Generate HTML template for payment failed notification
  private generatePaymentFailedTemplate(options: PaymentFailedOptions): EmailTemplate {
    const { userName = 'there', planName, daysRemaining, updatePaymentUrl } = options;

    const urgencyLevel = daysRemaining <= 2 ? 'critical' : daysRemaining <= 3 ? 'warning' : 'notice';
    const urgencyColor = urgencyLevel === 'critical' ? '#dc2626' : urgencyLevel === 'warning' ? '#f59e0b' : '#3b82f6';
    const urgencyBg = urgencyLevel === 'critical' ? '#fef2f2' : urgencyLevel === 'warning' ? '#fffbeb' : '#eff6ff';
    const urgencyBorder = urgencyLevel === 'critical' ? '#fecaca' : urgencyLevel === 'warning' ? '#fde68a' : '#bfdbfe';

    const subject = daysRemaining === 1
      ? `⚠️ Final Notice: Your CUTMV subscription will be paused tomorrow`
      : `Action Required: Update your payment method - ${daysRemaining} days remaining`;

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Payment Failed - CUTMV</title>
        </head>
        <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333;">
          <div style="max-width: 600px; margin: 0 auto; padding: 20px; background: #ffffff;">
            <!-- Header -->
            <div style="text-align: center; margin-bottom: 30px; padding: 20px 0; border-bottom: 2px solid #8cc63f;">
              <table style="margin: 0 auto 8px auto; border: 0; border-spacing: 0;">
                <tr>
                  <td style="vertical-align: middle; padding-right: 12px;">
                    <svg width="28" height="28" viewBox="0 0 200 200" version="1.1" xmlns="http://www.w3.org/2000/svg">
                    <g id="#94f33fff">
                    <path fill="#94f33f" opacity="1.00" d=" M 71.13 0.00 L 128.25 0.00 C 128.25 19.04 128.25 38.08 128.25 57.13 C 109.21 57.12 90.17 57.12 71.13 57.13 C 71.13 38.09 71.13 19.04 71.13 0.00 Z" />
                    <path fill="#94f33f" opacity="1.00" d=" M 142.25 0.00 L 199.38 0.00 C 199.37 19.04 199.38 38.08 199.37 57.12 C 180.33 57.10 161.29 57.16 142.25 57.09 C 142.25 38.06 142.26 19.03 142.25 0.00 Z" />
                    <path fill="#94f33f" opacity="1.00" d=" M 0.00 71.13 C 19.04 71.13 38.09 71.12 57.13 71.13 C 57.11 90.17 57.15 109.21 57.11 128.24 C 38.07 128.25 19.04 128.25 0.00 128.24 L 0.00 71.13 Z" />
                    <path fill="#94f33f" opacity="1.00" d=" M 71.13 71.13 C 90.16 71.12 109.19 71.13 128.22 71.13 C 128.28 90.17 128.23 109.21 128.25 128.24 C 109.21 128.27 90.17 128.22 71.13 128.27 C 71.13 109.22 71.12 90.18 71.13 71.13 Z" />
                    <path fill="#94f33f" opacity="1.00" d=" M 142.23 71.12 C 161.28 71.14 180.32 71.12 199.36 71.13 C 199.39 90.16 199.38 109.20 199.37 128.23 C 180.33 128.27 161.29 128.24 142.25 128.25 C 142.24 109.20 142.28 90.16 142.23 71.12 Z" />
                    <path fill="#94f33f" opacity="1.00" d=" M 71.14 142.27 C 90.18 142.24 109.21 142.26 128.25 142.26 C 128.26 161.30 128.23 180.34 128.26 199.38 C 109.22 199.36 90.17 199.39 71.13 199.36 C 71.13 180.33 71.11 161.30 71.14 142.27 Z" />
                    </g>
                    <g id="#ffffffff">
                    <path fill="#ffffff" opacity="1.00" d=" M 0.00 142.25 C 19.05 142.25 38.10 142.25 57.14 142.25 C 57.10 161.29 57.13 180.33 57.13 199.38 C 38.09 199.37 19.04 199.38 0.00 199.37 L 0.00 142.25 Z" />
                    </g>
                    </svg>
                  </td>
                  <td style="vertical-align: middle;">
                    <h1 style="margin: 0; color: #8cc63f; font-size: 28px; font-weight: 700; line-height: 1;">CUTMV</h1>
                  </td>
                </tr>
              </table>
              <p style="margin: 0; color: #666; font-size: 14px;">AI-Powered Video Creation Platform</p>
            </div>

            <!-- Payment Failed Alert -->
            <div style="background: ${urgencyBg}; padding: 30px; border-radius: 12px; margin-bottom: 20px; border: 1px solid ${urgencyBorder};">
              <h2 style="margin: 0 0 16px 0; color: ${urgencyColor}; font-size: 24px; text-align: center;">
                ${daysRemaining === 1 ? '⚠️ Final Notice' : '💳 Payment Update Needed'}
              </h2>

              <p style="margin: 0 0 16px 0; color: #374151; font-size: 16px;">
                Hi ${userName},
              </p>

              <p style="margin: 0 0 16px 0; color: #374151; font-size: 16px;">
                We couldn't process your payment for your <strong>${planName}</strong> subscription.
                ${daysRemaining === 1
                  ? 'This is your final reminder - your subscription will be paused <strong>tomorrow</strong> if we can\'t process payment.'
                  : `You have <strong>${daysRemaining} days</strong> to update your payment method before your subscription is paused.`
                }
              </p>

              <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid ${urgencyColor};">
                <p style="margin: 0; font-size: 14px; color: #6b7280;">
                  <strong>What happens if payment fails?</strong><br>
                  • You'll lose your 50% subscriber discount<br>
                  • Your monthly credits will not be renewed<br>
                  • You can re-subscribe anytime to restore benefits
                </p>
              </div>

              <div style="text-align: center; margin: 24px 0;">
                <a href="${updatePaymentUrl}" style="display: inline-block; background: #8cc63f; color: white; padding: 16px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 18px; box-shadow: 0 4px 6px rgba(140, 198, 63, 0.3);">Update Payment Method</a>
              </div>

              <p style="margin: 0; text-align: center; color: #6b7280; font-size: 14px;">
                ${daysRemaining > 1 ? `We'll send you a reminder each day for the next ${daysRemaining - 1} days.` : 'This is your last reminder.'}
              </p>
            </div>

            <!-- Support -->
            <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0; text-align: center;">
              <p style="margin: 0 0 8px 0; color: #374151; font-weight: 600;">Need Help?</p>
              <p style="margin: 0; color: #6b7280; font-size: 14px;">
                If you're having issues with payment, contact us at <a href="mailto:staff@fulldigitalll.com" style="color: #8cc63f;">staff@fulldigitalll.com</a>
              </p>
            </div>

            <!-- Footer -->
            <div style="text-align: center; padding-top: 20px; border-top: 1px solid #e5e7eb; color: #6b7280; font-size: 14px;">
              <p style="margin: 0 0 8px 0;">Made with ❤️ by <strong>Full Digital</strong></p>
              <p style="margin: 0;">Questions? Contact us at <a href="mailto:staff@fulldigitalll.com" style="color: #8cc63f;">staff@fulldigitalll.com</a></p>
            </div>
          </div>
        </body>
      </html>
    `;

    const text = `
CUTMV - Payment Update Needed

Hi ${userName},

We couldn't process your payment for your ${planName} subscription.
${daysRemaining === 1
  ? 'This is your final reminder - your subscription will be paused tomorrow if we can\'t process payment.'
  : `You have ${daysRemaining} days to update your payment method before your subscription is paused.`
}

What happens if payment fails?
• You'll lose your 50% subscriber discount
• Your monthly credits will not be renewed
• You can re-subscribe anytime to restore benefits

Update your payment method: ${updatePaymentUrl}

${daysRemaining > 1 ? `We'll send you a reminder each day for the next ${daysRemaining - 1} days.` : 'This is your last reminder.'}

Need Help? Contact us at staff@fulldigitalll.com

Made with ❤️ by Full Digital
    `;

    return { subject, html, text };
  }

  // Send payment failed notification
  async sendPaymentFailedNotification(options: PaymentFailedOptions): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.isConfigured || !this.resend) {
      console.warn('Email service not configured - skipping payment failed notification');
      return { success: false, error: 'Email service not configured' };
    }
    try {
      const template = this.generatePaymentFailedTemplate(options);

      const response = await this.resend.emails.send({
        from: this.fromEmail,
        to: options.userEmail,
        subject: template.subject,
        html: template.html,
        text: template.text,
      });

      if (response.data?.id) {
        console.log(`📧 Payment failed notification sent to ${options.userEmail} (${options.daysRemaining} days remaining)`);
        return {
          success: true,
          messageId: response.data.id
        };
      } else {
        console.error('Failed to send payment failed notification:', response.error);
        return {
          success: false,
          error: response.error?.message || 'Failed to send email'
        };
      }
    } catch (error) {
      console.error('Error sending payment failed notification:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
}

export const emailService = new EmailService();