---
name: video-generation
description: POST /v2/video/generate workflow and multi-scene videos for HeyGen
metadata:
  tags: video, generation, v2, scenes, workflow
---

# Video Generation

The `/v2/video/generate` endpoint is the primary way to create AI avatar videos with HeyGen.

## Video Output Formats

| Endpoint | Format | Use Case |
|----------|--------|----------|
| `/v2/video/generate` | MP4 | **Standard** - videos with background (most common) |
| `/v1/video.webm` | WebM | Transparent background - only when needed |

Use MP4 with background for most cases. WebM is only needed when you want to see content *behind* the avatar (e.g., overlaying avatar on a screen recording).

## Basic Video Generation

### curl

```bash
curl -X POST "https://api.heygen.com/v2/video/generate" \
  -H "X-Api-Key: $HEYGEN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "video_inputs": [
      {
        "character": {
          "type": "avatar",
          "avatar_id": "josh_lite3_20230714",
          "avatar_style": "normal"
        },
        "voice": {
          "type": "text",
          "input_text": "Hello! Welcome to HeyGen.",
          "voice_id": "1bd001e7e50f421d891986aad5158bc8"
        }
      }
    ],
    "dimension": {
      "width": 1920,
      "height": 1080
    }
  }'
```

## Request Fields

### Top-Level Fields

| Field | Type | Req | Description |
|-------|------|:---:|-------------|
| `video_inputs` | array | ✓ | Array of 1-50 video input objects |
| `dimension` | object | | Video dimensions `{width, height}` |
| `title` | string | | Video name for organization |
| `test` | boolean | | Test mode (watermarked, no credits) |
| `caption` | boolean | | Enable auto-captions |
| `callback_id` | string | | Custom ID for webhook tracking |
| `callback_url` | string | | URL for completion notification |
| `folder_id` | string | | Storage folder ID |

### video_inputs[].character Fields

| Field | Type | Req | Description |
|-------|------|:---:|-------------|
| `type` | string | ✓ | `"avatar"` or `"talking_photo"` |
| `avatar_id` | string | ✓* | Avatar ID (*required when type is "avatar") |
| `talking_photo_id` | string | ✓* | Photo ID (*required when type is "talking_photo") |
| `avatar_style` | string | | `"normal"`, `"closeUp"`, or `"circle"` |
| `scale` | number | | Avatar scale factor |
| `offset` | object | | Position offset `{x, y}` |

### video_inputs[].voice Fields

| Field | Type | Req | Description |
|-------|------|:---:|-------------|
| `type` | string | ✓ | `"text"`, `"audio"`, or `"silence"` |
| `voice_id` | string | ✓* | Voice ID (*required when type is "text") |
| `input_text` | string | ✓* | Script text (*required when type is "text") |
| `audio_url` | string | ✓* | Audio URL (*required when type is "audio") |
| `duration` | number | ✓* | Duration in seconds (*required when type is "silence") |
| `speed` | number | | Speech speed 0.5-2.0 (default 1.0) |
| `pitch` | number | | Voice pitch -20 to 20 (default 0) |

### video_inputs[].background Fields

| Field | Type | Req | Description |
|-------|------|:---:|-------------|
| `type` | string | | `"color"`, `"image"`, or `"video"` |
| `value` | string | | Hex color (when type is "color") |
| `url` | string | | Image/video URL (when type is "image"/"video") |
| `fit` | string | | `"cover"` or `"contain"` |

### TypeScript

