---
summary: "Run Nebius models (GLM-4.7, Qwen3) via LiteLLM proxy"
read_when:
  - You want to use Nebius Token Factory models with OpenClaw
  - You need an OpenAI-compatible proxy for Nebius API
  - You want to avoid proprietary API rate limits and costs
title: "LiteLLM + Nebius"
---

# OpenClaw + Nebius (via LiteLLM) - Zero-BS Setup

This is the fastest, least painful way to run Nebius models (e.g. GLM-4.7) inside OpenClaw using LiteLLM as the OpenAI-compatible proxy.

---

## Architecture (don't overthink it)

```
OpenClaw -> LiteLLM (localhost:4000) -> Nebius API
```

OpenClaw only ever talks OpenAI-style JSON. LiteLLM translates that to Nebius.

---

## 1) Install & run LiteLLM (systemd)

### /etc/litellm/config.yaml
```yaml
model_list:
  - model_name: glm-4.7
    litellm_params:
      model: nebius/zai-org/GLM-4.7-FP8
      api_base: https://api.studio.nebius.com/v1
      api_key: YOUR_NEBIUS_API_KEY

general_settings:
  master_key: sk-litellm-local

litellm_settings:
  drop_params: true       # Nebius rejects OpenAI-only params (store, etc)
  disable_streaming: true # prevents content=null responses
```

### Start / restart
```bash
systemctl restart litellm
systemctl status litellm --no-pager
```

### Sanity check
```bash
curl -s http://127.0.0.1:4000/v1/models \
  -H "Authorization: Bearer sk-litellm-local" | jq
```

You must see: `{"id":"glm-4.7"}`

---

## 2) Configure OpenClaw to use LiteLLM

### ~/.openclaw/openclaw.json
```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "litellm/glm-4.7"
      }
    }
  },
  "models": {
    "providers": {
      "litellm": {
        "baseUrl": "http://127.0.0.1:4000/v1",
        "apiKey": "sk-litellm-local",
        "api": "openai-completions",
        "models": [
          {
            "id": "glm-4.7",
            "name": "GLM-4.7 (Nebius via LiteLLM)",
            "contextWindow": 128000,
            "maxTokens": 8192
          }
        ]
      }
    }
  }
}
```

### Validate JSON
```bash
jq . ~/.openclaw/openclaw.json >/dev/null && echo OK
# or if jq is not available, try:
node -e 'require("fs").readFileSync(process.argv[1], "utf8"); console.log("OK")' ~/.openclaw/openclaw.json
```

---

## 3) Restart OpenClaw gateway (MANDATORY)

If you don't do this, nothing changes.

```bash
systemctl restart openclaw-gateway
systemctl status openclaw-gateway --no-pager
```

---

## 4) Verify OpenClaw sees the model

```bash
openclaw models list
openclaw models set litellm/glm-4.7
```

Test locally:
```bash
openclaw agent --message "Reply with exactly: ok"
```

If this works, Telegram/UI will work.

---

## 5) Common failure causes (read once)

### content: null
**Cause:** streaming / reasoning-only responses
**Fix:** `disable_streaming: true`

### UnsupportedParamsError: store
**Cause:** OpenAI-only params
**Fix:** `drop_params: true`

### Model shows but doesn't reply
**Cause:** gateway not restarted
**Fix:** `systemctl restart openclaw-gateway`

### JSON "Extra data" error
**Cause:** stray `}` or trailing commas
**Fix:** `jq . openclaw.json` or `node -e 'JSON.parse(require("fs").readFileSync("openclaw.json", "utf8"))'`

---

## 6) Known-good test curl

```bash
curl -s http://127.0.0.1:4000/v1/chat/completions \
  -H "Authorization: Bearer sk-litellm-local" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-4.7",
    "messages": [{"role":"user","content":"Reply with exactly: ok"}],
    "max_tokens": 50,
    "temperature": 0
  }' | jq -r '.choices[0].message.content'
```

---

## TL;DR (tattoo this)

* LiteLLM is the bridge
* `drop_params: true`
* `disable_streaming: true`
* Restart both LiteLLM and OpenClaw gateway
* Validate JSON every time

If it passes curl -> it will work in OpenClaw.