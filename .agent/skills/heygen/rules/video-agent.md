---
name: video-agent
description: One-shot prompt video generation with HeyGen Video Agent API
metadata:
  tags: video-agent, prompt, ai, automated, one-shot
---

# Video Agent API

The Video Agent API generates complete videos from a single text prompt. Unlike the standard video generation API which requires detailed scene-by-scene configuration, Video Agent automatically handles script writing, avatar selection, visuals, voiceover, pacing, and captions.

## When to Use Video Agent vs Standard API

| Use Case | Recommended API |
|----------|-----------------|
| Quick video from idea | Video Agent |
| Precise control over scenes, avatars, timing | Standard v2/video/generate |
| Automated content generation at scale | Video Agent |
| Specific avatar with exact script | Standard v2/video/generate |
| Prototype or draft video | Video Agent |
| Brand-consistent production video | Standard v2/video/generate |

## Endpoint

```
POST https://api.heygen.com/v1/video_agent/generate
```

## Request Fields

| Field | Type | Req | Description |
|-------|------|:---:|-------------|
| `prompt` | string | ✓ | Text prompt describing the video you want |
| `config` | object | | Configuration options (see below) |
| `files` | array | | Asset files to reference in generation |
| `callback_id` | string | | Custom ID for tracking |
| `callback_url` | string | | Webhook URL for completion notification |

### Config Object

| Field | Type | Description |
|-------|------|-------------|
| `duration_sec` | integer | Approximate duration in seconds (5-300) |
| `avatar_id` | string | Specific avatar to use (optional - agent selects if not provided) |
| `orientation` | string | `"portrait"` or `"landscape"` |

### Files Array

| Field | Type | Description |
|-------|------|-------------|
| `asset_id` | string | Asset ID of uploaded file to reference |

## Response Format

```json
{
  "error": null,
  "data": {
    "video_id": "abc123"
  }
}
```

## curl Example

```bash
curl -X POST "https://api.heygen.com/v1/video_agent/generate" \
  -H "X-Api-Key: $HEYGEN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Create a 60-second product demo video for a new AI-powered calendar app. The tone should be professional but friendly, targeting busy professionals. Highlight the smart scheduling feature and time zone handling."
  }'
```

## TypeScript

```typescript
interface VideoAgentConfig {
  duration_sec?: number;      // 5-300 seconds
  avatar_id?: string;         // Optional: specific avatar
  orientation?: "portrait" | "landscape";
}

interface VideoAgentFile {
  asset_id: string;
}

interface VideoAgentRequest {
  prompt: string;             // Required
  config?: VideoAgentConfig;
  files?: VideoAgentFile[];
  callback_id?: string;
  callback_url?: string;
}

interface VideoAgentResponse {
  error: string | null;
  data: {
    video_id: string;
  };
}

async function generateWithVideoAgent(
  prompt: string,
  config?: VideoAgentConfig
): Promise<string> {
  const request: VideoAgentRequest = { prompt };

  if (config) {
    request.config = config;
  }

  const response = await fetch(
    "https://api.heygen.com/v1/video_agent/generate",
    {
      method: "POST",
      headers: {
        "X-Api-Key": process.env.HEYGEN_API_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    }
  );

  const json: VideoAgentResponse = await response.json();

  if (json.error) {
    throw new Error(`Video Agent failed: ${json.error}`);
  }

  return json.data.video_id;
}
```

## Python

```python
import requests
import os
from typing import Optional

def generate_with_video_agent(
    prompt: str,
    duration_sec: Optional[int] = None,
    avatar_id: Optional[str] = None,
    orientation: Optional[str] = None
) -> str:
    request_body = {"prompt": prompt}

    config = {}
    if duration_sec:
        config["duration_sec"] = duration_sec
    if avatar_id:
        config["avatar_id"] = avatar_id
    if orientation:
        config["orientation"] = orientation

    if config:
        request_body["config"] = config

    response = requests.post(
        "https://api.heygen.com/v1/video_agent/generate",
        headers={
            "X-Api-Key": os.environ["HEYGEN_API_KEY"],
            "Content-Type": "application/json"
        },
        json=request_body
    )

    data = response.json()
    if data.get("error"):
        raise Exception(f"Video Agent failed: {data['error']}")

    return data["data"]["video_id"]
```

