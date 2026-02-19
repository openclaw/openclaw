# Testing the Research Chatbot + Ollama Integration

Comprehensive guide to verify the research chatbot works correctly with your local Ollama instance.

## Quick Start

**Run all tests at once:**

```bash
./scripts/test-research-ollama.sh
```

This script performs 8 tests and provides a detailed report. It takes ~2-5 minutes depending on Ollama model speed.

---

## Manual Testing Methods

### 1. Unit Tests (No Ollama Required)

These tests use mocked Ollama responses and verify the logic is correct.

```bash
# Test core chatbot logic
pnpm test src/lib/research-chatbot.test.ts

# Test Ollama integration (mocked)
pnpm test src/lib/research-ollama.test.ts

# Run all tests
pnpm test
```

**Expected output:**

```
✓ 8 passed (research-chatbot.test.ts)
✓ 14+ passed (research-ollama.test.ts - mocked)
```

### 2. Ollama Connectivity Test

Verify Ollama is running and models are available:

```bash
# Check if Ollama API responds
curl http://127.0.0.1:11434/api/tags | jq '.models[] | .name'

# Expected output (example):
# "mistral-8b"
# "neural-chat"
# "llama2"
```

If curl fails or returns no models:

```bash
# Start Ollama
ollama serve

# In another terminal, pull a model
ollama pull mistral-8b
```

### 3. Direct Ollama API Test

Test the LLM inference endpoint directly:

```bash
curl -X POST http://127.0.0.1:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mistral-8b",
    "messages": [{"role": "user", "content": "What is machine learning?"}],
    "temperature": 0.7,
    "stream": false
  }' | jq '.choices[0].message.content'
```

**Expected:** A response from Mistral about machine learning (takes 2-5 seconds)

### 4. Interactive CLI Test

Test the research chatbot CLI with real Ollama responses:

```bash
# Start interactive chat
pnpm openclaw research --chat

# Follow prompts:
# 1. Enter research title: "My AI Research"
# 2. Enter summary: "Learning about LLMs"
# 3. Type your input:
#    User: "Main insight: LLMs learn from patterns in text"
#    Assistant: [Ollama generates response]
#    User: "add section"
#    Assistant: [Suggests new section]
#    User: /export
#    Assistant: [Export dialog]
#    User: /done to exit
```

**What to verify:**

- ✅ Ollama responses appear (not heuristic fallbacks)
- ✅ Responses are contextual (reference your research topic)
- ✅ Session ID displayed at top
- ✅ Commands work: `/show`, `/export`, `/help`, `/done`

### 5. MCP Server Test

Test the MCP server responds to tool calls:

```bash
# Terminal 1: Start MCP server
node dist/lib/research-mcp-server.js

# Terminal 2: Send a tool call
echo '{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "research_create_session",
    "arguments": {"title": "Test Research"}
  }
}' | nc localhost 127.0.0.1 11434

# OR use curl to a different process:
# Terminal 2: In bash
cat <<'EOF' > /tmp/mcp_request.jsonl
{"jsonrpc":"2.0","id":1,"method":"initialize"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"research_create_session","arguments":{"title":"Test"}}}
EOF

node dist/lib/research-mcp-server.js < /tmp/mcp_request.jsonl
```

**Expected output** (JSON-RPC responses):

```json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"...", ...}}
{"jsonrpc":"2.0","id":2,"result":{"tools":[{...6 tools...}]}}
{"jsonrpc":"2.0","id":3,"result":{"ok":true,"sessionId":"research-..."}}
```

---

## Test Scenarios

### Scenario A: Happy Path (Everything Works)

1. **Setup**

   ```bash
   ollama serve &
   ollama pull mistral-8b
   ```

2. **Test**

   ```bash
   ./scripts/test-research-ollama.sh
   ```

3. **Expected result:** ✅ All 8 tests pass

### Scenario B: Ollama Unavailable (Testing Fallback)

1. **Setup**

   ```bash
   # Don't start Ollama
   # OR stop it if running: killall ollama
   ```

2. **Test**

   ```bash
   pnpm test src/lib/research-ollama.test.ts
   # Mocked tests still pass because they don't call real Ollama
   ```

