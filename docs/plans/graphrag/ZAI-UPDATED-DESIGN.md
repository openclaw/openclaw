# Updated Design Decisions & Architecture

**Date:** 2026-01-26
**Purpose:** Consolidate all architectural decisions from design review
**Status:** Final Design Specification

---

## Part 1: Model Abstraction Architecture

### 1.1 Pluggable Model Interface

All model interactions MUST go through pluggable interfaces to enable:
- Cloud vs local swapping (OpenAI ↔ Ollama)
- Cost vs performance trade-offs
- Model capability differences (structured output support)

**Location:** `src/models/`

```typescript
// models/model.interface.ts
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
}

export interface ModelConfig {
  /** Model identifier */
  model: string;
  /** API base URL (for local or alternate endpoints) */
  baseURL?: string;
  /** API key (if required) */
  apiKey?: string;
  /** Temperature for generation */
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

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolId?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface StructuredOutput<T> {
  success: boolean;
  data?: T;
  error?: string;
  raw?: string;
  fallbackUsed?: boolean;
}

/**
 * Core model interface for all LLM interactions
 */
export interface LanguageModel {
  /** Human-readable model name */
  readonly name: string;
  /** Model capabilities */
  readonly capabilities: ModelCapabilities;

  /**
   * Generate chat completion
   */
  chat(messages: ChatMessage[], options?: ModelConfig): Promise<string>;

  /**
   * Generate structured output with schema
   * - Attempts structured output first
   * - Falls back to delimiter parsing if structured output fails
   */
  structuredChat<T>(
    messages: ChatMessage[],
    schema: z.Schema<T>,
    examples?: T[],
    options?: ModelConfig
  ): Promise<StructuredOutput<T>>;

  /**
   * Generate embeddings for text
   */
  embed(text: string | string[]): Promise<number[][]>;

  /**
   * Stream chat completion
   */
  streamChat(
    messages: ChatMessage[],
    onChunk: (chunk: string) => void,
    options?: ModelConfig
  ): Promise<void>;
}
```

### 1.2 Model Registry

```typescript
// models/model-registry.ts
export interface ModelProvider {
  name: string;
  type: 'cloud' | 'local';
  createModel(config: ModelConfig): LanguageModel;
}

export class ModelRegistry {
  private providers = new Map<string, ModelProvider>();

  register(provider: ModelProvider): void {
    this.providers.set(provider.name, provider);
  }

  create(providerName: string, config: ModelConfig): LanguageModel {
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new Error(`Unknown model provider: ${providerName}`);
    }
    return provider.createModel(config);
  }

  // Pre-configured models
  static readonly MODELS = {
    // Cloud models
    openai: {
      provider: 'openai',
      defaultConfig: {
        model: 'gpt-4o',
        baseURL: 'https://api.openai.com/v1',
      },
    },
    gemini: {
      provider: 'gemini',
      defaultConfig: {
        model: 'gemini-2.0-flash-exp',
        baseURL: 'https://generativelanguage.googleapis.com/v1beta',
      },
    },

    // Local models
    ollama: {
      provider: 'ollama',
      defaultConfig: {
        model: 'deepseek-r1:7b',
        baseURL: 'http://localhost:11434/v1',
      },
    },
  };
}
```

### 1.3 OpenAI Provider Implementation

