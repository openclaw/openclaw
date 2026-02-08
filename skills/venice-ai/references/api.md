# Venice AI API Reference

**Base URL:** `https://api.venice.ai/api/v1`

**Authentication:** All requests require `Authorization: Bearer <VENICE_API_KEY>`

Venice implements the **OpenAI API specification** — any OpenAI-compatible client works by changing the base URL.

---

## Chat Completions

### Create Chat Completion
```
POST /chat/completions
```

**Request Body:**
```json
{
  "model": "deepseek-v3.2",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Hello!"}
  ],
  "temperature": 0.7,
  "max_tokens": 4096,
  "stream": false,
  "response_format": {"type": "json_object"},
  "reasoning_effort": "medium",
  "prompt_cache_key": "session-123",
  "venice_parameters": {
    "enable_web_search": "auto",
    "enable_web_citations": true,
    "enable_web_scraping": false,
    "include_venice_system_prompt": true,
    "character_slug": "coder-dan",
    "strip_thinking_response": false,
    "disable_thinking": false,
    "include_search_results_in_stream": false,
    "return_search_results_as_documents": false
  }
}
```

**Venice Parameters (unique to Venice):**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `enable_web_search` | `"off"/"on"/"auto"` | `"off"` | LLM-integrated web search. "auto" lets the model decide. |
| `enable_web_citations` | bool | false | Request `[REF]0[/REF]` citation format in responses |
| `enable_web_scraping` | bool | false | Scrape URLs found in user messages to augment context |
| `include_venice_system_prompt` | bool | true | Include Venice's default uncensored system prompt |
| `character_slug` | string | — | Use a Venice public character persona |
| `strip_thinking_response` | bool | false | Strip `<think>` tags server-side |
| `disable_thinking` | bool | false | Disable reasoning entirely |
| `include_search_results_in_stream` | bool | false | Emit search results as first SSE chunk |
| `return_search_results_as_documents` | bool | false | Return search results as OpenAI-compatible tool call |

**Response:**
```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "model": "deepseek-v3.2",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Hello! How can I help?",
      "reasoning_content": "The user said hello..."
    },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 15,
    "completion_tokens": 8,
    "total_tokens": 23,
    "prompt_tokens_details": {
      "cached_tokens": 0,
      "cache_creation_input_tokens": 0
    }
  }
}
```

**Model Feature Suffixes:** Append parameters to model name: `qwen3-4b:strip_thinking_response=true:disable_thinking=true`

### Reasoning Models

Supported: `claude-opus-4-6`, `grok-41-fast`, `kimi-k2-5`, `gemini-3-pro-preview`, `qwen3-235b-a22b-thinking-2507`, `qwen3-4b`, `deepseek-ai-DeepSeek-R1`

Control via `reasoning_effort`: `low` | `medium` | `high`

### Prompt Caching

Automatic for most models (>1024 tokens). Use `prompt_cache_key` for routing affinity.
Claude requires explicit `cache_control: {"type": "ephemeral"}` markers.

| Model | Min Tokens | Cache Life | Read Discount |
|-------|-----------|------------|---------------|
| Claude Opus 4.6 | ~4,000 | 5 min | 90% |
| GPT-5.2 | 1,024 | 5-10 min | 90% |
| Gemini | ~1,024 | 1 hour | 75-90% |
| DeepSeek | ~1,024 | 5 min | 50% |

---

## Models

### List Models
```
GET /models?type={text|image|video|audio|embedding}
```

**Response:**
```json
{
  "data": [{
    "id": "deepseek-v3.2",
    "type": "text",
    "model_spec": {
      "description": "DeepSeek V3.2",
      "offline": false,
      "beta": false,
      "availableForPrivateInference": true,
      "deprecation": {"date": null},
      "constraints": {
        "max_context_length": 164000
      }
    }
  }]
}
```

---

## Embeddings

### Generate Embeddings
```
POST /embeddings
```

