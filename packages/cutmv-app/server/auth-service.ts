/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Magic Link Authentication Service
 * Lightweight email-only login system
 */

import { randomBytes, createHash } from 'crypto';
import { db } from './db';
import { users, sessions, magicLinks, exports } from '@shared/schema';
import { eq, and, gt, lt, sql } from 'drizzle-orm';
import { Resend } from 'resend';
import { urlSecurity } from './url-security.js';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const isEmailConfigured = !!process.env.RESEND_API_KEY;
if (!isEmailConfigured) {
  console.warn('⚠️ RESEND_API_KEY not configured in auth-service - magic link emails will be disabled');
}

export class AuthService {
  // Generate secure random token
  private generateToken(): string {
    return randomBytes(32).toString('hex');
  }

  // Hash token for secure storage
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  // Generate unique referral code
  private generateReferralCode(): string {
    // Create a user-friendly 6-character code using letters and numbers
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  // Generate 6-digit verification code
  private generateVerificationCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  // Create or get user by email with Supabase integration
  async getOrCreateUser(email: string, referralCode?: string) {
    const normalizedEmail = email.toLowerCase().trim();
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Check if user exists in PostgreSQL (case-insensitive search for backwards compatibility)
        let [user] = await db.select().from(users).where(sql`lower(${users.email}) = ${normalizedEmail}`);

        if (user) {
          console.log('✅ Found existing user:', normalizedEmail);
          return user;
        }

        // Generate unique referral code for new user
        const newReferralCode = this.generateReferralCode();
        console.log('📝 Creating new user:', { email: normalizedEmail, referralCode: newReferralCode, attempt });

        // Create new user in PostgreSQL with auto-generated referral code
        [user] = await db.insert(users).values({
          email: normalizedEmail,
          referralCode: newReferralCode,
          referredBy: referralCode // Track who referred this user
        }).returning();

        console.log('✅ User created successfully:', normalizedEmail);
        return user;
      } catch (error: any) {
        const errorMessage = error?.message || String(error);
        const errorCode = error?.code;

        console.error(`❌ Error in getOrCreateUser (attempt ${attempt}/${maxRetries}):`, {
          email: normalizedEmail,
          errorMessage,
          errorCode,
          errorDetail: error?.detail,
          errorConstraint: error?.constraint
        });

        // Check if this is a unique constraint violation on referralCode
        if (errorCode === '23505' && error?.constraint?.includes('referral_code')) {
          console.log('⚠️ Referral code collision, retrying with new code...');
          continue; // Retry with a new referral code
        }

        // Check if this is a unique constraint violation on email (race condition)
        if (errorCode === '23505' && error?.constraint?.includes('email')) {
          console.log('⚠️ Email already exists (race condition), fetching existing user...');
          const [existingUser] = await db.select().from(users).where(sql`lower(${users.email}) = ${normalizedEmail}`);
          if (existingUser) {
            return existingUser;
          }
        }

        // If this is the last attempt or an unrecoverable error, throw
        if (attempt === maxRetries) {
          throw new Error(`Failed to create user: ${errorMessage}`, { cause: error });
        }
      }
    }

