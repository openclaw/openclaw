/**
 * GitHub 2FA Extension Types
 */

export type Session = {
  githubLogin: string;
  verifiedAt: string;
  expiresAt: string;
};

export type PendingVerification = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  intervalMs: number;
};

export type SessionStore = {
  version: 1;
  sessions: Record<string, Session>;
  pending: Record<string, PendingVerification>;
};

export type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
};

export type DeviceTokenResponse =
  | {
      access_token: string;
      token_type: string;
      scope?: string;
    }
  | {
      error: string;
      error_description?: string;
      error_uri?: string;
    };
