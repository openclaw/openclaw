import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyMessage } from '../src/classify_message.js';
import { parseEmail } from '../src/parse_email.js';
import { executeCommand } from '../src/execute_command.js';
import type { ParsedEmail, EmailListenerConfig } from '../src/types.js';

// Mock config for tests
const mockConfig: EmailListenerConfig = {
  imap: {
    host: 'imap.example.com',
    port: 993,
    secure: true,
    user: 'test@example.com',
    password: 'secret',
  },
  security: {
    allowedSenders: ['admin@example.com', 'user@example.com'],
    requireConfirmation: ['DELETE', 'RESTART', 'SHUTDOWN'],
    confirmationTimeout: 300000,
  },
  polling: {
    intervalMs: 300000,
    enabled: true,
  },
  commands: {
    enabled: ['STATUS', 'SECURITY_AUDIT', 'CHECK_UPDATES', 'MEMORY_COMPACT', 'AGENT_STATUS', 'PING'],
    disabled: [],
  },
};

describe('classifyMessage', () => {
  describe('sender authorization', () => {
    it('should classify message as unauthorized when sender is not in whitelist', () => {
      const email: ParsedEmail = {
        sender: 'unknown@example.com',
        subject: 'TIM:STATUS',
        body: 'Get status',
        timestamp: new Date(),
        messageId: '<test123@example.com>',
      };

      const result = classifyMessage(email, mockConfig);
      expect(result.type).toBe('unauthorized');
    });

    it('should classify message as command when sender is authorized and subject starts with TIM:', () => {
      const email: ParsedEmail = {
        sender: 'admin@example.com',
        subject: 'TIM:STATUS',
        body: 'Get status',
        timestamp: new Date(),
        messageId: '<test123@example.com>',
      };

      const result = classifyMessage(email, mockConfig);
      expect(result.type).toBe('command');
    });
  });

  describe('command parsing', () => {
    it('should parse STATUS command correctly', () => {
      const email: ParsedEmail = {
        sender: 'admin@example.com',
        subject: 'TIM:STATUS',
        body: '',
        timestamp: new Date(),
        messageId: '<test123@example.com>',
      };

      const result = classifyMessage(email, mockConfig);
      expect(result.type).toBe('command');
      expect(result.command).toBe('STATUS');
      expect(result.args).toEqual([]);
    });

    it('should parse command with arguments', () => {
      const email: ParsedEmail = {
        sender: 'admin@example.com',
        subject: 'TIM:RUN SECURITY_AUDIT',
        body: '',
        timestamp: new Date(),
        messageId: '<test123@example.com>',
      };

      const result = classifyMessage(email, mockConfig);
      expect(result.type).toBe('command');
      expect(result.command).toBe('RUN');
      expect(result.args).toEqual(['SECURITY_AUDIT']);
    });

    it('should parse CONFIRM command correctly', () => {
      const email: ParsedEmail = {
        sender: 'admin@example.com',
        subject: 'TIM:CONFIRM DELETE AGENT tim',
        body: '',
        timestamp: new Date(),
        messageId: '<test123@example.com>',
      };

      const result = classifyMessage(email, mockConfig);
      expect(result.type).toBe('command');
      expect(result.command).toBe('CONFIRM');
      expect(result.args).toEqual(['DELETE', 'AGENT', 'tim']);
    });
  });

  describe('non-command handling', () => {
    it('should classify as normal when subject does not start with TIM:', () => {
      const email: ParsedEmail = {
        sender: 'admin@example.com',
        subject: 'Hello there',
        body: 'Just saying hi',
        timestamp: new Date(),
        messageId: '<test123@example.com>',
      };

      const result = classifyMessage(email, mockConfig);
      expect(result.type).toBe('normal');
    });
  });

  describe('risk level classification', () => {
    it('should classify STATUS as safe', () => {
      const email: ParsedEmail = {
        sender: 'admin@example.com',
        subject: 'TIM:STATUS',
        body: '',
        timestamp: new Date(),
        messageId: '<test123@example.com>',
      };

      const result = classifyMessage(email, mockConfig);
      expect(result.riskLevel).toBe('safe');
    });

    it('should classify DELETE as high risk', () => {
      const email: ParsedEmail = {
        sender: 'admin@example.com',
        subject: 'TIM:DELETE AGENT tim',
        body: '',
        timestamp: new Date(),
        messageId: '<test123@example.com>',
      };

      const result = classifyMessage(email, mockConfig);
      expect(result.riskLevel).toBe('high');
    });
  });
});

describe('parseEmail', () => {
  it('should parse basic email fields', () => {
    const rawEmail = {
      from: 'test@example.com',
      subject: 'Test Subject',
      body: 'Test body content',
      date: new Date().toISOString(),
      messageId: '<unique123@example.com>',
    };

    const result = parseEmail(rawEmail);
    expect(result.sender).toBe('test@example.com');
    expect(result.subject).toBe('Test Subject');
    expect(result.body).toBe('Test body content');
    expect(result.messageId).toBe('<unique123@example.com>');
  });

  it('should extract email address from full name format', () => {
    const rawEmail = {
      from: 'John Doe <john@example.com>',
      subject: 'Test',
      body: 'Body',
      date: new Date().toISOString(),
      messageId: '<unique123@example.com>',
    };

    const result = parseEmail(rawEmail);
    expect(result.sender).toBe('john@example.com');
  });
});

describe('executeCommand', () => {
  let mockExecuteCommand: typeof executeCommand;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should execute STATUS command', async () => {
    const result = await executeCommand('STATUS', [], mockConfig);
    expect(result.success).toBe(true);
    expect(result.message).toContain('STATUS');
  });

  it('should execute PING command', async () => {
    const result = await executeCommand('PING', [], mockConfig);
    expect(result.success).toBe(true);
    expect(result.message).toBe('PONG');
  });

  it('should handle unknown commands', async () => {
    const result = await executeCommand('UNKNOWN_COMMAND', [], mockConfig);
    expect(result.success).toBe(false);
    expect(result.message).toContain('Available commands');
  });

  it('should execute AGENT_STATUS command', async () => {
    const result = await executeCommand('AGENT_STATUS', [], mockConfig);
    expect(result.success).toBe(true);
    expect(result.message).toContain('AGENT_STATUS');
  });
});
