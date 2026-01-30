/**
 * CLI command implementations.
 */

import { createInterface } from 'node:readline';
import { loadCredentials, updateCredentials, hasOpenAIKey, hasGmailCredentials, hasGmailTokens, auditCredentialSecurity } from '../security/credentials.js';
import { loadConfig, updateConfig, initializeConfigDir } from '../config/index.js';
import { getAuthUrl, exchangeCodeForTokens, isAuthenticated, revokeAccess } from '../gmail/auth.js';
import { getEmailAddress, getUnreadCount, listEmails } from '../gmail/client.js';
import { chat, resetConversation, getConversationLength } from '../agent/index.js';

/**
 * Interactive prompt helper
 */
async function prompt(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Setup command - configure OpenAI and Gmail
 */
export async function setup(): Promise<void> {
  console.log('\n🔧 Moltbot Mini Setup\n');

  initializeConfigDir();

  // Step 1: OpenAI API Key
  console.log('Step 1: OpenAI Configuration');
  console.log('----------------------------');

  if (hasOpenAIKey()) {
    const change = await prompt('OpenAI API key is configured. Change it? (y/N): ');
    if (change.toLowerCase() !== 'y') {
      console.log('Keeping existing OpenAI key.\n');
    } else {
      const key = await prompt('Enter your OpenAI API key: ');
      if (key.startsWith('sk-')) {
        updateCredentials({ openaiApiKey: key });
        console.log('OpenAI API key saved.\n');
      } else {
        console.log('Invalid key format. Skipping.\n');
      }
    }
  } else {
    const key = await prompt('Enter your OpenAI API key: ');
    if (key.startsWith('sk-')) {
      updateCredentials({ openaiApiKey: key });
      console.log('OpenAI API key saved.\n');
    } else {
      console.log('Invalid key format. Skipping.\n');
    }
  }

  // Step 2: Gmail OAuth Credentials
  console.log('Step 2: Gmail Configuration');
  console.log('---------------------------');
  console.log('You need to create OAuth credentials in Google Cloud Console:');
  console.log('1. Go to https://console.cloud.google.com/apis/credentials');
  console.log('2. Create an OAuth 2.0 Client ID (Desktop app)');
  console.log('3. Download the credentials JSON\n');

  if (hasGmailCredentials()) {
    const change = await prompt('Gmail credentials are configured. Change them? (y/N): ');
    if (change.toLowerCase() !== 'y') {
      console.log('Keeping existing Gmail credentials.\n');
    } else {
      await configureGmailCredentials();
    }
  } else {
    await configureGmailCredentials();
  }

  // Step 3: Gmail Authentication
  if (hasGmailCredentials() && !hasGmailTokens()) {
    console.log('Step 3: Gmail Authentication');
    console.log('----------------------------');
    await authenticateGmail();
  }

  console.log('\n✅ Setup complete!\n');
  await status();
}

/**
 * Configure Gmail OAuth credentials
 */
async function configureGmailCredentials(): Promise<void> {
  const clientId = await prompt('Enter Client ID: ');
  const clientSecret = await prompt('Enter Client Secret: ');

  if (clientId && clientSecret) {
    updateCredentials({
      gmailCredentials: {
        clientId,
        clientSecret,
        redirectUri: 'http://localhost',
      },
    });
    console.log('Gmail credentials saved.\n');
  } else {
    console.log('Invalid credentials. Skipping.\n');
  }
}

/**
 * Authenticate with Gmail
 */
async function authenticateGmail(): Promise<void> {
  const authUrl = getAuthUrl();
  if (!authUrl) {
    console.log('Gmail credentials not configured.');
    return;
  }

  console.log('\nOpen this URL in your browser to authorize:\n');
  console.log(authUrl);
  console.log('\nAfter authorizing, you will be redirected to a URL.');
  console.log('Copy the "code" parameter from that URL.\n');

  const code = await prompt('Enter the authorization code: ');

  if (code) {
    const success = await exchangeCodeForTokens(code);
    if (success) {
      console.log('Gmail authenticated successfully!');
    } else {
      console.log('Failed to authenticate with Gmail.');
    }
  }
}

/**
 * Gmail auth command
 */
export async function gmailAuth(): Promise<void> {
  if (!hasGmailCredentials()) {
    console.log('Gmail credentials not configured. Run: moltbot-mini setup');
    return;
  }

  await authenticateGmail();
}

/**
 * Gmail logout command
 */
export async function gmailLogout(): Promise<void> {
  await revokeAccess();
  console.log('Gmail access revoked.');
}

/**
 * Status command
 */
export async function status(): Promise<void> {
  console.log('\n📊 Moltbot Mini Status\n');

  // Security audit
  const audit = auditCredentialSecurity();
  if (!audit.secure) {
    console.log('⚠️  Security Issues:');
    audit.issues.forEach((issue) => console.log(`   - ${issue}`));
    console.log('');
  }

  // OpenAI
  console.log('OpenAI:');
  if (hasOpenAIKey()) {
    console.log('  ✅ API key configured');
  } else {
    console.log('  ❌ API key not configured');
  }

  // Gmail
  console.log('\nGmail:');
  if (hasGmailCredentials()) {
    console.log('  ✅ OAuth credentials configured');
  } else {
    console.log('  ❌ OAuth credentials not configured');
  }

  if (isAuthenticated()) {
    console.log('  ✅ Authenticated');
    try {
      const email = await getEmailAddress();
      const unread = await getUnreadCount();
      console.log(`  📧 ${email}`);
      console.log(`  📬 ${unread} unread emails`);
    } catch (error) {
      console.log('  ⚠️  Could not fetch account info');
    }
  } else {
    console.log('  ❌ Not authenticated');
  }

  // Config
  const config = loadConfig();
  console.log('\nConfiguration:');
  console.log(`  Model: ${config.openai.model}`);
  console.log(`  Max tokens: ${config.openai.maxTokens}`);
  console.log(`  Temperature: ${config.openai.temperature}`);

  console.log('');
}

/**
 * Set OpenAI key command
 */
export async function setOpenAIKey(key: string): Promise<void> {
  if (!key.startsWith('sk-')) {
    console.log('Invalid OpenAI API key format.');
    return;
  }

  updateCredentials({ openaiApiKey: key });
  console.log('OpenAI API key saved.');
}

/**
 * Interactive chat command
 */
export async function interactiveChat(): Promise<void> {
  if (!hasOpenAIKey()) {
    console.log('OpenAI API key not configured. Run: moltbot-mini setup');
    return;
  }

  if (!isAuthenticated()) {
    console.log('Gmail not authenticated. Run: moltbot-mini gmail auth');
    return;
  }

  console.log('\n🤖 Email Assistant');
  console.log('Type your message or use these commands:');
  console.log('  /reset - Reset conversation');
  console.log('  /status - Show status');
  console.log('  /quit or /exit - Exit\n');

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const askQuestion = (): void => {
    rl.question('You: ', async (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        askQuestion();
        return;
      }

      // Handle commands
      if (trimmed.startsWith('/')) {
        const cmd = trimmed.toLowerCase();

        if (cmd === '/quit' || cmd === '/exit') {
          console.log('Goodbye!');
          rl.close();
          return;
        }

        if (cmd === '/reset') {
          resetConversation();
          console.log('Conversation reset.\n');
          askQuestion();
          return;
        }

        if (cmd === '/status') {
          console.log(`Conversation length: ${getConversationLength()} messages\n`);
          askQuestion();
          return;
        }

        console.log('Unknown command.\n');
        askQuestion();
        return;
      }

      // Process message
      try {
        const response = await chat(trimmed);
        console.log(`\nAssistant: ${response}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.log(`Error: ${message}\n`);
      }

      askQuestion();
    });
  };

  askQuestion();
}

/**
 * Single message command
 */
export async function sendMessage(message: string): Promise<void> {
  if (!hasOpenAIKey()) {
    console.log('OpenAI API key not configured. Run: moltbot-mini setup');
    return;
  }

  if (!isAuthenticated()) {
    console.log('Gmail not authenticated. Run: moltbot-mini gmail auth');
    return;
  }

  try {
    resetConversation();
    const response = await chat(message);
    console.log(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

/**
 * List recent emails command
 */
export async function listRecentEmails(count: number): Promise<void> {
  if (!isAuthenticated()) {
    console.log('Gmail not authenticated. Run: moltbot-mini gmail auth');
    return;
  }

  try {
    const result = await listEmails({ maxResults: count });

    if (result.messages.length === 0) {
      console.log('No emails found.');
      return;
    }

    console.log(`\n📧 Recent Emails (${result.messages.length})\n`);

    result.messages.forEach((email, i) => {
      const date = email.date.toLocaleDateString();
      const unread = email.isUnread ? '📬' : '📭';
      console.log(`${unread} ${i + 1}. ${email.subject}`);
      console.log(`   From: ${email.from}`);
      console.log(`   Date: ${date}`);
      console.log(`   ID: ${email.id}\n`);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Error: ${message}`);
  }
}

/**
 * Security audit command
 */
export async function securityAudit(): Promise<void> {
  console.log('\n🔒 Security Audit\n');

  const audit = auditCredentialSecurity();

  if (audit.secure) {
    console.log('✅ No security issues found.');
  } else {
    console.log('⚠️  Security issues found:\n');
    audit.issues.forEach((issue) => {
      console.log(`  ❌ ${issue}`);
    });
  }

  console.log('');
}
