#!/usr/bin/env node
/**
 * Moltbot Mini - Minimal secure email assistant with OpenAI
 *
 * A stripped-down version of Moltbot demonstrating core patterns:
 * - Secure credential storage (0o600 permissions)
 * - Zod-validated configuration
 * - Plugin-like architecture (Gmail as single channel)
 * - OpenAI function calling for email tools
 */

import { Command } from 'commander';
import {
  setup,
  status,
  gmailAuth,
  gmailLogout,
  setOpenAIKey,
  interactiveChat,
  sendMessage,
  listRecentEmails,
  securityAudit,
} from './cli/commands.js';
import { initializeConfigDir } from './config/index.js';

// Initialize config directory on startup
initializeConfigDir();

const program = new Command();

program
  .name('moltbot-mini')
  .description('Minimal secure email assistant with OpenAI')
  .version('1.0.0');

// Setup command
program
  .command('setup')
  .description('Interactive setup for OpenAI and Gmail')
  .action(setup);

// Status command
program
  .command('status')
  .description('Show configuration and authentication status')
  .action(status);

// Gmail commands
const gmail = program
  .command('gmail')
  .description('Gmail management commands');

gmail
  .command('auth')
  .description('Authenticate with Gmail')
  .action(gmailAuth);

gmail
  .command('logout')
  .description('Revoke Gmail access')
  .action(gmailLogout);

gmail
  .command('list')
  .description('List recent emails')
  .option('-n, --count <number>', 'Number of emails to show', '10')
  .action((options) => {
    listRecentEmails(parseInt(options.count, 10));
  });

// Config commands
const config = program
  .command('config')
  .description('Configuration commands');

config
  .command('set-openai-key <key>')
  .description('Set OpenAI API key')
  .action(setOpenAIKey);

// Chat commands
program
  .command('chat')
  .description('Start interactive chat with email assistant')
  .action(interactiveChat);

program
  .command('message <text>')
  .description('Send a single message to the assistant')
  .action(sendMessage);

// Alias for quick questions
program
  .command('ask <text>')
  .description('Ask the assistant a question (alias for message)')
  .action(sendMessage);

// Security command
program
  .command('security')
  .description('Run security audit')
  .action(securityAudit);

// Parse arguments
program.parse();
