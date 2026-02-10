---
name: llm-router
description: "Unified LLM Gateway - One API for 70+ AI models. Route to GPT, Claude, Gemini, Grok and more with a single API key."
homepage: https://openclaw.ai
metadata: {"openclaw":{"emoji":"🧠","requires":{"bins":["curl","python3"],"env":["AISA_API_KEY"]},"primaryEnv":"AISA_API_KEY"}}
---

# OpenClaw LLM Router 🧠

**Unified LLM Gateway for autonomous agents. Powered by AIsa.**

One API key. 70+ models. OpenAI-compatible.

Replace 100+ API keys with one. Access GPT-4, Claude-3, Gemini, Grok, and more through a unified, OpenAI-compatible API.

## 🔥 What Can You Do?

### Multi-Model Chat
```
"Chat with GPT-4 for reasoning, switch to Claude for creative writing"
```

### Model Comparison
```
"Compare responses from GPT-4, Claude, and Gemini for the same question"
```

### Vision Analysis
```
"Analyze this image with GPT-4o - what objects are in it?"
```

### Cost Optimization
```
"Route simple queries to fast/cheap models, complex queries to GPT-4"
```

### Fallback Strategy
```
"If GPT-4 fails, automatically try Claude, then Gemini"
```

## Why LLM Router?

| Feature | LLM Router | Direct APIs |
|---------|------------|-------------|
| API Keys | 1 | 10+ |
| SDK Compatibility | OpenAI SDK | Multiple SDKs |
| Billing | Unified | Per-provider |
| Model Switching | Change string | Code rewrite |
| Fallback Routing | Built-in | DIY |
| Cost Tracking | Unified | Fragmented |

## Supported Model Families

| Family | Developer | Example Models |
|--------|-----------|----------------|
| GPT | OpenAI | gpt-5.2, gpt-5, gpt-5-mini, gpt-4.1, gpt-4.1-mini, gpt-4o, gpt-4o-mini |
| Claude | Anthropic | claude-sonnet-4-5, claude-opus-4-1, claude-opus-4, claude-sonnet-4, claude-haiku-4-5 |
| Gemini | Google | gemini-2.5-pro, gemini-2.5-flash, gemini-2.5-flash-lite, gemini-3-pro-preview |
| Grok | xAI | grok-4, grok-3 |
| Llama | Meta | llama-3.1-405b, llama-3.1-70b, llama-3.1-8b |
| Mistral | Mistral AI | mistral-large, mistral-medium, mixtral-8x7b |

> **Note**: Model availability may vary. Check [marketplace.aisa.one/pricing](https://marketplace.aisa.one/pricing) for the full list of currently available models and pricing.

## Quick Start

```bash
export AISA_API_KEY="your-key"
```

## API Endpoints

### OpenAI-Compatible Chat Completions

```
POST https://api.aisa.one/v1/chat/completions
```

#### Request

```bash
curl -X POST "https://api.aisa.one/v1/chat/completions" \
  -H "Authorization: Bearer $AISA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4.1",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Explain quantum computing in simple terms."}
    ],
    "temperature": 0.7,
    "max_tokens": 1000
  }'
```

#### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `model` | string | Yes | Model identifier (e.g., `gpt-4.1`, `claude-sonnet-4-5`) |
| `messages` | array | Yes | Conversation messages |
| `temperature` | number | No | Randomness (0-2, default: 1) |
| `max_tokens` | integer | No | Maximum response tokens |
| `stream` | boolean | No | Enable streaming (default: false) |
| `top_p` | number | No | Nucleus sampling (0-1) |
| `frequency_penalty` | number | No | Frequency penalty (-2 to 2) |
| `presence_penalty` | number | No | Presence penalty (-2 to 2) |
| `stop` | string/array | No | Stop sequences |

#### Message Format

```json
{
  "role": "user|assistant|system",
  "content": "message text or array for multimodal"
}
```

#### Response

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "gpt-4.1",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Quantum computing uses..."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 50,
    "completion_tokens": 200,
    "total_tokens": 250,
    "cost": 0.0025
  }
}
```

### Streaming Response

```bash
curl -X POST "https://api.aisa.one/v1/chat/completions" \
  -H "Authorization: Bearer $AISA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "messages": [{"role": "user", "content": "Write a poem about AI."}],
    "stream": true
  }'