```typescript
// models/providers/openai-provider.ts
import OpenAI from 'openai';
import type { LanguageModel, ModelConfig, ChatMessage, StructuredOutput } from '../model.interface.js';

export class OpenAIModel implements LanguageModel {
  readonly name = 'OpenAI';
  readonly capabilities = {
    structuredOutput: true,
    maxInputTokens: 128000,
    maxOutputTokens: 4096,
    streaming: true,
    costPerMillionInputTokens: 2.50,
    costPerMillionOutputTokens: 10.00,
  };

  private client: OpenAI;

  constructor(private config: ModelConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey || process.env.OPENAI_API_KEY,
      baseURL: config.baseURL,
    });
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.config.model || 'gpt-4o',
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      temperature: this.config.temperature || 0,
    });
    return response.choices[0].message.content || '';
  }

  async structuredChat<T>(
    messages: ChatMessage[],
    schema: z.Schema<T>,
    examples?: T[]
  ): Promise<StructuredOutput<T>> {
    // Attempt 1: Structured output
    try {
      const response = await this.client.chat.completions.create({
        model: this.config.model || 'gpt-4o',
        messages: this.buildMessagesWithSchema(messages, schema, examples),
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'extraction',
            schema: this.zodToJSONSchema(schema),
          },
        } as any, // OpenAI types
      });

      const parsed = JSON.parse(response.choices[0].message.content || '{}');
      return {
        success: true,
        data: schema.parse(parsed),
      };
    } catch (error) {
      // Attempt 2: Delimiter fallback
      return this.delimiterFallback(messages, schema);
    }
  }

  private delimiterFallback<T>(messages: ChatMessage[], schema: z.Schema<T>): StructuredOutput<T> {
    // Re-prompt with delimiter format
    const delimiterMessages = [
      ...messages,
      {
        role: 'user' as const,
        content: this.buildDelimiterPrompt(schema),
      },
    ];

    return this.client.chat.completions.create({
      model: this.config.model || 'gpt-4o-mini', // Use cheaper model for retry
      messages: delimiterMessages,
    }).then(response => {
      const content = response.choices[0].message.content || '';
      const parsed = this.parseDelimiterOutput(content, schema);
      return {
        success: true,
        data: parsed,
        fallbackUsed: true,
      };
    }).catch(error => {
      return {
        success: false,
        error: error.message,
      };
    });
  }

  async embed(text: string | string[]): Promise<number[][]> {
    const response = await this.client.embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
    });
    return response.data.map(d => d.embedding);
  }

  private buildMessagesWithSchema<T>(
    messages: ChatMessage[],
    schema: z.Schema<T>,
    examples?: T[]
  ): ChatMessage[] {
    const schemaDef = this.zodToJSONSchema(schema);
    const examplesStr = examples
      ? `\n\nExamples of valid output:\n${JSON.stringify(examples[0], null, 2)}`
      : '';

    return [
      ...messages.slice(0, -1),
      {
        ...messages[messages.length - 1],
        content: `${messages[messages.length - 1].content}

Output must match this schema:
${JSON.stringify(schemaDef, null, 2)}${examplesStr}`,
      },
    ];
  }

  private zodToJSONSchema(schema: z.Schema): any {
    // Convert Zod schema to JSON Schema format
    // Implementation depends on zod-to-json-schema library
    return {};
  }

  private buildDelimiterPrompt<T>(schema: z.Schema<T>): string {
    return `
Output format (one per line):
  ("entity" | "<name>" | "<type>" | "<description>")
  ("relationship" | "<source>" | "<target>" | "<type>" | "<description>" | "<keywords>" | <strength 1-10>)
`;
  }

  private parseDelimiterOutput<T>(raw: string, schema: z.Schema<T>): T {
    // Parse delimiter format
    // Implementation from ZAI-DESIGN.md
    return {} as T;
  }
}
```

### 1.4 Ollama Provider Implementation

