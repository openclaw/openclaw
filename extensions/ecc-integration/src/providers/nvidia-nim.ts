/**
 * NVIDIA NIM Provider
 * 
 * Integration with NVIDIA's free NIM (NVIDIA Inference Microservices) API.
 * Provides access to state-of-the-art models with reasoning capabilities.
 * 
 * API Base: https://integrate.api.nvidia.com/v1
 * Format: OpenAI-compatible
 * 
 * Supported Models:
 * - qwen/qwen3.5-397b-a17b (397B parameters, reasoning)
 * - z-ai/glm5 (Large reasoning model)
 * - z-ai/glm4.7 (Reasoning + content)
 * - moonshotai/kimi-k2.5 (Thinking mode)
 * - moonshotai/kimi-k2-instruct-0905
 * - deepseek-ai/deepseek-v3.2 (Reasoning)
 * - minimaxai/minimax-m2.5
 * - stepfun-ai/step-3.5-flash
 * - stockmark/stockmark-2-100b-instruct
 * - nvidia/nemotron-mini-4b-instruct
 * - google/gemma-3n-e2b-it
 */

import { z } from 'zod';

// ============================================================================
// Configuration Types
// ============================================================================

export const NVIDIAModelSchema = z.enum([
  'qwen/qwen3.5-397b-a17b',
  'z-ai/glm5',
  'z-ai/glm4.7',
  'moonshotai/kimi-k2.5',
  'moonshotai/kimi-k2-instruct-0905',
  'deepseek-ai/deepseek-v3.2',
  'minimaxai/minimax-m2.5',
  'stepfun-ai/step-3.5-flash',
  'stockmark/stockmark-2-100b-instruct',
  'nvidia/nemotron-mini-4b-instruct',
  'google/gemma-3n-e2b-it'
]);

export interface NVIDIAProviderConfig {
  apiKey: string;
  baseUrl: string;
  defaultModel: z.infer<typeof NVIDIAModelSchema>;
  timeoutMs: number;
  maxRetries: number;
  enableThinking: boolean;
  clearThinking: boolean;
}

export interface NVIDIARequestPayload {
  model: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens: number;
  temperature: number;
  top_p: number;
  top_k?: number;
  presence_penalty?: number;
  repetition_penalty?: number;
  stream: boolean;
  chat_template_kwargs?: {
    enable_thinking?: boolean;
    clear_thinking?: boolean;
    thinking?: boolean;
  };
}

export interface NVIDIAResponseChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      content?: string;
      role?: string;
      reasoning_content?: string;
    };
    finish_reason: string | null;
  }>;
}

// ============================================================================
// Model Capability Profiles
// ============================================================================

export interface ModelCapability {
  model: string;
  displayName: string;
  parameters: string;
  contextWindow: number;
  maxTokens: number;
  
  // Capability scores (0-1)
  reasoning: number;      // Logical reasoning, chain-of-thought
  coding: number;         // Code generation, debugging
  analysis: number;       // Data analysis, summarization
  creativity: number;   // Creative writing, ideation
  instruction: number;  // Following complex instructions
  math: number;         // Mathematical reasoning
  multilingual: number; // Non-English languages
  speed: number;        // Response speed (higher = faster)
  
  // Special features
  supportsThinking: boolean;
  supportsVision: boolean;
  supportsStreaming: boolean;
  supportsTools: boolean;
  
  // Use case recommendations
  bestFor: string[];
  avoidFor: string[];
  
  // Token pricing (relative)
  costTier: 'free' | 'low' | 'medium';
}