```

Streaming returns Server-Sent Events (SSE):

```
data: {"id":"chatcmpl-xxx","choices":[{"delta":{"content":"In"}}]}
data: {"id":"chatcmpl-xxx","choices":[{"delta":{"content":" circuits"}}]}
...
data: [DONE]
```

### Vision / Image Analysis

Analyze images by passing image URLs or base64 data:

```bash
curl -X POST "https://api.aisa.one/v1/chat/completions" \
  -H "Authorization: Bearer $AISA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [
      {
        "role": "user",
        "content": [
          {"type": "text", "text": "What is in this image?"},
          {"type": "image_url", "image_url": {"url": "https://example.com/image.jpg"}}
        ]
      }
    ]
  }'
```

### Function Calling

Enable tools/functions for structured outputs:

```bash
curl -X POST "https://api.aisa.one/v1/chat/completions" \
  -H "Authorization: Bearer $AISA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4.1",
    "messages": [{"role": "user", "content": "What is the weather in Tokyo?"}],
    "functions": [
      {
        "name": "get_weather",
        "description": "Get current weather for a location",
        "parameters": {
          "type": "object",
          "properties": {
            "location": {"type": "string", "description": "City name"},
            "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]}
          },
          "required": ["location"]
        }
      }
    ],
    "function_call": "auto"
  }'
```

### Google Gemini Format

For Gemini models, you can also use the native format:

```
POST https://api.aisa.one/v1/models/gemini-2.5-flash:generateContent
```

```bash
curl -X POST "https://api.aisa.one/v1/models/gemini-2.5-flash:generateContent" \
  -H "Authorization: Bearer $AISA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [
      {
        "role": "user",
        "parts": [{"text": "Explain machine learning."}]
      }
    ],
    "generationConfig": {
      "temperature": 0.7,
      "maxOutputTokens": 1000
    }
  }'
```

## Python Client

### Installation

No installation required - uses standard library only.

### CLI Usage

```bash
# Basic completion
python3 {baseDir}/scripts/llm_router_client.py chat --model gpt-4.1 --message "Hello, world!"

# With system prompt
python3 {baseDir}/scripts/llm_router_client.py chat --model claude-sonnet-4-5 --system "You are a poet" --message "Write about the moon"

# Streaming
python3 {baseDir}/scripts/llm_router_client.py chat --model gpt-4o --message "Tell me a story" --stream

# Multi-turn conversation
python3 {baseDir}/scripts/llm_router_client.py chat --model gpt-4.1 --messages '[{"role":"user","content":"Hi"},{"role":"assistant","content":"Hello!"},{"role":"user","content":"How are you?"}]'

# Vision analysis
python3 {baseDir}/scripts/llm_router_client.py vision --model gpt-4o --image "https://example.com/image.jpg" --prompt "Describe this image"

# List supported models
python3 {baseDir}/scripts/llm_router_client.py models

# Compare models
python3 {baseDir}/scripts/llm_router_client.py compare --models "gpt-4.1,claude-sonnet-4-5,gemini-2.5-flash" --message "What is 2+2?"
```

### Python SDK Usage

```python
from llm_router_client import LLMRouterClient

client = LLMRouterClient()  # Uses AISA_API_KEY env var

# Simple chat
response = client.chat(
    model="gpt-4.1",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response["choices"][0]["message"]["content"])

# With options
response = client.chat(
    model="claude-3-sonnet",
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Explain relativity."}
    ],
    temperature=0.7,
    max_tokens=500
)

# Streaming
for chunk in client.chat_stream(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Write a story."}]
):
    print(chunk, end="", flush=True)

# Vision
response = client.vision(
    model="gpt-4o",
    image_url="https://example.com/image.jpg",
    prompt="What's in this image?"
)