```typescript
// models/providers/ollama-provider.ts
import OpenAI from 'openai';
import type { LanguageModel, ModelConfig } from '../model.interface.js';

export class OllamaModel implements LanguageModel {
  readonly name = 'Ollama';
  readonly capabilities = {
    structuredOutput: true, // Ollama supports OpenAI-compatible API
    maxInputTokens: 32000,
    maxOutputTokens: 4096,
    streaming: true,
    costPerMillionInputTokens: 0, // Local = free
    costPerMillionOutputTokens: 0,
  };

  private client: OpenAI;

  constructor(private config: ModelConfig) {
    this.client = new OpenAI({
      baseURL: config.baseURL || 'http://localhost:11434/v1',
      apiKey: 'ollama', // Required by OpenAI client but not used by Ollama
    });
  }

  // Same interface as OpenAI, but uses local models
  async chat(messages: ChatMessage[]): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.config.model || 'deepseek-r1:7b',
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      temperature: this.config.temperature || 0,
    });
    return response.choices[0].message.content || '';
  }

  async structuredChat<T>(messages: ChatMessage[], schema: z.Schema<T>, examples?: T[]) {
    // Ollama supports structured output via OpenAI-compatible API
    // But with mixed results depending on model
    // Use same fallback strategy as OpenAI
    const openaiProvider = new OpenAIModel(this.config);
    return openaiProvider.structuredChat(messages, schema, examples);
  }

  async embed(text: string | string[]): Promise<number[][]> {
    // Use nomic-embed-text or similar local embedding model
    const response = await this.client.embeddings.create({
      model: 'nomic-embed-text',
      input: text,
    });
    return response.data.map(d => d.embedding);
  }
}
```

### 1.5 Configuration

```typescript
// config/types.models.ts
export type ModelTypeConfig = {
  models?: {
    /** Default model for chat/extraction */
    chat?: {
      provider: 'openai' | 'gemini' | 'ollama';
      model: string;
      baseURL?: string;
    };

    /** Model for embeddings (often local for throughput) */
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

**Example Configuration:**
```yaml
# config.yaml
models:
  chat:
    provider: openai
    model: gpt-4o
  embeddings:
    provider: ollama
    model: nomic-embed-text
    baseURL: http://localhost:11434/v1
  fast:
    provider: ollama
    model: deepseek-r1:7b
    baseURL: http://localhost:11434/v1
```

---

## Part 2: Hybrid Extraction Strategy

### 2.1 Multi-Stage Extraction

**Key Decision:** Use schema-based structured output first, fall back to delimiter parsing on failure.

```typescript
// knowledge/extraction/hybrid-extractor.ts
export class HybridExtractor {
  constructor(
    private model: LanguageModel,
    private fallbackModel?: LanguageModel  // Optional cheaper model for fallback
  ) {}

  async extractEntities(
    text: string,
    schema: z.Schema<EntityExtraction>,
    examples?: EntityExtraction[]
  ): Promise<StructuredOutput<EntityExtraction>> {
    // Stage 1: Try structured output with primary model
    const result = await this.model.structuredChat(
      [{ role: 'user', content: this.buildPrompt(text) }],
      schema,
      examples
    );

    if (result.success) {
      return result;
    }

    // Stage 2: Delimiter fallback
    this.logger.info('Structured output failed, using delimiter fallback');

    const fallbackModel = this.fallbackModel || this.model;
    return fallbackModel.structuredChat(
      [{ role: 'user', content: this.buildDelimiterPrompt(text) }],
      schema
    );
  }

  private buildPrompt(text: string): string {
    return `Extract entities and relationships from the following text.

${text}

Provide output in JSON format matching the provided schema.`;
  }

  private buildDelimiterPrompt(text: string): string {
    return `Extract entities and relationships from the following text.

Output format (one per line):
  ("entity" | "<name>" | "<type>" | "<description>")
  ("relationship" | "<source>" | "<target>" | "<type>" | "<description>" | "<keywords>" | <strength 1-10>)

---
${text}
---
Extract ALL entities and relationships.`;
  }
}
```

### 2.2 Retry Strategy

```typescript
// knowledge/extraction/retry-extractor.ts
export class RetryExtractor {
  async extractWithRetry<T>(
    text: string,
    schema: z.Schema<T>,
    maxAttempts: number = 3
  ): Promise<StructuredOutput<T>> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await this.extractor.extractEntities(text, schema);

        if (result.success) {
          if (attempt > 1) {
            this.logger.info(`Extraction succeeded on attempt ${attempt}`);
          }
          return result;
        }

