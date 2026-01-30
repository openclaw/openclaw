/**
 * Gmail OAuth2 authentication.
 *
 * Security:
 * - OAuth2 tokens stored with 0o600 permissions
 * - Automatic token refresh
 * - Scopes limited to minimum needed
 */

import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { loadCredentials, updateCredentials } from '../security/credentials.js';

// Gmail API scopes (minimal permissions needed)
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',     // Read emails
  'https://www.googleapis.com/auth/gmail.send',         // Send emails
  'https://www.googleapis.com/auth/gmail.compose',      // Create drafts
  'https://www.googleapis.com/auth/gmail.modify',       // Modify labels
];

/**
 * Create OAuth2 client from stored credentials
 */
export function createOAuth2Client(): OAuth2Client | null {
  const creds = loadCredentials();

  if (!creds.gmailCredentials) {
    return null;
  }

  const oauth2Client = new google.auth.OAuth2(
    creds.gmailCredentials.clientId,
    creds.gmailCredentials.clientSecret,
    creds.gmailCredentials.redirectUri
  );

  // Set tokens if available
  if (creds.gmailTokens) {
    oauth2Client.setCredentials({
      access_token: creds.gmailTokens.accessToken,
      refresh_token: creds.gmailTokens.refreshToken,
      expiry_date: creds.gmailTokens.expiryDate,
    });

    // Set up automatic token refresh
    oauth2Client.on('tokens', (tokens) => {
      const current = loadCredentials();
      updateCredentials({
        gmailTokens: {
          accessToken: tokens.access_token || current.gmailTokens?.accessToken || '',
          refreshToken: tokens.refresh_token || current.gmailTokens?.refreshToken || '',
          expiryDate: tokens.expiry_date || current.gmailTokens?.expiryDate || 0,
        },
      });
    });
  }

  return oauth2Client;
}

/**
 * Generate OAuth2 authorization URL
 */
export function getAuthUrl(): string | null {
  const oauth2Client = createOAuth2Client();
  if (!oauth2Client) {
    return null;
  }

  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent', // Force consent to get refresh token
  });
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCodeForTokens(code: string): Promise<boolean> {
  const oauth2Client = createOAuth2Client();
  if (!oauth2Client) {
    throw new Error('Gmail credentials not configured');
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.access_token || !tokens.refresh_token) {
      throw new Error('Failed to get tokens from Google');
    }

    // Store tokens securely
    updateCredentials({
      gmailTokens: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiryDate: tokens.expiry_date || 0,
      },
    });

    return true;
  } catch (error) {
    console.error('Failed to exchange code for tokens:', error);
    return false;
  }
}

/**
 * Check if Gmail is authenticated
 */
export function isAuthenticated(): boolean {
  const creds = loadCredentials();
  return Boolean(creds.gmailTokens?.accessToken && creds.gmailTokens?.refreshToken);
}

/**
 * Revoke Gmail access
 */
export async function revokeAccess(): Promise<void> {
  const oauth2Client = createOAuth2Client();
  if (oauth2Client) {
    const creds = loadCredentials();
    if (creds.gmailTokens?.accessToken) {
      try {
        await oauth2Client.revokeToken(creds.gmailTokens.accessToken);
      } catch {
        // Ignore revoke errors
      }
    }
  }

  // Clear tokens from storage
  updateCredentials({
    gmailTokens: undefined,
  });
}
