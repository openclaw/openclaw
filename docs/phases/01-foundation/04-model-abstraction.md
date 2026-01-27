# Phase 1, Task 04: Pluggable Model Abstraction

**Phase:** 1 - Foundation (Graph Storage + Entity Extraction Core)
**Task:** Implement pluggable LanguageModel interface for LLM providers
**Duration:** 2 days
**Complexity:** Medium
**Depends on:** None (can be done in parallel)

---

## Task Overview

Create a pluggable model abstraction layer that supports:
- Multiple LLM providers (OpenAI, Gemini, Ollama)
- Structured output with delimiter fallback
- Cloud vs local model swapping
- Cost tracking and optimization

## Architecture Decision

**Reference:** Part 1 of `docs/plans/graphrag/ZAI-UPDATED-DESIGN.md`

## File Structure

```
src/models/
├── interface.ts           # Core LanguageModel interface
├── registry.ts            # Model provider registry
├── providers/
│   ├── openai.ts         # OpenAI provider
│   ├── gemini.ts         # Google Gemini provider
│   └── ollama.ts         # Ollama (local) provider
└── types.ts              # Shared types
```

## Core Interface

**File:** `src/models/interface.ts`

```typescript
/**
 * Pluggable model abstraction for LLM interactions.
 *
 * Supports:
 * - Multiple providers (OpenAI, Gemini, Ollama)
 * - Structured output with delimiter fallback
 * - Streaming responses
 * - Embeddings
 * - Cost tracking
 *
 * Reference: docs/plans/graphrag/ZAI-UPDATED-DESIGN.md Part 1
 */

import { z } from 'zod';

// ============================================================================
// CAPABILITIES
// ============================================================================

export interface ModelCapabilities {
  /** Supports structured output / function calling */
  structuredOutput: boolean;
  /** Maximum input tokens */
  maxInputTokens: number;
  /** Maximum output tokens */
  maxOutputTokens: number;
  /** Supports streaming responses */
  streaming: boolean;
  /** Estimated cost per 1M input tokens (USD) */
  costPerMillionInputTokens: number;
  /** Estimated cost per 1M output tokens (USD) */
  costPerMillionOutputTokens: number;
  /** Supports embeddings */
  embeddings: boolean;
}

// ============================================================================
// CONFIG
// ============================================================================

export interface ModelConfig {
  /** Model identifier (e.g., 'gpt-4o', 'gemini-2.0-flash-exp') */
  model: string;
  /** API base URL (for local or alternate endpoints) */
  baseURL?: string;
  /** API key (if required) */
  apiKey?: string;
  /** Temperature for generation (0-2) */
  temperature?: number;
  /** Maximum tokens to generate */
  maxTokens?: number;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Retry configuration */
  retry?: {
    maxAttempts: number;
    backoffMs: number;
  };
}

// ============================================================================
// MESSAGES
// ============================================================================

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: MessageRole;
  content: string;
  toolCalls?: ToolCall[];
  toolId?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

// ============================================================================
// STRUCTURED OUTPUT
// ============================================================================

export interface StructuredOutput<T> {
  success: boolean;
  data?: T;
  error?: string;
  raw?: string;
  fallbackUsed?: boolean;
  attempts?: number;
}

// ============================================================================
// CORE MODEL INTERFACE
// ============================================================================

/**
 * Core model interface for all LLM interactions.
 *
 * All model providers must implement this interface.
 */
export interface LanguageModel {
  /** Human-readable model name */
  readonly name: string;

  /** Model capabilities */
  readonly capabilities: ModelCapabilities;

  /** Default configuration */
  readonly defaultConfig: ModelConfig;

  /**
   * Generate a chat completion.
   *
   * @param messages - Array of chat messages
   * @param options - Optional model configuration overrides
   * @returns The generated text response
   */
  chat(messages: ChatMessage[], options?: ModelConfig): Promise<string>;

  /**
   * Generate structured output with schema validation.
   *
   * Strategy:
   * 1. Try structured output (JSON schema / function calling)
   * 2. Fall back to delimiter parsing if structured output fails
   *
   * @param messages - Array of chat messages
   * @param schema - Zod schema for validation
   * @param examples - Optional few-shot examples
   * @param options - Optional model configuration overrides
   * @returns Structured output with validation result
   */
  structuredChat<T>(
    messages: ChatMessage[],
    schema: z.Schema<T>,
    examples?: T[],
    options?: ModelConfig
  ): Promise<StructuredOutput<T>>;

  /**
   * Generate embeddings for text.
   *
   * @param text - Single text or array of texts
   * @returns Array of embedding vectors
   */
  embed(text: string | string[]): Promise<number[][]>;

  /**
   * Stream chat completion with callbacks.
   *
   * @param messages - Array of chat messages
   * @param onChunk - Callback for each chunk of text
   * @param options - Optional model configuration overrides
   */
  streamChat(
    messages: ChatMessage[],
    onChunk: (chunk: string) => void,
    options?: ModelConfig
  ): Promise<void>;

  /**
   * Count tokens in a message array (for cost tracking).
   *
   * @param messages - Array of chat messages
   * @returns Estimated token count
   */
  countTokens(messages: ChatMessage[]): number;
}

// ============================================================================
// PROVIDER INTERFACE
// ============================================================================

export interface ModelProvider {
  /** Provider name (e.g., 'openai', 'gemini', 'ollama') */
  name: string;

  /** Provider type (cloud vs local) */
  type: 'cloud' | 'local';

  /**
   * Create a model instance from configuration.
   */
  createModel(config: ModelConfig): LanguageModel;

  /**
   * Get available models from this provider.
   */
  getAvailableModels(): string[];

  /**
   * Check if the provider is available (API key, network, etc.).
   */
  isAvailable(): Promise<boolean>;
}

// ============================================================================
// MODEL REGISTRY
// ============================================================================

export class ModelRegistry {
  private providers = new Map<string, ModelProvider>();

  register(provider: ModelProvider): void {
    this.providers.set(provider.name, provider);
  }

  get(name: string): ModelProvider | undefined {
    return this.providers.get(name);
  }

  listProviders(): ModelProvider[] {
    return Array.from(this.providers.values());
  }

  async create(providerName: string, config: ModelConfig): Promise<LanguageModel> {
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new Error(`Unknown model provider: ${providerName}`);
    }

    if (!(await provider.isAvailable())) {
      throw new Error(`Model provider not available: ${providerName}`);
    }

    return provider.createModel(config);
  }
}

// ============================================================================
// DELIMITER PARSING
// ============================================================================

/**
 * Parse delimiter-format entity extraction output.
 *
 * Format:
 *   ("entity" | "<name>" | "<type>" | "<description>")
 *   ("relationship" | "<source>" | "<target>" | "<type>" | "<description>" | "<keywords>" | <strength>)
 */
export interface DelimiterParserOptions {
  /** Record delimiter */
  recordDelimiter?: string;
  /** Field delimiter */
  fieldDelimiter?: string;
  /** Allow partial records (for error recovery) */
  allowPartial?: boolean;
}

export function parseDelimiterOutput(
  raw: string,
  options: DelimiterParserOptions = {}
): { entities: any[]; relationships: any[] } {
  const {
    recordDelimiter = '\\n',
    fieldDelimiter = '\\|',
    allowPartial = false,
  } = options;

  const lines = raw.split(recordDelimiter);
  const entities: any[] = [];
  const relationships: any[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      // Parse parenthesized tuple format
      const match = line.match(/^\\("([^"]+)"\\s*\\|\\s*"([^"]+)"\\s*\\|\\s*"([^"]+)"/);
      if (!match) continue;

      const [, type, field1, field2] = match;

      if (type === 'entity') {
        const nameMatch = line.match(/"([^"]+)"\\s*\\|\\s*"([^"]+)"\\s*\\|\\s*"([^"]+)"\\s*\\|\\s*"([^"]+)"/);
        if (nameMatch) {
          entities.push({
            name: nameMatch[1],
            type: nameMatch[2],
            description: nameMatch[3],
          });
        }
      } else if (type === 'relationship') {
        // Parse relationship tuple
        const relMatch = line.match(
          /"relationship"\\s*\\|\\s*"([^"]+)"\\s*\\|\\s*"([^"]+)"\\s*\\|\\s*"([^"]+)"\\s*\\|\\s*"([^"]*)"\\s*\\|\\s*\\[?([^\\]]*)\\]?\\s*\\|\\s*(\\d+)/
        );
        if (relMatch) {
          relationships.push({
            source: relMatch[1],
            target: relMatch[2],
            type: relMatch[3],
            description: relMatch[4],
            keywords: relMatch[5] ? relMatch[5].split(',').map((s: string) => s.trim()) : [],
            strength: parseInt(relMatch[6], 10),
          });
        }
      }
    } catch (error) {
      if (!allowPartial) {
        throw new Error(`Failed to parse delimiter output line: ${line}`);
      }
      // Skip malformed lines if allowPartial is true
    }
  }

  return { entities, relationships };
}

/**
 * Build a delimiter-format extraction prompt.
 */
export function buildDelimiterPrompt(instructions: string): string {
  return `${instructions}

