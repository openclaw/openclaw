---
summary: "Use LLMProxy as a high-performance reverse proxy for LLM backends"
read_when:
  - You want to route OpenClaw through a local LLM proxy
  - You need zero-buffer streaming with token metering
  - You want load balancing across multiple LLM backends
---
# LLMProxy

[LLMProxy](https://github.com/aiyuekuang/LLMProxy) is a high-performance reverse proxy for LLM inference services — like nginx for web servers, but built specifically for LLM workloads.

## Why LLMProxy?

| Feature | LLMProxy | Generic API Gateway |
|---------|----------|---------------------|
| SSE Streaming | Zero-buffer forwarding | Buffer causes delay |
| Token Metering | Native support | Plugin required |
| Deployment | Single binary | Requires database |
| LLM Optimization | Built for LLM | General purpose |

**Performance:**
- First token latency overhead: < 1ms
- Memory usage: < 50MB
- Concurrent connections: 10,000+

## Quick start

### 1. Start LLMProxy

```bash
# Download config
curl -o config.yaml https://raw.githubusercontent.com/aiyuekuang/LLMProxy/main/config.yaml.example

# Edit backend URL (point to your vLLM/TGI/Ollama instance)
vim config.yaml

# Start with Docker
docker run -d -p 8000:8000 \
  -v $(pwd)/config.yaml:/home/llmproxy/config.yaml \
  ghcr.io/aiyuekuang/llmproxy:latest
```

### 2. Configure OpenClaw

```json5
{
  models: {
    providers: {
      llmproxy: {
        baseUrl: "http://localhost:8000/v1",
        apiKey: "optional-key",  // LLMProxy handles auth separately
        api: "openai-completions",
        models: [
          {
            id: "qwen-coder",
            name: "Qwen Coder via LLMProxy",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192
          }
        ]
      }
    }
  },
  agents: {
    defaults: {
      model: { primary: "llmproxy/qwen-coder" }
    }
  }
}
```

### 3. Test the connection

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen-coder",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

## Configuration

### LLMProxy config (config.yaml)

```yaml
server:
  listen: ":8000"

backends:
  - url: "http://vllm:8000"
    weight: 5
  - url: "http://ollama:11434"
    weight: 3

# Optional: API Key authentication
auth:
  enabled: true
  header_names: ["Authorization", "X-API-Key"]
  skip_paths: ["/health", "/metrics"]

# Optional: Usage reporting (for billing/monitoring)
usage:
  enabled: true
  reporters:
    - name: billing
      type: webhook
      enabled: true
      webhook:
        url: "https://your-billing.com/llm-usage"
        timeout: 3s

# Optional: Rate limiting
rate_limit:
  enabled: true
  per_key:
    requests_per_minute: 60
    max_concurrent: 3
```

### Multiple backends with load balancing

LLMProxy supports load balancing across multiple LLM backends:

```yaml
backends:
  - url: "http://vllm-1:8000"
    weight: 10
  - url: "http://vllm-2:8000"
    weight: 10
  - url: "http://ollama:11434"
    weight: 5

routing:
  load_balance: least_connections  # or: round_robin, latency_based
```

### OpenClaw config for multiple models

```json5
{
  models: {
    providers: {
      llmproxy: {
        baseUrl: "http://localhost:8000/v1",
        api: "openai-completions",
        models: [
          {
            id: "qwen-coder-32b",
            name: "Qwen 2.5 Coder 32B",
            reasoning: false,
            input: ["text"],
            contextWindow: 128000,
            maxTokens: 8192
          },
          {
            id: "deepseek-r1",
            name: "DeepSeek R1",
            reasoning: true,
            input: ["text"],
            contextWindow: 64000,
            maxTokens: 8192
          }
        ]
      }
    }
  },
  agents: {
    defaults: {
      model: {
        primary: "llmproxy/qwen-coder-32b",
        fallbacks: ["llmproxy/deepseek-r1"]
      }
    }
  }
}
```

## Use cases

### Self-hosted AI coding assistant

Route Cursor, Aider, or other coding tools through LLMProxy to your private vLLM instance:

```
Developer IDE → LLMProxy → vLLM (Qwen2.5-Coder-32B)
```

Benefits:
- Fully private code data
- Tool calling support
- Unified API key management
- Response latency < 500ms

### Cost optimization

Use LLMProxy to route requests based on complexity:

```yaml
# LLMProxy routes to cheaper/faster backends first
backends:
  - url: "http://ollama:11434"      # Free, local
    weight: 10
  - url: "http://vllm-large:8000"   # More capable
    weight: 3
```

### Monitoring and billing

LLMProxy sends usage data to your webhook:

```json
{
  "request_id": "req_abc123",
  "user_id": "user_alice",
  "model": "qwen-coder",
  "prompt_tokens": 15,
  "completion_tokens": 42,
  "total_tokens": 57,
  "is_stream": true,
  "timestamp": "2026-01-30T10:30:00Z"
}
```

## Monitoring

LLMProxy exposes Prometheus metrics at `/metrics`:

| Metric | Description |
|--------|-------------|
| `llmproxy_requests_total` | Total requests |
| `llmproxy_latency_ms` | Request latency |
| `llmproxy_usage_tokens_total` | Token usage |

Access metrics:

```bash
curl http://localhost:8000/metrics
```

## Troubleshooting

### Connection refused

Check that LLMProxy is running:

```bash
curl http://localhost:8000/health
```

### Backend not responding

Verify your backend is accessible from LLMProxy:

```bash
# From the LLMProxy host
curl http://vllm:8000/v1/models
```

### Token counts missing

Ensure your backend returns usage data. For vLLM, add `--return-detailed-tokens`:

```bash
python -m vllm.entrypoints.openai.api_server \
  --model meta-llama/Llama-3-8b-Instruct \
  --return-detailed-tokens \
  --port 8000
```

## See also

- [LLMProxy GitHub](https://github.com/aiyuekuang/LLMProxy) - Source code and full documentation
- [Model Providers](/concepts/model-providers) - Overview of all providers
- [Ollama](/providers/ollama) - Local LLM runtime (can be used as LLMProxy backend)
- [Configuration](/gateway/configuration) - Full OpenClaw config reference