        lastError = new Error(result.error || 'Unknown error');
      } catch (error) {
        lastError = error as Error;
      }

      // Backoff before retry
      if (attempt < maxAttempts) {
        await this.backoff(attempt * 1000);
      }
    }

    return {
      success: false,
      error: lastError?.message || 'Max retries exceeded',
    };
  }
}
```

---

## Part 3: Cost/Performance Pluggable Architecture

### 3.1 Strategy Pattern for Cost/Speed Decisions

```typescript
// knowledge/strategies/extraction-strategy.interface.ts
export interface ExtractionStrategy {
  /** Human-readable strategy name */
  readonly name: string;

  /** Estimated cost per 1K tokens (USD) */
  readonly estimatedCostPer1KTokens: number;

  /** Estimated latency (ms) */
  readonly estimatedLatency: number;

  /** Execute extraction */
  extract(text: string, options: ExtractionOptions): Promise<ExtractionResult>;
}

export type ExtractionOptions = {
  maxTokens?: number;
  temperature?: number;
  useCache?: boolean;
  priority?: 'cost' | 'speed' | 'quality';
};
```

### 3.2 Strategy Implementations

```typescript
// knowledge/strategies/cloud-quality-strategy.ts
export class CloudQualityStrategy implements ExtractionStrategy {
  readonly name = 'Cloud Quality';
  readonly estimatedCostPer1KTokens = 0.002;  // $2/1M tokens
  readonly estimatedLatency = 500;  // 500ms average

  constructor(private model: LanguageModel) {}

  async extract(text: string, options: ExtractionOptions): Promise<ExtractionResult> {
    return this.model.structuredChat(
      [{ role: 'user', content: text }],
      ENTITY_SCHEMA,
      EXAMPLES,
      { model: 'gpt-4o', temperature: 0 }
    );
  }
}
```

```typescript
// knowledge/strategies/local-speed-strategy.ts
export class LocalSpeedStrategy implements ExtractionStrategy {
  readonly name = 'Local Speed';
  readonly estimatedCostPer1KTokens = 0;  // Free
  readonly estimatedLatency = 200;  // 200ms on local machine

  constructor(private model: LanguageModel) {}

  async extract(text: string, options: ExtractionOptions): Promise<ExtractionResult> {
    return this.model.structuredChat(
      [{ role: 'user', content: text }],
      ENTITY_SCHEMA,
      EXAMPLES,
      { model: 'deepseek-r1:7b', temperature: 0 }
    );
  }
}
```

```typescript
// knowledge/strategies/hybrid-cost-optimized-strategy.ts
export class HybridCostOptimizedStrategy implements ExtractionStrategy {
  readonly name = 'Hybrid Cost Optimized';
  readonly estimatedCostPer1KTokens = 0.0005;  // $0.50/1M tokens
  readonly estimatedLatency = 350;

  constructor(
    private localModel: LanguageModel,
    private cloudModel: LanguageModel
  ) {}

  async extract(text: string, options: ExtractionOptions): Promise<ExtractionResult> {
    // Try local first (free, fast)
    const localResult = await this.localModel.structuredChat(
      [{ role: 'user', content: text }],
      ENTITY_SCHEMA
    );

    if (localResult.success) {
      return localResult;
    }

    // Fall back to cloud if local fails
    this.logger.info('Local extraction failed, using cloud fallback');
    return this.cloudModel.structuredChat(
      [{ role: 'user', content: text }],
      ENTITY_SCHEMA,
      EXAMPLES,
      { model: 'gpt-4o-mini' }  // Cheaper cloud model
    );
  }
}
```

### 3.3 Strategy Selector

```typescript
// knowledge/strategies/strategy-selector.ts
export class StrategySelector {
  private strategies = new Map<string, ExtractionStrategy>();

  register(name: string, strategy: ExtractionStrategy): void {
    this.strategies.set(name, strategy);
  }

