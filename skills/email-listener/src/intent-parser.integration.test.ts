import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { parseIntent } from './intent-parser.js';
import { executeCommand, initializeCommands } from './execute_command.js';
import { clearAllTasks, getAllTasks, initTaskCreator } from './task-creator.js';
import type { ParsedEmail, EmailListenerConfig } from './types.js';

/**
 * Integration tests for the intent parser with real task creation
 * Tests the complete flow: email → intent parsing → task creation
 */
describe('Intent Parser Integration Tests', () => {
  // ============================================================================
  // Setup & Teardown
  // ============================================================================

  const mockConfig: EmailListenerConfig = {
    imap: {
      host: 'imap.example.com',
      port: 993,
      secure: true,
      user: 'tim@example.com',
      password: 'password',
    },
    security: {
      allowedSenders: ['frank@example.com', 'test@example.com'],
      requireConfirmation: ['DELETE', 'RESTART'],
      confirmationTimeout: 300000,
    },
    polling: {
      intervalMs: 300000,
      enabled: true,
    },
    commands: {
      enabled: ['STATUS', 'PING', 'AGENT_STATUS', 'CREATE_TASK'],
      disabled: [],
    },
    agent: {
      agentName: 'tim',
      enableFreeform: true,
      messageTimeoutMs: 120000,
      intentParserEnabled: true,
      intentParserModel: 'claude-haiku-4-5-20251001',
      intentConfidenceThreshold: 0.7,
    },
    cleanup: {
      enabled: false,
      intervalMs: 3600000,
      retentionPeriodMs: 86400000,
      action: 'trash',
    },
  };

  beforeEach(async () => {
    // Initialize commands
    initializeCommands();

    // Initialize task creator with in-memory test config
    initTaskCreator({
      enabled: true,
      backend: 'json',
      jsonFilePath: '/tmp/test-email-tasks.json',
    });

    // Clear any existing tasks from previous tests
    await clearAllTasks();
  });

  afterEach(async () => {
    // Clean up tasks after each test
    await clearAllTasks();
    // Clear all mocks
    vi.clearAllMocks();
  });

  // ============================================================================
  // Mock Claude Responses
  // ============================================================================

  /**
   * Mock Claude response for task creation
   */
  const mockClaudeCreateTaskResponse = {
    action: 'CREATE_TASK',
    confidence: 0.95,
    reasoning: 'User explicitly requests to create a task',
    params: {
      taskTitle: 'Review email functions',
      taskDescription: 'Review the email functions as requested',
      taskPriority: 'high' as const,
      taskDueDate: null,
      targetFolder: null,
      rawArgs: [],
    },
  };

  /**
   * Mock Claude response for status query
   */
  const mockClaudeStatusResponse = {
    action: 'STATUS',
    confidence: 0.91,
    reasoning: 'User requests system status',
    params: {
      taskTitle: null,
      taskDescription: null,
      taskPriority: null,
      taskDueDate: null,
      targetFolder: null,
      rawArgs: [],
    },
  };

  /**
   * Mock Claude response with low confidence
   */
  const mockClaudeLowConfidenceResponse = {
    action: 'UNKNOWN',
    confidence: 0.55,
    reasoning: 'Could mean multiple things',
    params: {
      taskTitle: null,
      taskDescription: null,
      taskPriority: null,
      taskDueDate: null,
      targetFolder: null,
      rawArgs: [],
    },
  };

  // ============================================================================
  // Unit Flow Tests - Intent to Command Execution
  // ============================================================================

  describe('intent to command execution', () => {
    it('should execute CREATE_TASK command from intent', async () => {
      const email: ParsedEmail = {
        sender: 'frank@example.com',
        senderName: 'Frank',
        subject: 'Create task for email review',
        body: 'Can you create a task to review the email functions?',
        timestamp: new Date(),
        messageId: '<test-1@example.com>',
      };

      const result = await executeCommand(
        'CREATE_TASK',
        ['Review email functions', 'high', 'Review the email functions as requested'],
        email,
        mockConfig
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('Task created');
      expect(result.data?.title).toBe('Review email functions');
      expect(result.data?.priority).toBe('high');

      // Verify task was persisted
      const tasks = getAllTasks();
      expect(tasks.length).toBe(1);
      expect(tasks[0].title).toBe('Review email functions');
      expect(tasks[0].priority).toBe('high');
      expect(tasks[0].sourceEmail.from).toBe('frank@example.com');
    });

    it('should execute STATUS command from intent', async () => {
      const email: ParsedEmail = {
        sender: 'frank@example.com',
        senderName: 'Frank',
        subject: 'What is the system status?',
        body: 'Is everything healthy?',
        timestamp: new Date(),
        messageId: '<test-2@example.com>',
      };

      const result = await executeCommand('STATUS', [], email, mockConfig);

      expect(result.success).toBe(true);
      expect(result.message).toContain('operational');
      expect(result.data?.status).toBe('healthy');
    });

    it('should execute PING command from intent', async () => {
      const email: ParsedEmail = {
        sender: 'frank@example.com',
        senderName: 'Frank',
        subject: 'Ping',
        body: 'Are you there?',
        timestamp: new Date(),
        messageId: '<test-3@example.com>',
      };

      const result = await executeCommand('PING', [], email, mockConfig);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Pong');
    });

    it('should execute AGENT_STATUS command from intent', async () => {
      const email: ParsedEmail = {
        sender: 'frank@example.com',
        senderName: 'Frank',
        subject: 'Agent status',
        body: 'Tell me about the agents',
        timestamp: new Date(),
        messageId: '<test-4@example.com>',
      };

      const result = await executeCommand('AGENT_STATUS', [], email, mockConfig);

      expect(result.success).toBe(true);
      expect(result.message).toContain('Agent status report');
    });

    it('should handle CREATE_TASK with minimal arguments', async () => {
      const email: ParsedEmail = {
        sender: 'frank@example.com',
        senderName: 'Frank',
        subject: 'Test',
        body: 'Body',
        timestamp: new Date(),
        messageId: '<test-5@example.com>',
      };

      const result = await executeCommand('CREATE_TASK', ['Quick task'], email, mockConfig);

      expect(result.success).toBe(true);
      const tasks = getAllTasks();
      expect(tasks.length).toBe(1);
      expect(tasks[0].title).toBe('Quick task');
      expect(tasks[0].priority).toBe('medium'); // default priority
    });

    it('should fail CREATE_TASK with no title', async () => {
      const email: ParsedEmail = {
        sender: 'frank@example.com',
        senderName: 'Frank',
        subject: 'Test',
        body: 'Body',
        timestamp: new Date(),
        messageId: '<test-6@example.com>',
      };

      const result = await executeCommand('CREATE_TASK', [], email, mockConfig);

      expect(result.success).toBe(false);
      expect(result.message).toContain('no title');
      const tasks = getAllTasks();
      expect(tasks.length).toBe(0);
    });
  });

  // ============================================================================
  // Task Creation Tests - Email Source Tracking
  // ============================================================================

  describe('task creation with email source tracking', () => {
    it('should track email source in created task', async () => {
      const email: ParsedEmail = {
        sender: 'frank@example.com',
        senderName: 'Frank Ventura',
        subject: 'Important task',
        body: 'Please create a task for this',
        timestamp: new Date('2026-03-07T10:00:00Z'),
        messageId: '<important-task@example.com>',
      };

      await executeCommand(
        'CREATE_TASK',
        ['Important task', 'urgent', 'This is urgent work'],
        email,
        mockConfig
      );

      const tasks = getAllTasks();
      expect(tasks.length).toBe(1);

      const task = tasks[0];
      expect(task.sourceEmail.from).toBe('frank@example.com');
      expect(task.sourceEmail.subject).toBe('Important task');
      expect(task.sourceEmail.messageId).toBe('<important-task@example.com>');
      expect(task.tags).toContain('natural-language');
      expect(task.metadata.createdBy).toBe('intent-parser');
    });

    it('should preserve email timestamp in task source', async () => {
      const emailDate = new Date('2026-03-07T15:30:00Z');
      const email: ParsedEmail = {
        sender: 'frank@example.com',
        senderName: 'Frank',
        subject: 'Timestamped task',
        body: 'Test',
        timestamp: emailDate,
        messageId: '<timestamp-test@example.com>',
      };

      await executeCommand('CREATE_TASK', ['Task'], email, mockConfig);

      const tasks = getAllTasks();
      expect(tasks[0].sourceEmail.date).toEqual(emailDate);
    });

    it('should create multiple tasks from different emails', async () => {
      const email1: ParsedEmail = {
        sender: 'frank@example.com',
        senderName: 'Frank',
        subject: 'First task',
        body: 'Test',
        timestamp: new Date(),
        messageId: '<first@example.com>',
      };

      const email2: ParsedEmail = {
        sender: 'frank@example.com',
        senderName: 'Frank',
        subject: 'Second task',
        body: 'Test',
        timestamp: new Date(),
        messageId: '<second@example.com>',
      };

      await executeCommand('CREATE_TASK', ['First task'], email1, mockConfig);
      await executeCommand('CREATE_TASK', ['Second task'], email2, mockConfig);

      const tasks = getAllTasks();
      expect(tasks.length).toBe(2);
      expect(tasks[0].sourceEmail.messageId).toBe('<first@example.com>');
      expect(tasks[1].sourceEmail.messageId).toBe('<second@example.com>');
    });
  });

  // ============================================================================
  // Priority and Description Tests
  // ============================================================================

  describe('task priority and description handling', () => {
    it('should create task with all priority levels', async () => {
      const priorities = ['low', 'medium', 'high', 'urgent'] as const;
      const email: ParsedEmail = {
        sender: 'frank@example.com',
        senderName: 'Frank',
        subject: 'Priority test',
        body: 'Test',
        timestamp: new Date(),
        messageId: '<priority@example.com>',
      };

      for (const priority of priorities) {
        await clearAllTasks();

        await executeCommand(
          'CREATE_TASK',
          [`Task ${priority}`, priority],
          email,
          mockConfig
        );

        const tasks = getAllTasks();
        expect(tasks[0].priority).toBe(priority);
      }
    });

    it('should create task with description', async () => {
      const email: ParsedEmail = {
        sender: 'frank@example.com',
        senderName: 'Frank',
        subject: 'Task with details',
        body: 'Test',
        timestamp: new Date(),
        messageId: '<details@example.com>',
      };

      const description = 'This is a detailed description of the task that needs to be completed';
      await executeCommand(
        'CREATE_TASK',
        ['Task title', 'high', ...description.split(' ')],
        email,
        mockConfig
      );

      const tasks = getAllTasks();
      expect(tasks[0].description).toContain('detailed');
      expect(tasks[0].description).toContain('completed');
    });

    it('should create task without description', async () => {
      const email: ParsedEmail = {
        sender: 'frank@example.com',
        senderName: 'Frank',
        subject: 'No description',
        body: 'Test',
        timestamp: new Date(),
        messageId: '<nodesc@example.com>',
      };

      await executeCommand('CREATE_TASK', ['Task only'], email, mockConfig);

      const tasks = getAllTasks();
      expect(tasks[0].description).toBe('');
    });
  });

  // ============================================================================
  // Integration Scenario Tests
  // ============================================================================

  describe('integration scenarios', () => {
    it('should handle task creation from formal request email', async () => {
      const email: ParsedEmail = {
        sender: 'frank@example.com',
        senderName: 'Frank',
        subject: 'Please review email implementation and provide feedback',
        body: `Hi Tim,

Can you please create a task to review the email listener implementation?
It's important to ensure all functionality works correctly.

Priority: High
Due: By end of week

Thanks,
Frank`,
        timestamp: new Date(),
        messageId: '<formal-request@example.com>',
      };

      // Simulate intent parser extracting from the email
      const args = [
        'Review email listener implementation',
        'high',
        'Ensure all functionality works correctly',
      ];

      const result = await executeCommand('CREATE_TASK', args, email, mockConfig);

      expect(result.success).toBe(true);
      const tasks = getAllTasks();
      expect(tasks.length).toBe(1);
      expect(tasks[0].priority).toBe('high');
      expect(tasks[0].sourceEmail.subject).toContain('review email');
    });

    it('should handle concurrent task creation', async () => {
      const emails: ParsedEmail[] = Array.from({ length: 5 }, (_, i) => ({
        sender: 'frank@example.com',
        senderName: 'Frank',
        subject: `Task ${i + 1}`,
        body: 'Test',
        timestamp: new Date(),
        messageId: `<concurrent-${i}@example.com>`,
      }));

      const promises = emails.map((email, i) =>
        executeCommand('CREATE_TASK', [`Task ${i + 1}`, 'medium'], email, mockConfig)
      );

      const results = await Promise.all(promises);

      expect(results.every((r) => r.success)).toBe(true);
      const tasks = getAllTasks();
      expect(tasks.length).toBe(5);
      expect(tasks.map((t) => t.title)).toEqual([
        'Task 1',
        'Task 2',
        'Task 3',
        'Task 4',
        'Task 5',
      ]);
    });

    it('should handle mixed commands in sequence', async () => {
      const email: ParsedEmail = {
        sender: 'frank@example.com',
        senderName: 'Frank',
        subject: 'Test',
        body: 'Test',
        timestamp: new Date(),
        messageId: '<mixed@example.com>',
      };

      // Create a task
      const createResult = await executeCommand(
        'CREATE_TASK',
        ['Mixed command test', 'medium'],
        email,
        mockConfig
      );
      expect(createResult.success).toBe(true);

      // Check status
      const statusResult = await executeCommand('STATUS', [], email, mockConfig);
      expect(statusResult.success).toBe(true);

      // Ping
      const pingResult = await executeCommand('PING', [], email, mockConfig);
      expect(pingResult.success).toBe(true);

      // Verify task still exists
      const tasks = getAllTasks();
      expect(tasks.length).toBe(1);
      expect(tasks[0].title).toBe('Mixed command test');
    });
  });

  // ============================================================================
  // Error Handling and Edge Cases
  // ============================================================================

  describe('error handling and edge cases', () => {
    it('should handle email with special characters in sender', async () => {
      const email: ParsedEmail = {
        sender: 'frank+test@example.com',
        senderName: 'Frank "The Tester" Ventura',
        subject: 'Special chars test',
        body: 'Test',
        timestamp: new Date(),
        messageId: '<special+chars@example.com>',
      };

      const result = await executeCommand('CREATE_TASK', ['Special task'], email, mockConfig);

      expect(result.success).toBe(true);
      const tasks = getAllTasks();
      expect(tasks[0].sourceEmail.from).toBe('frank+test@example.com');
    });

    it('should handle very long task title', async () => {
      const longTitle = 'A'.repeat(200);
      const email: ParsedEmail = {
        sender: 'frank@example.com',
        senderName: 'Frank',
        subject: 'Long title test',
        body: 'Test',
        timestamp: new Date(),
        messageId: '<long@example.com>',
      };

      const result = await executeCommand(
        'CREATE_TASK',
        [longTitle, 'medium'],
        email,
        mockConfig
      );

      expect(result.success).toBe(true);
      const tasks = getAllTasks();
      expect(tasks[0].title).toBe(longTitle);
    });

    it('should handle task creation from email with empty body', async () => {
      const email: ParsedEmail = {
        sender: 'frank@example.com',
        senderName: 'Frank',
        subject: 'Empty body email',
        body: '',
        timestamp: new Date(),
        messageId: '<empty@example.com>',
      };

      const result = await executeCommand(
        'CREATE_TASK',
        ['Task from empty email'],
        email,
        mockConfig
      );

      expect(result.success).toBe(true);
      const tasks = getAllTasks();
      expect(tasks[0].title).toBe('Task from empty email');
    });

    it('should handle email with Unicode characters', async () => {
      const email: ParsedEmail = {
        sender: 'frank@example.com',
        senderName: 'Frank',
        subject: '审查功能 - Review',
        body: 'Test with emoji 🚀',
        timestamp: new Date(),
        messageId: '<unicode@example.com>',
      };

      const result = await executeCommand(
        'CREATE_TASK',
        ['審查功能', 'high'],
        email,
        mockConfig
      );

      expect(result.success).toBe(true);
      const tasks = getAllTasks();
      expect(tasks[0].title).toBe('審查功能');
    });
  });

  // ============================================================================
  // Task Persistence Tests
  // ============================================================================

  describe('task persistence', () => {
    it('should persist tasks to disk', async () => {
      const email: ParsedEmail = {
        sender: 'frank@example.com',
        senderName: 'Frank',
        subject: 'Persist test',
        body: 'Test',
        timestamp: new Date(),
        messageId: '<persist@example.com>',
      };

      await executeCommand('CREATE_TASK', ['Persisted task', 'high'], email, mockConfig);

      const tasks = getAllTasks();
      expect(tasks.length).toBe(1);
      expect(tasks[0].title).toBe('Persisted task');
      expect(tasks[0].priority).toBe('high');
      expect(tasks[0].status).toBe('pending');
    });

    it('should create task with correct metadata', async () => {
      const email: ParsedEmail = {
        sender: 'frank@example.com',
        senderName: 'Frank',
        subject: 'Metadata test',
        body: 'Test',
        timestamp: new Date(),
        messageId: '<metadata@example.com>',
      };

      const beforeCreate = new Date();
      await executeCommand('CREATE_TASK', ['Test task'], email, mockConfig);
      const afterCreate = new Date();

      const tasks = getAllTasks();
      const task = tasks[0];

      expect(task.createdAt).toBeInstanceOf(Date);
      expect(task.createdAt.getTime()).toBeGreaterThanOrEqual(beforeCreate.getTime());
      expect(task.createdAt.getTime()).toBeLessThanOrEqual(afterCreate.getTime());
      expect(task.metadata.createdBy).toBe('intent-parser');
    });
  });
});