3. **Test CLI**

   ```bash
   pnpm openclaw research --chat
   # Type: "test message"
   # You should see a heuristic fallback response (pattern-matched)
   # NOT an error
   ```

4. **Expected result:** ✅ Graceful degradation, fallback responses work

### Scenario C: Large Model (Performance Test)

1. **Setup**

   ```bash
   ollama pull llama2      # Larger model (~7GB)
   ```

2. **Test**

   ```bash
   time curl -X POST http://127.0.0.1:11434/v1/chat/completions \
     -H "Content-Type: application/json" \
     -d '{"model":"llama2","messages":[{"role":"user","content":"test"}],"stream":false}' \
     | jq '.choices[0].message.content'
   ```

3. **Expected result:**
   - Mistral: ~2-5 seconds
   - Llama2: ~5-15 seconds (depending on GPU)
   - If much slower (>30s), model may be too large for your PC

### Scenario D: Streaming Responses

1. **Test streaming endpoint**

   ```bash
   curl -X POST http://127.0.0.1:11434/v1/chat/completions \
     -H "Content-Type: application/json" \
     -d '{
       "model": "mistral-8b",
       "messages": [{"role": "user", "content": "Write a haiku about AI"}],
       "stream": true
     }'
   ```

2. **Expected output:** Response arrives in chunks:
   ```
   data: {"choices":[{"delta":{"content":"AI"}}]}
   data: {"choices":[{"delta":{"content":" learns"}}]}
   data: {"choices":[{"delta":{"content":" patterns"}}]}
   ...
   data: [DONE]
   ```

---

## Debugging Failed Tests

### Test: "Ollama not responding"

**Symptom:** Connection refused

```bash
# 1. Check if Ollama is running
ps aux | grep ollama

# 2. If not running, start it
ollama serve

# 3. If running but not responding, check port
lsof -i :11434

# 4. If different port, update OLLAMA_BASE_URL in:
# src/lib/research-ollama.ts (line 5)
```

### Test: "No models available"

**Symptom:** Empty model list

```bash
# 1. Check available models
ollama list

# 2. If list is empty, pull a model
ollama pull mistral-8b        # ~7GB
# OR smaller alternatives:
ollama pull phi               # ~2.5GB (fastest)
ollama pull neural-chat       # ~7GB (good for chat)
```

### Test: "Response time slow"

**Symptom:** First response takes >30 seconds

```bash
# 1. Check if Ollama is using GPU
# macOS: GPU automatic
# Linux: nvidia-smi or rocm-smi to see GPU usage
nvidia-smi

# 2. Try a smaller model
ollama pull mistral-8b

# 3. Check system resources
top  # (or Activity Monitor on macOS)
free -h  # RAM usage

# 4. If CPU 100%: model might be too large
#    Recommend: mistral-8b or smaller
```

### Test: "Fallback responses instead of Ollama"

**Symptom:** Getting pattern-matched responses, not from Ollama

```bash
# 1. Verify Ollama responding
curl http://127.0.0.1:11434/api/tags

# 2. Check logs (if running interactively)
# Look for warning in console:
# "Ollama generation failed: ..."

# 3. Try direct API call
curl -X POST http://127.0.0.1:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"mistral-8b","messages":[{"role":"user","content":"hi"}],"stream":false}'

# 4. If that works but chatbot still shows fallbacks:
#    Check MODEL name in src/lib/research-ollama.ts (default: mistral-8b)
```

### Test: "MCP server not responding"

**Symptom:** No output from MCP server

```bash
# 1. Verify server starts
node dist/lib/research-mcp-server.js &
sleep 2
jobs

# 2. Send test message
echo '{"jsonrpc":"2.0","id":1,"method":"initialize"}' | node dist/lib/research-mcp-server.js

# 3. Check compilation
pnpm build

# 4. If errors, check imports in src/lib/research-mcp-server.ts
grep -n "import.*ollama" src/lib/research-mcp-server.ts
```

---

## Continuous Testing

### Watch Mode (Auto-rerun on file change)

