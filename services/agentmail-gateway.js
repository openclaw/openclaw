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
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const SECRETS_PATH = path.join(__dirname, '..', 'secrets', 'agentmail.env');
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'agent_email.json');
const LOG_PATH = path.join(__dirname, '..', 'logs', 'email_activity.log');
const PROCESSED_MESSAGES_PATH = path.join(__dirname, '..', 'logs', 'processed_messages.json');
const COMMANDS_LOG_PATH = path.join(__dirname, '..', 'logs', 'commands.log');

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
 * Log command processing
 */
function logCommand(action, details) {
  const timestamp = new Date().toISOString();
  const entry = {
    timestamp,
    action,
    ...details,
  };

  const logLine = JSON.stringify(entry);
  fs.appendFileSync(COMMANDS_LOG_PATH, logLine + '\n');
  console.log(`[${timestamp}] COMMAND ${action}: ${JSON.stringify(details)}`);
}

/**
 * Load processed message IDs from tracking file
 */
function loadProcessedMessages() {
  try {
    if (fs.existsSync(PROCESSED_MESSAGES_PATH)) {
      const data = fs.readFileSync(PROCESSED_MESSAGES_PATH, 'utf8');
      return new Set(JSON.parse(data));
    }
  } catch (error) {
    console.error('Error loading processed messages:', error.message);
  }
  return new Set();
}

/**
 * Save processed message IDs to tracking file
 */
function saveProcessedMessages(processedSet) {
  try {
    const data = JSON.stringify([...processedSet]);
    fs.writeFileSync(PROCESSED_MESSAGES_PATH, data);
  } catch (error) {
    console.error('Error saving processed messages:', error.message);
  }
}

/**
 * Validate sender against allowlist
 */
/**
 * Extract email address from sender string
 * Handles formats like "Name <email@domain.com>" or just "email@domain.com"
 */
function extractEmail(sender) {
  if (!sender) return '';
  
  // Try to match email in angle brackets: "Name <email@domain.com>"
  const angleBracketMatch = sender.match(/<([^>]+)>/);
  if (angleBracketMatch) {
    return angleBracketMatch[1].toLowerCase().trim();
  }
  
  // Otherwise use the whole string as email
  return sender.toLowerCase().trim();
}

/**
 * Validate sender against allowlist
 */
function validateSender(sender, config) {
  const allowlist = config.security.sender_allowlist || [];
  const senderEmail = extractEmail(sender);

  if (!senderEmail) {
    logCommand('sender_rejected', {
      sender,
      allowlist,
      reason: 'sender_email_empty',
    });
    return false;
  }

  if (!allowlist.some((allowed) => senderEmail === allowed.toLowerCase())) {
    logCommand('sender_rejected', {
      sender,
      sender_email: senderEmail,
      allowlist,
      reason: 'sender_not_in_allowlist',
    });
    return false;
  }
  return true;
}

/**
 * Parse command from subject line or body
 * Expected format: TIM:COMMAND_NAME [args]
 * Also checks body for TIM: prefix
 */
function parseCommand(subject, body = '') {
  if (!subject || typeof subject !== 'string') {
    return null;
  }

  const trimmed = subject.trim();
  
  // Check subject for TIM: prefix
  if (trimmed.toUpperCase().startsWith('TIM:')) {
    const commandPart = trimmed.substring(4).trim();
    const parts = commandPart.split(/\s+/);
    const command = parts[0]?.toUpperCase();
    const args = parts.slice(1).join(' ');
    return { command, args, raw: commandPart, source: 'subject' };
  }
  
  // Check body for TIM: prefix (in case it's in the body)
  if (body && typeof body === 'string') {
    const bodyTrimmed = body.trim();
    if (bodyTrimmed.toUpperCase().startsWith('TIM:')) {
      const commandPart = bodyTrimmed.substring(4).trim();
      const parts = commandPart.split(/\s+/);
      const command = parts[0]?.toUpperCase();
      const args = parts.slice(1).join(' ');
      return { command, args, raw: commandPart, source: 'body' };
    }
  }

  return null;
}

/**
 * Execute openclaw agent command for freeform messages
 */
