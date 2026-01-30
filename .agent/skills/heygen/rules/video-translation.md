---
name: video-translation
description: Translating videos, quality/fast modes, and dubbing for HeyGen
metadata:
  tags: translation, dubbing, localization, multi-language
---

# Video Translation

HeyGen's Video Translation feature allows you to translate and dub existing videos into multiple languages, preserving lip-sync and natural speech patterns.

## Creating a Translation Job

### Request Fields

| Field | Type | Req | Description |
|-------|------|:---:|-------------|
| `video_url` | string | ✓* | URL of video to translate (*or `video_id`) |
| `video_id` | string | ✓* | HeyGen video ID (*or `video_url`) |
| `output_language` | string | ✓ | Target language code (e.g., "es-ES") |
| `title` | string | | Name for the translated video |
| `translate_audio_only` | boolean | | Audio only, no lip-sync (faster) |
| `speaker_num` | number | | Number of speakers in video |
| `callback_id` | string | | Custom ID for webhook tracking |
| `callback_url` | string | | URL for completion notification |

**Either** `video_url` **OR** `video_id` must be provided.

### curl

```bash
curl -X POST "https://api.heygen.com/v2/video_translate" \
  -H "X-Api-Key: $HEYGEN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "video_url": "https://example.com/original-video.mp4",
    "output_language": "es-ES",
    "title": "Spanish Version"
  }'
```

### TypeScript

```typescript
interface VideoTranslateRequest {
  video_url?: string;                          // Required (or video_id)
  video_id?: string;                           // Required (or video_url)
  output_language: string;                     // Required
  title?: string;
  translate_audio_only?: boolean;
  speaker_num?: number;
  callback_id?: string;
  callback_url?: string;
}

interface VideoTranslateResponse {
  error: null | string;
  data: {
    video_translate_id: string;
  };
}

async function translateVideo(config: VideoTranslateRequest): Promise<string> {
  const response = await fetch("https://api.heygen.com/v2/video_translate", {
    method: "POST",
    headers: {
      "X-Api-Key": process.env.HEYGEN_API_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(config),
  });

  const json: VideoTranslateResponse = await response.json();

  if (json.error) {
    throw new Error(json.error);
  }

  return json.data.video_translate_id;
}
```

### Python

```python
import requests
import os

def translate_video(config: dict) -> str:
    response = requests.post(
        "https://api.heygen.com/v2/video_translate",
        headers={
            "X-Api-Key": os.environ["HEYGEN_API_KEY"],
            "Content-Type": "application/json"
        },
        json=config
    )

    data = response.json()
    if data.get("error"):
        raise Exception(data["error"])

    return data["data"]["video_translate_id"]
```

## Supported Languages

| Language | Code | Notes |
|----------|------|-------|
| English (US) | en-US | Default source |
| Spanish (Spain) | es-ES | European Spanish |
| Spanish (Mexico) | es-MX | Latin American |
| French | fr-FR | Standard French |
| German | de-DE | Standard German |
| Italian | it-IT | Standard Italian |
| Portuguese (Brazil) | pt-BR | Brazilian Portuguese |
| Japanese | ja-JP | Standard Japanese |
| Korean | ko-KR | Standard Korean |
| Chinese (Mandarin) | zh-CN | Simplified Chinese |
| Hindi | hi-IN | Standard Hindi |
| Arabic | ar-SA | Modern Standard Arabic |

## Translation Options

### Basic Translation

Translate video with lip-sync:

```typescript
const translateConfig = {
  video_url: "https://example.com/original.mp4",
  output_language: "es-ES",
  title: "Spanish Translation",
};
```

### Audio-Only Translation

Keep original video, only translate audio:

```typescript
const audioOnlyConfig = {
  video_url: "https://example.com/original.mp4",
  output_language: "es-ES",
  translate_audio_only: true,
};
```

### Multi-Speaker Videos

Specify number of speakers for better detection:

```typescript
const multiSpeakerConfig = {
  video_url: "https://example.com/interview.mp4",
  output_language: "fr-FR",
  speaker_num: 2, // Two speakers in video
};
```

## Advanced Options (v4 API)

For more control over translation:

```typescript
interface VideoTranslateV4Request {
  input_video_id?: string;
  google_url?: string;
  output_languages: string[];
  name: string;
  srt_key?: string;
  instruction?: string;
  vocabulary?: string[];
  brand_voice_id?: string;
  speaker_num?: number;
  project_id?: string;
  keep_the_same_format?: boolean;
  input_language?: string;
  enable_video_stretching?: boolean;
  disable_music_track?: boolean;
  enable_speech_enhancement?: boolean;
  srt_role?: "input" | "output";
  translate_audio_only?: boolean;
}
```

### Multiple Output Languages

```typescript
const multiLanguageConfig = {
  input_video_id: "original_video_id",
  output_languages: ["es-ES", "fr-FR", "de-DE"],
  name: "Multi-language translations",
};
```

### Custom Vocabulary

Preserve specific terms:

```typescript
const customVocabConfig = {
  video_url: "https://example.com/product-demo.mp4",
  output_language: "ja-JP",
  vocabulary: ["SuperWidget", "Pro Max", "TechCorp"],
  // These terms will be kept as-is or transliterated appropriately
};
```

### Using Custom SRT

Provide your own subtitles:

