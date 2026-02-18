---
title: Configuration Migration Guide
description: Deprecated configuration fields and migration paths
---

# Configuration Migration Guide

This guide helps you migrate from deprecated configuration fields to their modern equivalents.

## Deprecated Fields (v2026.2.x)

### Messages Configuration

#### `audioModels`
**Deprecated**: `messages.audioModels`  
**Use instead**: `tools.media.audio.models`  
**Migration**:
```yaml
# Before
messages:
  audioModels:
    - provider: openai
      model: whisper-1

# After
tools:
  media:
    audio:
      models:
        - provider: openai
          model: whisper-1
```

#### `messagePrefix`
**Deprecated**: `messages.messagePrefix`  
**Use instead**: `whatsapp.messagePrefix`  
**Migration**:
```yaml
# Before
messages:
  messagePrefix: "[Bot]"

# After
whatsapp:
  messagePrefix: "[Bot]"
```

### Direct Message Mode

#### `dmMode`
**Deprecated**: `dmMode` in various contexts  
**Use instead**: `direct`  
**Migration**:
```yaml
# Before
allowFrom:
  dmMode: true

# After
allowFrom:
  direct: true
```

### Session Maintenance

#### `pruneDays`
**Deprecated**: `sessions.maintenance.pruneDays`  
**Use instead**: `sessions.maintenance.pruneAfter`  
**Migration**:
```yaml
# Before
sessions:
  maintenance:
    pruneDays: 30

# After
sessions:
  maintenance:
    pruneAfter: "30d"
```

### Tools Configuration

#### `deepgram` (media)
**Deprecated**: `tools.media.audio.deepgram`, `tools.media.deepgram`  
**Use instead**: `tools.media.audio.providerOptions.deepgram`  
**Migration**:
```yaml
# Before
tools:
  media:
    audio:
      deepgram:
        detectLanguage: true

# After
tools:
  media:
    audio:
      providerOptions:
        deepgram:
          detect_language: true
```

### Slack Configuration

#### `dmReplyMode`
**Deprecated**: `slack.dmReplyMode`  
**Use instead**: `channels.slack.replyToModeByChatType.direct`  
**Migration**:
```yaml
# Before
slack:
  dmReplyMode: "in-thread"

# After
channels:
  slack:
    replyToModeByChatType:
      direct: "in-thread"
```

### CLI Options

#### `--keep-config`
**Deprecated**: `openclaw plugins uninstall --keep-config`  
**Use instead**: `--keep-files`  
**Migration**:
```bash
# Before
openclaw plugins uninstall my-plugin --keep-config

# After
openclaw plugins uninstall my-plugin --keep-files
```

### Cron Options

#### `--deliver`
**Deprecated**: `openclaw cron add --deliver`  
**Use instead**: `--announce`  
**Migration**:
```bash
# Before
openclaw cron add --deliver

# After
openclaw cron add --announce
```

## Removal Schedule

- **v2027.3.0**: All deprecated fields will be removed
- **v2026.12.x**: Final warning period (doctor command warns on each use)
- **Current (v2026.2.x)**: Deprecated fields still work but trigger warnings

## Doctor Command

Run `openclaw doctor` to detect deprecated configuration in your setup:

```bash
openclaw doctor
```

The doctor will:
- Detect deprecated fields in your config
- Suggest automatic migration
- Show the new configuration structure

## Need Help?

- See [Configuration Reference](/gateway/configuration-reference) for all available options
- Join [Discord](https://discord.gg/openclaw) for migration support
- Check [CHANGELOG](/reference/changelog) for detailed version history