# Compare models
results = client.compare_models(
    models=["gpt-4.1", "claude-sonnet-4-5", "gemini-2.5-flash"],
    message="Explain quantum computing"
)
for model, result in results.items():
    print(f"{model}: {result['response'][:100]}...")
```

## Use Cases

### 1. Cost-Optimized Routing

Use cheaper models for simple tasks:

```python
def smart_route(message: str) -> str:
    # Simple queries -> fast/cheap model
    if len(message) < 50:
        model = "gpt-3.5-turbo"
    # Complex reasoning -> powerful model
    else:
        model = "gpt-4.1"
    
    return client.chat(model=model, messages=[{"role": "user", "content": message}])
```

### 2. Fallback Strategy

Automatic fallback on failure:

```python
def chat_with_fallback(message: str) -> str:
    models = ["gpt-4.1", "claude-sonnet-4-5", "gemini-2.5-flash"]
    
    for model in models:
        try:
            return client.chat(model=model, messages=[{"role": "user", "content": message}])
        except Exception:
            continue
    
    raise Exception("All models failed")
```

### 3. Model A/B Testing

Compare model outputs:

```python
results = client.compare_models(
    models=["gpt-4.1", "claude-opus-4-1"],
    message="Analyze this quarterly report..."
)

# Log for analysis
for model, result in results.items():
    log_response(model=model, latency=result["latency"], cost=result["cost"])
```

### 4. Specialized Model Selection

Choose the best model for each task:

```python
MODEL_MAP = {
    "code": "gpt-4.1",
    "creative": "claude-opus-4-1",
    "fast": "gemini-2.5-flash",
    "vision": "gpt-4o",
    "reasoning": "o1",
    "open_source": "llama-3.1-70b"
}

def route_by_task(task_type: str, message: str) -> str:
    model = MODEL_MAP.get(task_type, "gpt-4.1")
    return client.chat(model=model, messages=[{"role": "user", "content": message}])
```

## Error Handling

Errors return JSON with `error` field:

```json
{
  "error": {
    "code": "model_not_found",
    "message": "Model 'xyz' is not available"
  }
}
```

Common error codes:
- `401` - Invalid or missing API key
- `402` - Insufficient credits
- `404` - Model not found
- `429` - Rate limit exceeded
- `500` - Server error

## Best Practices

1. **Use streaming** for long responses to improve UX
2. **Set max_tokens** to control costs
3. **Implement fallback** for production reliability
4. **Cache responses** for repeated queries
5. **Monitor usage** via response metadata
6. **Use appropriate models** - don't use GPT-4 for simple tasks

## OpenAI SDK Compatibility

Just change the base URL and key:

```python
import os
from openai import OpenAI

client = OpenAI(
    api_key=os.environ["AISA_API_KEY"],
    base_url="https://api.aisa.one/v1"
)

response = client.chat.completions.create(
    model="gpt-4.1",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)
```

## Pricing

Token-based pricing varies by model. Check [marketplace.aisa.one/pricing](https://marketplace.aisa.one/pricing) for current rates.

| Model Family | Approximate Cost |
|--------------|------------------|
| GPT-4.1 / GPT-4o | ~$0.01 / 1K tokens |
| Claude-3-Sonnet | ~$0.01 / 1K tokens |
| Gemini-2.5-Flash | ~$0.001 / 1K tokens |
| Grok-2 | ~$0.01 / 1K tokens |
| Llama-3.1-70b | ~$0.002 / 1K tokens |
| Mistral-Large | ~$0.008 / 1K tokens |

Every response includes `usage.cost` and `usage.credits_remaining`.

## Get Started

1. Sign up at [aisa.one](https://aisa.one)
2. Get your API key from the dashboard
3. Add credits (pay-as-you-go)
4. Set environment variable: `export AISA_API_KEY="your-key"`

## Full API Reference

See [API Reference](https://aisa.mintlify.app/api-reference/introduction) for complete endpoint documentation.
