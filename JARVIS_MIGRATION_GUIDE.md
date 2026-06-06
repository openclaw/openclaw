# 🤖 OpenClaw → Jarvis Migration Guide

## Overview

This guide documents the complete rebranding from **OpenClaw** to **Jarvis** with new voice-to-voice capabilities and laptop control features.

## ✅ Phase 1: Rebranding Changes

### Package Names
- `@openclaw/*` → `@jarvis/*`
- `openclaw` → `jarvis` (npm packages)

### CLI Commands
```bash
# Old
openclaw onboard
openclaw gateway
openclaw agent

# New
jarvis onboard
jarvis gateway
jarvis agent
```

### Configuration Paths
```bash
# Old
~/.openclaw/openclaw.json
~/.clawdbot/clawdbot.json

# New
~/.jarvis/jarvis.json
JARVIS_HOME environment variable
```

### Environment Variables
```bash
# Old
OPENCLAW_HOME
OPENCLAW_CONFIG_PATH
OPENCLAW_STATE_DIR

# New
JARVIS_HOME
JARVIS_CONFIG_PATH
JARVIS_STATE_DIR
```

## ✅ Phase 2: Voice-to-Voice Features

### Configuration

Add voice settings to `~/.jarvis/jarvis.json`:

```json
{
  "agent": {
    "model": "openai/gpt-4"
  },
  "voice": {
    "enabled": true,
    "stt": {
      "provider": "openai",
      "language": "en-US",
      "enablePunctuation": true
    },
    "tts": {
      "provider": "nvidia",
      "voice": "default",
      "speed": 1.0,
      "pitch": 1.0
    },
    "audio": {
      "sampleRate": 16000,
      "channels": 1,
      "bitDepth": 16,
      "format": "wav"
    }
  },
  "laptopControl": {
    "enabled": true,
    "allowedCommands": ["sleep", "lock", "shutdown"]
  }
}
```

### NVIDIA Riva Setup

#### Installation

1. **Docker Installation (Recommended)**
   ```bash
   docker pull nvcr.io/nvidia/riva/riva-server:latest
   
   docker run --gpus all \
     -e NVAPIKEYS=${NVAPIKEYS} \
     -p 50051:50051 \
     -p 8000:8000 \
     -p 8001:8001 \
     -p 8002:8002 \
     nvcr.io/nvidia/riva/riva-server:latest
   ```

2. **Environment Setup**
   ```bash
   export JARVIS_NVIDIA_ENDPOINT="localhost:50051"
   export JARVIS_NVIDIA_API_KEY="your-api-key"
   export JARVIS_ELEVENLABS_API_KEY="your-elevenlabs-key"
   ```

3. **Verify Connection**
   ```bash
   jarvis voice test
   ```

### Voice Commands

#### Voice-to-Voice Chat
```bash
# Start voice interaction
jarvis voice chat

# Speak: "What's the weather?"
# Jarvis responds with audio
```

#### Laptop Control
```bash
# Available commands
jarvis voice command "sleep"      # Put laptop to sleep
jarvis voice command "lock"       # Lock screen
jarvis voice command "shutdown"   # Shutdown
jarvis voice command "restart"    # Restart
jarvis voice command "logout"     # Logout user
```

## ✅ Phase 3: Tool Compatibility

### Preserved Tools
All existing tools remain fully functional:

- ✅ **Browser Tool** - Web automation
- ✅ **Canvas Tool** - Visual workspace
- ✅ **Sessions Tool** - Session management
- ✅ **Cron Tool** - Scheduled tasks
- ✅ **Nodes Tool** - Device connectivity
- ✅ **Process Tool** - System processes
- ✅ **File Tools** - read, write, edit

### Tool Usage (Unchanged)

```bash
# All existing commands work the same
jarvis agent --message "Browse https://example.com"
jarvis browser --action screenshot
jarvis sessions list
```

## ✅ Phase 4: Migration Checklist

### For Existing Users

- [ ] Update npm/pnpm packages
  ```bash
  npm uninstall -g openclaw
  npm install -g jarvis@latest
  ```

- [ ] Migrate config files
  ```bash
  mkdir -p ~/.jarvis
  cp ~/.openclaw/openclaw.json ~/.jarvis/jarvis.json
  ```

- [ ] Update environment variables
  ```bash
  export JARVIS_HOME="~/.jarvis"
  ```

- [ ] Verify tools still work
  ```bash
  jarvis agent --message "Hello"
  jarvis doctor  # Check system health
  ```

### For Developers

- [ ] Update imports
  ```typescript
  // Old
  import { OpenClawGateway } from "@openclaw/core";
  
  // New
  import { JarvisGateway } from "@jarvis/core";
  ```

- [ ] Update package dependencies
  ```json
  {
    "dependencies": {
      "@jarvis/core": "^2026.6.0",
      "@jarvis/voice-engine": "^2026.6.0"
    }
  }
  ```

- [ ] Update skill manifests
  ```yaml
  # skills/my-skill/jarvis.yaml
  name: my-skill
  version: 1.0.0
  compatibility:
    min-jarvis-version: "2026.6.0"
  ```

## ⚠️ Breaking Changes

### Config Path
- Old default: `~/.openclaw/openclaw.json`
- New default: `~/.jarvis/jarvis.json`
- **Action Required**: Move config files or set `JARVIS_CONFIG_PATH`

### CLI Executable Name
- Old: `openclaw`
- New: `jarvis`
- **Action Required**: Update shell aliases and scripts

### Environment Variables
- Old: `OPENCLAW_*`
- New: `JARVIS_*`
- **Action Required**: Update .bashrc, .zshrc, etc.

## 📝 Troubleshooting

### "Command not found: jarvis"
```bash
# Reinstall globally
npm install -g jarvis@latest

# Or add to PATH
export PATH="$PATH:$(npm config get prefix)/bin"
```

### Voice not working
```bash
# Check NVIDIA Riva connection
jarvis voice test

# Verify API keys
echo $JARVIS_NVIDIA_ENDPOINT
echo $JARVIS_NVIDIA_API_KEY

# Run diagnostics
jarvis doctor --verbose
```

### Config migration issues
```bash
# Reset to defaults
jarvis setup --reset

# Verify config
cat ~/.jarvis/jarvis.json
```

## 🔗 Resources

- [Jarvis Documentation](https://docs.jarvis.ai)
- [Voice Configuration](https://docs.jarvis.ai/voice)
- [NVIDIA Riva Setup](https://docs.nvidia.com/riva)
- [ElevenLabs API](https://elevenlabs.io/docs)

## 📞 Support

For migration help:
- Discord: https://discord.gg/jarvis
- Issues: https://github.com/narikootma-ai/jarvis/issues
- Docs: https://docs.jarvis.ai