Output format (one tuple per line):
  ("entity" | "<name>" | "<type>" | "<description>")
  ("relationship" | "<source>" | "<target>" | "<type>" | "<description>" | "<keyword1,keyword2>" | <strength 1-10>)

Example:
  ("entity" | "Auth Service" | "concept" | "Handles JWT authentication")
  ("entity" | "Redis" | "tool" | "In-memory data store")
  ("relationship" | "Auth Service" | "Redis" | "uses" | "Auth Service uses Redis for caching" | "uses,caching" | 8)

Extract ALL entities and relationships from the text above.`;
}

// ============================================================================
// ZOD TO JSON SCHEMA CONVERSION
// ============================================================================

/**
 * Convert a Zod schema to JSON Schema format.
 * Used for structured output with models that support JSON Schema.
 */
export function zodToJSONSchema(schema: z.ZodTypeAny): any {
  const zodType = schema._def;

  switch (zodType.typeName) {
    case 'ZodString':
      return { type: 'string' };
    case 'ZodNumber':
      return { type: 'number' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodArray':
      return {
        type: 'array',
        items: zodToJSONSchema(zodType.type),
      };
    case 'ZodObject': {
      const properties: Record<string, any> = {};
      const required: string[] = [];

      for (const [key, value] of Object.entries(zodType.shape())) {
        properties[key] = zodToJSONSchema(value as z.ZodTypeAny);
        if (!(value as any)._def.optional) {
          required.push(key);
        }
      }

      return {
        type: 'object',
        properties,
        required: required.length > 0 ? required : undefined,
      };
    }
    case 'ZodOptional':
      return zodToJSONSchema(zodType.innerType());
    case 'ZodEnum':
      return {
        type: 'string',
        enum: zodType.values,
      };
    default:
      return { type: 'string' };
  }
}
```

