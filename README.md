# Per-Agent TTS Voice Configuration

Configure unique TTS (Text-to-Speech) voice and model settings per agent, with sensible defaults and inheritance.

## Features

- Per-agent voice/model configuration with defaults
- Configuration inheritance (agent → group → global defaults)
- Validation of voice/model combinations
- YAML-based configuration
- CLI for testing voices and managing config
- REST API for runtime voice resolution
- Async TTS synthesis with provider abstraction

## Quick Start

bash
pip install -e .


### Configure agents

Edit config.yaml:

yaml
defaults:
  provider: openai
  model: tts-1
  voice: alloy
  speed: 1.0
  response_format: mp3

agents:
  customer_support:
    voice: nova
    speed: 0.9
  narrator:
    provider: elevenlabs
    model: eleven_multilingual_v2
    voice: rachel


### CLI Usage

bash
# Resolve voice config for an agent
agent-tts resolve customer_support

# List available voices per provider
agent-tts voices openai

# Synthesize speech
agent-tts speak narrator "Hello, welcome to the story."

# Validate configuration
agent-tts validate

# Start API server
agent-tts serve --port 8000


### API Usage

bash
# Resolve agent voice config
curl http://localhost:8000/agents/narrator/voice

# Synthesize
curl -X POST http://localhost:8000/synthesize \
  -H "Content-Type: application/json" \
  -d '{"agent_id": "narrator", "text": "Hello world"}' \
  --output speech.mp3


## Configuration Hierarchy

Resolution order (first defined wins):

1. Agent-level overrides
2. Group-level defaults (if agent belongs to a group)
3. Global defaults

## Supported Providers

| Provider | Models | Voices |
|----------|--------|--------|
| openai | tts-1, tts-1-hd | alloy, echo, fable, onyx, nova, shimmer |
| elevenlabs | eleven_multilingual_v2, eleven_turbo_v2 | rachel, adam, antoni, bella, domi, elli, josh, sam |
| google | standard, wavenet, neural2 | en-US-Standard-A through J, en-US-Wavenet-A through J |

## Testing

bash
pytest