  select(options: ExtractionOptions): ExtractionStrategy {
    const { priority = 'quality' } = options;

    switch (priority) {
      case 'cost':
        return this.strategies.get('local-speed') ||
               this.strategies.get('hybrid-cost') ||
               this.strategies.get('cloud-quality')!;

      case 'speed':
        return this.strategies.get('local-speed') ||
               this.strategies.get('hybrid-cost') ||
               this.strategies.get('cloud-quality')!;

      case 'quality':
      default:
        return this.strategies.get('cloud-quality') ||
               this.strategies.get('hybrid-cost') ||
               this.strategies.get('local-speed')!;
    }
  }
}
```

---

## Part 4: Visualization Framework Decision

### 4.1 Decision: React Flow for Knowledge Graph Visualization

**Official Decision:** React Flow will be used for all knowledge graph visualization in Clawdbot.

**Rationale:**

1. **Native React Integration**
   - Clawdbot's web and desktop UIs are React-based
   - No wrapper layer or compatibility layer needed
   - Direct integration with existing React components

2. **Interactive Features**
   - Drag-and-drop entity repositioning
   - Mini-map for navigation
   - Built-in zoom/fit controls
   - Smooth animations and transitions

3. **Developer Experience**
   - Excellent TypeScript support
   - Comprehensive documentation with examples
   - Active community (23K GitHub stars, 500K weekly NPM downloads)
   - Regular updates and responsive maintainers

4. **Performance Characteristics**
   - Optimized for graphs with <1000 visible nodes
   - Typical knowledge graph visualizations fit this profile
   - Efficient SVG-based rendering

5. **Community Ecosystem**
   - react-flow-background: Background patterns
   - react-flow-controls: Enhanced zoom/fit controls
   - react-flow-minimap: Mini-map navigation
   - react-flow-extra: Additional node types and patterns

**React Flow Capabilities for Knowledge Graphs:**

**Core Features:**
- Force-directed layout algorithm (built-in)
- Custom node components using React
- Animated edges for relationships
- Selection and highlighting
- Zoom, pan, and fit-to-view

**Advanced Features:**
- Background patterns for visual context
- Mini-map for large graph navigation
- Custom edge types with animations
- Node and edge styling via CSS
- Event handling (click, hover, drag)

**Performance Characteristics:**
- Handles up to ~500-1000 visible nodes smoothly
- Rendering degrades gracefully with larger graphs
- Performance scales with viewport size (nodes visible)

**Migration Considerations:**

**Current UI Architecture:**
The existing Clawdbot UI uses Lit (web components). React Flow can be integrated via:

1. **Web Components Bridge:** Wrap React Flow components as web components
2. **Partial Migration:** Migrate knowledge graph section to React
3. **iframe Isolation:** Render React Flow in isolated iframe

**Recommended Approach:** Start with web components bridge, evaluate full React migration based on performance.

**When to Reconsider:**

**React Flow Remains Optimal For:**
- Interactive graph exploration
- Visual editing workflows
- Knowledge graphs with <1000 visible entities
- Force-directed layouts

**Consider Alternative Frameworks If:**
- Graph grows to >2000 visible nodes (AntV G6 for better performance)
- Need 3D visualization capabilities (AntV G6)
- Need advanced graph algorithms (centrality, community detection)
- Bioinformatics/scientific research use cases

**Recommendation: Use React Flow for Clawdbot's knowledge graph visualization**

**Rationale:**

1. **React-Native Integration**
   - Clawdbot's UI is React-based (apps/macos, apps/web if exists)
   - Native React integration reduces complexity
   - No wrapper layer needed

2. **Interactive Requirements**
   - Need drag-and-drop for entity repositioning
   - Need mini-map for navigation
   - Need zoom/fit controls
   - React Flow has these built-in

3. **Developer Experience**
   - Excellent TypeScript support
   - Great documentation with examples
   - Active community (23K stars, 500K weekly downloads)
   - Regular updates

4. **Graph Size**
   - Knowledge graphs typically < 500 entities visible at once
   - React Flow handles this well
   - If >1000 nodes needed, can reconsider G6

5. **Community Ecosystem**
   - react-flow-extra: Additional node types
   - Multiple background and control plugins
   - Active Discord community

**When to Reconsider:**
- Graph grows to >2000 visible nodes
- Need 3D visualization
- Need advanced graph algorithms (centrality, clustering)

### 4.2 Implementation

**Location:** `src/knowledge/viz/` or `ui/src/ui/components/graph/`

```typescript
// knowledge/viz/graph-visualization.tsx
import ReactFlow, {
  Node,
  Edge,
  Background,
  Controls,
  MiniMap,
} from 'reactflow';
import 'reactflow/dist/style.css';

