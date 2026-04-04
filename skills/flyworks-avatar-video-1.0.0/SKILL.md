---
name: flyworks-avatar-video
description: Generate videos using Flyworks (a.k.a HiFly) Digital Humans. Create talking photo videos from images, use public avatars with TTS, or clone voices for custom audio.
license: MIT
compatibility: Requires Python 3 and network access to hfw-api.hifly.cc
---

# Avatar Video Generation Skill

This skill allows you to generate videos using Flyworks (a.k.a HiFly 飞影数字人) Digital Humans. Available features:

1.  **Public Avatar Video**: Create video from text or audio using pre-made highly realistic avatars.
2.  **Talking Photo**: Create a "talking photo" video from a single image and text/audio.
3.  **Voice Cloning**: Clone a voice from an audio sample to use in TTS.

For detailed documentation, see the [references/](references/) folder:

- [authentication.md](references/authentication.md) - API token setup
- [avatars.md](references/avatars.md) - Working with avatars
- [voices.md](references/voices.md) - Voice selection and cloning
- [video-generation.md](references/video-generation.md) - Video creation workflow

## API Token & Limitations

This skill works with a default free-tier token, but it has limitations:

- **Watermark**: Generated videos will have a watermark.
- **Duration Limit**: Videos are limited to 30 seconds.

**To remove limitations:**

1.  Register at [hifly.cc](https://hifly.cc) or [flyworks.ai](https://flyworks.ai).
2.  Get your API key from [User Settings](https://hifly.cc/setting).
3.  Set the environment variable: `export HIFLY_API_TOKEN="your_token_here"`

## Tools

### `scripts/hifly_client.py`

The main entry point for all operations.

#### Usage

```bash
# List available public avatars
python scripts/hifly_client.py list_public_avatars

# List available public voices
python scripts/hifly_client.py list_public_voices

# Create a video with a public avatar (TTS)
python scripts/hifly_client.py create_video --type tts --text "Hello world" --avatar "avatar_id_or_alias" --voice "voice_id_or_alias"

# Create a video with a public avatar (Audio URL or File)
python scripts/hifly_client.py create_video --audio "https://... or path/to/audio.mp3" --avatar "avatar_id_or_alias"

# Create a talked photo video using bundled assets
python scripts/hifly_client.py create_talking_photo --image assets/avatar.png --title "Bundled Avatar"

# Clone a voice using bundled assets
python scripts/hifly_client.py clone_voice --audio assets/voice.MP3 --title "Bundled Voice"

# Check status of generated tasks
python scripts/hifly_client.py check_task --id "TASK_ID"

# Manage local aliases (saved in memory.json)
python scripts/hifly_client.py manage_memory add my_avatar "av_12345"
python scripts/hifly_client.py manage_memory list
```

## Examples

### 1. Create a simple greeting video

```bash
# First find a voice and avatar
python scripts/hifly_client.py list_public_avatars
python scripts/hifly_client.py list_public_voices

# Generate
python scripts/hifly_client.py create_video --type tts --text "Welcome to our service." --avatar "av_public_01" --voice "voice_public_01"
```

### 2. Use a custom talking photo

```bash
# Create the avatar from an image URL
python scripts/hifly_client.py create_talking_photo --image "https://mysite.com/photo.jpg" --title "CEO Photo"
# Output will give you an Avatar ID, e.g., av_custom_99

# Save it to memory
python scripts/hifly_client.py manage_memory add ceo av_custom_99

# Generate video using the new avatar
python scripts/hifly_client.py create_video --type tts --text "Here is the quarterly report." --avatar ceo --voice "voice_public_01"
```

## Agent Behavior Guidelines

When assisting users with video generation, follow these guidelines:

### Voice Selection Required

**Video generation requires both text AND a voice.** If the user provides text but no voice:

1. **Check local memory first**: Run `manage_memory list` to see if the user has saved any voice aliases.
2. **Ask the user to choose**:
   - "I see you want to create a video with the text '[text]'. Which voice would you like to use?"
   - If they have saved voices: "You have these saved voices: [list]. Or would you prefer a public voice?"
   - If no saved voices: "Would you like to use a public voice, or clone your own voice from an audio sample first?"

3. **Help them select**:
   - To see public voices: `list_public_voices`
   - To clone a voice: `clone_voice --audio [file] --title [name]`

### Complete Workflow Example

For a prompt like _"Create a talking photo video from my photo saying 'this is my AI twin'"_:

1. Ask: "Which voice would you like for your AI twin? You can use a public voice or clone your own."
2. If they want to clone: Help them with `clone_voice`
3. Create the talking photo with both text and voice:
   ```bash
   python scripts/hifly_client.py create_talking_photo \
     --image user_photo.jpg \
     --text "this is my AI twin" \
     --voice SELECTED_VOICE_ID \
     --title "My AI Twin"
   ```

### Saving for Later

After creating avatars or cloning voices, offer to save them:

```bash
python scripts/hifly_client.py manage_memory add my_avatar AVATAR_ID --kind avatar
python scripts/hifly_client.py manage_memory add my_voice VOICE_ID --kind voice
```