async function handleFreeformMessage(messageText, agentName = 'tim') {
  return new Promise((resolve, reject) => {
    logCommand('freeform_attempt', {
      agent: agentName,
      message_preview: messageText.substring(0, 100),
    });

    // Use pnpm openclaw agent --message to send to the agent
    // Note: pnpm must be used since 'openclaw' is not in system PATH
    const args = ['openclaw', 'agent', '--message', messageText, '--agent', agentName];
    
    const proc = spawn('pnpm', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      shell: true,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    // Timeout after 2 minutes
    const timeout = setTimeout(() => {
      proc.kill('SIGTERM');
      logCommand('freeform_timeout', {
        agent: agentName,
        message_preview: messageText.substring(0, 100),
      });
      resolve({ status: 'timeout', message: 'Agent command timed out after 2 minutes' });
    }, 120000);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      
      if (code === 0) {
        logCommand('freeform_success', {
          agent: agentName,
          message_preview: messageText.substring(0, 100),
        });
        resolve({ status: 'success', output: stdout });
      } else {
        logCommand('freeform_error', {
          agent: agentName,
          message_preview: messageText.substring(0, 100),
          exit_code: code,
          stderr: stderr.substring(0, 500),
        });
        resolve({ status: 'failed', error: stderr || `Exit code: ${code}` });
      }
    });

    proc.on('error', (error) => {
      clearTimeout(timeout);
      logCommand('freeform_spawn_error', {
        agent: agentName,
        error: error.message,
      });
      resolve({ status: 'error', error: error.message });
    });
  });
}

/**
 * Command handlers
 */
async function handleStatus() {
  return {
    status: 'SUCCESS',
    command: 'STATUS',
    result: {
      gateway: 'operational',
      email_listener: 'active',
      timestamp: new Date().toISOString(),
    },
  };
}

async function handleAgentStatus() {
  return {
    status: 'SUCCESS',
    command: 'AGENT STATUS',
    result: {
      agent_id: 'tim-guardian',
      agent_status: 'running',
      uptime: process.uptime?.() || 'unknown',
      last_heartbeat: new Date().toISOString(),
    },
  };
}

async function handleCheckUpdates() {
  return {
    status: 'SUCCESS',
    command: 'CHECK UPDATES',
    result: {
      current_version: '2026.3.6',
      update_available: false,
      last_checked: new Date().toISOString(),
    },
  };
}

/**
 * Execute command based on parsed command
 */
async function executeCommand(parsedCommand) {
  const { command, args } = parsedCommand;

  switch (command) {
    case 'STATUS':
      return handleStatus();
    case 'AGENT':
      if (args?.toUpperCase() === 'STATUS') {
        return handleAgentStatus();
      }
      return { status: 'FAILED', error: `Unknown subcommand: ${args}` };
    case 'CHECK':
      if (args?.toUpperCase() === 'UPDATES') {
        return handleCheckUpdates();
      }
      return { status: 'FAILED', error: `Unknown subcommand: ${args}` };
    default:
      return { status: 'FAILED', error: `Unknown command: ${command}` };
  }
}

/**
 * Generate reply email body
 */
