# Plugin Model Calling API Design

## Current Problem

Plugins need to call LLM models (e.g. for anti-rationalization review) but have no clean API:

**Current workarounds:**
1. ❌ `exec("openclaw run ...")` - Gross, slow, fragile
2. ❌ Direct `import { createModel } from "@mariozechner/pi-ai"` - Works but awkward, needs config
3. ✅ Need proper API in `PluginRuntime`

## Proposed API

### Add to `PluginRuntime.model`

```typescript
export type PluginRuntime = {
  // ... existing fields ...
  
  model: {
    /**
     * Call a model with a simple prompt.
     * Uses the agent's configured credentials and handles auth automatically.
     */
    call: (params: {
      model: string;              // e.g. "anthropic/claude-haiku-4-5-20251001"
      prompt: string;             // User prompt
      systemPrompt?: string;      // Optional system prompt
      temperature?: number;       // 0-1, default 0
      maxTokens?: number;         // Optional limit
      timeout?: number;           // Timeout in ms, default 30000
    }) => Promise<ModelCallResult>;
    
    /**
     * Call a model with full message history.
     * For more complex multi-turn interactions.
     */
    generate: (params: {
      model: string;
      messages: Array<{
        role: "user" | "assistant" | "system";
        content: string;
      }>;
      temperature?: number;
      maxTokens?: number;
      timeout?: number;
    }) => Promise<ModelCallResult>;
  };
};

export type ModelCallResult = {
  text: string;                   // Response text
  model: string;                  // Actual model used
  stopReason?: string;            // "end_turn" | "max_tokens" | "stop_sequence"
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
};
```

### Plugin Usage Example

```typescript
// Anti-rationalization plugin using the API
export default function antiRationalizationPlugin(api: OpenClawPluginApi) {
  api.on("agent_end", async (event, ctx) => {
    const lastMsg = event.messages[event.messages.length - 1];
    if (!lastMsg || lastMsg.role !== "assistant") return;
    
    // Call Haiku for judgment
    const result = await api.runtime.model.call({
      model: "anthropic/claude-haiku-4-5-20251001",
      prompt: `Review this response for rationalization:\n\n${lastMsg.content}`,
      temperature: 0,
      timeout: 10000,
    });
    
    // Parse response
    const judgment = JSON.parse(result.text);
    
    if (judgment.incomplete) {
      ctx.injectMessage?.(judgment.reason);
    }
  });
}
```

## Implementation

### 1. Create `src/plugins/runtime/model.ts`

```typescript
import { createModel } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/config.js";
import type { ModelCallParams, ModelCallResult, ModelGenerateParams } from "./types.js";

export async function callModel(
  params: ModelCallParams,
  config: OpenClawConfig,
): Promise<ModelCallResult> {
  const model = createModel(params.model, config);
  
  const messages = [
    ...(params.systemPrompt ? [{ role: "system" as const, content: params.systemPrompt }] : []),
    { role: "user" as const, content: params.prompt },
  ];
  
  const timeoutPromise = params.timeout
    ? new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Model call timeout")), params.timeout),
      )
    : null;
  
  const callPromise = model.generate({
    messages,
    temperature: params.temperature ?? 0,
    maxTokens: params.maxTokens,
  });
  
  const response = timeoutPromise
    ? await Promise.race([callPromise, timeoutPromise])
    : await callPromise;
  
  return {
    text: response.content?.[0]?.text || response.text || "",
    model: params.model,
    stopReason: response.stopReason,
    usage: response.usage
      ? {
          inputTokens: response.usage.inputTokens || 0,
          outputTokens: response.usage.outputTokens || 0,
        }
      : undefined,
  };
}

export async function generateWithModel(
  params: ModelGenerateParams,
  config: OpenClawConfig,
): Promise<ModelCallResult> {
  const model = createModel(params.model, config);
  
  const timeoutPromise = params.timeout
    ? new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Model call timeout")), params.timeout),
      )
    : null;
  
  const callPromise = model.generate({
    messages: params.messages,
    temperature: params.temperature ?? 0,
    maxTokens: params.maxTokens,
  });
  
  const response = timeoutPromise
    ? await Promise.race([callPromise, timeoutPromise])
    : await callPromise;
  
  return {
    text: response.content?.[0]?.text || response.text || "",
    model: params.model,
    stopReason: response.stopReason,
    usage: response.usage
      ? {
          inputTokens: response.usage.inputTokens || 0,
          outputTokens: response.usage.outputTokens || 0,
        }
      : undefined,
  };
}
```

### 2. Wire into PluginRuntime

In `src/plugins/runtime/index.ts`:

```typescript
import { callModel, generateWithModel } from "./model.js";

export function createPluginRuntime(config: OpenClawConfig): PluginRuntime {
  return {
    // ... existing fields ...
    
    model: {
      call: (params) => callModel(params, config),
      generate: (params) => generateWithModel(params, config),
    },
  };
}
```

### 3. Update Type Exports

In `src/plugin-sdk/index.ts`:

```typescript
export type { 
  PluginRuntime,
  ModelCallParams,
  ModelCallResult,
  ModelGenerateParams,
} from "../plugins/runtime/types.js";
```

## Benefits

✅ **Clean API** - No exec hacks, no config juggling
✅ **Consistent** - Uses same credentials as main agent
✅ **Typed** - Full TypeScript support
✅ **Timeout handling** - Built-in timeout protection
✅ **Usage tracking** - Returns token counts for cost monitoring

## Use Cases

### 1. Anti-Rationalization Gate
```typescript
const judgment = await api.runtime.model.call({
  model: "anthropic/claude-haiku-4-5-20251001",
  prompt: reviewPrompt,
  temperature: 0,
});
```

### 2. Content Moderation
```typescript
const safety = await api.runtime.model.call({
  model: "anthropic/claude-haiku-4-5-20251001",
  prompt: `Is this message safe? ${message}`,
});
```

### 3. Smart Summarization
```typescript
const summary = await api.runtime.model.call({
  model: "anthropic/claude-haiku-4-5-20251001",
  prompt: `Summarize in 2 sentences: ${longText}`,
  maxTokens: 100,
});
```

### 4. Multi-Turn Review
```typescript
const result = await api.runtime.model.generate({
  model: "anthropic/claude-haiku-4-5-20251001",
  messages: [
    { role: "system", content: "You are a code reviewer." },
    { role: "user", content: "Review this code..." },
    { role: "assistant", content: "I found 3 issues..." },
    { role: "user", content: "Are these blocking?" },
  ],
});
```

## Alternative Approaches Considered

### Option A: Just export from plugin-sdk
```typescript
export { createModel } from "@mariozechner/pi-ai";
```
**Problem:** Plugins need to handle config themselves

### Option B: Context method instead of runtime
```typescript
ctx.callModel?.({ model, prompt })
```
**Problem:** Only available in hook contexts, not during plugin init

### Option C: Register model as a tool
```typescript
api.registerTool(createModelCallingTool())
```
**Problem:** Synchronous tools can't call models, wrong abstraction

## Recommendation

**Ship the PluginRuntime.model API** - It's clean, composable, and follows the existing runtime pattern. Minimal implementation (~100 LOC), huge DX improvement for plugins.
