---
name: voices
description: Listing voices, locales, speed/pitch configuration for HeyGen
metadata:
  tags: voices, voice-id, locales, languages, tts, speech
---

# HeyGen Voices

HeyGen provides a wide variety of AI voices for different languages, accents, and styles. Voices convert your text script into natural-sounding speech.

## Listing Available Voices

### curl

```bash
curl -X GET "https://api.heygen.com/v2/voices" \
  -H "X-Api-Key: $HEYGEN_API_KEY"
```

### TypeScript

```typescript
interface Voice {
  voice_id: string;
  name: string;
  language: string;
  gender: "male" | "female";
  preview_audio: string;
  support_pause: boolean;
  emotion_support: boolean;
}

interface VoicesResponse {
  error: null | string;
  data: {
    voices: Voice[];
  };
}

async function listVoices(): Promise<Voice[]> {
  const response = await fetch("https://api.heygen.com/v2/voices", {
    headers: { "X-Api-Key": process.env.HEYGEN_API_KEY! },
  });

  const json: VoicesResponse = await response.json();

  if (json.error) {
    throw new Error(json.error);
  }

  return json.data.voices;
}
```

### Python

```python
import requests
import os

def list_voices() -> list:
    response = requests.get(
        "https://api.heygen.com/v2/voices",
        headers={"X-Api-Key": os.environ["HEYGEN_API_KEY"]}
    )

    data = response.json()
    if data.get("error"):
        raise Exception(data["error"])

    return data["data"]["voices"]
```

## Response Format

```json
{
  "error": null,
  "data": {
    "voices": [
      {
        "voice_id": "1bd001e7e50f421d891986aad5158bc8",
        "name": "Sara",
        "language": "English",
        "gender": "female",
        "preview_audio": "https://files.heygen.ai/...",
        "support_pause": true,
        "emotion_support": true
      },
      {
        "voice_id": "de8b5d78f2e0485f88d1e9f5c8e7f9a6",
        "name": "Paul",
        "language": "English",
        "gender": "male",
        "preview_audio": "https://files.heygen.ai/...",
        "support_pause": true,
        "emotion_support": false
      }
    ]
  }
}
```

## Supported Languages

HeyGen supports many languages including:

| Language | Code | Notes |
|----------|------|-------|
| English (US) | en-US | Multiple voice options |
| English (UK) | en-GB | British accent |
| Spanish | es-ES | Spain Spanish |
| Spanish (Latin) | es-MX | Mexican Spanish |
| French | fr-FR | France French |
| German | de-DE | Standard German |
| Portuguese | pt-BR | Brazilian Portuguese |
| Chinese (Mandarin) | zh-CN | Simplified Chinese |
| Japanese | ja-JP | Standard Japanese |
| Korean | ko-KR | Standard Korean |
| Italian | it-IT | Standard Italian |
| Dutch | nl-NL | Standard Dutch |
| Polish | pl-PL | Standard Polish |
| Arabic | ar-SA | Saudi Arabic |

## Using Voices in Video Generation

### Basic Voice Usage

```typescript
const videoConfig = {
  video_inputs: [
    {
      character: {
        type: "avatar",
        avatar_id: "josh_lite3_20230714",
        avatar_style: "normal",
      },
      voice: {
        type: "text",
        input_text: "Hello! Welcome to our presentation.",
        voice_id: "1bd001e7e50f421d891986aad5158bc8",
      },
    },
  ],
};
```

### Voice with Speed Adjustment

```typescript
const videoConfig = {
  video_inputs: [
    {
      character: {
        type: "avatar",
        avatar_id: "josh_lite3_20230714",
        avatar_style: "normal",
      },
      voice: {
        type: "text",
        input_text: "This is spoken at a faster pace.",
        voice_id: "1bd001e7e50f421d891986aad5158bc8",
        speed: 1.2, // 1.0 is normal, range: 0.5 - 2.0
      },
    },
  ],
};
```

### Voice with Pitch Adjustment

