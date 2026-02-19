# Comprehensive Testing Strategy for Research Chatbot + Ollama

## Overview

The research chatbot integrates with your local Ollama instance. This document explains how to test it at different levels to ensure everything works correctly.

---

## Test Levels & Methods

### Level 1: Unit Tests (Mocked)

**What it tests:** Core logic without external dependencies  
**Run time:** ~10 seconds  
**Ollama needed:** ❌ No

```bash
# Run all unit tests
pnpm test

# Or specific test files:
pnpm test src/lib/research-chatbot.test.ts           # 8 tests
pnpm test src/lib/research-ollama.test.ts            # 17 tests (mocked)
pnpm test src/lib/research-mcp-server.test.ts        # 38 tests
pnpm test src/cli/research-chat-interactive.test.ts  # 44 tests
# Total: 108 tests
```

**What's verified:**

- ✅ Session creation and management
- ✅ Chat turn handling
- ✅ Document formatting
- ✅ Export logic (Markdown/JSON)
- ✅ Ollama API call construction
- ✅ Error handling and fallbacks
- ✅ Streaming response parsing
- ✅ Parameter handling (model, temperature, etc.)
- ✅ MCP protocol implementation
- ✅ CLI command parsing and execution

**Expected output:**

```
Test Files  5 passed (5)
Tests       108 passed (108)
Duration    ~10s
```

---

### Level 2: Smoke Tests (Real Ollama Integration)

**What it tests:** Real Ollama instance integration  
**Run time:** ~90 seconds  
**Ollama needed:** ✅ Yes (must be running)

```bash
# Run smoke tests with real Ollama
OLLAMA_SMOKE_TEST=1 pnpm test research-ollama.smoke.test.ts  # 9 tests
```

**What's verified:**

1. ✅ Ollama server is accessible
2. ✅ Models are available and enumerated
3. ✅ Simple prompt responses work
4. ✅ Research response generation works
5. ✅ Multi-turn conversations work
6. ✅ Response time is acceptable
7. ✅ Error handling gracefully falls back
8. ✅ Dynamic model detection works
9. ✅ Streaming (if enabled) works

**Expected output:**

```
✓ src/lib/research-ollama.smoke.test.ts (9 tests) ~90s
  ✓ should call Ollama with simple prompt
  ✓ should generate research response
  ✓ should handle multi-turn conversation
  ✓ should respond within reasonable time
  ✓ should handle invalid model gracefully
  [5 more tests...]

Test Files  1 passed (1)
Tests       9 passed (9)
Duration    ~90s
```

**Key Note:** Smoke tests automatically detect and use the first available model on your Ollama instance. No hardcoded model names.

---

### Level 3: Manual Testing (Interactive)

**What it tests:** User-facing experience  
**Run time:** 5-10 minutes  
**Ollama needed:** ✅ Yes (must be running)

#### 3a. CLI Chat Test

```bash
# Start interactive chat
pnpm openclaw research --chat

# Follow prompts:
```

**Test steps:**

1. Enter title: "Test Research on AI"
2. Enter summary: "Exploring machine learning"
3. Chat normally:

   ```
   User: "Machine learning uses pattern recognition"
   Assistant: [Should respond with Ollama, not fallback]

   User: "add section"
   Assistant: [Should suggest sections]

   User: "/show"
   Assistant: [Should display current document]

   User: "/export"
   [Choose format and location]

   User: "/done"
   [Should exit cleanly]
   ```

**What to verify:**

- ✅ Responses are contextual (not generic fallback)
- ✅ Responses reference your research topic
- ✅ Commands work (/show, /export, /help, /done)
- ✅ No errors or crashes
- ✅ Response time reasonable (2-5 seconds)

#### 3b. MCP Server Test

```bash
# Terminal 1: Start MCP server
node dist/lib/research-mcp-server.js

# Terminal 2: Send test requests
cat <<'EOF' | node dist/lib/research-mcp-server.js
{"jsonrpc":"2.0","id":1,"method":"initialize"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"research_create_session","arguments":{"title":"Test"}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"research_add_message","arguments":{"sessionId":"research-...","content":"Test message"}}}
EOF
```

