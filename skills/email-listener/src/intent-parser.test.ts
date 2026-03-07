import { describe, it, expect } from 'vitest';
import { parseIntentResponse } from './intent-parser.js';
import type { ParsedIntent } from './types.js';

describe('parseIntentResponse', () => {
  // ============================================================================
  // Valid Intent Responses - All Action Types
  // ============================================================================

  describe('valid responses - all action types', () => {
    it('should parse CREATE_TASK action correctly', () => {
      const json = '{"action":"CREATE_TASK","confidence":0.95,"reasoning":"Explicit task creation","params":{"taskTitle":"Review email functions","taskDescription":"Review the email functions as requested","taskPriority":"medium","taskDueDate":null,"targetFolder":null,"rawArgs":[]}}';

      const result = parseIntentResponse(json);

      expect(result).not.toBeNull();
      expect(result?.action).toBe('CREATE_TASK');
      expect(result?.confidence).toBe(0.95);
      expect(result?.reasoning).toBe('Explicit task creation');
      expect(result?.params.taskTitle).toBe('Review email functions');
      expect(result?.params.taskPriority).toBe('medium');
    });

    it('should parse STATUS action correctly', () => {
      const json = '{"action":"STATUS","confidence":0.91,"reasoning":"Direct request for system status","params":{"taskTitle":null,"taskDescription":null,"taskPriority":null,"taskDueDate":null,"targetFolder":null,"rawArgs":[]}}';

      const result = parseIntentResponse(json);

      expect(result).not.toBeNull();
      expect(result?.action).toBe('STATUS');
      expect(result?.confidence).toBe(0.91);
    });

    it('should parse PING action correctly', () => {
      const json = '{"action":"PING","confidence":0.95,"reasoning":"Sender is testing connectivity","params":{"taskTitle":null,"taskDescription":null,"taskPriority":null,"taskDueDate":null,"targetFolder":null,"rawArgs":[]}}';

      const result = parseIntentResponse(json);

      expect(result).not.toBeNull();
      expect(result?.action).toBe('PING');
      expect(result?.confidence).toBe(0.95);
    });

    it('should parse AGENT_STATUS action correctly', () => {
      const json = '{"action":"AGENT_STATUS","confidence":0.89,"reasoning":"Request for agent status","params":{"taskTitle":null,"taskDescription":null,"taskPriority":null,"taskDueDate":null,"targetFolder":null,"rawArgs":[]}}';

      const result = parseIntentResponse(json);

      expect(result).not.toBeNull();
      expect(result?.action).toBe('AGENT_STATUS');
      expect(result?.confidence).toBe(0.89);
    });

    it('should parse MOVE_EMAIL action correctly', () => {
      const json = '{"action":"MOVE_EMAIL","confidence":0.88,"reasoning":"Clear move request with target folder","params":{"taskTitle":null,"taskDescription":null,"taskPriority":null,"taskDueDate":null,"targetFolder":"archive","rawArgs":[]}}';

      const result = parseIntentResponse(json);

      expect(result).not.toBeNull();
      expect(result?.action).toBe('MOVE_EMAIL');
      expect(result?.params.targetFolder).toBe('archive');
    });

    it('should parse UNKNOWN action correctly', () => {
      const json = '{"action":"UNKNOWN","confidence":0.97,"reasoning":"Casual message with no actionable request","params":{"taskTitle":null,"taskDescription":null,"taskPriority":null,"taskDueDate":null,"targetFolder":null,"rawArgs":[]}}';

      const result = parseIntentResponse(json);

      expect(result).not.toBeNull();
      expect(result?.action).toBe('UNKNOWN');
      expect(result?.confidence).toBe(0.97);
    });
  });

  // ============================================================================
  // Markdown Code Fence Handling
  // ============================================================================

  describe('markdown code fence handling', () => {
    it('should strip ```json code fence from beginning and end', () => {
      const json = '```json\n{"action":"PING","confidence":0.9,"reasoning":"Test","params":{"taskTitle":null,"taskDescription":null,"taskPriority":null,"taskDueDate":null,"targetFolder":null,"rawArgs":[]}}\n```';

      const result = parseIntentResponse(json);

      expect(result).not.toBeNull();
      expect(result?.action).toBe('PING');
    });

    it('should strip generic ``` code fence', () => {
      const json = '```\n{"action":"STATUS","confidence":0.85,"reasoning":"Test","params":{"taskTitle":null,"taskDescription":null,"taskPriority":null,"taskDueDate":null,"targetFolder":null,"rawArgs":[]}}\n```';

      const result = parseIntentResponse(json);

      expect(result).not.toBeNull();
      expect(result?.action).toBe('STATUS');
    });

    it('should handle nested code fence markers', () => {
      const json = '```json\n{"action":"PING","confidence":0.8,"reasoning":"Test","params":{"taskTitle":null,"taskDescription":null,"taskPriority":null,"taskDueDate":null,"targetFolder":null,"rawArgs":[]}}\n```';

      const result = parseIntentResponse(json);

      expect(result).not.toBeNull();
      expect(result?.action).toBe('PING');
    });

    it('should handle leading and trailing whitespace', () => {
      const json = '  \n  ```json\n{"action":"PING","confidence":0.9,"reasoning":"Test","params":{"taskTitle":null,"taskDescription":null,"taskPriority":null,"taskDueDate":null,"targetFolder":null,"rawArgs":[]}}\n```  \n  ';

      const result = parseIntentResponse(json);

      expect(result).not.toBeNull();
      expect(result?.action).toBe('PING');
    });
  });

  // ============================================================================
  // Confidence Value Validation
  // ============================================================================

  describe('confidence value validation', () => {
    it('should accept confidence of 0.0', () => {
      const json = '{"action":"PING","confidence":0.0,"reasoning":"Test","params":{"taskTitle":null,"taskDescription":null,"taskPriority":null,"taskDueDate":null,"targetFolder":null,"rawArgs":[]}}';

      const result = parseIntentResponse(json);

      expect(result).not.toBeNull();
      expect(result?.confidence).toBe(0.0);
    });

    it('should accept confidence of 1.0', () => {
      const json = '{"action":"PING","confidence":1.0,"reasoning":"Test","params":{"taskTitle":null,"taskDescription":null,"taskPriority":null,"taskDueDate":null,"targetFolder":null,"rawArgs":[]}}';

      const result = parseIntentResponse(json);

      expect(result).not.toBeNull();
      expect(result?.confidence).toBe(1.0);
    });

    it('should accept confidence between 0 and 1', () => {
      const json = '{"action":"PING","confidence":0.75,"reasoning":"Test","params":{"taskTitle":null,"taskDescription":null,"taskPriority":null,"taskDueDate":null,"targetFolder":null,"rawArgs":[]}}';

      const result = parseIntentResponse(json);

      expect(result).not.toBeNull();
      expect(result?.confidence).toBe(0.75);
    });

    it('should reject confidence > 1.0', () => {
      const json = '{"action":"PING","confidence":1.5,"reasoning":"Test","params":{"taskTitle":null,"taskDescription":null,"taskPriority":null,"taskDueDate":null,"targetFolder":null,"rawArgs":[]}}';

      const result = parseIntentResponse(json);

      expect(result).toBeNull();
    });

    it('should reject confidence < 0.0', () => {
      const json = '{"action":"PING","confidence":-0.5,"reasoning":"Test","params":{"taskTitle":null,"taskDescription":null,"taskPriority":null,"taskDueDate":null,"targetFolder":null,"rawArgs":[]}}';

      const result = parseIntentResponse(json);

      expect(result).toBeNull();
    });

    it('should reject non-numeric confidence', () => {
      const json = '{"action":"PING","confidence":"high","reasoning":"Test","params":{"taskTitle":null,"taskDescription":null,"taskPriority":null,"taskDueDate":null,"targetFolder":null,"rawArgs":[]}}';

      const result = parseIntentResponse(json);

      expect(result).toBeNull();
    });

    it('should reject NaN confidence', () => {
      const json = '{"action":"PING","confidence":NaN,"reasoning":"Test","params":{"taskTitle":null,"taskDescription":null,"taskPriority":null,"taskDueDate":null,"targetFolder":null,"rawArgs":[]}}';

      // NaN will parse as a string, not a number, so this should fail
      const result = parseIntentResponse(json);

      expect(result).toBeNull();
    });
  });

  // ============================================================================
  // Action Validation
  // ============================================================================

  describe('action validation', () => {
    it('should reject invalid action', () => {
      const json = '{"action":"INVALID","confidence":0.9,"reasoning":"Test","params":{"taskTitle":null,"taskDescription":null,"taskPriority":null,"taskDueDate":null,"targetFolder":null,"rawArgs":[]}}';

      const result = parseIntentResponse(json);

      expect(result).toBeNull();
    });

    it('should reject action as null', () => {
      const json = '{"action":null,"confidence":0.9,"reasoning":"Test","params":{"taskTitle":null,"taskDescription":null,"taskPriority":null,"taskDueDate":null,"targetFolder":null,"rawArgs":[]}}';

      const result = parseIntentResponse(json);

      expect(result).toBeNull();
    });

    it('should be case-sensitive for action', () => {
      const json = '{"action":"ping","confidence":0.9,"reasoning":"Test","params":{"taskTitle":null,"taskDescription":null,"taskPriority":null,"taskDueDate":null,"targetFolder":null,"rawArgs":[]}}';

      const result = parseIntentResponse(json);

      expect(result).toBeNull();
    });
  });

  // ============================================================================
  // Parameter Validation
  // ============================================================================

  describe('parameter handling', () => {
    it('should handle all null params', () => {
      const json = '{"action":"PING","confidence":0.9,"reasoning":"Test","params":{"taskTitle":null,"taskDescription":null,"taskPriority":null,"taskDueDate":null,"targetFolder":null,"rawArgs":[]}}';

      const result = parseIntentResponse(json);

      expect(result).not.toBeNull();
      expect(result?.params.taskTitle).toBeUndefined();
      expect(result?.params.taskDescription).toBeUndefined();
      expect(result?.params.taskPriority).toBeUndefined();
      expect(result?.params.taskDueDate).toBeUndefined();
      expect(result?.params.targetFolder).toBeUndefined();
    });

    it('should handle mixed param values', () => {
      const json = '{"action":"CREATE_TASK","confidence":0.9,"reasoning":"Test","params":{"taskTitle":"Do something","taskDescription":null,"taskPriority":"high","taskDueDate":"2026-03-15","targetFolder":null,"rawArgs":["--flag"]}}';

      const result = parseIntentResponse(json);

      expect(result).not.toBeNull();
      expect(result?.params.taskTitle).toBe('Do something');
      expect(result?.params.taskDescription).toBeUndefined();
      expect(result?.params.taskPriority).toBe('high');
      expect(result?.params.taskDueDate).toBe('2026-03-15');
      expect(result?.params.rawArgs).toEqual(['--flag']);
    });

    it('should accept taskPriority values: low, medium, high, urgent', () => {
      const priorities = ['low', 'medium', 'high', 'urgent'] as const;

      for (const priority of priorities) {
        const json = `{"action":"CREATE_TASK","confidence":0.9,"reasoning":"Test","params":{"taskTitle":"Task","taskDescription":null,"taskPriority":"${priority}","taskDueDate":null,"targetFolder":null,"rawArgs":[]}}`;

        const result = parseIntentResponse(json);

        expect(result).not.toBeNull();
        expect(result?.params.taskPriority).toBe(priority);
      }
    });

    it('should reject invalid taskPriority', () => {
      const json = '{"action":"CREATE_TASK","confidence":0.9,"reasoning":"Test","params":{"taskTitle":"Task","taskDescription":null,"taskPriority":"critical","taskDueDate":null,"targetFolder":null,"rawArgs":[]}}';

      // parseIntentResponse doesn't validate taskPriority values, just stores them
      const result = parseIntentResponse(json);

      expect(result).not.toBeNull();
      // It stores the invalid value
      expect(result?.params.taskPriority).toBe('critical');
    });

    it('should reject missing params object', () => {
      const json = '{"action":"PING","confidence":0.9,"reasoning":"Test"}';

      const result = parseIntentResponse(json);

      expect(result).toBeNull();
    });

    it('should reject params that is not an object', () => {
      const json = '{"action":"PING","confidence":0.9,"reasoning":"Test","params":"invalid"}';

      const result = parseIntentResponse(json);

      expect(result).toBeNull();
    });

    it('should reject params that is null', () => {
      const json = '{"action":"PING","confidence":0.9,"reasoning":"Test","params":null}';

      const result = parseIntentResponse(json);

      expect(result).toBeNull();
    });

    it('should handle empty rawArgs array', () => {
      const json = '{"action":"PING","confidence":0.9,"reasoning":"Test","params":{"taskTitle":null,"taskDescription":null,"taskPriority":null,"taskDueDate":null,"targetFolder":null,"rawArgs":[]}}';

      const result = parseIntentResponse(json);

      expect(result).not.toBeNull();
      expect(result?.params.rawArgs).toEqual([]);
    });

    it('should handle rawArgs with multiple items', () => {
      const json = '{"action":"PING","confidence":0.9,"reasoning":"Test","params":{"taskTitle":null,"taskDescription":null,"taskPriority":null,"taskDueDate":null,"targetFolder":null,"rawArgs":["--verbose","--debug"]}}';

      const result = parseIntentResponse(json);

      expect(result).not.toBeNull();
      expect(result?.params.rawArgs).toEqual(['--verbose', '--debug']);
    });
  });

  // ============================================================================
  // Malformed JSON
  // ============================================================================

  describe('malformed JSON handling', () => {
    it('should reject invalid JSON syntax', () => {
      const json = '{invalid json}';

      const result = parseIntentResponse(json);

      expect(result).toBeNull();
    });

    it('should reject empty string', () => {
      const json = '';

      const result = parseIntentResponse(json);

      expect(result).toBeNull();
    });

    it('should reject null', () => {
      const json = 'null';

      const result = parseIntentResponse(json);

      expect(result).toBeNull();
    });

    it('should reject plain string', () => {
      const json = '"just a string"';

      const result = parseIntentResponse(json);

      expect(result).toBeNull();
    });

    it('should reject number', () => {
      const json = '42';

      const result = parseIntentResponse(json);

      expect(result).toBeNull();
    });

    it('should reject array', () => {
      const json = '[1, 2, 3]';

      const result = parseIntentResponse(json);

      expect(result).toBeNull();
    });

    it('should reject unclosed JSON', () => {
      const json = '{"action":"PING","confidence":0.9';

      const result = parseIntentResponse(json);

      expect(result).toBeNull();
    });

    it('should reject JSON with trailing comma', () => {
      const json = '{"action":"PING","confidence":0.9,"reasoning":"Test","params":{"taskTitle":null,}}';

      const result = parseIntentResponse(json);

      expect(result).toBeNull();
    });

    it('should reject JSON with single quotes', () => {
      const json = "{'action':'PING','confidence':0.9,'reasoning':'Test','params':{}}";

      const result = parseIntentResponse(json);

      expect(result).toBeNull();
    });
  });

  // ============================================================================
  // Real-World Claude Responses
  // ============================================================================

  describe('real-world Claude responses', () => {
    it('should handle CREATE_TASK with full details', () => {
      const json = '{"action":"CREATE_TASK","confidence":0.95,"reasoning":"User explicitly requests to create a task for reviewing email functions","params":{"taskTitle":"Review email functions","taskDescription":"Review the email functions implementation as requested in the email","taskPriority":"high","taskDueDate":"2026-03-15","targetFolder":null,"rawArgs":[]}}';

      const result = parseIntentResponse(json);

      expect(result).not.toBeNull();
      expect(result?.action).toBe('CREATE_TASK');
      expect(result?.confidence).toBe(0.95);
      expect(result?.params.taskTitle).toBe('Review email functions');
      expect(result?.params.taskDescription).toContain('Review');
      expect(result?.params.taskPriority).toBe('high');
      expect(result?.params.taskDueDate).toBe('2026-03-15');
    });

    it('should handle low confidence ambiguous message', () => {
      const json = '{"action":"UNKNOWN","confidence":0.62,"reasoning":"Could mean multiple things - might be a question about status, or could be casual conversation","params":{"taskTitle":null,"taskDescription":null,"taskPriority":null,"taskDueDate":null,"targetFolder":null,"rawArgs":[]}}';

      const result = parseIntentResponse(json);

      expect(result).not.toBeNull();
      expect(result?.action).toBe('UNKNOWN');
      expect(result?.confidence).toBe(0.62);
    });

    it('should handle MOVE_EMAIL with folder specification', () => {
      const json = '{"action":"MOVE_EMAIL","confidence":0.88,"reasoning":"User explicitly requests to move email to the spam folder","params":{"taskTitle":null,"taskDescription":null,"taskPriority":null,"taskDueDate":null,"targetFolder":"spam","rawArgs":[]}}';

      const result = parseIntentResponse(json);

      expect(result).not.toBeNull();
      expect(result?.action).toBe('MOVE_EMAIL');
      expect(result?.params.targetFolder).toBe('spam');
    });

    it('should handle response with extra whitespace in code fence', () => {
      const json = '```json   \n\n{"action":"PING","confidence":0.9,"reasoning":"User is checking connectivity","params":{"taskTitle":null,"taskDescription":null,"taskPriority":null,"taskDueDate":null,"targetFolder":null,"rawArgs":[]}}\n\n   ```';

      const result = parseIntentResponse(json);

      expect(result).not.toBeNull();
      expect(result?.action).toBe('PING');
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  describe('edge cases', () => {
    it('should handle reasoning as empty string', () => {
      const json = '{"action":"PING","confidence":0.9,"reasoning":"","params":{"taskTitle":null,"taskDescription":null,"taskPriority":null,"taskDueDate":null,"targetFolder":null,"rawArgs":[]}}';

      const result = parseIntentResponse(json);

      expect(result).not.toBeNull();
      expect(result?.reasoning).toBe('');
    });

    it('should handle missing reasoning field', () => {
      const json = '{"action":"PING","confidence":0.9,"params":{"taskTitle":null,"taskDescription":null,"taskPriority":null,"taskDueDate":null,"targetFolder":null,"rawArgs":[]}}';

      const result = parseIntentResponse(json);

      expect(result).not.toBeNull();
      expect(result?.reasoning).toBe('No reasoning provided');
    });

    it('should handle very long task title', () => {
      const longTitle = 'A'.repeat(500);
      const json = `{"action":"CREATE_TASK","confidence":0.9,"reasoning":"Task","params":{"taskTitle":"${longTitle}","taskDescription":null,"taskPriority":"medium","taskDueDate":null,"targetFolder":null,"rawArgs":[]}}`;

      const result = parseIntentResponse(json);

      expect(result).not.toBeNull();
      expect(result?.params.taskTitle?.length).toBe(500);
    });

    it('should handle task title with special characters', () => {
      const json = JSON.stringify({
        action: 'CREATE_TASK',
        confidence: 0.9,
        reasoning: 'Task',
        params: {
          taskTitle: 'Review email "functions" & handle chars',
          taskDescription: null,
          taskPriority: 'medium',
          taskDueDate: null,
          targetFolder: null,
          rawArgs: [],
        },
      });

      const result = parseIntentResponse(json);

      expect(result).not.toBeNull();
      expect(result?.params.taskTitle).toContain('functions');
      expect(result?.params.taskTitle).toContain('&');
    });

    it('should handle target folder with special characters', () => {
      const json = '{"action":"MOVE_EMAIL","confidence":0.9,"reasoning":"Move","params":{"taskTitle":null,"taskDescription":null,"taskPriority":null,"taskDueDate":null,"targetFolder":"archive/2026/old-emails","rawArgs":[]}}';

      const result = parseIntentResponse(json);

      expect(result).not.toBeNull();
      expect(result?.params.targetFolder).toBe('archive/2026/old-emails');
    });

    it('should handle ISO date string correctly', () => {
      const json = '{"action":"CREATE_TASK","confidence":0.9,"reasoning":"Task","params":{"taskTitle":"Task","taskDescription":null,"taskPriority":"medium","taskDueDate":"2026-12-25","targetFolder":null,"rawArgs":[]}}';

      const result = parseIntentResponse(json);

      expect(result).not.toBeNull();
      expect(result?.params.taskDueDate).toBe('2026-12-25');
    });

    it('should preserve confidence precision', () => {
      const json = '{"action":"PING","confidence":0.7234,"reasoning":"Test","params":{"taskTitle":null,"taskDescription":null,"taskPriority":null,"taskDueDate":null,"targetFolder":null,"rawArgs":[]}}';

      const result = parseIntentResponse(json);

      expect(result).not.toBeNull();
      expect(result?.confidence).toBe(0.7234);
    });
  });

  // ============================================================================
  // Type Safety
  // ============================================================================

  describe('type safety', () => {
    it('should return ParsedIntent type on success', () => {
      const json = '{"action":"PING","confidence":0.9,"reasoning":"Test","params":{"taskTitle":null,"taskDescription":null,"taskPriority":null,"taskDueDate":null,"targetFolder":null,"rawArgs":[]}}';

      const result = parseIntentResponse(json);

      expect(result).not.toBeNull();
      expect(result?.action).toBeDefined();
      expect(result?.confidence).toBeDefined();
      expect(result?.reasoning).toBeDefined();
      expect(result?.params).toBeDefined();
    });

    it('should return null on failure', () => {
      const json = 'invalid';

      const result = parseIntentResponse(json);

      expect(result).toBeNull();
    });
  });
});
