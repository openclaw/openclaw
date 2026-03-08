# Hand‑Off: Migrate OpenClaw From OpenAI to Ollama (8 GB GPU)

This document explains exactly how to switch my existing OpenClaw setup from the OpenAI API to **Ollama**, optimized for an 8 GB GPU.  The goal is that all agents and channels (like Telegram) use **local models only**, with **no further OpenAI usage**. [docs.openclaw](https://docs.openclaw.ai/providers/ollama)

***

## 1. Objectives

- Replace **OpenAI** as the primary model provider in OpenClaw with **Ollama**. [openclawcn](https://openclawcn.com/en/docs/providers/ollama/)
- Use **Llama 3.1 8B** as the main model and **Qwen 2.5 7B** as a fallback, both suitable for an 8 GB GPU. [localllm](https://localllm.in/blog/ollama-vram-requirements-for-local-llms)
- Keep all existing workflows (messages, tools, etc.) working with minimal changes.

***

## 2. Prerequisites

Please verify these before modifying config:

- OpenClaw is already installed and working (gateway running, Telegram bot connected). [ollama](https://ollama.com/blog/openclaw)
- Ollama is installed on the same machine and listening on the default:  
  `http://127.0.0.1:11434`. [docs.ollama](https://docs.ollama.com/quickstart)
- These models are pulled in Ollama (or equivalent tags shown in `ollama list`):  
  ```bash
  ollama pull llama3.1:8b
  ollama pull qwen2.5:7b
  ```  [docs.ollama](https://docs.ollama.com/quickstart)

If tags differ in the Ollama library (e.g., `llama3:8b` instead of `llama3.1:8b`), please use the **actual tags** returned by `ollama list`. [ollama](https://ollama.com/library)

***

## 3. Locate the OpenClaw Config

Find the OpenClaw config file that the gateway is using. Common locations: [datacamp](https://www.datacamp.com/tutorial/openclaw-ollama-tutorial)

- `$HOME/.config/openclaw/openclaw.json`, or  
- A project‑local config referenced by the `OPENCLAW_CONFIG_PATH` environment variable.

All edits below apply to that file.

***

## 4. Current (OpenAI‑based) Example Config

This is a simplified approximation of how my current config looks, with OpenAI as the primary provider:

```jsonc
{
  "models": {
    "providers": {
      "openai": {
        "apiKey": "sk-REDACTED",
        "baseUrl": "https://api.openai.com/v1",
        "api": "openai"
      }
    }
  },

  "agents": {
    "defaults": {
      "model": {
        "primary": "openai/gpt-4.1-mini"
      }
    },

    "agents": {
      "default": {
        "name": "Terrance Assistant",
        "model": {
          "primary": "openai/gpt-4.1-mini"
        }
      }
    }
  }
}
```

If my actual file is different, please **preserve everything unrelated** (tools, channels, memory, etc.) and only change the `models.providers` and `agents.*.model` sections as described next.

***

## 5. Target Config: Ollama as Primary Provider

### 5.1 Add Ollama provider

Add an `ollama` provider pointing at the local Ollama instance: [docs.openclaw](https://docs.openclaw.ai/providers/ollama)

```jsonc
{
  "models": {
    "providers": {
      "ollama": {
        "apiKey": "ollama-local",
        "baseUrl": "http://127.0.0.1:11434",
        "api": "ollama"
      },

      // Optional: keep OpenAI defined but no longer used
      "openai": {
        "apiKey": "sk-REDACTED",
        "baseUrl": "https://api.openai.com/v1",
        "api": "openai"
      }
    }
  }
}
```

Notes:

- Ollama itself does **not** require an API key; `"ollama-local"` is just a placeholder so OpenClaw accepts the provider. [openclawcn](https://openclawcn.com/en/docs/providers/ollama/)
- `baseUrl` must point to the Ollama host (here, localhost). [arsturn](https://www.arsturn.com/blog/understanding-the-base-url-in-ollama)

If the config is merged into a bigger JSON, ensure this block is merged under the existing `models.providers` object rather than overwriting unrelated providers.

### 5.2 Switch default agent to Ollama

Set my **default agent** and global **defaults** to use `llama3.1:8b` as primary, `qwen2.5:7b` as fallback: [localaimaster](https://localaimaster.com/blog/free-local-ai-models)

```jsonc
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "ollama/llama3.1:8b",
        "fallbacks": [
          "ollama/qwen2.5:7b"
        ]
      }
    },

    "agents": {
      "default": {
        "name": "Terrance Assistant",
        "model": {
          "primary": "ollama/llama3.1:8b",
          "fallbacks": [
            "ollama/qwen2.5:7b"
          ]
        }
      }

      // If other agents exist, please switch their `primary` to `ollama/llama3.1:8b`
      // unless there is a specific reason to keep them on another provider.
    }
  }
}
```

Important:

- Replace `llama3.1:8b` and `qwen2.5:7b` with the exact tags shown by `ollama list` if they differ (for example `llama3:8b`, `qwen2.5:7b-instruct`). [localaimaster](https://localaimaster.com/blog/free-local-ai-models)
- Ensure **no agent** still has a `primary` or `fallback` pointing to `openai/...` if we want to fully avoid OpenAI usage.

***

## 6. Stop Accidental OpenAI Usage

To make sure nothing silently falls back to OpenAI:

1. After confirming Ollama works, you may optionally remove the OpenAI provider:

   ```jsonc
   "models": {
     "providers": {
       "ollama": {
         "apiKey": "ollama-local",
         "baseUrl": "http://127.0.0.1:11434",
         "api": "ollama"
       }
     }
   }
   ```

2. Double‑check that in **all agents** (defaults and named agents):

   - `"primary"` starts with `"ollama/"`.  
   - `"fallbacks"` only contain `"ollama/...` entries.

3. Verify no external scripts (outside OpenClaw) are still calling OpenAI directly with the same key.

***

## 7. Restart and Validate

1. Restart the OpenClaw gateway so it reads the new config: [ollama](https://ollama.com/blog/openclaw)

   ```bash
   openclaw gateway --force
   ```

2. From my Telegram/OpenClaw bot, send a simple prompt like:

   > "Tell me which provider and model you are currently running on."

3. On the machine running Ollama, confirm that traffic is hitting it, for example by checking logs or watching CPU/GPU usage. [docs.openclaw](https://docs.openclaw.ai/providers/ollama)

4. In the OpenAI dashboard, confirm **no new API usage** appears after this migration.

***

## 8. Rollback Plan (If Needed)

If anything breaks and we need to temporarily fall back to OpenAI:

1. Change the default and agent models back to the original:

   ```jsonc
   "primary": "openai/gpt-4.1-mini"
   ```

2. Ensure `openai` is present again under `models.providers` with the correct API key.  
3. Restart the gateway and confirm messages are flowing again. [ollama](https://ollama.com/blog/openclaw)

***

## 9. Expected Deliverables

When you (Copilot / dev) are done:

- [ ] `openclaw.json` updated so **Ollama** is the primary provider.  
- [ ] All main agents use `ollama/llama3.1:8b` with `ollama/qwen2.5:7b` as fallback (or equivalent tags on my machine).  
- [ ] Telegram/OpenClaw bot responds correctly while Ollama is running.  
- [ ] OpenAI usage dashboard shows no additional API usage after the change.

***

## Quick Checklist for Agent Execution

1. **Before making changes:**
   - [ ] Confirm `~/.openclaw/openclaw.json` location and read permissions.
   - [ ] Run `ollama list` and verify `llama3.1:8b` and `qwen2.5:7b` (or your actual tags) are present.

2. **Making changes:**
   - [ ] Add Ollama provider block to `models.providers`.
   - [ ] Update `agents.defaults.model.primary` to `ollama/llama3.1:8b`.
   - [ ] Update `agents.defaults.model.fallbacks` to include `ollama/qwen2.5:7b`.
   - [ ] For each agent in `agents.agents.*`, update `model.primary` and `model.fallbacks` similarly.
   - [ ] Preserve all other config sections (tools, channels, memory, etc.).

3. **After changes:**
   - [ ] Restart gateway: `openclaw gateway --force`.
   - [ ] Test via Telegram bot with a simple prompt.
   - [ ] Monitor Ollama logs or CPU/GPU for traffic.
   - [ ] Verify OpenAI dashboard shows no new usage.

---

**File location:** `docs/integrations/ollama-handoff.md`
