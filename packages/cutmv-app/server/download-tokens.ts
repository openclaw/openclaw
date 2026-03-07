// Secure Download Token System
// Creates obscure, time-limited download links instead of revealing file paths

import crypto from 'crypto';
import { db } from './db';
import { sql } from 'drizzle-orm';

interface DownloadToken {
  sessionId: string;
  filename: string;
  userEmail: string;
  expiresAt: number;
}

class DownloadTokenManager {
  private tokens = new Map<string, DownloadToken>();
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    // Clean up expired tokens every 10 minutes
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredTokens();
    }, 10 * 60 * 1000);
  }

  // Generate a secure download token
  async generateToken(sessionId: string, filename: string, userEmail: string, expirationHours: number = 24): Promise<string> {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + (expirationHours * 60 * 60 * 1000));
    
    // Store in database for persistence
    try {
      await db.execute(sql`
        INSERT INTO download_tokens (token, session_id, filename, user_email, expires_at)
        VALUES (${token}, ${sessionId}, ${filename}, ${userEmail}, ${expiresAt})
        ON CONFLICT (token) DO NOTHING
      `);
    } catch (error) {
      console.error('Failed to store download token in database:', error);
    }

    // Also store in memory for fast access
    this.tokens.set(token, {
      sessionId,
      filename,
      userEmail,
      expiresAt: expiresAt.getTime()
    });

    console.log(`🔒 Generated secure download token for ${userEmail}: ${token.substring(0, 8)}...`);
    return token;
  }

  // Validate and retrieve token data
  async validateToken(token: string): Promise<{ sessionId: string; filename: string; userEmail: string } | null> {
    let tokenData = this.tokens.get(token);
    
    // If not in memory, try database
    if (!tokenData) {
      try {
        const dbTokens = await db.execute(sql`
          SELECT session_id, filename, user_email, expires_at 
          FROM download_tokens 
          WHERE token = ${token} AND expires_at > NOW()
        `);
        
        if (dbTokens.rows.length > 0) {
          const dbToken = dbTokens.rows[0];
          tokenData = {
            sessionId: dbToken.session_id as string,
            filename: dbToken.filename as string,
            userEmail: dbToken.user_email as string,
            expiresAt: new Date(dbToken.expires_at as string).getTime()
          };
          
          // Cache in memory
          this.tokens.set(token, tokenData);
        }
      } catch (error) {
        console.error('Failed to retrieve token from database:', error);
      }
    }
    
    if (!tokenData) {
      console.log(`❌ Invalid token: ${token.substring(0, 8)}...`);
      return null;
    }

    if (Date.now() > tokenData.expiresAt) {
      this.tokens.delete(token);
      // Clean up from database
      try {
        await db.execute(sql`DELETE FROM download_tokens WHERE token = ${token}`);
      } catch (error) {
        console.error('Failed to delete expired token from database:', error);
      }
      console.log(`⏰ Expired token: ${token.substring(0, 8)}...`);
      return null;
    }

    return {
      sessionId: tokenData.sessionId,
      filename: tokenData.filename,
      userEmail: tokenData.userEmail
    };
  }

  // Clean up expired tokens
  private cleanupExpiredTokens() {
    const now = Date.now();
    let cleaned = 0;
    
    // Convert Map.entries() to Array to fix iteration issue
    const entries = Array.from(this.tokens.entries());
    for (const [token, data] of entries) {
      if (now > data.expiresAt) {
        this.tokens.delete(token);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      console.log(`🧹 Cleaned up ${cleaned} expired download tokens`);
    }
  }
}

export const downloadTokenManager = new DownloadTokenManager();