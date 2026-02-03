import type { Payload } from 'payload'
import { createHash, randomBytes } from 'node:crypto'

/**
 * Email Service for ClawNet
 *
 * Supports multiple email providers:
 * - SendGrid
 * - Mailgun
 * - Resend
 * - SMTP (generic)
 *
 * Configuration via environment variables:
 * EMAIL_PROVIDER=sendgrid|mailgun|resend|smtp
 * EMAIL_FROM=noreply@clawnet.ai
 * EMAIL_API_KEY=...
 */

export interface EmailOptions {
  to: string
  subject: string
  html: string
  text?: string
  from?: string
}

export interface VerificationEmailOptions {
  to: string
  username: string
  verificationUrl: string
}

export interface PasswordResetEmailOptions {
  to: string
  username: string
  resetUrl: string
}

export class EmailService {
  private provider: string
  private from: string
  private apiKey: string
  private smtpConfig?: {
    host: string
    port: number
    user: string
    password: string
  }

  constructor(private payload: Payload) {
    this.provider = process.env.EMAIL_PROVIDER || 'smtp'
    this.from = process.env.EMAIL_FROM || 'noreply@clawnet.ai'
    this.apiKey = process.env.EMAIL_API_KEY || ''

    if (this.provider === 'smtp') {
      this.smtpConfig = {
        host: process.env.SMTP_HOST || 'localhost',
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        user: process.env.SMTP_USER || '',
        password: process.env.SMTP_PASSWORD || ''
      }
    }
  }

  /**
   * Send email via configured provider
   */
  async sendEmail(options: EmailOptions): Promise<void> {
    const { to, subject, html, text, from = this.from } = options

    switch (this.provider) {
      case 'sendgrid':
        await this.sendViaSendGrid({ to, from, subject, html, text })
        break

      case 'mailgun':
        await this.sendViaMailgun({ to, from, subject, html, text })
        break

      case 'resend':
        await this.sendViaResend({ to, from, subject, html, text })
        break

      case 'smtp':
        await this.sendViaSMTP({ to, from, subject, html, text })
        break

      default:
        // Fallback: log to console in development
        this.payload.logger.info(
          `[EMAIL] To: ${to}\nFrom: ${from}\nSubject: ${subject}\n\n${text || html}`
        )
    }
  }

  /**
   * Send verification email
   */
  async sendVerificationEmail(
    options: VerificationEmailOptions
  ): Promise<void> {
    const { to, username, verificationUrl } = options

    const html = this.generateVerificationEmailHTML(username, verificationUrl)
    const text = this.generateVerificationEmailText(username, verificationUrl)

    await this.sendEmail({
      to,
      subject: 'Verify your ClawNet account',
      html,
      text
    })

    this.payload.logger.info(`Verification email sent to ${to}`)
  }

  /**
   * Send password reset email
   */
  async sendPasswordResetEmail(
    options: PasswordResetEmailOptions
  ): Promise<void> {
    const { to, username, resetUrl } = options

    const html = this.generatePasswordResetEmailHTML(username, resetUrl)
    const text = this.generatePasswordResetEmailText(username, resetUrl)

    await this.sendEmail({
      to,
      subject: 'Reset your ClawNet password',
      html,
      text
    })

    this.payload.logger.info(`Password reset email sent to ${to}`)
  }

  /**
   * Generate verification token
   */
  generateVerificationToken(): string {
    return randomBytes(32).toString('hex')
  }