**What to verify:**

- ✅ Server starts without errors
- ✅ Responds to initialize
- ✅ Lists all 6 tools
- ✅ Creates sessions
- ✅ Adds messages and generates responses
- ✅ Uses Ollama for responses

#### 3c. Ollama API Test

```bash
# Check Ollama is accessible and list available models
curl http://127.0.0.1:11434/api/tags | jq '.models[].name'

# Test direct chat completion (use first available model or replace MODEL_NAME)
MODEL_NAME=$(curl -s http://127.0.0.1:11434/api/tags | jq -r '.models[0].name')
curl -X POST http://127.0.0.1:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "'$MODEL_NAME'",
    "messages": [{"role": "user", "content": "What is AI?"}],
    "stream": false
  }' | jq '.choices[0].message.content'
```

**What to verify:**

- ✅ Ollama responds on `http://127.0.0.1:11434`
- ✅ Models are available
- ✅ Chat completion endpoint works
- ✅ Response quality is good

---

## Test Scenarios

### Happy Path (Everything Works)

```bash
# 1. Ensure Ollama is running
ollama serve &

# 2. Ensure at least one model is available
ollama list

# 3. Run unit tests (no Ollama needed)
pnpm test                           # 108 unit tests: ✅ All pass

# 4. Run smoke tests (real Ollama)
OLLAMA_SMOKE_TEST=1 pnpm test research-ollama.smoke.test.ts  # 9 tests: ✅ All pass

# 5. Manual verification
pnpm openclaw research --chat      # ✅ Works smoothly
node dist/lib/research-mcp-server.js  # ✅ Responds to requests

# Expected: ✅ Full green across all tests
```

### Ollama Unavailable (Testing Fallback)

```bash
# Don't start Ollama (or kill it)
killall ollama

# 1. Unit tests still pass (they're mocked)
pnpm test src/lib/research-ollama.test.ts        # ✅ 17 passed

# 2. Smoke tests gracefully skip (Ollama not running)
OLLAMA_SMOKE_TEST=1 pnpm test research-ollama.smoke.test.ts     # ⚠️ Skipped
                                                  # (Ollama required)

# 3. CLI still works (with fallback responses)
pnpm openclaw research --chat                   # ✅ Works
# Responses are pattern-matched, not from Ollama
# But user can still use the system

# Expected: ✅ Graceful degradation
```

### Performance Testing

```bash
# Test first response time
time curl -X POST http://127.0.0.1:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mistral-8b",
    "messages": [{"role": "user", "content": "test"}],
    "stream": false
  }' > /dev/null

# Test CLI response time
time ( echo "Q1 revenue up 15%" | pnpm openclaw research --chat ) 2>&1
```

**Expected times:**

- **Mistral-8b:** 1-5 seconds first response, 2-4 seconds subsequent
- **Llama2:** 5-15 seconds (depends on GPU)
- **Phi:** 1-2 seconds (smallest/fastest)

---

## Debugging Failed Tests

### Issue: Tests Fail with "Ollama not found"

```bash
# 1. Check if Ollama is running
curl http://127.0.0.1:11434/api/tags

# 2. If failed, start Ollama
ollama serve

# 3. In another terminal, pull a model
ollama pull mistral-8b

# 4. Rerun tests
pnpm test src/lib/research-ollama.test.ts
```

### Issue: "No models available"

```bash
# 1. List installed models
ollama list

# 2. If empty, pull one
ollama pull mistral-8b        # Recommended
ollama pull phi              # Smaller/faster

# 3. Verify it's available
curl http://127.0.0.1:11434/api/tags | jq '.models[].name'
```

### Issue: Response Time Slow (>10 seconds)

```bash
# 1. Check model size
ollama list

# 2. Try smaller model
ollama pull mistral-8b  # 7GB - good balance

# 3. Check system resources
top              # CPU usage
free -h          # RAM usage

# 4. Check if GPU is available
nvidia-smi       # NVIDIA
rocm-smi         # AMD
# (macOS uses GPU automatically)
```

### Issue: Build Fails

