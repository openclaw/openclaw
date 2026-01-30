/**
 * Configuration management with secure file handling.
 */

import { existsSync, readFileSync, statSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { Config, ConfigSchema } from './schema.js';

const SECURE_FILE_MODE = 0o600;
const SECURE_DIR_MODE = 0o700;

/**
 * Get the config directory path
 */
export function getConfigDir(): string {
  return join(homedir(), '.moltbot-mini');
}

/**
 * Get the config file path
 */
export function getConfigPath(): string {
  return join(getConfigDir(), 'config.json');
}

/**
 * Get the sessions directory path
 */
export function getSessionsDir(): string {
  return join(getConfigDir(), 'sessions');
}

/**
 * Ensure directory exists with secure permissions
 */
function ensureSecureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true, mode: SECURE_DIR_MODE });
  }
}

/**
 * Atomic write with secure permissions
 */
function atomicWriteSecure(filePath: string, data: string): void {
  const dir = dirname(filePath);
  ensureSecureDir(dir);

  const tempPath = `${filePath}.${randomBytes(8).toString('hex')}.tmp`;

  try {
    writeFileSync(tempPath, data, { mode: SECURE_FILE_MODE, encoding: 'utf-8' });
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch { /* ignore */ }
    throw error;
  }
}

/**
 * Load configuration with validation
 */
export function loadConfig(): Config {
  const configPath = getConfigPath();

  if (!existsSync(configPath)) {
    // Return default config
    return ConfigSchema.parse({});
  }

  // Check permissions
  const stats = statSync(configPath);
  const mode = stats.mode & 0o777;
  if (mode & 0o077) {
    console.warn(`Warning: Fixing insecure config file permissions`);
    chmodSync(configPath, SECURE_FILE_MODE);
  }

  const raw = readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(raw);

  // Validate with Zod
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    console.error('Config validation errors:', result.error.format());
    throw new Error('Invalid configuration file');
  }

  return result.data;
}

/**
 * Save configuration
 */
export function saveConfig(config: Config): void {
  // Validate before saving
  const validated = ConfigSchema.parse(config);
  const data = JSON.stringify(validated, null, 2);
  atomicWriteSecure(getConfigPath(), data);
}

/**
 * Update specific config fields
 */
export function updateConfig(updates: Partial<Config>): Config {
  const current = loadConfig();
  const updated = {
    ...current,
    ...updates,
    gmail: { ...current.gmail, ...updates.gmail },
    openai: { ...current.openai, ...updates.openai },
    agent: { ...current.agent, ...updates.agent },
  };
  saveConfig(updated);
  return updated;
}

/**
 * Initialize config directory structure
 */
export function initializeConfigDir(): void {
  ensureSecureDir(getConfigDir());
  ensureSecureDir(getSessionsDir());
  ensureSecureDir(join(getConfigDir(), 'credentials'));
}

// Re-export schema types
export * from './schema.js';