```typescript
const customSrtConfig = {
  video_url: "https://example.com/video.mp4",
  output_language: "es-ES",
  srt_key: "path/to/custom-subtitles.srt",
  srt_role: "input", // Use SRT as source transcript
};
```

## Checking Translation Status

### curl

```bash
curl -X GET "https://api.heygen.com/v1/video_translate/{translate_id}" \
  -H "X-Api-Key: $HEYGEN_API_KEY"
```

### TypeScript

```typescript
interface TranslateStatusResponse {
  error: null | string;
  data: {
    id: string;
    status: "pending" | "processing" | "completed" | "failed";
    video_url?: string;
    message?: string;
  };
}

async function getTranslateStatus(translateId: string): Promise<TranslateStatusResponse["data"]> {
  const response = await fetch(
    `https://api.heygen.com/v1/video_translate/${translateId}`,
    { headers: { "X-Api-Key": process.env.HEYGEN_API_KEY! } }
  );

  const json: TranslateStatusResponse = await response.json();

  if (json.error) {
    throw new Error(json.error);
  }

  return json.data;
}
```

## Polling for Completion

```typescript
async function waitForTranslation(
  translateId: string,
  maxWaitMs = 1800000, // 30 minutes (translations can take longer)
  pollIntervalMs = 30000 // 30 seconds
): Promise<string> {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const status = await getTranslateStatus(translateId);

    switch (status.status) {
      case "completed":
        return status.video_url!;
      case "failed":
        throw new Error(status.message || "Translation failed");
      default:
        console.log(`Status: ${status.status}...`);
        await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }

  throw new Error("Translation timed out");
}
```

## Complete Translation Workflow

```typescript
async function translateAndDownload(
  videoUrl: string,
  targetLanguage: string
): Promise<string> {
  // 1. Start translation
  console.log(`Starting translation to ${targetLanguage}...`);
  const translateId = await translateVideo({
    video_url: videoUrl,
    output_language: targetLanguage,
  });
  console.log(`Translation ID: ${translateId}`);

  // 2. Wait for completion
  console.log("Processing translation...");
  const translatedVideoUrl = await waitForTranslation(translateId);
  console.log(`Translation complete: ${translatedVideoUrl}`);

  return translatedVideoUrl;
}

// Usage
const spanishVideo = await translateAndDownload(
  "https://example.com/my-video.mp4",
  "es-ES"
);
```

## Batch Translation

Translate to multiple languages:

```typescript
async function translateToMultipleLanguages(
  sourceVideoUrl: string,
  targetLanguages: string[]
): Promise<Record<string, string>> {
  const results: Record<string, string> = {};

  // Start all translations in parallel
  const translatePromises = targetLanguages.map(async (lang) => {
    const translateId = await translateVideo({
      video_url: sourceVideoUrl,
      output_language: lang,
    });
    return { lang, translateId };
  });

  const translationJobs = await Promise.all(translatePromises);

  // Wait for all to complete
  for (const job of translationJobs) {
    try {
      const videoUrl = await waitForTranslation(job.translateId);
      results[job.lang] = videoUrl;
      console.log(`✓ ${job.lang} complete`);
    } catch (error) {
      console.error(`✗ ${job.lang} failed: ${error.message}`);
      results[job.lang] = `error: ${error.message}`;
    }
  }

  return results;
}

// Usage
const translations = await translateToMultipleLanguages(
  "https://example.com/original.mp4",
  ["es-ES", "fr-FR", "de-DE", "ja-JP"]
);
```

## Video Translation Features

### Lip Sync

HeyGen automatically adjusts the speaker's lip movements to match the translated audio, creating a natural-looking result.

### Voice Cloning

The translated audio attempts to match the original speaker's voice characteristics while speaking the target language.

### Music Track Handling

```typescript
const config = {
  video_url: "https://example.com/video-with-music.mp4",
  output_language: "fr-FR",
  disable_music_track: true, // Remove background music
};
```

### Speech Enhancement

```typescript
const config = {
  video_url: "https://example.com/video.mp4",
  output_language: "de-DE",
  enable_speech_enhancement: true, // Improve audio quality
};
```

## Best Practices

1. **Source quality matters** - Use high-quality source videos for better results
2. **Clear audio** - Videos with clear speech translate better
3. **Single speaker** - Best results with single-speaker content
4. **Moderate pacing** - Very fast speech may affect quality
5. **Test first** - Try with shorter clips before translating long videos
6. **Allow extra time** - Translation takes longer than generation

## Limitations

- Maximum video duration varies by subscription tier
- Some complex audio scenarios may reduce quality
- Background noise can affect translation accuracy
- Processing time is longer than standard video generation
- Multi-speaker detection has limitations

## Error Handling

```typescript
async function safeTranslate(
  videoUrl: string,
  targetLanguage: string
): Promise<{ success: boolean; result?: string; error?: string }> {
  try {
    const url = await translateAndDownload(videoUrl, targetLanguage);
    return { success: true, result: url };
  } catch (error) {
    console.error(`Translation failed: ${error.message}`);

    // Common error handling
    if (error.message.includes("quota")) {
      return { success: false, error: "Insufficient credits" };
    }
    if (error.message.includes("duration")) {
      return { success: false, error: "Video too long" };
    }
    if (error.message.includes("format")) {
      return { success: false, error: "Unsupported video format" };
    }

    return { success: false, error: error.message };
  }
}
```