function generateReplyBody(commandResult) {
  const lines = [
    `COMMAND RESULT`,
    `==============`,
    `Status: ${commandResult.status}`,
    `Command: ${commandResult.command}`,
    `Timestamp: ${new Date().toISOString()}`,
    ``,
    `RESULT:`,
    `-------`,
  ];

  if (commandResult.result) {
    for (const [key, value] of Object.entries(commandResult.result)) {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }

  if (commandResult.error) {
    lines.push(`Error: ${commandResult.error}`);
  }

  return lines.join('\n');
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
 * Uses extractEmail to handle "Name <email@domain.com>" format
 */
function validateRecipient(recipient, config) {
  const allowlist = config.security.recipient_allowlist || [];
  const recipientEmail = extractEmail(recipient);

  if (!recipientEmail) {
    logActivity('send_email_blocked', {
      reason: 'recipient_email_empty',
      recipient,
      allowlist,
    });
    throw new Error(`Recipient email is empty: ${recipient}`);
  }

  if (!allowlist.some((allowed) => recipientEmail === allowed.toLowerCase())) {
    logActivity('send_email_blocked', {
      reason: 'recipient_not_allowlisted',
      recipient,
      recipient_email: recipientEmail,
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

    // Process commands from inbox messages
    await processInboxCommands(messages, config);

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
 * Process commands from inbox messages
 * Only processes messages from whitelisted senders with TIM: prefix in subject
 */
async function processInboxCommands(messages, config) {
  const processedMessages = loadProcessedMessages();
  const newProcessed = new Set();

  for (const message of messages) {
    // Get message ID (try different fields)
    const messageId = message.id || message.message_id || message.uid;
    if (!messageId) {
      continue;
    }

    // Skip already processed messages
    if (processedMessages.has(messageId)) {
      continue;
    }

    // Get sender
    const sender = message.from || message.sender || message.from_address;
    if (!sender) {
      continue;
    }

    // Validate sender against allowlist
    if (!validateSender(sender, config)) {
      continue;
    }

    // Get subject and body
    const subject = message.subject || '';
    const body = message.body || message.text || message.content || '';

    // Parse command from subject and body
    const parsedCommand = parseCommand(subject, body);
    if (!parsedCommand) {
      // Not a command - check if freeform is enabled
      const enableFreeform = config.features?.freeform !== false;
      
      if (enableFreeform) {
        // Handle as freeform message - combine subject and body
        const freeformText = subject && body 
          ? `${subject}\n\n${body}` 
          : subject || body;
        
        if (freeformText) {
          logCommand('freeform_processing', {
            message_id: messageId,
            sender,
            subject,
            body_preview: body.substring(0, 100),
          });

          try {
            const result = await handleFreeformMessage(freeformText, 'tim');
            
            // Mark message as processed
            newProcessed.add(messageId);
            
            logCommand('freeform_completed', {
              message_id: messageId,
              sender,
              result_status: result.status,
            });
          } catch (error) {
            logCommand('freeform_failed', {
              message_id: messageId,
              sender,
              error: error.message,
            });
          }
          
          continue;
        }
      }
      
      // Not a command and freeform disabled - skip
      continue;
    }

    // Execute command
    logCommand('processing', {
      message_id: messageId,
      sender,
      subject,
      command: parsedCommand.command,
      args: parsedCommand.args,
    });

    let commandResult;
    try {
      commandResult = await executeCommand(parsedCommand);
    } catch (error) {
      commandResult = {
        status: 'FAILED',
        command: parsedCommand.command,
        error: error.message,
      };
    }

    // Generate reply
    const replyBody = generateReplyBody(commandResult);

    // Send reply to sender
    try {
      const secrets = loadSecrets();
      await sendEmail(sender, `RE: ${subject}`, replyBody);

      logCommand('reply_sent', {
        message_id: messageId,
        sender,
        subject,
        command: parsedCommand.command,
        result_status: commandResult.status,
      });
    } catch (error) {
      logCommand('reply_failed', {
        message_id: messageId,
        sender,
        subject,
        command: parsedCommand.command,
        error: error.message,
      });
    }

    // Mark message as processed
    newProcessed.add(messageId);
  }

  // Save newly processed messages
  if (newProcessed.size > 0) {
    for (const msgId of newProcessed) {
      processedMessages.add(msgId);
    }
    saveProcessedMessages(processedMessages);

    logActivity('commands_processed', {
      count: newProcessed.size,
      message_ids: [...newProcessed],
    });
  }
}

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
// Polling interval in milliseconds (30 seconds)
const POLL_INTERVAL_MS = 30000;

/**
 * Main polling loop - runs continuously
 */
async function startPolling() {
  console.log('🤖 AgentMail Gateway starting...');
  console.log('📧 Polling for commands every', POLL_INTERVAL_MS / 1000, 'seconds');
  
  // Initial run
  await runOnce();
  
  // Set up continuous polling
  setInterval(async () => {
    await runOnce();
  }, POLL_INTERVAL_MS);
}

/**
 * Single polling iteration
 */
async function runOnce() {
  const timestamp = new Date().toISOString();
  console.log(`\n[${timestamp}] 🔍 Checking inbox...`);
  
  try {
    // First, read the inbox to get messages
    const inboxResult = await readAgentInbox();
    
    if (!inboxResult.inbox || !Array.isArray(inboxResult.inbox)) {
      console.log('📭 No messages in inbox');
      return;
    }
    
    const messages = inboxResult.inbox;
    console.log(`📬 Found ${messages.length} message(s) in inbox`);
    
    if (messages.length === 0) {
      console.log('📭 No new commands');
      return;
    }
    
    // Then process commands from those messages
    const config = loadConfig();
    const result = await processInboxCommands(messages, config);
    
    if (result && result.commands_processed > 0) {
      console.log(`✅ Processed ${result.commands_processed} command(s)`);
    } else {
      console.log('📭 No new commands');
    }
  } catch (error) {
    console.error('❌ Error processing inbox:', error.message);
  }
}

// Start polling if run directly
startPolling().catch(console.error);

export { sendEmail, readAgentInbox, getVerificationLinks, healthCheck, logActivity, getInboxId, logCommand, parseCommand, validateSender, executeCommand, processInboxCommands, startPolling, runOnce };