export interface GraphVisualizationProps {
  entities: Entity[];
  relationships: Relationship[];
  onEntityClick?: (entity: Entity) => void;
  onRelationshipClick?: (relationship: Relationship) => void;
}

export function GraphVisualization({
  entities,
  relationships,
  onEntityClick,
  onRelationshipClick,
}: GraphVisualizationProps) {
  // Convert entities to React Flow nodes
  const nodes: Node[] = entities.map(entity => ({
    id: entity.id,
    type: 'custom', // Custom node component
    position: { x: entity.x || 0, y: entity.y || 0 },
    data: {
      label: entity.name,
      type: entity.type,
      description: entity.description,
    },
  }));

  // Convert relationships to React Flow edges
  const edges: Edge[] = relationships.map(rel => ({
    id: rel.id,
    source: rel.sourceEntityId,
    target: rel.targetEntityId,
    label: rel.type,
    type: 'smoothstep', // Animated edge
    animated: true,
    data: rel,
  }));

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodeClick={(event, node) => onEntityClick?.(node.data as Entity)}
        onEdgeClick={(event, edge) => onRelationshipClick?.(edge.data as Relationship)}
        fitView
      >
        <Background />
        <Controls />
        <MiniMap />
      </ReactFlow>
    </div>
  );
}
```

**Custom Node Component:**

```typescript
// knowledge/viz/entity-node.tsx
export function EntityNode({ data }: NodeProps) {
  const entity = data as Entity;

  return (
    <div
      className={cn(
        'px-4 py-2 rounded-lg border-2 shadow-md',
        'bg-white dark:bg-gray-800',
        'border-gray-300 dark:border-gray-600',
        'hover:border-blue-500 dark:hover:border-blue-400',
        'transition-colors'
      )}
    >
      <div className="font-semibold text-sm">{entity.name}</div>
      <div className="text-xs text-gray-500 dark:text-gray-400">
        {entity.type}
      </div>
      {entity.description && (
        <div className="text-xs text-gray-400 dark:text-gray-500 mt-1">
          {entity.description.slice(0, 50)}...
        </div>
      )}
    </div>
  );
}
```

### 4.5 Node Types Configuration

```typescript
// knowledge/viz/node-types.ts
import { NodeTypes } from 'reactflow';

const nodeTypes: NodeTypes = {
  custom: EntityNode,
  person: PersonNode,
  organization: OrganizationNode,
  concept: ConceptNode,
};

