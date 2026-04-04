---
name: avatars
description: Working with public avatars and custom talking photos
---

# Avatars

## Public Avatars

Pre-made realistic digital humans available for immediate use.

### List Available Avatars

```bash
python scripts/hifly_client.py list_public_avatars
```

Returns avatar IDs and names. Example output:

```
ID: TnaRN9Z3CLxpLVuDXvVlmA | Name: single_right
ID: l_aDkE8HtOl5poFGpBha1w | Name: 徐皓然
```

### Using an Avatar

Use the avatar ID in video creation:

```bash
python scripts/hifly_client.py create_video \
  --type tts \
  --text "Hello world" \
  --avatar "TnaRN9Z3CLxpLVuDXvVlmA" \
  --voice "VOICE_ID"
```

## Custom Avatars (Talking Photos)

Create a personalized avatar from any portrait image.

### Create from Image

```bash
# From local file
python scripts/hifly_client.py create_talking_photo \
  --image /path/to/portrait.jpg \
  --title "My Custom Avatar"

# From URL
python scripts/hifly_client.py create_talking_photo \
  --image "https://example.com/portrait.jpg" \
  --title "My Custom Avatar"
```

### Requirements for Best Results

- **Portrait orientation** preferred
- **Clear face visibility** - frontal view works best
- **Good lighting** - avoid harsh shadows
- **Neutral expression** - for natural lip-sync

### Output

Returns an Avatar ID that can be used for video generation:

```
Avatar Created: lGdTqom22EKEqAkZzBdtzQ
```