```typescript
// Required fields have no '?' - optional fields have '?'
interface VideoInput {
  character: {
    type: "avatar" | "talking_photo";           // Required
    avatar_id?: string;                         // Required when type="avatar"
    talking_photo_id?: string;                  // Required when type="talking_photo"
    avatar_style?: "normal" | "closeUp" | "circle";
    scale?: number;
    offset?: { x: number; y: number };
  };
  voice: {
    type: "text" | "audio" | "silence";         // Required
    input_text?: string;                        // Required when type="text"
    voice_id?: string;                          // Required when type="text"
    audio_url?: string;                         // Required when type="audio"
    duration?: number;                          // Required when type="silence"
    speed?: number;
    pitch?: number;
  };
  background?: {
    type?: "color" | "image" | "video";
    value?: string;
    url?: string;
    fit?: "cover" | "contain";
  };
}

interface VideoGenerateRequest {
  video_inputs: VideoInput[];                   // Required
  dimension?: { width: number; height: number };
  test?: boolean;
  title?: string;
  caption?: boolean;
  callback_id?: string;
  callback_url?: string;
  folder_id?: string;
}

interface VideoGenerateResponse {
  error: null | string;
  data: {
    video_id: string;
  };
}

async function generateVideo(config: VideoGenerateRequest): Promise<string> {
  const response = await fetch("https://api.heygen.com/v2/video/generate", {
    method: "POST",
    headers: {
      "X-Api-Key": process.env.HEYGEN_API_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(config),
  });

  const json: VideoGenerateResponse = await response.json();

  if (json.error) {
    throw new Error(json.error);
  }

  return json.data.video_id;
}
```

### Python

```python
import requests
import os

def generate_video(config: dict) -> str:
    response = requests.post(
        "https://api.heygen.com/v2/video/generate",
        headers={
            "X-Api-Key": os.environ["HEYGEN_API_KEY"],
            "Content-Type": "application/json"
        },
        json=config
    )

    data = response.json()
    if data.get("error"):
        raise Exception(data["error"])

    return data["data"]["video_id"]
```

## Video Configuration Options

### Full Configuration Example

```typescript
const fullConfig: VideoGenerateRequest = {
  // Test mode (no credits consumed, watermarked output)
  test: false,

  // Video title (for organization)
  title: "Product Demo Video",

  // Video dimensions
  dimension: {
    width: 1920,
    height: 1080,
  },

  // Video scenes/inputs
  video_inputs: [
    {
      // Avatar configuration
      character: {
        type: "avatar",
        avatar_id: "josh_lite3_20230714",
        avatar_style: "normal",
      },

      // Voice configuration
      voice: {
        type: "text",
        input_text: "Welcome to our product demonstration!",
        voice_id: "1bd001e7e50f421d891986aad5158bc8",
        speed: 1.0,
        pitch: 0,
      },

      // Background configuration
      background: {
        type: "color",
        value: "#FFFFFF",
      },
    },
  ],
};
```

## Multi-Scene Videos

Create videos with multiple scenes:

```typescript
const multiSceneConfig = {
  video_inputs: [
    // Scene 1: Introduction
    {
      character: {
        type: "avatar",
        avatar_id: "josh_lite3_20230714",
        avatar_style: "normal",
      },
      voice: {
        type: "text",
        input_text: "Hello! Today I'll show you three key features.",
        voice_id: "1bd001e7e50f421d891986aad5158bc8",
      },
      background: {
        type: "color",
        value: "#1a1a2e",
      },
    },
    // Scene 2: Feature 1
    {
      character: {
        type: "avatar",
        avatar_id: "josh_lite3_20230714",
        avatar_style: "closeUp",
      },
      voice: {
        type: "text",
        input_text: "First, let's look at our dashboard.",
        voice_id: "1bd001e7e50f421d891986aad5158bc8",
      },
      background: {
        type: "image",
        url: "https://example.com/dashboard-bg.jpg",
      },
    },
    // Scene 3: Conclusion
    {
      character: {
        type: "avatar",
        avatar_id: "josh_lite3_20230714",
        avatar_style: "normal",
      },
      voice: {
        type: "text",
        input_text: "Thanks for watching! Try it today.",
        voice_id: "1bd001e7e50f421d891986aad5158bc8",
      },
      background: {
        type: "color",
        value: "#1a1a2e",
      },
    },
  ],
  dimension: { width: 1920, height: 1080 },
};
```

## Using Different Character Types

### Avatar

```typescript
{
  character: {
    type: "avatar",
    avatar_id: "josh_lite3_20230714",
    avatar_style: "normal"
  }
}
```

### Talking Photo

```typescript
{
  character: {
    type: "talking_photo",
    talking_photo_id: "your_talking_photo_id"
  }
}
```

## Voice Input Types

### Text-to-Speech

```typescript
{
  voice: {
    type: "text",
    input_text: "Your script here",
    voice_id: "1bd001e7e50f421d891986aad5158bc8",
    speed: 1.0,  // 0.5 - 2.0
    pitch: 0     // -20 to 20
  }
}
```