**Request:**
```json
{
  "model": "text-embedding-bge-m3",
  "input": "Your text here"
}
```

Or batch: `"input": ["text1", "text2", "text3"]`

**Response:**
```json
{
  "data": [{
    "index": 0,
    "embedding": [0.123, -0.456, ...],
    "object": "embedding"
  }],
  "usage": {"prompt_tokens": 5, "total_tokens": 5}
}
```

---

## Audio

### Text-to-Speech
```
POST /audio/speech
```

**Request:**
```json
{
  "model": "tts-kokoro",
  "input": "Hello world",
  "voice": "af_sky",
  "speed": 1.0
}
```

**Response:** Audio bytes (MP3). Content-Type: audio/mpeg

**Available voices (60+):**
- English US: `af_sky`, `af_nova`, `af_bella`, `am_adam`, `am_liam`
- English UK: `bf_emma`, `bf_isabella`, `bm_daniel`, `bm_george`
- Chinese: `zf_xiaobei`, `zf_xiaoni`, `zm_yunjian`
- Japanese: `jf_alpha`, `jm_kumo`
- And many more (French, Hindi, Italian, Portuguese, Spanish)

Prefix: a=American, b=British, z=Chinese, j=Japanese; f=female, m=male

### Speech-to-Text (Transcription)
```
POST /audio/transcriptions
```

**Request:** Multipart form data
- `file`: Audio file (WAV, FLAC, MP3, M4A, AAC, MP4)
- `model`: `nvidia/parakeet-tdt-0.6b-v3`
- `timestamps`: `true` (optional, word-level timing)

**Response:**
```json
{
  "text": "Transcribed text here..."
}
```

---

## Images

### Generate Image
```
POST /images/generations
```

### Edit Image
```
POST /images/edits
```

### Upscale Image
```
POST /images/upscale
```

> See `venice-image.py`, `venice-upscale.py`, and `venice-edit.py` in the scripts folder for CLI usage.

---

## Video

### Generate Video
```
POST /video/generate
```

### Get Video Quote
```
POST /video/generate/quote
```

> See `venice-video.py` in the scripts folder for CLI usage.

---

## Response Headers

All authenticated requests include useful headers:

| Header | Description |
|--------|-------------|
| `x-venice-balance-usd` | USD credit balance |
| `x-venice-balance-diem` | DIEM token balance |
| `x-venice-balance-vcu` | Venice Compute Units |
| `x-venice-model-id` | Model used for inference |
| `x-ratelimit-remaining-requests` | Remaining request quota |
| `x-ratelimit-remaining-tokens` | Remaining token quota |
| `CF-RAY` | Request ID (for support) |

---

## Pricing Quick Reference

### Text (per 1M tokens)

| Model | Input | Output | Privacy |
|-------|-------|--------|---------|
| qwen3-4b | $0.05 | $0.15 | Private |
| venice-uncensored | $0.20 | $0.90 | Private |
| deepseek-v3.2 | $0.40 | $1.00 | Private |
| mistral-31-24b | $0.50 | $2.00 | Private |
| llama-3.3-70b | $0.70 | $2.80 | Private |
| grok-41-fast | $0.50 | $1.25 | Anonymized |
| openai-gpt-52 | $2.19 | $17.50 | Anonymized |
| claude-opus-4-6 | $6.00 | $30.00 | Anonymized |

### Other

| Feature | Cost |
|---------|------|
| Embeddings (BGE-M3) | $0.15/M tokens input |
| TTS (Kokoro) | $3.50/M characters |
| Speech-to-Text (Parakeet) | $0.0001/audio second |
| Web Search | $10/1K calls |
| Web Scraping | $10/1K calls |
| Images | $0.01-$0.23/image |
| Video | Variable (use quote API) |

---

## Resources

- **Docs:** https://docs.venice.ai
- **Status:** https://veniceai-status.com
- **Discord:** https://discord.gg/askvenice
- **Twitter:** https://x.com/AskVenice
