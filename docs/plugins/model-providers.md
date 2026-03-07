# Model Provider Plugins

Plugins can register model providers that OpenClaw uses for text inference, embeddings, speech (TTS/STT), and media understanding (image/video).

## Registering a Provider

Use `api.registerProvider()` to register a provider with capabilities:

```ts
api.registerProvider({
  id: "my-provider",
  label: "My Provider",
  capabilities: ["embedding", "tts", "audio", "image", "video"],

  // Implement methods for each capability you support
  // (not all are required)
});
```

## Capabilities

The `capabilities` array declares what your provider supports:

| Capability  | Description         | Methods to implement                      |
| ----------- | ------------------- | ----------------------------------------- |
| `embedding` | Text embeddings     | `embed`, `embedBatch`, `embedBatchInputs` |
| `tts`       | Text-to-speech      | `textToSpeech`                            |
| `audio`     | Speech-to-text      | `transcribeAudio`                         |
| `image`     | Image understanding | `describeImage`                           |
| `video`     | Video understanding | `describeVideo`                           |

## Text Inference (Chat)

Text inference does not use a plugin method. Instead, plugins provide text inference through the **catalog/discovery system**:

1. **Catalog hook**: Implement `catalog` to return `ModelCatalogEntry` rows that describe your provider's chat models
2. **Auth hooks**: Implement `auth` methods to handle API key/OAuth authentication
3. **Runtime hooks**: Optionally implement `prepareRuntimeAuth`, `normalizeResolvedModel`, etc. to customize the inference flow

The catalog entry shape determines how OpenClaw routes inference requests to your provider's API.

## Capability Methods

### Embeddings

```ts
// Single text embedding
embed: async (req) => {
  // req.text: string
  // req.model?: string
  // req.apiKey: string
  // req.baseUrl?: string
  // req.timeoutMs: number
  // req.fetchFn?: typeof fetch

  return {
    embedding: [0.1, 0.2, /* ... */],
    model: req.model,
  };
},

// Batch text embeddings
embedBatch: async (req) => {
  // req.texts: string[]
  // req.model?: string
  // req.apiKey: string
  // req.baseUrl?: string
  // req.timeoutMs: number
  // req.fetchFn?: typeof fetch

  return {
    embeddings: [[0.1, 0.2], [0.3, 0.4]],
    model: req.model,
  };
},

// Multimodal embeddings (text + images)
embedBatchInputs: async (req) => {
  // req.inputs: { text?: string, parts?: { type: "text" | "inline-data", ... }[] }[]
  // req.model?: string
  // req.apiKey: string
  // req.baseUrl?: string
  // req.timeoutMs: number
  // req.fetchFn?: typeof fetch

  return {
    embeddings: [[0.1, 0.2], [0.3, 0.4]],
    model: req.model,
  };
},
```

### Text-to-Speech (TTS)

```ts
textToSpeech: async (req) => {
  // req.text: string
  // req.model?: string
  // req.modelId?: string
  // req.voice?: string
  // req.voiceId?: string
  // req.apiKey: string
  // req.baseUrl?: string
  // req.headers?: Record<string, string>
  // req.timeoutMs: number
  // req.fetchFn?: typeof fetch
  // req.telephony?: boolean (set to true if used for voice calls)

  return {
    audio: Buffer.from(/* audio data */),
    mime: "audio/mp3",
    // sampleRate is required for telephony (voice calls)
    sampleRate: 24000,
  };
},
```

### Speech-to-Text (Audio)

```ts
transcribeAudio: async (req) => {
  // req.buffer: Buffer
  // req.fileName?: string
  // req.mime: string
  // req.model?: string
  // req.language?: string
  // req.prompt?: string
  // req.apiKey: string
  // req.baseUrl?: string
  // req.headers?: Record<string, string>
  // req.timeoutMs: number
  // req.fetchFn?: typeof fetch

  return { text: "transcribed text", model: req.model };
},
```

### Image Understanding

```ts
describeImage: async (req) => {
  // req.buffer: Buffer
  // req.fileName?: string
  // req.mime?: string
  // req.model: string (required)
  // req.provider: string
  // req.prompt?: string
  // req.maxTokens?: number
  // req.timeoutMs: number
  // req.profile?: string
  // req.preferredProfile?: string
  // req.agentDir: string (required)
  // req.apiKey: string
  // req.baseUrl?: string
  // req.headers?: Record<string, string>
  // req.fetchFn?: typeof fetch

  return { text: "image description", model: req.model };
},
```

### Video Understanding

```ts
describeVideo: async (req) => {
  // req.buffer: Buffer
  // req.fileName?: string
  // req.mime?: string
  // req.model?: string
  // req.prompt?: string
  // req.apiKey: string
  // req.baseUrl?: string
  // req.headers?: Record<string, string>
  // req.timeoutMs: number
  // req.fetchFn?: typeof fetch

  return { text: "video description", model: req.model };
},
```

## Configuration

Users configure your provider in their OpenClaw config:

```json
{
  "models": {
    "providers": {
      "my-provider": {
        "baseUrl": "https://api.myprovider.com",
        "apiKey": "..."
      }
    }
  },
  "agents": {
    "defaults": {
      "model": "my-provider"
    }
  }
}
```

## Provider Selection

When users set `provider: "auto"`, OpenClaw tries providers in this order:

1. User's configured provider (if valid)
2. Built-in providers (OpenAI, Anthropic, etc.)
3. Other registered plugin providers

If a provider fails, OpenClaw automatically falls back to the next provider in the list.
