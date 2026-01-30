/**
 * Secure credential storage with proper file permissions.
 *
 * Security principles applied:
 * - File permissions: 0o600 (owner read/write only)
 * - Atomic writes: temp file + rename to prevent corruption
 * - No secrets in memory longer than needed
 */

import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync, readFileSync, statSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';

// Secure file permission: owner read/write only
const SECURE_FILE_MODE = 0o600;
const SECURE_DIR_MODE = 0o700;

export interface CredentialStore {
  openaiApiKey?: string;
  gmailCredentials?: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  };
  gmailTokens?: {
    accessToken: string;
    refreshToken: string;
    expiryDate: number;
  };
}

/**
 * Get the credentials directory path
 */
export function getCredentialsDir(): string {
  return join(homedir(), '.moltbot-mini', 'credentials');
}

/**
 * Get the credentials file path
 */
export function getCredentialsPath(): string {
  return join(getCredentialsDir(), 'credentials.json');
}

/**
 * Ensure directory exists with secure permissions
 */
function ensureSecureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true, mode: SECURE_DIR_MODE });
  } else {
    // Verify and fix permissions if needed
    const stats = statSync(dirPath);
    const currentMode = stats.mode & 0o777;
    if (currentMode !== SECURE_DIR_MODE) {
      chmodSync(dirPath, SECURE_DIR_MODE);
    }
  }
}

/**
 * Atomic write with secure permissions
 * Uses temp file + rename to prevent corruption
 */
function atomicWriteSecure(filePath: string, data: string): void {
  const dir = dirname(filePath);
  ensureSecureDir(dir);

  // Create temp file with random suffix
  const tempPath = `${filePath}.${randomBytes(8).toString('hex')}.tmp`;

  try {
    // Write to temp file with secure permissions
    writeFileSync(tempPath, data, { mode: SECURE_FILE_MODE, encoding: 'utf-8' });

    // Atomic rename
    renameSync(tempPath, filePath);
  } catch (error) {
    // Clean up temp file on error
    try {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Load credentials from secure storage
 */
export function loadCredentials(): CredentialStore {
  const credPath = getCredentialsPath();

  if (!existsSync(credPath)) {
    return {};
  }

  // Verify file permissions before reading
  const stats = statSync(credPath);
  const currentMode = stats.mode & 0o777;

  if (currentMode !== SECURE_FILE_MODE) {
    console.warn(`Warning: Fixing insecure permissions on ${credPath}`);
    chmodSync(credPath, SECURE_FILE_MODE);
  }

  const data = readFileSync(credPath, 'utf-8');
  return JSON.parse(data) as CredentialStore;
}

/**
 * Save credentials to secure storage
 */
export function saveCredentials(credentials: CredentialStore): void {
  const data = JSON.stringify(credentials, null, 2);
  atomicWriteSecure(getCredentialsPath(), data);
}

/**
 * Update specific credential fields
 */
export function updateCredentials(updates: Partial<CredentialStore>): void {
  const current = loadCredentials();
  const updated = { ...current, ...updates };
  saveCredentials(updated);
}

/**
 * Check if OpenAI API key is configured
 */
export function hasOpenAIKey(): boolean {
  const creds = loadCredentials();
  return Boolean(creds.openaiApiKey);
}

/**
 * Check if Gmail is configured
 */
export function hasGmailCredentials(): boolean {
  const creds = loadCredentials();
  return Boolean(creds.gmailCredentials?.clientId && creds.gmailCredentials?.clientSecret);
}

/**
 * Check if Gmail is authenticated (has tokens)
 */
export function hasGmailTokens(): boolean {
  const creds = loadCredentials();
  return Boolean(creds.gmailTokens?.accessToken && creds.gmailTokens?.refreshToken);
}

/**
 * Audit credential file security
 */
export function auditCredentialSecurity(): { secure: boolean; issues: string[] } {
  const issues: string[] = [];
  const credPath = getCredentialsPath();
  const credDir = getCredentialsDir();

  // Check if credentials exist
  if (!existsSync(credPath)) {
    return { secure: true, issues: [] };
  }

  // Check directory permissions
  if (existsSync(credDir)) {
    const dirStats = statSync(credDir);
    const dirMode = dirStats.mode & 0o777;

    if (dirMode & 0o077) {
      issues.push(`Credentials directory is accessible by others (mode: ${dirMode.toString(8)})`);
    }
  }

  // Check file permissions
  const fileStats = statSync(credPath);
  const fileMode = fileStats.mode & 0o777;

  if (fileMode & 0o077) {
    issues.push(`Credentials file is accessible by others (mode: ${fileMode.toString(8)})`);
  }

  // Check for symlinks (potential attack vector)
  if (fileStats.isSymbolicLink()) {
    issues.push('Credentials file is a symlink (potential security risk)');
  }

  return {
    secure: issues.length === 0,
    issues
  };
}