### Custom Audio

```typescript
{
  voice: {
    type: "audio",
    audio_url: "https://example.com/your-audio.mp3"
  }
}
```

## Complete Workflow Example

```typescript
async function createVideo(script: string, avatarId: string, voiceId: string) {
  // 1. Generate video
  console.log("Starting video generation...");
  const videoId = await generateVideo({
    video_inputs: [
      {
        character: {
          type: "avatar",
          avatar_id: avatarId,
          avatar_style: "normal",
        },
        voice: {
          type: "text",
          input_text: script,
          voice_id: voiceId,
        },
        background: {
          type: "color",
          value: "#FFFFFF",
        },
      },
    ],
    dimension: { width: 1920, height: 1080 },
  });

  console.log(`Video ID: ${videoId}`);

  // 2. Poll for completion
  console.log("Waiting for video completion...");
  const videoUrl = await waitForVideo(videoId);

  console.log(`Video ready: ${videoUrl}`);
  return videoUrl;
}

// Helper function for polling
async function waitForVideo(videoId: string): Promise<string> {
  const maxAttempts = 60;
  const pollInterval = 10000; // 10 seconds

  for (let i = 0; i < maxAttempts; i++) {
    const response = await fetch(
      `https://api.heygen.com/v1/video_status.get?video_id=${videoId}`,
      { headers: { "X-Api-Key": process.env.HEYGEN_API_KEY! } }
    );

    const { data } = await response.json();

    if (data.status === "completed") {
      return data.video_url;
    } else if (data.status === "failed") {
      throw new Error(data.error || "Video generation failed");
    }

    await new Promise((r) => setTimeout(r, pollInterval));
  }

  throw new Error("Video generation timed out");
}
```

## Error Handling

```typescript
async function generateVideoSafe(config: VideoGenerateRequest) {
  try {
    const videoId = await generateVideo(config);
    return { success: true, videoId };
  } catch (error) {
    // Common errors
    if (error.message.includes("quota")) {
      console.error("Insufficient credits");
    } else if (error.message.includes("avatar")) {
      console.error("Invalid avatar ID");
    } else if (error.message.includes("voice")) {
      console.error("Invalid voice ID");
    } else if (error.message.includes("script")) {
      console.error("Script too long or invalid");
    }

    return { success: false, error: error.message };
  }
}
```

## Script Length Limits

| Tier | Max Characters |
|------|----------------|
| Free | ~500 |
| Creator | ~1,500 |
| Team | ~3,000 |
| Enterprise | ~5,000+ |

## Adding Pauses to Scripts

Use `<break>` tags to add pauses in your script:

```typescript
const script = "Welcome to our demo. <break time=\"1s\"/> Let me show you the features.";
```

**Format:** `<break time="Xs"/>` where X is seconds (e.g., `1s`, `1.5s`, `0.5s`)

**Important:** Break tags must have spaces before and after them.

See [voices.md](voices.md) for detailed break tag documentation.

## Test Mode

Use test mode during development:

```typescript
const config = {
  test: true, // Watermarked output, no credits consumed
  video_inputs: [...],
};
```

## Production-Ready Workflow

Complete example using avatar's default voice (recommended), proper timeouts, and retry logic:

```typescript
interface VideoGenerationResult {
  videoId: string;
  videoUrl: string;
  duration: number;
  avatarId: string;
  voiceId: string;
  avatarName: string;
}