export { nodeTypes };
```

---

## Part 5: Updated Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLAWDBOT                                     │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                        Application Layer                            │  │
│  │  (CLI, Web UI, macOS App, Mobile Apps)                             │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                      │                                     │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                        Model Abstraction Layer                      │  │
│  │                                                                       │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │  │
│  │  │ Chat Model   │  │ Embed Model  │  │ Fast Model   │              │  │
│  │  │              │  │              │  │              │              │  │
│  │  │ OpenAI/Gemini│  │ Local Ollama │  │ Local/Cheap  │              │  │
│  │  │              │  │              │  │              │              │  │
│  │  │ Structured   │  │ High         │  │ Cost         │              │  │
│  │  │ + Fallback   │  │ Throughput   │  │ Optimized   │              │  │
│  │  └──────────────┘  └──────────────┘  └──────────────┘              │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                      │                                     │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                     Knowledge Graph Layer                           │  │
│  │                                                                       │  │
│  │  ┌─────────────────┐  ┌──────────────┐  ┌────────────────┐           │  │
│  │  │ Hybrid Extractor│  │ Consolidator │  │ Graph Query   │           │  │
│  │  │                 │  │              │  │ Engine        │           │  │
│  │  │ Schema-first    │  │ 3-tier dedup │  │ SQLite CTEs   │           │  │
│  │  │ Delimiter fallback│  │             │  │               │           │  │
│  │  └─────────────────┘  └──────────────┘  └────────────────┘           │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                      │                                     │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                    Storage Layer (Pluggable)                        │  │
│  │                                                                       │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │  │
│  │  │ SQLite       │  │ PostgreSQL   │  │ Future...    │              │  │
│  │  │ (Default)    │  │ (Production) │  │              │              │  │
│  │  │              │  │              │  │              │              │  │
│  │  │ Embedded     │  │ Scalable     │  │              │              │  │
│  │  │ Zero-config  │  │ High concur. │  │              │              │  │
│  │  └──────────────┘  └──────────────┘  └──────────────┘              │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Part 6: Updated Configuration Schema

```typescript
// config/types.ts
export type ClawdbotConfig = {
  // Model configuration
  models?: {
    chat?: {
      provider: 'openai' | 'gemini' | 'ollama';
      model: string;
      baseURL?: string;
      fallback?: {
        provider: 'openai' | 'gemini' | 'ollama';
        model: string;
      };
    };
    embeddings?: {
      provider: 'openai' | 'gemini' | 'ollama';
      model: string;
      baseURL?: string;
    };
    fast?: {
      provider: 'openai' | 'gemini' | 'ollama';
      model: string;
      baseURL?: string;
    };
  };

  // Datastore configuration
  datastore?: {
    type: 'sqlite' | 'postgresql';
    sqlite?: {
      path: string;
      wal?: boolean;
    };
    postgresql?: {
      connectionString?: string;
      host?: string;
      port?: number;
      database?: string;
      user?: string;
      password?: string;
      poolSize?: number;
    };
  };

  // Knowledge graph configuration
  knowledge?: {
    enabled: boolean;
    extraction?: {
      strategy: 'cloud-quality' | 'local-speed' | 'hybrid-cost';
      priority?: 'cost' | 'speed' | 'quality';
      maxRetries?: number;
      delimiterFallback?: boolean;
    };
    consolidation?: {
      fuzzyThreshold?: number;
      editDistanceThreshold?: number;
      llmConfirm?: boolean;
    };
    retrieval?: {
      graphExpansion?: boolean;
      maxHops?: number;
      maxChunks?: number;
      minGraphScore?: number;
    };
  };

  // Visualization configuration
  visualization?: {
    framework?: 'react-flow' | 'cytoscape' | 'g6';
    layout?: 'force' | 'hierarchical' | 'circular';
    maxNodes?: number;
  };
};
```

**Example Configuration:**

```yaml
# config.yaml
models:
  chat:
    provider: openai
    model: gpt-4o
    fallback:
      provider: ollama
      model: deepseek-r1:7b
      baseURL: http://localhost:11434/v1
  embeddings:
    provider: ollama
    model: nomic-embed-text
    baseURL: http://localhost:11434/v1
  fast:
    provider: ollama
    model: deepseek-r1:7b
    baseURL: http://localhost:11434/v1

datastore:
  type: sqlite
  sqlite:
    path: ~/.clawdbot/memory.db
    wal: true

knowledge:
  enabled: true
  extraction:
    strategy: hybrid-cost
    priority: quality
    maxRetries: 3
    delimiterFallback: true
  consolidation:
    fuzzyThreshold: 0.92
    editDistanceThreshold: 3
    llmConfirm: true
  retrieval:
    graphExpansion: true
    maxHops: 1
    maxChunks: 4
    minGraphScore: 0.3

visualization:
  framework: react-flow
  layout: force
  maxNodes: 500
