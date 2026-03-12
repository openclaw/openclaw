# 🔧 Fixing OpenClaw Token Tracking (Ollama Cloud)

**Version:** OpenClaw 2026.3.8 (3caab92)  
**Affected:** Users with custom Ollama providers (ollama.com cloud)  
**Symptom:** Context stuck at `0/131k (0%)` despite hours of activity

---

## 🚨 The Problem

In OpenClaw 2026.3.8, using the `openai-responses` API setting for ollama.com models causes OpenClaw to **ignore token metadata**. The model works fine, but the **Context bar stays at zero** because the data parser is looking for standard OpenAI headers that Ollama doesn't send.

### What You'll See
```
🧮 Tokens: 0 in / 0 out · 💵 Cost: $0.0000
📚 Context: 0/131k (0%) · 🧹 Compactions: 0
```

### Why It Matters
- **Compaction never fires** (token-based thresholds can't trigger)
- **Session degradation accelerates** (no context pruning, no memory flush)
- **You're flying blind** — can't see actual usage or costs

---

## ✅ The Solution: Switch to Native Ollama Parsing

You must update your `openclaw.json` file to use the **native `ollama` API type** instead of `openai-responses`.

---

## 📋 Step-by-Step Fix

### 1. Open Your Config
```
C:\Users\YourName\.openclaw\openclaw.json
```
(Or wherever your OpenClaw workspace lives)

### 2. Locate Your Custom Provider
Scroll to:
```json
"models": {
  "providers": {
    "custom-ollama-com": {
      ...
    }
  }
}
```

### 3. Change the API Labels
Find **both** occurrences of `"api": "openai-responses"` and change to `"api": "ollama"`:
- **Provider block** (top level)
- **Model block** (inside the models array)

---

## 📝 Corrected Config Snippet

```json
{
  "models": {
    "providers": {
      "custom-ollama-com": {
        "baseUrl": "https://ollama.com",
        "apiKey": "YOUR_KEY_HERE",
        "api": "ollama",
        "models": [
          {
            "id": "qwen3.5:397b-cloud",
            "name": "qwen3.5:397b-cloud (Custom Provider)",
            "api": "ollama",
            "reasoning": false,
            "input": ["text"],
            "cost": {
              "input": 0,
              "output": 0,
              "cacheRead": 0,
              "cacheWrite": 0
            },
            "contextWindow": 131072,
            "maxTokens": 16000
          }
        ]
      }
    }
  }
}
```

**Key changes:**
- `"api": "ollama"` in the provider block
- `"api": "ollama"` in the model block

---

## 🔄 Apply the Fix

### Option A: Gateway Restart (Recommended)
```bash
openclaw gateway restart
```

### Option B: Manual Restart (Windows Task Issues)
If you get *"Scheduled Task disabled"* error:
1. **Kill the gateway:** `Ctrl+C` in terminal
2. **Start fresh:** `openclaw gateway`

---

## ✅ Verify It Worked

Run any task that generates tokens (ask a question, run a skill, etc.). You should see:

```
🧮 Tokens: 34k in / 64 out · 💵 Cost: $0.0000
📚 Context: 34k/131k (26%) · 🧹 Compactions: 0
```

**Success!** Token counters are now tracking, compaction can fire, and you're no longer flying blind.

---

## 🧠 What Changed Under the Hood

| Before | After |
|--------|-------|
| `api: "openai-responses"` | `api: "ollama"` |
| OpenAI header parser (fails on Ollama) | Native Ollama parser (correct) |
| Token counters stuck at 0 | Real-time token tracking |
| Compaction disabled (no trigger) | Compaction active (time + token triggers) |
| Session degradation risk | Stable session management |

---

## 💡 Pro Tips

### For Other Custom Providers
This fix applies to **any** custom provider where:
- You're using a non-OpenAI backend
- Token counters show 0 despite activity
- The provider has native API support in OpenClaw

**Check available API types:** `openai`, `ollama`, `anthropic`, `google`, etc.

### Backup Before Editing
```bash
copy .openclaw\openclaw.json .openclaw\openclaw.json.backup
```

### Don't Break JSON
- Use a JSON validator (https://jsonlint.com)
- Watch for trailing commas
- Keep quotes balanced

---

## 📚 Related Issues

- **GitHub #1516** — Token counter bugs with custom providers
- **GitHub #17799** — Compaction not firing on token thresholds
- **OpenClaw Docs** — Custom provider configuration guide

---

## 🙏 Credits

**Fix discovered:** 2026-03-11 by Dale + Nova  
**Tested on:** OpenClaw 2026.3.8, qwen3.5:397b-cloud via ollama.com  
**Shared with:** OpenClaw community

---

**Last updated:** 2026-03-11  
**License:** CC-BY (share freely, credit appreciated)