```typescript
const videoConfig = {
  video_inputs: [
    {
      character: {
        type: "avatar",
        avatar_id: "josh_lite3_20230714",
        avatar_style: "normal",
      },
      voice: {
        type: "text",
        input_text: "This has a higher pitch.",
        voice_id: "1bd001e7e50f421d891986aad5158bc8",
        pitch: 10, // Range: -20 to 20
      },
    },
  ],
};
```

## Adding Pauses with Break Tags

HeyGen supports SSML-style `<break>` tags to add pauses in scripts.

### Break Tag Format

```
<break time="Xs"/>
```

Where `X` is the duration in seconds (e.g., `1s`, `1.5s`, `0.5s`).

### Requirements

| Rule | Example |
|------|---------|
| Use seconds with "s" suffix | `<break time="1.5s"/>` ✓ |
| Must have space before tag | `word <break time="1s"/>` ✓ |
| Must have space after tag | `<break time="1s"/> word` ✓ |
| Self-closing tag | `<break time="1s"/>` ✓ |

**Incorrect:** `word<break time="1s"/>word` (no spaces)
**Correct:** `word <break time="1s"/> word`

### Examples

```typescript
// Single pause
const script1 = "Hello and welcome. <break time=\"1s\"/> Let me introduce our product.";

// Multiple pauses
const script2 = "First point. <break time=\"1.5s\"/> Second point. <break time=\"1s\"/> Third point.";

// Pause at start (dramatic opening)
const script3 = "<break time=\"0.5s\"/> Welcome to our presentation.";

// Longer pause for emphasis
const script4 = "And the winner is... <break time=\"2s\"/> You!";
```

### Full Example

```typescript
const scriptWithPauses = `
Welcome to our product demo. <break time="1s"/>
Today I'll show you three key features. <break time="0.5s"/>
First, let's look at the dashboard. <break time="1.5s"/>
As you can see, it's incredibly intuitive.
`;

const videoConfig = {
  video_inputs: [
    {
      character: {
        type: "avatar",
        avatar_id: "josh_lite3_20230714",
        avatar_style: "normal",
      },
      voice: {
        type: "text",
        input_text: scriptWithPauses,
        voice_id: "1bd001e7e50f421d891986aad5158bc8",
      },
    },
  ],
};
```

### Consecutive Breaks

Multiple consecutive break tags are automatically combined:

```typescript
// These two breaks:
"Hello <break time=\"1s\"/> <break time=\"0.5s\"/> world"

// Are treated as a single 1.5s pause
```

### Best Practices

1. **Use for emphasis** - Add pauses before important points
2. **Keep pauses reasonable** - 0.5s to 2s is typical; longer feels unnatural
3. **Match natural speech** - Add pauses where a human would breathe or pause
4. **Test the output** - Listen to generated audio to verify timing feels right

## Using Custom Audio Instead of TTS

Instead of text-to-speech, you can provide your own audio:

```typescript
const videoConfig = {
  video_inputs: [
    {
      character: {
        type: "avatar",
        avatar_id: "josh_lite3_20230714",
        avatar_style: "normal",
      },
      voice: {
        type: "audio",
        audio_url: "https://example.com/my-audio.mp3",
      },
    },
  ],
};
```

## Filtering Voices

### By Language

```typescript
function filterByLanguage(voices: Voice[], language: string): Voice[] {
  return voices.filter((v) =>
    v.language.toLowerCase().includes(language.toLowerCase())
  );
}

const englishVoices = filterByLanguage(voices, "english");
const spanishVoices = filterByLanguage(voices, "spanish");
```

### By Gender

```typescript
function filterByGender(voices: Voice[], gender: "male" | "female"): Voice[] {
  return voices.filter((v) => v.gender === gender);
}

const femaleVoices = filterByGender(voices, "female");
```

### By Features

```typescript
function filterByFeatures(
  voices: Voice[],
  options: { supportPause?: boolean; emotionSupport?: boolean }
): Voice[] {
  return voices.filter((v) => {
    if (options.supportPause !== undefined && v.support_pause !== options.supportPause) {
      return false;
    }
    if (options.emotionSupport !== undefined && v.emotion_support !== options.emotionSupport) {
      return false;
    }
    return true;
  });
}

const expressiveVoices = filterByFeatures(voices, { emotionSupport: true });
```

