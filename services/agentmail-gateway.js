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

// Cache for inbox ID (to avoid repeated API calls)
let cachedInboxId = null;
let cacheTimestamp = null;
const CACHE_DURATION = 60 * 60 * 1000; // 1 hour

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
 * Get inbox ID for the agent email address
 * Fetches from API and caches the result
 */
async function getInboxId() {
  const secrets = loadSecrets();

  // Return cached inbox ID if still valid
  if (cachedInboxId && cacheTimestamp && Date.now() - cacheTimestamp < CACHE_DURATION) {
    return cachedInboxId;
  }

  try {
    const response = await fetch(`${secrets.AGENTMAIL_BASE_URL}/v0/inboxes`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${secrets.AGENTMAIL_API_KEY}`,
      },
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`Failed to fetch inboxes (${response.status}): ${errorData}`);
    }

    const result = await response.json();
    const inboxes = result.inboxes || [];

    // Find inbox matching our email address
    const targetEmail = secrets.AGENTMAIL_EMAIL.toLowerCase();
    const matchedInbox = inboxes.find((inbox) => {
      // Check both inbox_id and display_name
      const inboxId = (inbox.inbox_id || '').toLowerCase();
      const displayName = (inbox.display_name || '').toLowerCase();
      return inboxId === targetEmail || displayName === targetEmail;
    });

    if (!matchedInbox) {
      throw new Error(`No inbox found for ${secrets.AGENTMAIL_EMAIL}. Available inboxes: ${inboxes.map((i) => `${i.display_name} (${i.inbox_id})`).join(', ')}`);
    }

    cachedInboxId = matchedInbox.inbox_id;
    cacheTimestamp = Date.now();

    return cachedInboxId;
  } catch (error) {
    throw new Error(`Failed to get inbox ID: ${error.message}`);
  }
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
 * Send email via AgentMail API
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

    // Get inbox ID
    const inboxId = await getInboxId();

    // Call AgentMail API with correct endpoint
    const response = await fetch(
      `${secrets.AGENTMAIL_BASE_URL}/v0/inboxes/${inboxId}/messages/send`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${secrets.AGENTMAIL_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          to,
          subject,
          text: body,
        }),
      },
    );

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`AgentMail API error (${response.status}): ${errorData}`);
    }

    const result = await response.json();

    rateLimitState.emailsThisHour++;
    rateLimitState.emailsThisDay++;

    logActivity('send_email_success', {
      recipient: to,
      subject,
      message_hash: messageHash,
      message_id: result.message_id,
    });

    return {
      status: 'success',
      message: `Email sent to ${to}`,
      message_id: result.message_id,
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
 * Read agent inbox from AgentMail API
 */
async function readAgentInbox() {
  const secrets = loadSecrets();
  const config = loadConfig();

  try {
    logActivity('read_inbox_attempt', {
      email: secrets.AGENTMAIL_EMAIL,
    });

    // Get inbox ID
    const inboxId = await getInboxId();

    // Fetch messages from inbox
    const response = await fetch(
      `${secrets.AGENTMAIL_BASE_URL}/v0/inboxes/${inboxId}/messages`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${secrets.AGENTMAIL_API_KEY}`,
        },
      },
    );

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`AgentMail API error (${response.status}): ${errorData}`);
    }

    const result = await response.json();
    const messages = result.messages || result.data || [];

    logActivity('read_inbox_success', {
      email: secrets.AGENTMAIL_EMAIL,
      message_count: messages.length,
    });

    return {
      status: 'success',
      inbox: messages,
      message: messages.length > 0 ? `Found ${messages.length} messages` : 'No messages in inbox',
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
 * Extract verification links from inbox messages
 */
async function getVerificationLinks() {
  const secrets = loadSecrets();

  try {
    logActivity('get_verification_links_attempt', {
      email: secrets.AGENTMAIL_EMAIL,
    });

    const inbox = await readAgentInbox();

    // Parse messages for verification links (URLs)
    const links = [];
    const urlRegex = /https?:\/\/[^\s\)]+/g;

    if (inbox.inbox && Array.isArray(inbox.inbox)) {
      for (const message of inbox.inbox) {
        const body = message.body || message.content || '';
        const matches = body.match(urlRegex) || [];

        for (const url of matches) {
          // Filter for common verification link patterns
          if (url.includes('verify') || url.includes('confirm') || url.includes('token') || url.includes('code')) {
            links.push({
              url,
              from_message_id: message.id,
              from_sender: message.from,
            });
          }
        }
      }
    }

    logActivity('get_verification_links_success', {
      email: secrets.AGENTMAIL_EMAIL,
      link_count: links.length,
    });

    return {
      status: 'success',
      links,
      message: links.length > 0 ? `Found ${links.length} verification links` : 'No verification links found',
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
export { sendEmail, readAgentInbox, getVerificationLinks, healthCheck, logActivity, getInboxId };