async function generateAvatarVideo(
  script: string,
  options: {
    avatarId?: string; // Specific avatar, or will pick first available
    width?: number;
    height?: number;
  } = {}
): Promise<VideoGenerationResult> {
  const { width = 1920, height = 1080 } = options;
  let { avatarId } = options;

  // 1. List avatars if no specific one provided
  if (!avatarId) {
    console.log("Listing available avatars...");
    const listResponse = await fetch("https://api.heygen.com/v2/avatars", {
      headers: { "X-Api-Key": process.env.HEYGEN_API_KEY! },
    });
    const listData = await listResponse.json();

    if (!listData.data?.avatars?.length) {
      throw new Error("No avatars available");
    }
    avatarId = listData.data.avatars[0].avatar_id;
  }

  // 2. Get avatar details including default_voice_id
  console.log(`Getting details for avatar: ${avatarId}`);
  const detailsResponse = await fetch(
    `https://api.heygen.com/v2/avatar/${avatarId}/details`,
    { headers: { "X-Api-Key": process.env.HEYGEN_API_KEY! } }
  );
  const { data: avatar } = await detailsResponse.json();

  if (!avatar.default_voice_id) {
    throw new Error(`Avatar ${avatar.name} has no default voice - select voice manually`);
  }

  console.log(`Using avatar: ${avatar.name} with default voice: ${avatar.default_voice_id}`);

  // 3. Generate video using avatar's default voice
  const videoId = await generateVideo({
    video_inputs: [{
      character: {
        type: "avatar",
        avatar_id: avatar.id, // from details response
        avatar_style: "normal",
      },
      voice: {
        type: "text",
        input_text: script,
        voice_id: avatar.default_voice_id, // pre-matched default voice
        speed: 1.0,
      },
      background: {
        type: "color",
        value: "#1a1a2e",
      },
    }],
    dimension: { width, height },
  });

  console.log(`Video ID: ${videoId}`);

  // 3. Wait for completion (20 minute timeout - generation can take 15+ min)
  console.log("Waiting for video generation (typically 5-15 minutes, can be longer)...");
  const result = await waitForVideo(
    videoId,
    process.env.HEYGEN_API_KEY!,
    (status, elapsed) => {
      console.log(`  [${Math.round(elapsed / 1000)}s] ${status}`);
    },
    1200000 // 20 minute timeout for safety
  );

  return {
    videoId,
    videoUrl: result.video_url!,
    duration: result.duration!,
    avatarId: avatar.id,
    voiceId: avatar.default_voice_id,
    avatarName: avatar.name,
  };
}

// Usage - let it pick an avatar automatically
const result = await generateAvatarVideo(
  "Hello! Welcome to our product demonstration."
);
console.log(`Video ready: ${result.videoUrl}`);

// Or specify a known avatar_id
const result2 = await generateAvatarVideo(
  "Hello! Welcome to our product demonstration.",
  { avatarId: "josh_lite3_20230714" }
);
```

## Transparent Background Videos (WebM)

Use WebM **only when you need transparency** - i.e., when the avatar should be overlaid on other video content and you need to see through to what's behind.

**Don't need WebM for:**
- Avatar with motion graphics/text overlaid ON TOP of avatar
- Picture-in-picture with solid background
- Standard presenter videos

**Do need WebM for:**
- Avatar overlaid on screen recording
- Avatar floating over video background
- True alpha-channel compositing

### WebM Request Fields

**Note:** The WebM endpoint (`/v1/video.webm`) uses a different structure than `/v2/video/generate`.

| Field | Type | Req | Description |
|-------|------|:---:|-------------|
| `avatar_pose_id` | string | ✓ | Avatar pose ID (from avatar details) |
| `avatar_style` | string | ✓ | `"normal"` or `"closeUp"` only (no circle) |
| `input_text` | string | ✓* | Script text (*required if not using input_audio) |
| `voice_id` | string | ✓* | Voice ID (*required with input_text) |
| `input_audio` | string | ✓* | Audio URL (*required if not using input_text) |
| `dimension` | object | | `{width, height}` (default: 1280x720) |

**Either** (`input_text` + `voice_id`) **OR** `input_audio` must be provided, but not both.

### curl

```bash
curl -X POST "https://api.heygen.com/v1/video.webm" \
  -H "X-Api-Key: $HEYGEN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "avatar_pose_id": "josh_lite3_20230714",
    "avatar_style": "normal",
    "input_text": "Hello! This video has a transparent background.",
    "voice_id": "1bd001e7e50f421d891986aad5158bc8",
    "dimension": {
      "width": 1920,
      "height": 1080
    }
  }'
```

### TypeScript

```typescript
interface WebMVideoRequest {
  avatar_pose_id: string;                      // Required
  avatar_style: "normal" | "closeUp";          // Required (no circle support)
  input_text?: string;                         // Required if not using input_audio
  voice_id?: string;                           // Required with input_text
  input_audio?: string;                        // Required if not using input_text
  dimension?: { width: number; height: number };
}