## Voice Selection Helper

```typescript
interface VoiceSelectionCriteria {
  language?: string;
  gender?: "male" | "female";
  supportPause?: boolean;
  emotionSupport?: boolean;
}

async function findVoice(criteria: VoiceSelectionCriteria): Promise<Voice | null> {
  const voices = await listVoices();

  const filtered = voices.filter((v) => {
    if (criteria.language && !v.language.toLowerCase().includes(criteria.language.toLowerCase())) {
      return false;
    }
    if (criteria.gender && v.gender !== criteria.gender) {
      return false;
    }
    if (criteria.supportPause !== undefined && v.support_pause !== criteria.supportPause) {
      return false;
    }
    if (criteria.emotionSupport !== undefined && v.emotion_support !== criteria.emotionSupport) {
      return false;
    }
    return true;
  });

  return filtered[0] || null;
}

// Usage
const voice = await findVoice({
  language: "english",
  gender: "female",
  emotionSupport: true,
});
```

## Multi-Language Videos

Create videos with different languages per scene:

```typescript
const multiLanguageConfig = {
  video_inputs: [
    {
      character: {
        type: "avatar",
        avatar_id: "josh_lite3_20230714",
        avatar_style: "normal",
      },
      voice: {
        type: "text",
        input_text: "Hello! Welcome to our global product launch.",
        voice_id: "english_voice_id",
      },
    },
    {
      character: {
        type: "avatar",
        avatar_id: "josh_lite3_20230714",
        avatar_style: "normal",
      },
      voice: {
        type: "text",
        input_text: "Hola! Bienvenidos al lanzamiento global de nuestro producto.",
        voice_id: "spanish_voice_id",
      },
    },
  ],
};
```

## Matching Voice to Avatar

### Recommended: Use Avatar's Default Voice

Many avatars have a `default_voice_id` that's pre-matched. **This is the best approach.**

```typescript
// Using v3 API to get avatar with default voice
const response = await fetch(
  "https://api.heygen.com/v3/avatar_group.list?include_public=true",
  { headers: { "X-Api-Key": process.env.HEYGEN_API_KEY! } }
);
const { data } = await response.json();

// Find avatar with a default voice
const avatar = data.avatar_group_list.find((a: any) => a.default_voice_id);

if (avatar) {
  const videoConfig = {
    video_inputs: [{
      character: { type: "avatar", avatar_id: avatar.id },
      voice: {
        type: "text",
        input_text: script,
        voice_id: avatar.default_voice_id, // Pre-matched voice
      },
    }],
  };
}
```

See [avatars.md](avatars.md) for complete examples.

### Fallback: Match Gender Manually

If avatar has no default voice, match genders manually:

```typescript
interface AvatarVoicePair {
  avatarId: string;
  voiceId: string;
  gender: "male" | "female";
}

async function findMatchingAvatarAndVoice(
  preferredGender?: "male" | "female"
): Promise<AvatarVoicePair> {
  const [avatars, voices] = await Promise.all([
    listAvatars(),
    listVoices(),
  ]);

  // Default to male if no preference
  const gender = preferredGender || "male";

  // Find avatar with matching gender
  const avatar = avatars.find((a) => a.gender === gender);
  if (!avatar) {
    throw new Error(`No ${gender} avatar available`);
  }

  // Find voice with matching gender AND language
  const voice = voices.find(
    (v) => v.gender === gender && v.language.toLowerCase().includes("english")
  );
  if (!voice) {
    throw new Error(`No ${gender} English voice available`);
  }

  return {
    avatarId: avatar.avatar_id,
    voiceId: voice.voice_id,
    gender,
  };
}
```

## Best Practices

1. **Match voice gender to avatar** - Always pair male voices with male avatars, female with female
2. **Match voice to content** - Use professional voices for business content
3. **Test voice previews** - Listen to preview audio before selecting
4. **Consider locale** - Match voice accent to target audience
5. **Use natural pacing** - Adjust speed for clarity, typically 0.9-1.1x
6. **Add pauses** - Use SSML breaks for more natural speech flow
7. **Validate availability** - Always verify voice_id exists before using