export const NVIDIA_MODEL_CAPABILITIES: ModelCapability[] = [
  {
    model: 'qwen/qwen3.5-397b-a17b',
    displayName: 'Qwen 3.5 397B',
    parameters: '397B',
    contextWindow: 32768,
    maxTokens: 16384,
    reasoning: 0.95,
    coding: 0.92,
    analysis: 0.94,
    creativity: 0.88,
    instruction: 0.93,
    math: 0.90,
    multilingual: 0.91,
    speed: 0.60,  // Large model, slower
    supportsThinking: true,
    supportsVision: false,
    supportsStreaming: true,
    supportsTools: true,
    bestFor: ['complex reasoning', 'code architecture', 'system design', 'deep analysis'],
    avoidFor: ['quick responses', 'simple queries'],
    costTier: 'free'
  },
  {
    model: 'z-ai/glm5',
    displayName: 'GLM-5',
    parameters: 'Unknown',
    contextWindow: 32768,
    maxTokens: 16384,
    reasoning: 0.93,
    coding: 0.90,
    analysis: 0.92,
    creativity: 0.85,
    instruction: 0.91,
    math: 0.88,
    multilingual: 0.87,
    speed: 0.65,
    supportsThinking: true,
    supportsVision: false,
    supportsStreaming: true,
    supportsTools: true,
    bestFor: ['reasoning tasks', 'document analysis', 'step-by-step instructions'],
    avoidFor: ['real-time chat'],
    costTier: 'free'
  },
  {
    model: 'z-ai/glm4.7',
    displayName: 'GLM-4.7',
    parameters: 'Unknown',
    contextWindow: 32768,
    maxTokens: 16384,
    reasoning: 0.90,
    coding: 0.88,
    analysis: 0.89,
    creativity: 0.82,
    instruction: 0.88,
    math: 0.85,
    multilingual: 0.85,
    speed: 0.70,
    supportsThinking: true,
    supportsVision: false,
    supportsStreaming: true,
    supportsTools: true,
    bestFor: ['balanced tasks', 'general purpose'],
    avoidFor: ['specialized reasoning'],
    costTier: 'free'
  },
  {
    model: 'moonshotai/kimi-k2.5',
    displayName: 'Kimi K2.5',
    parameters: 'Unknown',
    contextWindow: 200000,  // 200K context!
    maxTokens: 16384,
    reasoning: 0.92,
    coding: 0.89,
    analysis: 0.93,
    creativity: 0.87,
    instruction: 0.92,
    math: 0.87,
    multilingual: 0.90,
    speed: 0.68,
    supportsThinking: true,
    supportsVision: false,
    supportsStreaming: true,
    supportsTools: true,
    bestFor: ['long context', 'document processing', 'large codebase analysis'],
    avoidFor: ['quick tasks'],
    costTier: 'free'
  },
  {
    model: 'deepseek-ai/deepseek-v3.2',
    displayName: 'DeepSeek V3.2',
    parameters: 'Unknown',
    contextWindow: 32768,
    maxTokens: 8192,
    reasoning: 0.91,
    coding: 0.93,  // Excellent for code
    analysis: 0.90,
    creativity: 0.84,
    instruction: 0.89,
    math: 0.88,
    multilingual: 0.86,
    speed: 0.72,
    supportsThinking: true,
    supportsVision: false,
    supportsStreaming: true,
    supportsTools: true,
    bestFor: ['code generation', 'debugging', 'technical analysis'],
    avoidFor: ['creative writing'],
    costTier: 'free'
  },
  {
    model: 'minimaxai/minimax-m2.5',
    displayName: 'MiniMax M2.5',
    parameters: 'Unknown',
    contextWindow: 32768,
    maxTokens: 8192,
    reasoning: 0.85,
    coding: 0.82,
    analysis: 0.84,
    creativity: 0.88,
    instruction: 0.86,
    math: 0.80,
    multilingual: 0.83,
    speed: 0.78,  // Faster
    supportsThinking: false,
    supportsVision: false,
    supportsStreaming: true,
    supportsTools: true,
    bestFor: ['quick responses', 'chat', 'moderate complexity'],
    avoidFor: ['deep reasoning', 'complex coding'],
    costTier: 'free'
  },
  {
    model: 'stepfun-ai/step-3.5-flash',
    displayName: 'Step 3.5 Flash',
    parameters: 'Unknown',
    contextWindow: 32768,
    maxTokens: 16384,
    reasoning: 0.88,
    coding: 0.86,
    analysis: 0.87,
    creativity: 0.85,
    instruction: 0.88,
    math: 0.84,
    multilingual: 0.86,
    speed: 0.85,  // Flash = fast
    supportsThinking: false,
    supportsVision: false,
    supportsStreaming: true,
    supportsTools: true,
    bestFor: ['fast responses', 'high throughput', 'chat'],
    avoidFor: ['complex reasoning'],
    costTier: 'free'
  },
  {
    model: 'stockmark/stockmark-2-100b-instruct',
    displayName: 'Stockmark 2 100B',
    parameters: '100B',
    contextWindow: 8192,
    maxTokens: 1024,
    reasoning: 0.83,
    coding: 0.78,
    analysis: 0.85,
    creativity: 0.80,
    instruction: 0.82,
    math: 0.79,
    multilingual: 0.75,
    speed: 0.75,
    supportsThinking: false,
    supportsVision: false,
    supportsStreaming: true,
    supportsTools: false,
    bestFor: ['general queries', 'simple tasks'],
    avoidFor: ['complex coding', 'long context'],
    costTier: 'free'
  },
  {
    model: 'google/gemma-3n-e2b-it',
    displayName: 'Gemma 3N E2B',
    parameters: '2B',
    contextWindow: 2048,
    maxTokens: 512,
    reasoning: 0.75,
    coding: 0.72,
    analysis: 0.74,
    creativity: 0.70,
    instruction: 0.76,
    math: 0.70,
    multilingual: 0.72,
    speed: 0.95,  // Very fast (small model)
    supportsThinking: false,
    supportsVision: false,
    supportsStreaming: true,
    supportsTools: false,
    bestFor: ['ultra-fast responses', 'simple classification', 'edge cases'],
    avoidFor: ['complex tasks', 'long outputs'],
    costTier: 'free'
  },
  {
    model: 'nvidia/nemotron-mini-4b-instruct',
    displayName: 'Nemotron Mini 4B',
    parameters: '4B',
    contextWindow: 4096,
    maxTokens: 1024,
    reasoning: 0.72,
    coding: 0.68,
    analysis: 0.70,
    creativity: 0.78,  // Color theorist personality
    instruction: 0.74,
    math: 0.65,
    multilingual: 0.68,
    speed: 0.92,
    supportsThinking: false,
    supportsVision: false,
    supportsStreaming: true,
    supportsTools: false,
    bestFor: ['personality-based tasks', 'creative descriptions', 'simple chat'],
    avoidFor: ['technical tasks', 'complex reasoning'],
    costTier: 'free'
  }
];