## OpenAI Provider

**File:** `src/models/providers/openai.ts`

```typescript
/**
 * OpenAI provider implementation.
 */

import OpenAI from 'openai';
import type {
  LanguageModel,
  ModelConfig,
  ModelCapabilities,
  ChatMessage,
  StructuredOutput,
} from '../interface.js';
import { zodToJSONSchema, buildDelimiterPrompt, parseDelimiterOutput } from '../interface.js';

export class OpenAIModel implements LanguageModel {
  readonly name = 'OpenAI';
  readonly capabilities: ModelCapabilities;
  readonly defaultConfig: ModelConfig;

  private client: OpenAI;

  constructor(config: ModelConfig = {}) {
    this.client = new OpenAI({
      apiKey: config.apiKey || process.env.OPENAI_API_KEY,
      baseURL: config.baseURL,
    });

    this.capabilities = {
      structuredOutput: true,
      maxInputTokens: 128000,
      maxOutputTokens: 4096,
      streaming: true,
      costPerMillionInputTokens: 2.50,
      costPerMillionOutputTokens: 10.00,
      embeddings: true,
    };

    this.defaultConfig = {
      model: 'gpt-4o',
      temperature: 0,
      maxTokens: 4096,
      timeout: 30000,
      retry: {
        maxAttempts: 3,
        backoffMs: 1000,
      },
      ...config,
    };
  }

  async chat(messages: ChatMessage[], options?: ModelConfig): Promise<string> {
    const config = { ...this.defaultConfig, ...options };

    const response = await this.client.chat.completions.create({
      model: config.model,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
      temperature: config.temperature,
      max_tokens: config.maxTokens,
    });

    return response.choices[0]?.message?.content || '';
  }

  async structuredChat<T>(
    messages: ChatMessage[],
    schema: import('zod').ZodSchema<T>,
    examples?: T[],
    options?: ModelConfig
  ): Promise<StructuredOutput<T>> {
    const config = { ...this.defaultConfig, ...options };
    let attempts = 0;
    const maxAttempts = config.retry?.maxAttempts || 3;

    while (attempts < maxAttempts) {
      attempts++;

      try {
        // Attempt 1: Structured output with JSON Schema
        if (attempts === 1) {
          const response = await this.client.chat.completions.create({
            model: config.model,
            messages: this.buildMessagesWithSchema(messages, schema, examples),
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'extraction',
                schema: zodToJSONSchema(schema),
              },
            } as any,
            temperature: config.temperature || 0,
          });

          const raw = response.choices[0]?.message?.content || '';
          const parsed = JSON.parse(raw);
          const validated = schema.safeParse(parsed);

          if (validated.success) {
            return {
              success: true,
              data: validated.data,
              raw,
              attempts,
            };
          }
        }

        // Attempt 2: Delimiter fallback
        if (attempts === 2) {
          const delimiterPrompt = this.buildDelimiterPrompt(messages, schema);
          const response = await this.client.chat.completions.create({
            model: config.model || 'gpt-4o-mini',  // Use cheaper model for fallback
            messages: [
              ...messages.slice(0, -1),
              { role: 'user', content: delimiterPrompt },
            ],
            temperature: 0,
          });

          const raw = response.choices[0]?.message?.content || '';
          const parsed = this.parseDelimiterOutput(raw, schema);

          const validated = schema.safeParse(parsed);
          if (validated.success) {
            return {
              success: true,
              data: validated.data,
              raw,
              fallbackUsed: true,
              attempts,
            };
          }
        }
      } catch (error) {
        // Continue to next attempt
      }

      // Backoff before retry
      if (attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, config.retry?.backoffMs || 1000));
      }
    }

    return {
      success: false,
      error: `Failed after ${attempts} attempts`,
      attempts,
    };
  }

  async embed(text: string | string[]): Promise<number[][]> {
    const response = await this.client.embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
    });

    return response.data.map(d => d.embedding);
  }

  async streamChat(
    messages: ChatMessage[],
    onChunk: (chunk: string) => void,
    options?: ModelConfig
  ): Promise<void> {
    const config = { ...this.defaultConfig, ...options };

    const stream = await this.client.chat.completions.create({
      model: config.model,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        onChunk(content);
      }
    }
  }

  countTokens(messages: ChatMessage[]): number {
    // Rough estimate: ~4 characters per token
    const total = messages.reduce((sum, m) => sum + m.content.length, 0);
    return Math.ceil(total / 4);
  }

  // Private helpers

  private buildMessagesWithSchema<T>(
    messages: ChatMessage[],
    schema: import('zod').ZodSchema<T>,
    examples?: T[]
  ): ChatMessage[] {
    const jsonSchema = zodToJSONSchema(schema);
    const examplesStr = examples
      ? `\n\nExamples of valid output:\n${JSON.stringify(examples[0], null, 2)}`
      : '';

    return [
      ...messages.slice(0, -1),
      {
        ...messages[messages.length - 1],
        content: `${messages[messages.length - 1].content}