```

---

## Part 7: Summary of Updated Decisions

### 7.1 Model Abstraction

**Decision:** All model access goes through `LanguageModel` interface

**Benefits:**
- Cloud ↔ Local swapping (OpenAI ↔ Ollama)
- Cost vs performance optimization
- Consistent API across providers
- Easy testing with mock models

### 7.2 Hybrid Extraction

**Decision:** Schema-based structured output with delimiter fallback

**Approach:**
1. Try structured output first (most models support it)
2. Fall back to delimiter parsing if structured output fails
3. Use cheaper/faster model for fallback if available

**Benefits:**
- Best of both worlds
- Reliable extraction
- Token-efficient when needed
- Works with any model

### 7.3 Cost/Performance Pluggability

**Decision:** Strategy pattern for extraction operations

**Implementation:**
- `CloudQualityStrategy`: GPT-4o, high quality, higher cost
- `LocalSpeedStrategy`: Ollama, free, fast
- `HybridCostOptimizedStrategy`: Local first, cloud fallback

**Benefits:**
- Isolated cost/speed decisions
- Easy to add new strategies
- Runtime selection based on priority
- Transparent cost tracking

### 7.4 Visualization Framework

**Decision:** React Flow for knowledge graph visualization

**Rationale:**
- Native React integration
- Best-in-class interactive features
- Great TypeScript support
- Active community (23K stars)
- Optimized for our use case (<500 visible nodes)

**Alternatives Considered:**
- Cytoscape.js: Better for research, complex algorithms
- G6: Better for large-scale graphs, 3D visualization

**Re-evaluate if:**
- Graph grows to >2000 visible nodes
- Need 3D visualization
- Need advanced graph algorithms

---

## Part 8: Implementation Priority

### Phase 1: Model Abstraction (Week 1)
1. Create `LanguageModel` interface
2. Implement OpenAI provider
3. Implement Ollama provider
4. Create model registry
5. Add configuration schema

### Phase 2: Hybrid Extraction (Week 2)
1. Implement schema-based extraction
2. Add delimiter fallback parser
3. Implement retry logic
4. Add cost tracking
5. Write tests for both extraction modes

### Phase 3: Strategy Pattern (Week 2)
1. Define strategy interfaces
2. Implement cloud quality strategy
3. Implement local speed strategy
4. Implement hybrid cost strategy
5. Add strategy selector

### Phase 4: Visualization (Week 3)
1. Install React Flow
2. Create basic graph visualization
3. Implement custom node components
4. Add interactive features (zoom, mini-map)
5. Integrate with graph queries

---

## Conclusion

This updated design incorporates:

1. **Pluggable model abstraction** - Easy cloud/local swapping
2. **Hybrid extraction** - Schema-based with delimiter fallback
3. **Cost/speed strategies** - Isolated, swappable implementations
4. **React Flow visualization** - Best-in-class for our use case

All decisions prioritize:
- **Flexibility** - Easy to swap implementations
- **Simplicity** - Minimal code changes to add options
- **Performance** - Local models where appropriate
- **Cost optimization** - Strategic use of cloud vs local

The architecture supports evolution from simple (SQLite, local models) to production (PostgreSQL, cloud models) without major rewrites.

---

## Sources

### Model Abstraction
- [OpenAI API Documentation](https://platform.openai.com/docs)
- [Ollama OpenAI Compatibility](https://ollama.com/blog/openai-compatibility)

### Visualization Frameworks
- [React Flow](https://reactflow.dev/)
- [Cytoscape.js](http://js.cytoscape.org/)
- [AntV G6](https://g6.antv.vision/)
- [npm trends comparison](https://npmtrends.com/@antv/g6-vs-cytoscape-vs-d3.js-vs-diagram-js)
- [React Flow GitHub](https://github.com/xyflow/xyflow)
- [Cytoscape.js GitHub](https://github.com/cytoscape/cytoscape.js)
- [AntV G6 GitHub](https://github.com/antvis/G6)
- [Medium - Top 15 Visualization Libraries 2025](https://medium.com/lets-code-future/top-15-visualization-libraries-every-developer-should-know-in-2025-c20f0b62e63c)
- [Linkurious - JS Graph Libraries](https://linkurious.com/blog/top-javascript-graph-libraries/)
