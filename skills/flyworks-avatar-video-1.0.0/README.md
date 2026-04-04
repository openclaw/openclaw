# Flyworks Avatar Video Skill

An [Agent Skill](https://agentskills.io) for generating videos using [Flyworks](https://flyworks.ai) (a.k.a HiFly) Digital Humans.

## Features

- 🎬 **Public Avatar Video**: Create videos using pre-made realistic avatars with TTS
- 🖼️ **Talking Photo**: Turn any image into a talking video
- 🎙️ **Voice Cloning**: Clone voices from audio samples

## Installation

### Option 1: Using add-skill CLI (Recommended)

```bash
# Install globally
npx skills add Flyworks-AI/skills -a claude-code -g

# Or install to current project only
npx skills add Flyworks-AI/skills -a claude-code
```

Works with Claude Code, Cursor, Codex, and [other agents](https://github.com/vercel-labs/add-skill#available-agents).

### Option 2: Manual Installation

```bash
# Clone and symlink to your skills directory
git clone https://github.com/Flyworks-AI/skills.git
ln -s $(pwd)/skills/flyworks-avatar-video ~/.claude/skills/flyworks-avatar-video
```

### Option 3: Direct Copy

```bash
git clone https://github.com/Flyworks-AI/skills.git
cp -r skills/flyworks-avatar-video ~/.claude/skills/
```

## Quick Start

### 1. Install Dependencies

```bash
pip install -r requirements.txt
```

### 2. Try it out (with demo token)

The skill includes a demo token for testing (30s limit, watermarked videos):

```bash
# List available avatars
python scripts/hifly_client.py list_public_avatars

# Clone a voice using bundled sample
python scripts/hifly_client.py clone_voice --audio assets/voice.MP3 --title "My Voice"

# Create a talking photo
python scripts/hifly_client.py create_talking_photo --image assets/avatar.png --title "My Avatar"
```

### 3. Use your own API token (optional)

For longer videos without watermarks, get your token from [hifly.cc/setting](https://hifly.cc/setting):

```bash
export HIFLY_API_TOKEN="your_token_here"
```

## Example Prompts

When using with an AI agent, try prompts like:

```
"Create a talking photo video from my photo"
"Clone my voice from this audio file and generate a greeting video"
"List available public avatars from Flyworks"
"Generate a welcome video with a professional avatar"
"Help me create a video announcement using my custom avatar"
```

## Documentation

- [SKILL.md](SKILL.md) - Complete skill documentation
- [references/](references/) - Detailed API references
  - [authentication.md](references/authentication.md) - Token setup
  - [avatars.md](references/avatars.md) - Working with avatars
  - [voices.md](references/voices.md) - Voice cloning
  - [video-generation.md](references/video-generation.md) - Video workflow

## API Reference

| Item         | Value                                        |
| ------------ | -------------------------------------------- |
| Base URL     | `https://hfw-api.hifly.cc/api/v2/hifly`      |
| Auth         | Bearer token via `Authorization` header      |
| Token Source | [hifly.cc/setting](https://hifly.cc/setting) |

## License

MIT - See [LICENSE](LICENSE) for details.