Output must match this schema:
${JSON.stringify(jsonSchema, null, 2)}${examplesStr}`,
      },
    ];
  }

  private buildDelimiterPrompt<T>(
    messages: ChatMessage[],
    schema: import('zod').ZodSchema<T>
  ): string {
    const lastMessage = messages[messages.length - 1];
    return buildDelimiterPrompt(lastMessage.content);
  }

  private parseDelimiterOutput<T>(raw: string, schema: import('zod').ZodSchema<T>): T {
    const result = parseDelimiterOutput(raw);
    return result as any;  // Will be validated by schema
  }
}
```

## Configuration Schema

**Add to:** `src/config/types.ts`

```typescript
export type ModelsConfig = {
  models?: {
    /** Default model for chat/extraction */
    chat?: {
      provider: 'openai' | 'gemini' | 'ollama';
      model: string;
      baseURL?: string;
      fallback?: {
        provider: 'openai' | 'gemini' | 'ollama';
        model: string;
      };
    };

    /** Model for embeddings */
    embeddings?: {
      provider: 'openai' | 'gemini' | 'ollama';
      model: string;
      baseURL?: string;
    };

    /** Model for small/fast operations */
    fast?: {
      provider: 'openai' | 'gemini' | 'ollama';
      model: string;
      baseURL?: string;
    };
  };
};
```

## Dependencies

```bash
pnpm add openai zod
```

## Testing

**File:** `src/models/interface.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { OpenAIModel } from './providers/openai.js';

describe('LanguageModel Interface', () => {
  it('should implement all required methods', () => {
    const model = new OpenAIModel();
    expect(model.chat).toBeDefined();
    expect(model.structuredChat).toBeDefined();
    expect(model.embed).toBeDefined();
    expect(model.streamChat).toBeDefined();
    expect(model.countTokens).toBeDefined();
  });

  it('should have capabilities', () => {
    const model = new OpenAIModel();
    expect(model.capabilities.structuredOutput).toBe(true);
    expect(model.capabilities.streaming).toBe(true);
    expect(model.capabilities.embeddings).toBe(true);
  });

  it('should count tokens', () => {
    const model = new OpenAIModel();
    const messages = [
      { role: 'user' as const, content: 'Hello world' },
    ];
    const count = model.countTokens(messages);
    expect(count).toBeGreaterThan(0);
  });
});
```

## Success Criteria

- [ ] LanguageModel interface defined
- [ ] OpenAI provider implements all methods
- [ ] Structured output with delimiter fallback works
- [ ] Embeddings functional
- [ ] Configuration schema added
- [ ] Tests pass

## References

- Design: `docs/plans/graphrag/ZAI-UPDATED-DESIGN.md` Part 1
- OpenAI API: https://platform.openai.com/docs
- Zod: https://zod.dev/

## Next Task

Proceed to `05-hybrid-extractor.md` to implement entity extraction pipeline.