## Examples

### Basic: Prompt Only

```typescript
const videoId = await generateWithVideoAgent(
  "Create a 30-second welcome video for new employees at a tech startup. Keep it energetic and modern."
);
```

### With Duration and Orientation

```typescript
const videoId = await generateWithVideoAgent(
  "Explain the benefits of cloud computing for small businesses. Use simple language and real-world examples.",
  {
    duration_sec: 90,
    orientation: "landscape"
  }
);
```

### With Specific Avatar

```typescript
const videoId = await generateWithVideoAgent(
  "Present quarterly sales results. Professional tone, data-focused.",
  {
    duration_sec: 120,
    avatar_id: "josh_lite3_20230714",
    orientation: "landscape"
  }
);
```

### With Reference Files

Upload assets first, then reference them:

```typescript
// 1. Upload reference materials (see assets.md)
const logoAssetId = await uploadFile("./company-logo.png", "image/png");
const productImageId = await uploadFile("./product-screenshot.png", "image/png");

// 2. Generate video with references
const response = await fetch(
  "https://api.heygen.com/v1/video_agent/generate",
  {
    method: "POST",
    headers: {
      "X-Api-Key": process.env.HEYGEN_API_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt: "Create a product demo video showcasing our new dashboard feature. Use the uploaded screenshots as visual references.",
      config: {
        duration_sec: 60,
        orientation: "landscape"
      },
      files: [
        { asset_id: logoAssetId },
        { asset_id: productImageId }
      ]
    }),
  }
);
```

## Writing Effective Prompts

### Include in Your Prompt

| Element | Example |
|---------|---------|
| **Purpose** | "product demo", "tutorial", "announcement" |
| **Duration hint** | "60-second", "brief 30-second", "comprehensive 3-minute" |
| **Tone** | "professional", "casual", "energetic", "serious" |
| **Audience** | "targeting developers", "for beginners", "enterprise customers" |
| **Key points** | "highlight the AI features and pricing" |

### Example Prompts

**Product Demo:**
```
Create a 90-second product demo for our project management tool.
Target audience: startup founders and small team leads.
Highlight: Kanban boards, time tracking, and Slack integration.
Tone: Professional but approachable.
```

**Educational:**
```
Explain how blockchain technology works in simple terms.
Duration: 2 minutes.
Audience: Complete beginners with no technical background.
Use analogies and avoid jargon.
```

**Marketing:**
```
Create an energetic 30-second ad for our fitness app launch.
Target: Health-conscious millennials.
Key message: AI-powered personalized workouts.
End with a strong call-to-action to download.
```

## Checking Video Status

Video Agent returns a `video_id` - use the standard status endpoint to check progress:

```typescript
// Same polling as standard video generation
const videoUrl = await waitForVideo(videoId);
```

See [video-status.md](video-status.md) for polling implementation.

## Comparison: Video Agent vs Standard API

### Video Agent Request
```typescript
// Simple: describe what you want
const videoId = await generateWithVideoAgent(
  "Create a 60-second tutorial on setting up two-factor authentication. Professional tone, step-by-step."
);
```

### Equivalent Standard API Request
```typescript
// Complex: specify every detail
const videoId = await generateVideo({
  video_inputs: [
    {
      character: {
        type: "avatar",
        avatar_id: "josh_lite3_20230714",
        avatar_style: "normal",
      },
      voice: {
        type: "text",
        input_text: "Welcome to this tutorial on two-factor authentication...",
        voice_id: "1bd001e7e50f421d891986aad5158bc8",
      },
      background: {
        type: "color",
        value: "#1a1a2e",
      },
    },
    // ... more scenes for each step
  ],
  dimension: { width: 1920, height: 1080 },
});
```

## Limitations

- Less control over exact script wording
- Avatar selection may vary if not specified
- Scene composition is automated
- May not match precise brand guidelines
- Duration is approximate, not exact

## Best Practices

1. **Be specific in prompts** - More detail = better results
2. **Specify duration** - Use `config.duration_sec` for predictable length
3. **Lock avatar if needed** - Use `config.avatar_id` for consistency
4. **Upload reference files** - Help agent understand your brand/product
5. **Iterate on prompts** - Refine based on results
6. **Use for drafts** - Video Agent is great for quick iterations before final production
