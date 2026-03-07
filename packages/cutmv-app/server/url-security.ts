/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - URL Security & Encryption Service
 * Proprietary software - unauthorized use prohibited
 */

import crypto from 'crypto';

const SECRET_KEY = process.env.URL_ENCRYPTION_SECRET || 'cutmv-url-security-key-2025';
const ALGORITHM = 'aes-256-cbc';

export class URLSecurityService {
  private static instance: URLSecurityService;
  
  static getInstance(): URLSecurityService {
    if (!URLSecurityService.instance) {
      URLSecurityService.instance = new URLSecurityService();
    }
    return URLSecurityService.instance;
  }

  // Encrypt sensitive data for URL usage
  encryptForURL(data: string): string {
    try {
      const iv = crypto.randomBytes(16);
      const key = crypto.scryptSync(SECRET_KEY, 'cutmv-salt', 32);
      const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
      
      let encrypted = cipher.update(data, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      
      // Combine iv and encrypted data
      const combined = Buffer.concat([iv, Buffer.from(encrypted, 'hex')]);
      
      // Return URL-safe base64
      return combined.toString('base64url');
    } catch (error) {
      console.error('URL encryption failed:', error);
      throw new Error('Failed to encrypt URL data');
    }
  }

  // Decrypt URL data
  decryptFromURL(encryptedData: string): string {
    try {
      // Handle potential URL encoding issues and add padding if needed
      let normalizedData = encryptedData.replace(/-/g, '+').replace(/_/g, '/');
      
      // Add padding if necessary for base64url
      const padding = '='.repeat((4 - normalizedData.length % 4) % 4);
      normalizedData += padding;
      
      let combined;
      try {
        combined = Buffer.from(normalizedData, 'base64');
      } catch (base64Error) {
        // Fallback to base64url if regular base64 fails
        combined = Buffer.from(encryptedData, 'base64url');
      }
      
      if (combined.length < 16) {
        throw new Error('Invalid data length - too short');
      }
      
      const iv = combined.slice(0, 16);
      const encrypted = combined.slice(16);
      
      const key = crypto.scryptSync(SECRET_KEY, 'cutmv-salt', 32);
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      
      let decrypted = decipher.update(encrypted, undefined, 'utf8');
      decrypted += decipher.final('utf8');
      
      return decrypted;
    } catch (error) {
      console.error('URL decryption failed:', error);
      throw new Error('Invalid or corrupted URL data');
    }
  }

  // Generate obfuscated session token for URLs
  generateSessionToken(data: { email: string; sessionId: string; videoName?: string }): string {
    const payload = JSON.stringify(data);
    return this.encryptForURL(payload);
  }

  // Decode session token from URL
  decodeSessionToken(token: string): { email: string; sessionId: string; videoName?: string } {
    const payload = this.decryptFromURL(token);
    return JSON.parse(payload);
  }

  // Generate secure video reuse token
  generateVideoReuseToken(videoId: number, userEmail: string): string {
    const data = JSON.stringify({ videoId, userEmail, timestamp: Date.now() });
    return this.encryptForURL(data);
  }

  // Decode video reuse token
  decodeVideoReuseToken(token: string): { videoId: number; userEmail: string; timestamp: number } {
    const payload = this.decryptFromURL(token);
    const data = JSON.parse(payload);
    
    // Check if token is older than 24 hours
    if (Date.now() - data.timestamp > 24 * 60 * 60 * 1000) {
      throw new Error('Reuse token expired');
    }
    
    return data;
  }
}

export const urlSecurity = URLSecurityService.getInstance();