async function generateTransparentVideo(
  script: string,
  avatarPoseId: string,
  voiceId: string
): Promise<string> {
  const response = await fetch("https://api.heygen.com/v1/video.webm", {
    method: "POST",
    headers: {
      "X-Api-Key": process.env.HEYGEN_API_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      avatar_pose_id: avatarPoseId,            // Required
      avatar_style: "normal",                  // Required: "normal" or "closeUp"
      input_text: script,                      // Required (with voice_id)
      voice_id: voiceId,                       // Required (with input_text)
      dimension: { width: 1920, height: 1080 },
    }),
  });

  const { data } = await response.json();
  return data.video_id;
}
```

### When to Use WebM vs MP4

| Scenario | Format | Why |
|----------|--------|-----|
| Avatar with overlays on top | **MP4** | Overlays go on top, don't need transparency |
| Standard presenter | **MP4** | Simpler, more compatible |
| Loom-style (avatar over screen recording) | **WebM** + `normal`/`closeUp` | Need transparency, crop to circle in post |
| Avatar floating over video content | **WebM** | Need to see content behind avatar |

**Note:** WebM only supports `normal` and `closeUp` styles. Circle style is not supported for WebM - apply circular masking in your video editor/Remotion instead.

### WebM Example: Loom-Style (Avatar Over Screen Recording)

Generate with `normal` or `closeUp` style (circle not supported for WebM):

```typescript
// Generate avatar with transparent background
const videoId = await fetch("https://api.heygen.com/v1/video.webm", {
  method: "POST",
  headers: { "X-Api-Key": apiKey, "Content-Type": "application/json" },
  body: JSON.stringify({
    avatar_pose_id: avatarPoseId,              // Required
    avatar_style: "closeUp",                   // Required: "normal" or "closeUp" only
    input_text: script,                        // Required (with voice_id)
    voice_id: voiceId,                         // Required (with input_text)
    dimension: { width: 1920, height: 1080 },
  }),
}).then(r => r.json()).then(d => d.data.video_id);
```

Apply circular masking in Remotion:

```tsx
import { Video, AbsoluteFill } from "remotion";

export const LoomStyleVideo: React.FC<{
  screenRecordingUrl: string;
  avatarWebmUrl: string;
}> = ({ screenRecordingUrl, avatarWebmUrl }) => {
  return (
    <AbsoluteFill>
      {/* Screen recording as base layer */}
      <Video src={screenRecordingUrl} style={{ width: "100%", height: "100%" }} />

      {/* Avatar with circular mask applied in CSS */}
      <Video
        src={avatarWebmUrl}
        style={{
          position: "absolute",
          bottom: 20,
          left: 20,
          width: 150,
          height: 150,
          borderRadius: "50%", // Circular mask
          overflow: "hidden",
          objectFit: "cover",
        }}
      />
    </AbsoluteFill>
  );
};
```

### Note on Status Polling

WebM videos use the same status endpoint as MP4:

```typescript
// Same polling as regular videos
const status = await getVideoStatus(videoId);
// status.video_url will be a .webm file
```

## Best Practices

1. **Preview avatars before generating** - Download `preview_image_url` so user can see what the avatar looks like before committing to a video (see [avatars.md](avatars.md))
2. **Use avatar's default voice** - Most avatars have a `default_voice_id` that's pre-matched for natural results (see [avatars.md](avatars.md))
2. **Fallback: match gender manually** - If no default voice, ensure avatar and voice genders match (see [voices.md](voices.md))
3. **Validate inputs** - Check avatar and voice IDs before generating
4. **Use test mode** - Test configurations without consuming credits
5. **Set generous timeouts** - Use 15-20 minutes; generation often takes 10-15 min, sometimes longer
6. **Consider async patterns** - For long videos, save video_id and check status later (see [video-status.md](video-status.md))
7. **Handle errors gracefully** - Implement proper error handling
8. **Monitor progress** - Implement polling with progress feedback
9. **Optimize scripts** - Keep scripts concise and natural
10. **Consider dimensions** - Match dimensions to your use case (see [dimensions.md](dimensions.md))