// ============================================================================
// NVIDIA Provider Implementation
// ============================================================================

export class NVIDIAProvider {
  private config: NVIDIAProviderConfig;
  private modelCapabilities: Map<string, ModelCapability>;

  constructor(config?: Partial<NVIDIAProviderConfig>) {
    this.config = {
      apiKey: config?.apiKey || process.env.NVIDIA_API_KEY || '',
      baseUrl: config?.baseUrl || 'https://integrate.api.nvidia.com/v1',
      defaultModel: config?.defaultModel || 'qwen/qwen3.5-397b-a17b',
      timeoutMs: config?.timeoutMs || 60000,
      maxRetries: config?.maxRetries || 3,
      enableThinking: config?.enableThinking ?? true,
      clearThinking: config?.clearThinking ?? false,
    };

    // Build capability map
    this.modelCapabilities = new Map();
    for (const cap of NVIDIA_MODEL_CAPABILITIES) {
      this.modelCapabilities.set(cap.model, cap);
    }
  }

  /**
   * Generate completion using NVIDIA NIM API
   */
  async generate(
    messages: Array<{ role: string; content: string }>,
    options?: {
      model?: string;
      temperature?: number;
      maxTokens?: number;
      stream?: boolean;
      enableThinking?: boolean;
    }
  ): Promise<{
    content: string;
    reasoning?: string;
    model: string;
    usage: { prompt: number; completion: number; total: number };
  }> {
    const model = options?.model || this.config.defaultModel;
    const capabilities = this.modelCapabilities.get(model);

    const payload: NVIDIARequestPayload = {
      model,
      messages,
      max_tokens: options?.maxTokens || 4096,
      temperature: options?.temperature ?? 0.7,
      top_p: 0.95,
      top_k: 20,
      presence_penalty: 0,
      repetition_penalty: 1,
      stream: options?.stream ?? false,
      chat_template_kwargs: {
        enable_thinking: options?.enableThinking ?? this.config.enableThinking,
        clear_thinking: this.config.clearThinking,
      },
    };

    // Adjust for models without thinking support
    if (!capabilities?.supportsThinking) {
      delete payload.chat_template_kwargs?.enable_thinking;
      delete payload.chat_template_kwargs?.clear_thinking;
    }

    // Adjust for models with different thinking param
    if (model.includes('kimi')) {
      payload.chat_template_kwargs = {
        thinking: options?.enableThinking ?? this.config.enableThinking,
      };
    }

    if (model.includes('deepseek')) {
      payload.chat_template_kwargs = {
        thinking: options?.enableThinking ?? this.config.enableThinking,
      };
    }

    try {
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`NVIDIA API error: ${response.status} - ${error}`);
      }

