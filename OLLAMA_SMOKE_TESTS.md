# Ollama Smoke Tests

These smoke tests verify that the research chatbot works correctly with a **real Ollama instance** (not mocked).

## Prerequisites

1. **Install Ollama**: https://ollama.ai

2. **Start Ollama server**:

   ```bash
   ollama serve
   ```

   This runs on `http://127.0.0.1:11434` by default.

3. **Install at least one model**:
   ```bash
   ollama pull mistral
   # or qwen2.5-coder, llama2, neural-chat, startcoder, etc.
   ```
   The smoke tests will automatically detect and use the first available model.

## Running Smoke Tests

Run the smoke tests with:

```bash
OLLAMA_SMOKE_TEST=1 pnpm test research-ollama.smoke.test.ts
```

### View just the smoke tests:

```bash
OLLAMA_SMOKE_TEST=1 pnpm test research-ollama.smoke.test.ts --reporter=verbose
```

### Skip mocked tests, run only smoke tests:

```bash
OLLAMA_SMOKE_TEST=1 pnpm test --include "**/*.smoke.test.ts"
```

## What Gets Tested

✅ **Connectivity**: Verifies Ollama is running and accessible  
✅ **Model Management**: Lists available models  
✅ **LLM Interaction**: Calls Ollama with real prompts  
✅ **Multi-turn Conversation**: Tests research session with context  
✅ **Performance**: Ensures responses come back in reasonable time  
✅ **Error Handling**: Validates graceful failure modes

## Expected Output

Successful run:

```
✓ src/lib/research-ollama.smoke.test.ts (8 tests) 45,234ms
  ✓ should connect to running Ollama instance
  ✓ should list available models
  ✓ should have at least one model available
  ✓ should call Ollama with simple prompt (8,234ms)
  ✓ should generate research response (12,567ms)
  ✓ should handle multi-turn conversation (24,433ms)
  ✓ should respond within reasonable time (4,234ms)
  ✓ should handle invalid model gracefully (2,105ms)
```

Failed run (Ollama not running):

```
⚠️  Ollama is not running on http://127.0.0.1:11434. Start it with: ollama serve

Tests are SKIPPED because Ollama is unavailable.
```

## Troubleshooting

### "Connection refused" errors

```bash
# Start Ollama
ollama serve
```

### "Model not found" errors

```bash
# Install a model (tests will auto-detect and use it)
ollama pull mistral
# or: ollama pull qwen2.5-coder
```

The smoke tests automatically detect available models at runtime; no hardcoded model names are used.

### Slow responses

- Ollama is CPU/GPU intensive
- First request primes the model (slower)
- Subsequent requests are faster
- GPU support speeds up significantly

### Port already in use

Ollama defaults to `:11434`. If busy, check what's running:

```bash
lsof -i :11434
```

## Unit Tests vs Smoke Tests

| Aspect          | Unit Tests        | Smoke Tests                     |
| --------------- | ----------------- | ------------------------------- |
| Ollama Required | ❌ No (mocked)    | ✅ Yes (real)                   |
| Run via         | `pnpm test`       | `OLLAMA_SMOKE_TEST=1 pnpm test` |
| Speed           | Fast (~100ms)     | Slow (~30-120s)                 |
| Verifies        | Logic correctness | Real integration                |
| CI/CD           | Always run        | Manual only                     |

## CI/CD Integration

For production CI/CD, **keep smoke tests disabled** (don't set `OLLAMA_SMOKE_TEST=1`). This avoids:

- Requiring Ollama installation in CI
- Long test times
- External service dependency

Use smoke tests for:

- Local development verification
- Pre-release validation
- Docker-based integration tests

## Example: Docker-based Smoke Testing

```dockerfile
FROM ollama/ollama:latest

# Pull model
RUN ollama pull mistral

# Copy code
COPY . /app
WORKDIR /app

# Install deps
RUN npm install

# Run smoke tests
CMD ollama serve & sleep 3 && OLLAMA_SMOKE_TEST=1 pnpm test research-ollama.smoke.test.ts
```

Then run:

```bash
docker build -t research-chatbot-smoke .
docker run research-chatbot-smoke
```

## Performance Benchmarks

On typical hardware (as reference):

| Operation            | Time          |
| -------------------- | ------------- |
| Connect check        | ~50ms         |
| List models          | ~100ms        |
| Simple prompt        | 2-5 seconds   |
| Research response    | 5-15 seconds  |
| Multi-turn (3 turns) | 15-30 seconds |

Times vary significantly based on:

- CPU/GPU (GPU much faster)
- Model size (larger = slower)
- System load
- Network latency (local = instant)
