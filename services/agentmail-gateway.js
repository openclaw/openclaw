/**
 * AgentMail Gateway Service
 *
 * Provides secure, restricted access to AgentMail API.
 * The LLM/agent never sees the API key or interacts directly with AgentMail.
 * All requests are validated and rate-limited.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const SECRETS_PATH = path.join(__dirname, '..', 'secrets', 'agentmail.env');
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'agent_email.json');
const LOG_PATH = path.join(__dirname, '..', 'logs', 'email_activity.log');

// Rate limiting state
const rateLimitState = {
  emailsThisHour: 0,
  emailsThisDay: 0,
  lastHourReset: Date.now(),
  lastDayReset: Date.now(),
};

/**
 * Load and validate secrets file
 */
function loadSecrets() {
  if (!fs.existsSync(SECRETS_PATH)) {
    throw new Error(`Secrets file not found: ${SECRETS_PATH}`);
  }

  const contents = fs.readFileSync(SECRETS_PATH, 'utf8');
  const secrets = {};

  contents.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, value] = trimmed.split('=');
      if (key && value) {
        secrets[key.trim()] = value.trim();
      }
    }
  });

  // Validate required keys
  const required = ['AGENTMAIL_API_KEY', 'AGENTMAIL_BASE_URL', 'AGENTMAIL_EMAIL', 'OWNER_EMAIL'];
  const missing = required.filter((key) => !secrets[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required secrets: ${missing.join(', ')}`);
  }

  return secrets;
}

/**
 * Load and validate configuration
 */
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Configuration file not found: ${CONFIG_PATH}`);
  }

  const contents = fs.readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(contents);
}

/**
 * Log email activity
 */
function logActivity(action, details) {
  const timestamp = new Date().toISOString();
  const entry = {
    timestamp,
    action,
    ...details,
  };

  const logLine = JSON.stringify(entry);
  fs.appendFileSync(LOG_PATH, logLine + '\n');
  console.log(`[${timestamp}] ${action}: ${JSON.stringify(details)}`);
}

/**
 * Check rate limits
 */
function checkRateLimit(config) {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  const oneDay = 24 * 60 * 60 * 1000;

  // Reset hourly counter if needed
  if (now - rateLimitState.lastHourReset > oneHour) {
    rateLimitState.emailsThisHour = 0;
    rateLimitState.lastHourReset = now;
  }

  // Reset daily counter if needed
  if (now - rateLimitState.lastDayReset > oneDay) {
    rateLimitState.emailsThisDay = 0;
    rateLimitState.lastDayReset = now;
  }

  const hourlyLimit = config.security.rate_limits.emails_per_hour;
  const dailyLimit = config.security.rate_limits.emails_per_day;

  if (rateLimitState.emailsThisHour >= hourlyLimit) {
    throw new Error(`Hourly rate limit exceeded (${hourlyLimit} emails/hour)`);
  }

  if (rateLimitState.emailsThisDay >= dailyLimit) {
    throw new Error(`Daily rate limit exceeded (${dailyLimit} emails/day)`);
  }
}

/**
 * Validate recipient against allowlist
 */
function validateRecipient(recipient, config) {
  const allowlist = config.security.recipient_allowlist || [];

  if (!allowlist.includes(recipient)) {
    logActivity('send_email_blocked', {
      reason: 'recipient_not_allowlisted',
      recipient,
      allowlist,
    });
    throw new Error(`Recipient not in allowlist: ${recipient}`);
  }
}

/**
 * Send email (mock implementation for now)
 *
 * In production, this would call the AgentMail API:
 * POST /api/v1/send
 */
async function sendEmail(to, subject, body) {
  const secrets = loadSecrets();
  const config = loadConfig();

  try {
    // Check rate limits
    checkRateLimit(config);

    // Validate recipient
    validateRecipient(to, config);

    // Create message hash for logging (no body logging)
    const messageHash = crypto.createHash('sha256').update(body).digest('hex');

    logActivity('send_email_attempt', {
      recipient: to,
      subject,
      message_hash: messageHash,
    });

    // TODO: Implement actual API call to AgentMail
    // const response = await fetch(`${secrets.AGENTMAIL_BASE_URL}/api/v1/send`, {
    //   method: 'POST',
    //   headers: {
    //     'Authorization': `Bearer ${secrets.AGENTMAIL_API_KEY}`,
    //     'Content-Type': 'application/json',
    //   },
    //   body: JSON.stringify({
    //     from: secrets.AGENTMAIL_EMAIL,
    //     to,
    //     subject,
    //     body,
    //   }),
    // });

    // For now, return success
    rateLimitState.emailsThisHour++;
    rateLimitState.emailsThisDay++;

    logActivity('send_email_success', {
      recipient: to,
      subject,
      message_hash: messageHash,
    });

    return {
      status: 'success',
      message: `Email sent to ${to}`,
    };
  } catch (error) {
    logActivity('send_email_error', {
      recipient: to,
      subject,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Read agent inbox (mock implementation)
 */
async function readAgentInbox() {
  const secrets = loadSecrets();
  const config = loadConfig();

  try {
    logActivity('read_inbox_attempt', {
      email: secrets.AGENTMAIL_EMAIL,
    });

    // TODO: Implement actual API call to AgentMail
    // const response = await fetch(`${secrets.AGENTMAIL_BASE_URL}/api/v1/inbox`, {
    //   headers: {
    //     'Authorization': `Bearer ${secrets.AGENTMAIL_API_KEY}`,
    //   },
    // });

    // For now, return empty inbox
    logActivity('read_inbox_success', {
      email: secrets.AGENTMAIL_EMAIL,
      message_count: 0,
    });

    return {
      status: 'success',
      inbox: [],
      message: 'No messages in inbox',
    };
  } catch (error) {
    logActivity('read_inbox_error', {
      email: secrets.AGENTMAIL_EMAIL,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Extract verification links from inbox
 */
async function getVerificationLinks() {
  const secrets = loadSecrets();

  try {
    logActivity('get_verification_links_attempt', {
      email: secrets.AGENTMAIL_EMAIL,
    });

    const inbox = await readAgentInbox();

    // TODO: Parse inbox messages for verification links
    const links = [];

    logActivity('get_verification_links_success', {
      email: secrets.AGENTMAIL_EMAIL,
      link_count: links.length,
    });

    return {
      status: 'success',
      links,
      message: 'No verification links found',
    };
  } catch (error) {
    logActivity('get_verification_links_error', {
      email: secrets.AGENTMAIL_EMAIL,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Health check
 */
function healthCheck() {
  try {
    loadSecrets();
    loadConfig();
    return {
      status: 'healthy',
      secrets: 'loaded',
      config: 'loaded',
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString(),
    };
  }
}

// Export public API
export { sendEmail, readAgentInbox, getVerificationLinks, healthCheck, logActivity };
