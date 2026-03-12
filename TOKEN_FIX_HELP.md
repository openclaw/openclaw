# ⚡ Quick Fix: OpenClaw Token Counters Stuck at 0

**5-minute fix** for OpenClaw 2026.3.8 users with Ollama cloud models.

---

## 🚨 Symptom Check

Your status bar looks like this?
```
🧮 Tokens: 0 in / 0 out
📚 Context: 0/131k (0%)
```

**You have the bug.** Keep reading.

---

## 🔧 The Fix (3 Steps)

### 1️⃣ Open `openclaw.json`
```
C:\Users\YourName\.openclaw\openclaw.json
```

### 2️⃣ Find & Replace
Search for: `"api": "openai-responses"`  
Replace with: `"api": "ollama"`

**Do this in TWO places:**
- Provider block
- Model block

### 3️⃣ Restart Gateway
```bash
openclaw gateway restart
```

---

## ✅ Done? Verify

Ask a question or run any task. You should see **real numbers**:
```
🧮 Tokens: 34k in / 64 out
📚 Context: 34k/131k (26%)
```

---

## 🆘 Windows Task Error?

If `gateway restart` fails with *"Scheduled Task disabled"*:

1. **Kill it:** `Ctrl+C`
2. **Start fresh:** `openclaw gateway`

---

## 📋 Why This Works

OpenClaw was trying to parse **OpenAI-style headers** from Ollama responses. They don't match. Switching to `api: "ollama"` tells OpenClaw to use the **native Ollama parser** that actually reads the token metadata.

---

## 🎯 What This Fixes

- ✅ Token counters track real usage
- ✅ Compaction can fire (prevents session degradation)
- ✅ Memory flush triggers work
- ✅ Context pruning active
- ✅ You're no longer flying blind

---

## 📞 Need More Help?

See the full guide: `TOKEN_FIX_GUIDE.md` (same folder)

**Community:** https://discord.com/invite/clawd  
**Docs:** https://docs.openclaw.ai

---

**Quick reference card** — print this, share it, stick it on your wiki.  
**Created:** 2026-03-11 | **Tested:** ✅ Working