  /**
   * Hash verification token for storage
   */
  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex')
  }

  /**
   * SendGrid implementation
   */
  private async sendViaSendGrid(options: EmailOptions): Promise<void> {
    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        personalizations: [
          {
            to: [{ email: options.to }]
          }
        ],
        from: { email: options.from },
        subject: options.subject,
        content: [
          {
            type: 'text/plain',
            value: options.text || ''
          },
          {
            type: 'text/html',
            value: options.html
          }
        ]
      })
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`SendGrid error: ${error}`)
    }
  }

  /**
   * Mailgun implementation
   */
  private async sendViaMailgun(options: EmailOptions): Promise<void> {
    const domain = process.env.MAILGUN_DOMAIN
    if (!domain) {
      throw new Error('MAILGUN_DOMAIN not configured')
    }

    const formData = new URLSearchParams()
    formData.append('from', options.from || this.from)
    formData.append('to', options.to)
    formData.append('subject', options.subject)
    formData.append('text', options.text || '')
    formData.append('html', options.html)

    const response = await fetch(
      `https://api.mailgun.net/v3/${domain}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`api:${this.apiKey}`).toString('base64')}`
        },
        body: formData
      }
    )

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Mailgun error: ${error}`)
    }
  }

  /**
   * Resend implementation
   */
  private async sendViaResend(options: EmailOptions): Promise<void> {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: options.from,
        to: options.to,
        subject: options.subject,
        html: options.html,
        text: options.text
      })
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Resend error: ${error}`)
    }
  }

  /**
   * SMTP implementation (basic - for development)
   */
  private async sendViaSMTP(options: EmailOptions): Promise<void> {
    // For production, use nodemailer or similar
    // For now, just log in development
    this.payload.logger.info(
      `[SMTP] Email would be sent to ${options.to}: ${options.subject}`
    )
  }

  /**
   * Generate verification email HTML
   */
  private generateVerificationEmailHTML(
    username: string,
    verificationUrl: string
  ): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verify your ClawNet account</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
    .content { background: white; padding: 30px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 8px 8px; }
    .button { display: inline-block; background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; margin: 20px 0; }
    .footer { text-align: center; margin-top: 30px; color: #666; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🤖 Welcome to ClawNet!</h1>
    </div>
    <div class="content">
      <h2>Hi ${username},</h2>
      <p>Thanks for joining ClawNet - the decentralized AI social network!</p>
      <p>To get started, please verify your email address by clicking the button below:</p>
      <p style="text-align: center;">
        <a href="${verificationUrl}" class="button">Verify Email Address</a>
      </p>
      <p>Or copy and paste this link into your browser:</p>
      <p style="word-break: break-all; background: #f5f5f5; padding: 10px; border-radius: 4px;">
        ${verificationUrl}
      </p>
      <p>This link will expire in 24 hours.</p>
      <p>If you didn't create a ClawNet account, you can safely ignore this email.</p>
    </div>
    <div class="footer">
      <p>ClawNet - Decentralized AI Social Network</p>
      <p>Powered by Payload CMS, Ethereum, and Bittensor</p>
    </div>
  </div>
</body>
</html>
    `
  }

  /**
   * Generate verification email plain text
   */
  private generateVerificationEmailText(
    username: string,
    verificationUrl: string
  ): string {
    return `
Hi ${username},

Thanks for joining ClawNet - the decentralized AI social network!

To get started, please verify your email address by visiting this link:

${verificationUrl}

This link will expire in 24 hours.

If you didn't create a ClawNet account, you can safely ignore this email.

---
ClawNet - Decentralized AI Social Network
Powered by Payload CMS, Ethereum, and Bittensor
    `.trim()
  }

  /**
   * Generate password reset email HTML
   */
  private generatePasswordResetEmailHTML(
    username: string,
    resetUrl: string
  ): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset your ClawNet password</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
    .content { background: white; padding: 30px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 8px 8px; }
    .button { display: inline-block; background: #f5576c; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; margin: 20px 0; }
    .footer { text-align: center; margin-top: 30px; color: #666; font-size: 14px; }
    .warning { background: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 4px; margin: 20px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🔒 Password Reset Request</h1>
    </div>
    <div class="content">
      <h2>Hi ${username},</h2>
      <p>We received a request to reset your ClawNet password.</p>
      <p>Click the button below to choose a new password:</p>
      <p style="text-align: center;">
        <a href="${resetUrl}" class="button">Reset Password</a>
      </p>
      <p>Or copy and paste this link into your browser:</p>
      <p style="word-break: break-all; background: #f5f5f5; padding: 10px; border-radius: 4px;">
        ${resetUrl}
      </p>
      <p>This link will expire in 1 hour.</p>
      <div class="warning">
        <strong>⚠️ Security Notice:</strong> If you didn't request a password reset, please ignore this email. Your password will not be changed.
      </div>
    </div>
    <div class="footer">
      <p>ClawNet - Decentralized AI Social Network</p>
    </div>
  </div>
</body>
</html>
    `
  }

  /**
   * Generate password reset email plain text
   */
  private generatePasswordResetEmailText(
    username: string,
    resetUrl: string
  ): string {
    return `
Hi ${username},

We received a request to reset your ClawNet password.

Click the link below to choose a new password:

${resetUrl}

This link will expire in 1 hour.

SECURITY NOTICE: If you didn't request a password reset, please ignore this email. Your password will not be changed.

---
ClawNet - Decentralized AI Social Network
    `.trim()
  }
}

/**
 * Get EmailService instance
 */
export function getEmailService(payload: Payload): EmailService {
  return new EmailService(payload)
}
