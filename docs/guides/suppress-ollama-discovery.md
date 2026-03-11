# Suppress Ollama Auto-Discovery

OpenClaw automatically discovers local Ollama instances by polling
`http://127.0.0.1:11434/api/tags`. If you don't use Ollama, this
produces repeated warnings in your gateway logs:

```
[agents/model-providers] Failed to discover Ollama models: TypeError: fetch failed
```

## Fix

### Option 1: Environment Variable

Set before starting the gateway:

```bash
export OPENCLAW_OLLAMA_DISABLED=1
openclaw gateway
```

On Windows (PowerShell):
```powershell
$env:OPENCLAW_OLLAMA_DISABLED = "1"
openclaw gateway
```

### Option 2: Config

In `openclaw.json`:

```json5
{
  models: {
    ollamaDiscovery: {
      enabled: false
    }
  }
}
```

### Option 3: Firewall (workaround for unpatched versions)

Block port 11434 so the discovery fetch fails instantly instead of
timing out over 5 seconds:

```powershell
# Windows
New-NetFirewallRule -DisplayName "Block Ollama Discovery" -Direction Outbound -Protocol TCP -RemotePort 11434 -Action Block

# Linux
sudo nft add rule inet filter output tcp dport 11434 reject
```

## Also: vLLM

Same env var pattern for vLLM auto-discovery:

```bash
export OPENCLAW_VLLM_DISABLED=1
```

## When You DO Use Ollama

If you're running Ollama on a non-standard port, configure it explicitly
instead of relying on auto-discovery:

```json5
{
  models: {
    providers: {
      ollama: {
        baseUrl: "http://127.0.0.1:54144/v1",
        api: "ollama",
        models: [
          { id: "llama3:8b", name: "llama3:8b" }
        ]
      }
    }
  }
}
```

Explicit models skip discovery entirely — no network probes needed.
