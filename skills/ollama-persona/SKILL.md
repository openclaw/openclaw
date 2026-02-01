---
name: ollama-persona
description: Set up a local Ollama model with agent persona for cost-efficient posting.
metadata: { "openclaw": { "emoji": "🦙", "requires": { "bins": ["curl", "python3"] } } }
---

# Ollama Persona

Create a local LLM persona from workspace identity files for cheap, fast replies.

## Prerequisites

- NVIDIA GPU with 4GB+ VRAM (or CPU-only with 8GB+ RAM)
- ~3GB disk space for base model

## Quick Setup

### 1. Install Ollama

```bash
# Linux
curl -fsSL https://ollama.com/install.sh | sh

# macOS
brew install ollama

# Start server
ollama serve &
```

### 2. Generate Persona Model

Run the bundled script to create a model from your workspace identity:

```bash
python3 scripts/create_persona.py \
  --name "myagent" \
  --workspace /path/to/workspace \
  --base llama3.2:3b
```

The script reads `SOUL.md`, `IDENTITY.md`, and `USER.md` to build a system prompt.

### 3. Use the Model

```bash
# Quick prompt via curl
curl -s http://localhost:11434/api/generate \
  -d '{"model":"myagent","prompt":"Write a tweet","stream":false}' \
  | jq -r '.response'

# Or use the generated helper script (created at ~/.local/bin/ask-<name>)
ask-myagent "Write a tweet"
```

Note: The helper script is installed to `~/.local/bin/`. Ensure this is in your PATH.

## When to Use Local vs Cloud

| Task              | Local | Cloud |
| ----------------- | ----- | ----- |
| Tweets/posts      | ✅    |       |
| Simple summaries  | ✅    |       |
| Greentext replies | ✅    |       |
| Coding            |       | ✅    |
| Complex reasoning |       | ✅    |
| Multi-step tasks  |       | ✅    |

## Model Options

| Model       | Size  | VRAM | Speed  | Quality |
| ----------- | ----- | ---- | ------ | ------- |
| llama3.2:1b | 1.3GB | 2GB  | Fast   | Basic   |
| llama3.2:3b | 2GB   | 4GB  | Good   | Solid   |
| llama3.1:8b | 4.7GB | 8GB  | Slower | Better  |

## Customization

Edit the generated Modelfile at `~/.ollama/<name>.modelfile` to tune:

- `PARAMETER temperature` - Higher = more creative (0.7-1.0 for posts)
- `PARAMETER top_p` - Nucleus sampling (0.9 default)
- System prompt - Add catchphrases, topics, forbidden words

## Interactive Chat

For multi-turn conversations, use the chat script:

```bash
python3 scripts/chat.py myagent
```

Commands in chat:
- `quit` - Exit the chat
- `clear` - Reset conversation history

## Persona Templates

Pre-built templates for common use cases in `templates/`:

| Template | Use Case |
|----------|----------|
| `shitposter.md` | Social media, meme content, greentext |
| `shopkeeper.md` | In-game NPCs, service providers |
| `tinfoil.md` | Conspiracy-adjacent humor, pattern finding |

Copy relevant sections from templates into your system prompt for quick persona creation.

## Troubleshooting

- **Model too slow**: Try `llama3.2:1b` or enable GPU offloading
- **Out of memory**: Set `OLLAMA_NUM_GPU=0` for CPU-only
- **Server not running**: `ollama serve &` or check port 11434
- **Chat history too long**: Use `clear` command to reset context