```bash
# Terminal 1: Watch TypeScript compilation
pnpm build --watch

# Terminal 2: Watch tests
pnpm test --watch src/lib/research-ollama.test.ts
```

### Integration Test in CI/CD

```bash
# Full pipeline (build + test)
pnpm build && pnpm test

# Only integration tests
pnpm test:integration  # (if configured in package.json)
```

---

## Test Coverage

**Current test coverage:**

| Module                       | Unit Tests    | Integration | Notes                           |
| ---------------------------- | ------------- | ----------- | ------------------------------- |
| research-chatbot.ts          | ✅ 8 tests    | ✅ CLI test | Core logic tested               |
| research-ollama.ts           | ✅ 14+ mocked | ⏳ Manual   | Ollama calls tested with mocks  |
| research-chat-interactive.ts | ⏳ Planned    | ✅ CLI      | Interactive flow needs e2e test |
| research-mcp-server.ts       | ⏳ Planned    | ⏳ Manual   | MCP protocol needs test         |

**Phase 2 will add:**

- E2E CLI tests
- MCP protocol tests
- Streaming response tests
- Persistent session storage tests

---

## Performance Benchmarks

Expected response times on modern PC:

| Model       | Size  | First Response | Subsequent | GPU          | CPU           |
| ----------- | ----- | -------------- | ---------- | ------------ | ------------- |
| mistral-8b  | 7GB   | 3-5s           | 2-4s       | 🟢 Fast      | 🟡 Medium     |
| neural-chat | 7GB   | 3-5s           | 2-4s       | 🟢 Fast      | 🟡 Medium     |
| phi         | 2.5GB | 1-2s           | 1-2s       | 🟢 Very Fast | 🟡 Light      |
| llama2      | 7GB   | 5-10s          | 4-8s       | 🟡 Medium    | 🟠 Heavy      |
| llama2-13b  | 13GB  | 10-20s         | 8-15s      | 🔴 Slow      | 🔴 Very Heavy |

---

## Checklist: Full Test Suite

```
Before Deployment
─────────────────
☐ Ollama running: ollama serve
☐ Model available: ollama list (shows at least 1)
☐ Build passes: pnpm build ✔
☐ Unit tests pass: pnpm test (8/8)
☐ CLI works: pnpm openclaw research --chat
  ☐ Chat responds (type a question)
  ☐ Response is from Ollama (contextual, not fallback)
  ☐ /export command works
  ☐ /done exits cleanly
☐ MCP server starts: node dist/lib/research-mcp-server.js
  ☐ Responds to initialize message
  ☐ Responds to tools/list
  ☐ Creates sessions
☐ Performance acceptable (first response <10s, typical <5s)
☐ Fallback works (kill Ollama, chat still responds)

Ready for Use!
──────────────
```

---

## Questions & Support

**Q: My PC is too slow, what model should I use?**

- Try `phi` (2.5GB) or `neural-chat` (7GB)
- Check GPU: `nvidia-smi` or `rocm-smi`
- If no GPU, use small models

**Q: Can I use a different LLM engine?**

- Yes! Edit `src/lib/research-ollama.ts` to call any API
- Or use OpenAI, Anthropic, Groq endpoints
- Just replace the `fetch()` call

**Q: How do I test with Claude Desktop?**

- Add MCP server to `claude_desktop_config.json`
- Ask Claude to create research documents
- Claude will call your MCP server → Ollama responses

**Q: Can I see Ollama request/response?**

- Set `DEBUG=*` environment variable
- Or check Ollama shell logs: `ollama serve`
- Or add `console.log` in `research-ollama.ts` for debugging

**Q: Test passes but responses seem wrong?**

- Check system prompt is appropriate
- Try with different model: `ollama pull neural-chat`
- Adjust temperature in CLI code (~0.5 = focused, ~0.9 = creative)

---

## Next Steps

✅ **Phase 1 (Current):** Unit tests + mocked integration tests  
🔄 **Phase 2:** E2E tests, MCP protocol tests, performance tests  
🔄 **Phase 3:** Stress tests, concurrent session tests, persistence tests

**Start testing now:**

```bash
./scripts/test-research-ollama.sh
```