```bash
# 1. Check TypeScript errors
pnpm build 2>&1 | grep -A5 ERROR

# 2. Check imports are correct
grep "research-ollama" src/lib/research-mcp-server.ts
grep "research-ollama" src/cli/research-chat-interactive.ts

# 3. Rebuild clean
rm -rf dist
pnpm build
```

### Issue: CLI Crashes or Returns Errors

```bash
# 1. Try with verbose logging
DEBUG=* pnpm openclaw research --chat

# 2. Check Ollama is responding
curl http://127.0.0.1:11434/api/tags

# 3. Try direct API call
curl -X POST http://127.0.0.1:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"mistral-8b","messages":[{"role":"user","content":"hi"}]}'

# 4. Check fallback works
killall ollama && pnpm openclaw research --chat
# Should still work with pattern-matched responses
```

---

## Test Automation

### Pre-commit Hook

```bash
# Add to .git/hooks/pre-commit
#!/bin/bash
pnpm build || exit 1
pnpm test src/lib/research-*.test.ts || exit 1
```

### CI/CD Pipeline

```yaml
# .github/workflows/research-tests.yml
name: Research Tests
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: pnpm/action-setup@v2
      - run: pnpm install
      - run: pnpm build
      - run: pnpm test src/lib/research-*.test.ts
```

---

## Coverage Summary

| Component                    | Unit Tests | Smoke Tests | Manual        | Status      |
| ---------------------------- | ---------- | ----------- | ------------- | ----------- |
| research-chatbot.ts          | ✅ 8       | ✅ Included | ✅ CLI        | 🟢 Complete |
| research-ollama.ts           | ✅ 17      | ✅ 9 tests  | ✅ Direct API | 🟢 Complete |
| research-mcp-server.ts       | ✅ 38      | ✅ Included | ✅ JSON-RPC   | 🟢 Complete |
| research-chat-interactive.ts | ✅ 44      | ✅ Included | ✅ CLI        | 🟢 Complete |
| End-to-End                   | -          | ✅ 9 tests  | ✅ Manual     | 🟢 Complete |

**Total Test Count:**

- Unit Tests: 108 (all passing)
- Smoke Tests: 9 (all passing when Ollama running)
- **Total: 117 tests**

**Test Coverage:**

- All critical paths tested
- Error handling validated
- Dynamic model detection verified
- Multi-turn conversations tested
- Performance benchmarked

---

## Running All Tests

```bash
# Quick test - unit tests only (10 seconds)
pnpm test

# Full integration - includes real Ollama tests (2-3 minutes)
pnpm build && pnpm test && OLLAMA_SMOKE_TEST=1 pnpm test research-ollama.smoke.test.ts

# Everything including manual
pnpm build && pnpm test && OLLAMA_SMOKE_TEST=1 pnpm test research-ollama.smoke.test.ts && pnpm openclaw research --chat
```

---

## Test Status Dashboard

```bash
# Run full test suite with verbose output
pnpm test --reporter=verbose

# Run only smoke tests
OLLAMA_SMOKE_TEST=1 pnpm test research-ollama.smoke.test.ts --reporter=verbose

# Check specific test file
pnpm test src/lib/research-ollama.test.ts --reporter=verbose
```

---

## Questions?

**Why do unit tests pass but integration fails?**

- Unit tests are mocked. Integration test likely means Ollama not running.
- Solution: `ollama serve` in another terminal

**Why are responses slow?**

- Model might be too large for your PC
- GPU might not be available
- Solution: Try `ollama pull mistral-8b` or smaller

**How do I test with my own AI engine?**

- Modify `src/lib/research-ollama.ts` to call your engine
- Keep the same interface (async function returning string)
- Update the OLLAMA_BASE_URL or API endpoint

**Can I run tests with different models?**

- Yes! Pass model name in options: `generateOllamaResearchResponse(msg, session, { model: "llama2" })`
- Or set in CLI via environment variable (Phase 2 feature)

**How do I benchmark performance?**

- Use `time` command
- Check response times in logs
- Compare different models: `ollama pull mistral-8b` vs `ollama pull phi`