      const data = await response.json();
      
      const choice = data.choices?.[0];
      const content = choice?.message?.content || '';
      const reasoning = choice?.message?.reasoning_content || 
                       choice?.message?.thinking || '';

      return {
        content,
        reasoning: reasoning || undefined,
        model: data.model || model,
        usage: data.usage || { prompt: 0, completion: 0, total: 0 },
      };

    } catch (error) {
      console.error('[NVIDIA Provider] Generation failed:', error);
      throw error;
    }
  }

  /**
   * Stream completion from NVIDIA NIM API
   */
  async *streamGenerate(
    messages: Array<{ role: string; content: string }>,
    options?: {
      model?: string;
      temperature?: number;
      maxTokens?: number;
      enableThinking?: boolean;
    }
  ): AsyncGenerator<{
    content?: string;
    reasoning?: string;
    done: boolean;
  }> {
    const model = options?.model || this.config.defaultModel;
    const capabilities = this.modelCapabilities.get(model);

    const payload: NVIDIARequestPayload = {
      model,
      messages,
      max_tokens: options?.maxTokens || 4096,
      temperature: options?.temperature ?? 0.7,
      top_p: 0.95,
      top_k: 20,
      presence_penalty: 0,
      repetition_penalty: 1,
      stream: true,
      chat_template_kwargs: {
        enable_thinking: options?.enableThinking ?? this.config.enableThinking,
        clear_thinking: this.config.clearThinking,
      },
    };

    // Adjust for models without thinking support
    if (!capabilities?.supportsThinking) {
      delete payload.chat_template_kwargs?.enable_thinking;
      delete payload.chat_template_kwargs?.clear_thinking;
    }

    // Adjust for models with different thinking param
    if (model.includes('kimi')) {
      payload.chat_template_kwargs = {
        thinking: options?.enableThinking ?? this.config.enableThinking,
      };
    }

    if (model.includes('deepseek')) {
      payload.chat_template_kwargs = {
        thinking: options?.enableThinking ?? this.config.enableThinking,
      };
    }

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`NVIDIA API error: ${response.status} - ${error}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              yield { done: true };
              return;
            }

            try {
              const chunk: NVIDIAResponseChunk = JSON.parse(data);
              const delta = chunk.choices?.[0]?.delta;

              if (delta) {
                yield {
                  content: delta.content,
                  reasoning: delta.reasoning_content,
                  done: false,
                };
              }
            } catch (e) {
              // Skip invalid JSON
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { done: true };
  }

  /**
   * Get model capabilities
   */
  getModelCapabilities(model: string): ModelCapability | undefined {
    return this.modelCapabilities.get(model);
  }

  /**
   * Get all available models
   */
  getAvailableModels(): ModelCapability[] {
    return NVIDIA_MODEL_CAPABILITIES;
  }

  /**
   * Select best model for task
   */
  selectBestModel(task: {
    type: 'reasoning' | 'coding' | 'analysis' | 'creativity' | 'instruction' | 'math' | 'multilingual' | 'speed';
    complexity: 'low' | 'medium' | 'high';
    contextLength?: number;
    requiresThinking?: boolean;
  }): string {
    const candidates = NVIDIA_MODEL_CAPABILITIES.filter(m => {
      // Check context window
      if (task.contextLength && m.contextWindow < task.contextLength) {
        return false;
      }
      
      // Check thinking requirement
      if (task.requiresThinking && !m.supportsThinking) {
        return false;
      }
      
      return true;
    });

    // Sort by capability score for the task type
    candidates.sort((a, b) => b[task.type] - a[task.type]);

    // For high complexity, prefer larger models
    if (task.complexity === 'high') {
      const highPerf = candidates.filter(c => c[task.type] > 0.90);
      if (highPerf.length > 0) {
        return highPerf[0].model;
      }
    }

    // For speed, prefer faster models even if slightly less capable
    if (task.type === 'speed') {
      return candidates[0]?.model || this.config.defaultModel;
    }

    // Default: best balance of capability and speed for complexity
    const targetSpeed = task.complexity === 'low' ? 0.80 : 0.60;
    const balanced = candidates.find(c => c.speed >= targetSpeed);
    
    return balanced?.model || candidates[0]?.model || this.config.defaultModel;
  }
}

// ============================================================================
// Model Router for Intelligent Selection
// ============================================================================

export interface RoutingDecision {
  model: string;
  reasoning: string;
  confidence: number;
}

export class NVIDIAModelRouter {
  private provider: NVIDIAProvider;

  constructor(provider: NVIDIAProvider) {
    this.provider = provider;
  }

  /**
   * Analyze request and route to optimal model
   */
  async routeRequest(
    messages: Array<{ role: string; content: string }>,
    requirements?: {
      preferSpeed?: boolean;
      requireThinking?: boolean;
      maxLatencyMs?: number;
    }
  ): Promise<RoutingDecision> {
    const lastMessage = messages[messages.length - 1]?.content || '';
    const contextLength = messages.reduce((acc, m) => acc + m.content.length, 0);

    // Task classification
    const taskType = this.classifyTask(lastMessage);
    const complexity = this.assessComplexity(lastMessage, contextLength);

    // Check for code-related keywords
    const isCodeTask = /\b(code|programming|function|debug|error|api|database|server)\b/i.test(lastMessage);
    
    // Check for reasoning keywords
    const isReasoningTask = /\b(analyze|explain|why|how|compare|evaluate|solve|proof)\b/i.test(lastMessage);

    // Check for creative keywords
    const isCreativeTask = /\b(write|create|story|design|imagine|creative|poem|essay)\b/i.test(lastMessage);

    // Select model
    let selectedModel: string;
    let selectionReason: string;

    if (requirements?.preferSpeed) {
      selectedModel = this.provider.selectBestModel({
        type: 'speed',
        complexity: 'low',
        contextLength,
        requiresThinking: requirements?.requireThinking,
      });
      selectionReason = 'Selected for speed (low latency requirement)';
    } else if (isCodeTask && complexity === 'high') {
      selectedModel = 'deepseek-ai/deepseek-v3.2';
      selectionReason = 'Selected DeepSeek for complex coding task';
    } else if (isReasoningTask || (requirements?.requireThinking ?? true)) {
      selectedModel = this.provider.selectBestModel({
        type: 'reasoning',
        complexity,
        contextLength,
        requiresThinking: true,
      });
      selectionReason = `Selected for reasoning task (${complexity} complexity)`;
    } else if (contextLength > 50000) {
      selectedModel = 'moonshotai/kimi-k2.5';
      selectionReason = 'Selected Kimi for long context (200K tokens)';
    } else if (isCreativeTask) {
      selectedModel = this.provider.selectBestModel({
        type: 'creativity',
        complexity,
        contextLength,
      });
      selectionReason = 'Selected for creative task';
    } else {
      // Balanced choice
      selectedModel = this.provider.selectBestModel({
        type: 'instruction',
        complexity,
        contextLength,
      });
      selectionReason = `Selected balanced model for ${complexity} complexity task`;
    }

    return {
      model: selectedModel,
      reasoning: selectionReason,
      confidence: 0.85,
    };
  }

  private classifyTask(content: string): 'reasoning' | 'coding' | 'analysis' | 'creativity' | 'instruction' | 'math' | 'multilingual' | 'speed' {
    const lower = content.toLowerCase();
    
    if (/\b(code|program|debug|function|api|error|bug)\b/.test(lower)) return 'coding';
    if (/\b(analyze|compare|evaluate|assess|study)\b/.test(lower)) return 'analysis';
    if (/\b(write|create|story|design|imagine|poem|essay)\b/.test(lower)) return 'creativity';
    if (/\b(calculate|math|equation|formula|number|solve)\b/.test(lower)) return 'math';
    if (/\b(translate|chinese|spanish|french|german|japanese|korean)\b/.test(lower)) return 'multilingual';
    if (/\b(quick|fast|now|immediately|asap)\b/.test(lower)) return 'speed';
    if (/\b(why|how|explain|reason|proof|logic)\b/.test(lower)) return 'reasoning';
    
    return 'instruction';
  }

  private assessComplexity(content: string, contextLength: number): 'low' | 'medium' | 'high' {
    // Simple heuristics
    const wordCount = content.split(/\s+/).length;
    const sentenceCount = content.split(/[.!?]+/).length;
    
    if (contextLength > 10000 || wordCount > 500 || sentenceCount > 30) {
      return 'high';
    }
    
    if (contextLength > 2000 || wordCount > 100 || sentenceCount > 10) {
      return 'medium';
    }
    
    return 'low';
  }
}

// ============================================================================
// Export
// ============================================================================

export { NVIDIAProvider as default };