    throw new Error('Failed to create user after maximum retries');
  }

  // Send magic link to user's email with referral support
  async sendMagicLink(email: string, callbackUrl: string = '/app', referralCode?: string) {
    try {
      // Normalize email for consistent storage and lookup
      const normalizedEmail = email.toLowerCase().trim();

      // Generate magic link token and 6-digit verification code
      const token = this.generateToken();
      const hashedToken = this.hashToken(token);
      const verificationCode = this.generateVerificationCode();
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour for better UX

      // Save magic link to database (store hashed token for security)
      await db.insert(magicLinks).values({
        email: normalizedEmail,
        token: hashedToken, // This should be the hashed version
        verificationCode, // Store plaintext code (will be used once)
        expiresAt,
      });

      // CANONICAL DOMAIN STRATEGY: Always use cutmv.fulldigitalll.com for magic links
      let baseUrl;
      const canonicalDomain = 'cutmv.fulldigitalll.com';
      const replitDomains = process.env.REPLIT_DOMAINS;
      const isProduction = process.env.NODE_ENV === 'production' || process.env.REPLIT_DEPLOYMENT === '1';
      
      // Always use canonical domain for production magic links
      console.log('🔗 Canonical domain configuration:', {
        canonicalDomain,
        replitDomains,
        nodeEnv: process.env.NODE_ENV,
        replitDeployment: process.env.REPLIT_DEPLOYMENT,
        isProduction
      });
      
      // CANONICAL DOMAIN: Always use cutmv.fulldigitalll.com for magic links
      if (isProduction) {
        baseUrl = `https://${canonicalDomain}`;
        console.log('✅ Using canonical production domain:', baseUrl);
      } else {
        // Development: use replit domains or localhost
        if (replitDomains) {
          baseUrl = `https://${replitDomains.split(',')[0]}`;
          console.log('✅ Using Replit development domain:', baseUrl);
        } else {
          // Local development - use localhost with PORT from env
          const port = process.env.PORT || '3000';
          baseUrl = `http://localhost:${port}`;
          console.log('✅ Using local development domain:', baseUrl);
        }
      }
      
      // SECURITY: Use encrypted auth token to avoid exposing email in URL
      const authToken = urlSecurity.generateSessionToken({
        email: normalizedEmail,
        sessionId: token,
        videoName: callbackUrl
      });
      const magicLinkUrl = `${baseUrl}/api/auth/verify?auth=${authToken}`;

      console.log('✅ Magic link generated and stored in database');
      console.log('🔗 Magic link URL:', magicLinkUrl.replace(/token=([^&]+)/, 'token=***'));
      console.log('🔑 Token details:', {
        rawTokenPreview: token.substring(0, 16) + '...',
        hashedTokenPreview: hashedToken.substring(0, 16) + '...',
        storedInDB: 'hashed version',
        sentInURL: 'raw version'
      });
      console.log('🔍 Auth flow:', {
        email: normalizedEmail,
        domain: baseUrl,
        process: 'Magic link → Authentication → Dashboard'
      });

      // Check if email service is configured
      if (!resend) {
        console.warn('⚠️ Email service not configured - magic link NOT sent. Code:', verificationCode);
        return { success: false, error: 'Email service not configured' };
      }

      // Send email using Resend
      const emailResult = await resend.emails.send({
        from: 'CUTMV Login <noreply@delivery.fulldigitalll.com>',
        to: email,
        subject: 'Your CUTMV Login Link',
        html: `
          <!DOCTYPE html>
          <html>
            <head>
              <meta charset="utf-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title>Login to CUTMV</title>
            </head>
            <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; background: #f5f5f5;">
              <div style="max-width: 600px; margin: 0 auto; background: #ffffff;">
                <!-- Header Banner with Logo -->
                <div style="background: #2d2d2d; color: white; padding: 30px 20px; text-align: center;">
                  <!-- Logo and Brand centered using table layout for email compatibility -->
                  <table style="margin: 0 auto 12px auto; border: 0; border-spacing: 0;">
                    <tr>
                      <td style="vertical-align: middle; padding-right: 12px;">
                        <!-- Inline SVG for Full Digital logo - guaranteed compatibility -->
                        <svg width="32" height="32" viewBox="0 0 32 32" style="display: block;">
                          <rect width="32" height="32" rx="6" fill="#8cc63f"/>
                          <text x="16" y="22" font-family="Arial, sans-serif" font-size="16" font-weight="bold" text-anchor="middle" fill="white">FD</text>
                        </svg>
                      </td>
                      <td style="vertical-align: middle;">
                        <h1 style="margin: 0; color: #8cc63f; font-size: 32px; font-weight: 700; line-height: 1; display: inline;">CUTMV</h1>
                      </td>
                    </tr>
                  </table>
                  <p style="margin: 0; color: #cccccc; font-size: 14px;">AI-Powered Video Creation</p>
                </div>

                <!-- Content -->
                <div style="padding: 40px 30px;">
                  <h2 style="margin: 0 0 20px 0; color: #333; font-size: 24px; font-weight: 600;">Login to Your Account</h2>

                  <p style="margin: 0 0 30px 0; color: #555; font-size: 16px; line-height: 1.6;">
                    Click the button below to securely log into your CUTMV account, or use the 6-digit code. This link will expire in 1 hour.
                  </p>

                  <div style="text-align: center; margin: 40px 0;">
                    <a href="${magicLinkUrl}"
                       style="background: #8cc63f; color: white; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; display: inline-block; font-size: 18px; box-shadow: 0 4px 6px rgba(140, 198, 63, 0.3);">
                      Login to CUTMV →
                    </a>
                  </div>

                  <div style="text-align: center; margin: 30px 0;">
                    <p style="color: #666; font-size: 14px; margin: 0 0 10px 0;">Or enter this code:</p>
                    <div style="background: #f8f8f8; border: 2px solid #8cc63f; border-radius: 8px; padding: 16px; display: inline-block;">
                      <span style="font-size: 32px; font-weight: 700; letter-spacing: 8px; color: #333; font-family: monospace;">${verificationCode}</span>
                    </div>
                    <p style="color: #999; font-size: 12px; margin: 10px 0 0 0;">Enter this code on the login page</p>
                  </div>

                  <p style="color: #999; font-size: 14px; margin: 30px 0 0 0; text-align: center;">
                    If you didn't request this login link, you can safely ignore this email.
                  </p>
                </div>
                
                <!-- Footer -->
                <div style="background: #f8f8f8; padding: 20px; text-align: center; border-top: 1px solid #eee;">
                  <p style="margin: 0; color: #999; font-size: 12px;">
                    © 2026 Full Digital LLC. All rights reserved.
                  </p>
                </div>
              </div>
            </body>
          </html>
        `,
        text: `
Login to CUTMV

Click this link to log into your account: ${magicLinkUrl}

Or enter this 6-digit code on the login page: ${verificationCode}

This link and code will expire in 1 hour. If you didn't request this login link, you can safely ignore this email.

© 2026 Full Digital LLC. All rights reserved.
        `,
      });

      console.log('✅ Magic link sent successfully:', emailResult.data?.id);
      return { success: true, messageId: emailResult.data?.id };
    } catch (error) {
      console.error('❌ Error sending magic link:', error);
      throw new Error('Failed to send login email', { cause: error });
    }
  }

  // Verify magic link and create session
  async verifyMagicLink(token: string, email: string) {
    try {
      // Normalize email for consistent lookup
      const normalizedEmail = email.toLowerCase().trim();
      const hashedToken = this.hashToken(token);

      console.log('🔍 Verifying magic link:', {
        email: normalizedEmail,
        rawToken: token.substring(0, 16) + '...',
        tokenHash: hashedToken.substring(0, 16) + '...',
        currentTime: new Date().toISOString()
      });

      // First, try to find an unused magic link
      let [magicLink] = await db
        .select()
        .from(magicLinks)
        .where(
          and(
            eq(magicLinks.token, hashedToken),
            sql`lower(${magicLinks.email}) = ${normalizedEmail}`,
            eq(magicLinks.used, false),
            gt(magicLinks.expiresAt, new Date())
          )
        );

      let isGracePeriodReuse = false;

      // If not found, check for recently used magic link (grace period for email scanner protection)
      // Email security scanners often "click" links before users, so we allow reuse within 60 seconds
      if (!magicLink) {
        const gracePeriodSeconds = 60;
        const gracePeriodStart = new Date(Date.now() - gracePeriodSeconds * 1000);

        const [recentlyUsedLink] = await db
          .select()
          .from(magicLinks)
          .where(
            and(
              eq(magicLinks.token, hashedToken),
              sql`lower(${magicLinks.email}) = ${normalizedEmail}`,
              eq(magicLinks.used, true),
              gt(magicLinks.expiresAt, new Date()),
              gt(magicLinks.usedAt, gracePeriodStart) // Used within grace period
            )
          );

        if (recentlyUsedLink) {
          console.log('🔄 Magic link was recently used, allowing grace period reuse:', {
            usedAt: recentlyUsedLink.usedAt,
            gracePeriodSeconds
          });
          magicLink = recentlyUsedLink;
          isGracePeriodReuse = true;
        }
      }

      console.log('🔍 Magic link lookup result:', {
        found: !!magicLink,
        email: normalizedEmail,
        expired: magicLink ? magicLink.expiresAt < new Date() : 'N/A',
        used: magicLink?.used,
        isGracePeriodReuse
      });

      if (!magicLink) {
        // Check if there are any magic links for this email to help debug (case-insensitive)
        const allLinksForEmail = await db
          .select()
          .from(magicLinks)
          .where(sql`lower(${magicLinks.email}) = ${normalizedEmail}`)
          .orderBy(magicLinks.createdAt);

        console.log('🔍 All magic links for email:', {
          email: normalizedEmail,
          count: allLinksForEmail.length,
          recent: allLinksForEmail.slice(-3).map(link => ({
            tokenPreview: link.token.substring(0, 16) + '...',
            used: link.used,
            usedAt: link.usedAt,
            expired: link.expiresAt < new Date(),
            expiresAt: link.expiresAt,
            created: link.createdAt
          })),
          searchingForHash: hashedToken.substring(0, 16) + '...'
        });

        throw new Error('Invalid or expired magic link');
      }

      // Mark magic link as used (with timestamp for grace period tracking)
      if (!isGracePeriodReuse) {
        await db
          .update(magicLinks)
          .set({ used: true, usedAt: new Date() })
          .where(eq(magicLinks.id, magicLink.id));
      }

      // Get or create user (no referral code in magic link verification)
      const user = await this.getOrCreateUser(normalizedEmail);

      // Update last login
      await db
        .update(users)
        .set({ lastLoginAt: new Date() })
        .where(eq(users.id, user.id));

      // Create session with 90-day timeout for persistent login
      const sessionToken = this.generateToken();
      const sessionExpiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000); // 90 days

      const [session] = await db
        .insert(sessions)
        .values({
          userId: user.id,
          token: sessionToken,
          expiresAt: sessionExpiresAt,
        })
        .returning();

      return { user, session };
    } catch (error) {
      console.error('❌ Error verifying magic link:', error);
      throw error;
    }
  }

  // Verify 6-digit code and create session
  async verifyCode(email: string, code: string) {
    try {
      // Normalize email for consistent lookup
      const normalizedEmail = email.toLowerCase().trim();

      console.log('🔍 Verifying 6-digit code:', {
        email: normalizedEmail,
        code: code.substring(0, 3) + '...',
        currentTime: new Date().toISOString()
      });

      // Find valid magic link with matching code (case-insensitive email for backwards compatibility)
      const [magicLink] = await db
        .select()
        .from(magicLinks)
        .where(
          and(
            sql`lower(${magicLinks.email}) = ${normalizedEmail}`,
            eq(magicLinks.verificationCode, code),
            eq(magicLinks.used, false),
            gt(magicLinks.expiresAt, new Date())
          )
        );

      console.log('🔍 Code verification result:', {
        found: !!magicLink,
        email: normalizedEmail,
        expired: magicLink ? magicLink.expiresAt < new Date() : 'N/A',
        used: magicLink?.used
      });

      if (!magicLink) {
        throw new Error('Invalid or expired verification code');
      }

      // Mark magic link as used (with timestamp)
      await db
        .update(magicLinks)
        .set({ used: true, usedAt: new Date() })
        .where(eq(magicLinks.id, magicLink.id));

      // Get or create user
      const user = await this.getOrCreateUser(normalizedEmail);

      // Update last login
      await db
        .update(users)
        .set({ lastLoginAt: new Date() })
        .where(eq(users.id, user.id));

      // Create session with 90-day timeout for persistent login
      const sessionToken = this.generateToken();
      const sessionExpiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000); // 90 days

      const [session] = await db
        .insert(sessions)
        .values({
          userId: user.id,
          token: sessionToken,
          expiresAt: sessionExpiresAt,
        })
        .returning();

      console.log('✅ 6-digit code verified successfully for:', normalizedEmail);
      return { user, session };
    } catch (error) {
      console.error('❌ Error verifying code:', error);
      throw error;
    }
  }

  // Create session for user
  async createSession(userId: string) {
    try {
      const sessionToken = this.generateToken();
      const sessionExpiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000); // 90 days for persistent login

      const [session] = await db
        .insert(sessions)
        .values({
          userId,
          token: sessionToken,
          expiresAt: sessionExpiresAt,
        })
        .returning();

      console.log('✅ Session created for user:', userId);
      return sessionToken;
    } catch (error) {
      console.error('❌ Error creating session:', error);
      throw new Error('Failed to create session', { cause: error });
    }
  }

  // Verify session token with improved error handling
  async verifySession(token: string) {
    try {
      console.log('🔍 Verifying session token:', {
        tokenPreview: token.substring(0, 8) + '...',
        tokenLength: token.length,
        currentTime: new Date().toISOString()
      });
      
      const [session] = await db
        .select({
          session: sessions,
          user: users,
        })
        .from(sessions)
        .innerJoin(users, eq(sessions.userId, users.id))
        .where(
          and(
            eq(sessions.token, token),
            gt(sessions.expiresAt, new Date())
          )
        );

      if (session) {
        console.log('✅ Session verified for user:', session.user.email);
        return { user: session.user, session: session.session };
      } else {
        console.log('❌ No valid session found for token');
        return null;
      }
    } catch (error) {
      console.error('❌ Error verifying session:', error);
      
      // Check if it's a connection termination error
      if (error && typeof error === 'object' && 'message' in error) {
        const errorMessage = String(error.message);
        if (errorMessage.includes('terminating connection due to administrator command')) {
          console.error('🚨 Database connection was terminated by administrator - this may indicate connection pool issues');
        } else if (errorMessage.includes('connection') && errorMessage.includes('closed')) {
          console.error('🚨 Database connection was closed unexpectedly');
        }
      }
      
      return null;
    }
  }

  // Logout user (invalidate session)
  async logout(token: string) {
    try {
      await db.delete(sessions).where(eq(sessions.token, token));
      return { success: true };
    } catch (error) {
      console.error('❌ Error logging out:', error);
      throw new Error('Failed to logout', { cause: error });
    }
  }

  // Update user profile
  async updateUserProfile(userId: string, updates: { name?: string; marketingConsent?: boolean }) {
    try {
      const [updatedUser] = await db.update(users)
        .set({
          name: updates.name,
          marketingConsent: updates.marketingConsent,
        })
        .where(eq(users.id, userId))
        .returning();

      return updatedUser;
    } catch (error) {
      console.error('❌ Error updating user profile:', error);
      throw new Error('Failed to update profile', { cause: error });
    }
  }

  // Update user with arbitrary fields
  async updateUser(userId: string, updates: Partial<{
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
    credits: number;
    subscriptionCredits: number;
    subscriptionCreditResetDate: Date;
  }>) {
    try {
      const [updatedUser] = await db.update(users)
        .set(updates)
        .where(eq(users.id, userId))
        .returning();

      return updatedUser;
    } catch (error) {
      console.error('❌ Error updating user:', error);
      throw new Error('Failed to update user', { cause: error });
    }
  }

  // Complete user onboarding
  async completeOnboarding(userId: string, name: string, marketingConsent: boolean) {
    try {
      const [updatedUser] = await db
        .update(users)
        .set({
          name,
          marketingConsent,
          onboardingCompleted: true,
        })
        .where(eq(users.id, userId))
        .returning();

      console.log('✅ Onboarding completed for user:', userId);
      return updatedUser;
    } catch (error) {
      console.error('❌ Error completing onboarding:', error);
      throw new Error('Failed to complete onboarding', { cause: error });
    }
  }

  // Clean up expired sessions
  async cleanupExpiredSessions() {
    try {
      const result = await db
        .delete(sessions)
        .where(lt(sessions.expiresAt, new Date()));
      
      console.log('🧹 Cleaned up expired sessions');
      return result;
    } catch (error) {
      console.error('❌ Error cleaning up expired sessions:', error);
      throw new Error('Failed to cleanup expired sessions', { cause: error });
    }
  }

  // Force logout all sessions for a user (useful for security)
  async logoutAllSessions(userId: string) {
    try {
      await db.delete(sessions).where(eq(sessions.userId, userId));
      console.log('✅ All sessions logged out for user:', userId);
      return { success: true };
    } catch (error) {
      console.error('❌ Error logging out all sessions:', error);
      throw new Error('Failed to logout all sessions', { cause: error });
    }
  }



  // Extend session (refresh on activity)
  async extendSession(token: string) {
    try {
      const newExpiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000); // 90 days from now
      
      const [session] = await db
        .update(sessions)
        .set({ expiresAt: newExpiresAt })
        .where(
          and(
            eq(sessions.token, token),
            gt(sessions.expiresAt, new Date()) // Only extend if not already expired
          )
        )
        .returning();

      return session ? { success: true, expiresAt: newExpiresAt } : null;
    } catch (error) {
      console.error('❌ Error extending session:', error);
      return null;
    }
  }

  // Get user's export history
  async getUserExports(userId: string) {
    try {
      const userExports = await db
        .select()
        .from(exports)
        .where(eq(exports.userId, userId))
        .orderBy(exports.createdAt);

      return userExports;
    } catch (error) {
      console.error('❌ Error getting user exports:', error);
      throw new Error('Failed to get export history', { cause: error });
    }
  }

  // Create export record for user
  async createExport(userId: string, exportData: {
    videoId?: number;
    filename: string;
    format: string;
    downloadUrl?: string;
    r2Key?: string;
    watermarkRemoved?: boolean;
  }) {
    try {
      const expiresAt = new Date(Date.now() + 29 * 24 * 60 * 60 * 1000); // 29 days

      const [exportRecord] = await db
        .insert(exports)
        .values({
          userId,
          ...exportData,
          expiresAt,
        })
        .returning();

      return exportRecord;
    } catch (error) {
      console.error('❌ Error creating export:', error);
      throw new Error('Failed to create export record', { cause: error });
    }
  }

  // Legacy pin export method removed - all exports now use universal 29-day retention

  // Clean up expired exports and sessions
  async cleanupExpired() {
    try {
      const now = new Date();
      
      // Delete expired sessions
      await db.delete(sessions).where(lt(sessions.expiresAt, now));
      
      // Delete expired magic links
      await db.delete(magicLinks).where(lt(magicLinks.expiresAt, now));
      
      // Mark expired exports (don't delete, just update status)
      await db
        .update(exports)
        .set({ status: 'expired' })
        .where(
          and(
            lt(exports.expiresAt, now),
            eq(exports.status, 'completed')
          )
        );

      console.log('🧹 Cleanup completed: expired sessions, magic links, and exports');
    } catch (error) {
      console.error('❌ Error during cleanup:', error);
    }
  }
}

export const authService = new AuthService();