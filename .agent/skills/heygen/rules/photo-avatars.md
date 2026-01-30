---
name: photo-avatars
description: Creating avatars from photos (talking photos) for HeyGen
metadata:
  tags: photo-avatar, talking-photo, avatar-iv, image-to-video
---

# Photo Avatars (Talking Photos)

Photo avatars allow you to animate a static photo and make it speak. This is useful for creating personalized video content from portraits, headshots, or any suitable image.

## Overview

HeyGen offers several approaches to photo-based avatars:

| Type | Description | Quality |
|------|-------------|---------|
| Talking Photo | Basic photo animation | Good |
| Photo Avatar | Enhanced photo avatar with motion | Better |
| Avatar IV | Latest generation photo avatar | Best |

## Uploading a Photo for Talking Photo

### Step 1: Upload the Image

```typescript
// Upload photo as an asset
const assetId = await uploadFile("./portrait.jpg", "image/jpeg");
```

### Step 2: Create Talking Photo

```bash
curl -X POST "https://api.heygen.com/v2/talking_photo" \
  -H "X-Api-Key: $HEYGEN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "image_url": "https://files.heygen.ai/asset/your_asset_id"
  }'
```

### TypeScript

```typescript
interface TalkingPhotoResponse {
  error: null | string;
  data: {
    talking_photo_id: string;
  };
}

async function createTalkingPhoto(imageUrl: string): Promise<string> {
  const response = await fetch("https://api.heygen.com/v2/talking_photo", {
    method: "POST",
    headers: {
      "X-Api-Key": process.env.HEYGEN_API_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ image_url: imageUrl }),
  });

  const json: TalkingPhotoResponse = await response.json();

  if (json.error) {
    throw new Error(json.error);
  }

  return json.data.talking_photo_id;
}
```

## Using Talking Photo in Video

```typescript
const videoConfig = {
  video_inputs: [
    {
      character: {
        type: "talking_photo",
        talking_photo_id: "your_talking_photo_id",
      },
      voice: {
        type: "text",
        input_text: "Hello! This is my talking photo speaking!",
        voice_id: "1bd001e7e50f421d891986aad5158bc8",
      },
    },
  ],
  dimension: { width: 1920, height: 1080 },
};

const videoId = await generateVideo(videoConfig);
```

## Avatar IV API

Avatar IV is HeyGen's latest photo avatar technology with improved quality and natural motion.

### Generate Avatar IV Video

```bash
curl -X POST "https://api.heygen.com/v2/video/av4/generate" \
  -H "X-Api-Key: $HEYGEN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "photo_s3_key": "path/to/uploaded/photo.jpg",
    "script": "Hello! This is Avatar IV with enhanced quality.",
    "voice_id": "1bd001e7e50f421d891986aad5158bc8",
    "video_orientation": "portrait",
    "video_title": "My Avatar IV Video"
  }'
```

### TypeScript

```typescript
interface AvatarIVRequest {
  photo_s3_key: string;
  script: string;
  voice_id: string;
  video_orientation?: "portrait" | "landscape" | "square";
  video_title?: string;
  fit?: "cover" | "contain";
  custom_motion_prompt?: string;
  enhance_custom_motion_prompt?: boolean;
}

interface AvatarIVResponse {
  error: null | string;
  data: {
    video_id: string;
  };
}

async function generateAvatarIVVideo(config: AvatarIVRequest): Promise<string> {
  const response = await fetch(
    "https://api.heygen.com/v2/video/av4/generate",
    {
      method: "POST",
      headers: {
        "X-Api-Key": process.env.HEYGEN_API_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(config),
    }
  );

  const json: AvatarIVResponse = await response.json();

  if (json.error) {
    throw new Error(json.error);
  }

  return json.data.video_id;
}
```

## Avatar IV Options

### Video Orientation

| Orientation | Dimensions | Use Case |
|-------------|------------|----------|
| `portrait` | 720x1280 | TikTok, Stories |
| `landscape` | 1280x720 | YouTube, Web |
| `square` | 720x720 | Instagram Feed |

### Fit Options

| Fit | Description |
|-----|-------------|
| `cover` | Fill the frame, may crop edges |
| `contain` | Fit entire image, may show background |

### Custom Motion Prompts

Add specific motion or expression:

```typescript
const config = {
  photo_s3_key: "path/to/photo.jpg",
  script: "Let me tell you about our product.",
  voice_id: "voice_id",
  custom_motion_prompt: "nodding head and smiling",
  enhance_custom_motion_prompt: true,
};
```

## Photo Avatar Groups

Organize multiple photo looks:

### Create Photo Avatar Group

```typescript
interface PhotoAvatarGroupRequest {
  image_key: string;
  name: string;
  generation_id?: string;
}

async function createPhotoAvatarGroup(
  imageKey: string,
  name: string
): Promise<string> {
  const response = await fetch(
    "https://api.heygen.com/v2/photo_avatar/avatar_group/create",
    {
      method: "POST",
      headers: {
        "X-Api-Key": process.env.HEYGEN_API_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ image_key: imageKey, name }),
    }
  );

  const json = await response.json();

  if (json.error) {
    throw new Error(json.error);
  }

  return json.data.id;
}
```

### Add Photos to Group

```typescript
async function addPhotosToGroup(
  groupId: string,
  imageKeys: string[],
  name: string
): Promise<void> {
  const response = await fetch(
    "https://api.heygen.com/v2/photo_avatar/avatar_group/add",
    {
      method: "POST",
      headers: {
        "X-Api-Key": process.env.HEYGEN_API_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        group_id: groupId,
        image_keys: imageKeys,
        name,
      }),
    }
  );

  const json = await response.json();

  if (json.error) {
    throw new Error(json.error);
  }
}
```

## Photo Requirements

For best results, use photos that meet these criteria:

### Technical Requirements

| Aspect | Requirement |
|--------|-------------|
| Format | JPEG, PNG |
| Resolution | Minimum 512x512px |
| File size | Under 10MB |
| Face visibility | Clear, front-facing |

### Quality Guidelines

1. **Lighting** - Even, natural lighting on face
2. **Expression** - Neutral or slight smile
3. **Background** - Simple, uncluttered
4. **Face position** - Centered, not cut off
5. **Clarity** - Sharp, in focus
6. **Angle** - Straight-on or slight angle

## Generating AI Photo Avatars

Generate synthetic photo avatars from text descriptions.

> **IMPORTANT: All 8 fields are REQUIRED.** The API will reject requests missing any field.
> You cannot simply provide a text description - you MUST specify each enum field explicitly.
> When a user asks to "generate an AI avatar of a professional man", you need to ask for or select values for ALL fields below.

### Required Fields (ALL must be provided)

| Field | Type | Allowed Values |
|-------|------|----------------|
| `name` | string | Name for the generated avatar |
| `age` | enum | `"Young Adult"`, `"Early Middle Age"`, `"Late Middle Age"`, `"Senior"`, `"Unspecified"` |
| `gender` | enum | `"Woman"`, `"Man"`, `"Unspecified"` |
| `ethnicity` | enum | `"White"`, `"Black"`, `"Asian American"`, `"East Asian"`, `"South East Asian"`, `"South Asian"`, `"Middle Eastern"`, `"Pacific"`, `"Hispanic"`, `"Unspecified"` |
| `orientation` | enum | `"square"`, `"horizontal"`, `"vertical"` |
| `pose` | enum | `"half_body"`, `"close_up"`, `"full_body"` |
| `style` | enum | `"Realistic"`, `"Pixar"`, `"Cinematic"`, `"Vintage"`, `"Noir"`, `"Cyberpunk"`, `"Unspecified"` |
| `appearance` | string | Text prompt describing appearance (clothing, mood, lighting, etc). Max 1000 chars |

### curl Example

```bash
curl -X POST "https://api.heygen.com/v2/photo_avatar/photo/generate" \
  -H "X-Api-Key: $HEYGEN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Sarah Product Demo",
    "age": "Young Adult",
    "gender": "Woman",
    "ethnicity": "White",
    "orientation": "horizontal",
    "pose": "half_body",
    "style": "Realistic",
    "appearance": "Professional woman with a friendly smile, wearing a navy blue blazer over a white blouse, soft studio lighting, clean neutral background"
  }'
```

### TypeScript

```typescript
// All fields are REQUIRED - the API will reject requests with missing fields
interface GeneratePhotoAvatarRequest {
  name: string;                    // Name for the avatar
  age: "Young Adult" | "Early Middle Age" | "Late Middle Age" | "Senior" | "Unspecified";
  gender: "Woman" | "Man" | "Unspecified";
  ethnicity: "White" | "Black" | "Asian American" | "East Asian" | "South East Asian" | "South Asian" | "Middle Eastern" | "Pacific" | "Hispanic" | "Unspecified";
  orientation: "square" | "horizontal" | "vertical";
  pose: "half_body" | "close_up" | "full_body";
  style: "Realistic" | "Pixar" | "Cinematic" | "Vintage" | "Noir" | "Cyberpunk" | "Unspecified";
  appearance: string;              // Max 1000 characters
  callback_url?: string;           // Optional: webhook for completion notification
  callback_id?: string;            // Optional: custom ID for tracking
}

interface GeneratePhotoAvatarResponse {
  error: string | null;
  data: {
    generation_id: string;
  };
}

async function generatePhotoAvatar(
  config: GeneratePhotoAvatarRequest
): Promise<string> {
  const response = await fetch(
    "https://api.heygen.com/v2/photo_avatar/photo/generate",
    {
      method: "POST",
      headers: {
        "X-Api-Key": process.env.HEYGEN_API_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(config),
    }
  );

  const json: GeneratePhotoAvatarResponse = await response.json();

  if (json.error) {
    throw new Error(`Photo avatar generation failed: ${json.error}`);
  }

  return json.data.generation_id;
}
```

### Example: Generate Professional Avatar

```typescript
const generationId = await generatePhotoAvatar({
  name: "Tech Demo Presenter",
  age: "Early Middle Age",
  gender: "Man",
  ethnicity: "East Asian",
  orientation: "horizontal",
  pose: "half_body",
  style: "Realistic",
  appearance: "Professional man in a modern office setting, wearing a dark gray suit with no tie, confident and approachable expression, soft natural lighting from a window, clean minimalist background"
});

console.log(`Generation started: ${generationId}`);
// Save generationId to poll for status later
```

### Check Generation Status

```typescript
interface PhotoGenerationStatus {
  error: string | null;
  data: {
    status: "pending" | "processing" | "completed" | "failed";
    image_url?: string;        // Available when completed
    image_key?: string;        // S3 key for use in video generation
  };
}

async function checkPhotoGeneration(generationId: string): Promise<PhotoGenerationStatus> {
  const response = await fetch(
    `https://api.heygen.com/v2/photo_avatar/generation/${generationId}`,
    { headers: { "X-Api-Key": process.env.HEYGEN_API_KEY! } }
  );

  return response.json();
}

// Poll for completion
async function waitForPhotoGeneration(generationId: string): Promise<string> {
  const maxAttempts = 60;
  const pollIntervalMs = 5000; // 5 seconds

  for (let i = 0; i < maxAttempts; i++) {
    const status = await checkPhotoGeneration(generationId);

    if (status.error) {
      throw new Error(status.error);
    }

    if (status.data.status === "completed") {
      return status.data.image_key!;
    }

    if (status.data.status === "failed") {
      throw new Error("Photo generation failed");
    }

    console.log(`Status: ${status.data.status}, waiting...`);
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }

  throw new Error("Photo generation timed out");
}
```

### Pre-Generation Checklist

Before calling the API, ensure you have values for ALL fields:

| # | Field | Question to Ask / Default |
|---|-------|---------------------------|
| 1 | `name` | What should we call this avatar? |
| 2 | `age` | Young Adult / Early Middle Age / Late Middle Age / Senior? |
| 3 | `gender` | Woman / Man? |
| 4 | `ethnicity` | Which ethnicity? (see enum values above) |
| 5 | `orientation` | horizontal (landscape) / vertical (portrait) / square? |
| 6 | `pose` | half_body (recommended) / close_up / full_body? |
| 7 | `style` | Realistic (recommended) / Cinematic / other? |
| 8 | `appearance` | Describe clothing, expression, lighting, background |

**If the user only provides a vague request** like "create a professional looking man", ask them to specify the missing fields OR make reasonable defaults (e.g., "Early Middle Age", "Realistic" style, "half_body" pose, "horizontal" orientation).

### Appearance Prompt Tips

The `appearance` field is a text prompt - be descriptive:

**Good prompts:**
- "Professional woman with shoulder-length brown hair, wearing a light blue button-down shirt, warm friendly smile, soft studio lighting, clean white background"
- "Young man with short black hair, casual tech startup style, wearing a dark hoodie, confident expression, modern office background with plants"

**Avoid:**
- Vague descriptions: "a nice person"
- Conflicting attributes
- Requesting specific real people

## Complete Workflow: Photo to Video

```typescript
async function createVideoFromPhoto(
  photoPath: string,
  script: string,
  voiceId: string
): Promise<string> {
  // 1. Upload photo
  console.log("Uploading photo...");
  const assetId = await uploadFile(photoPath, "image/jpeg");

  // 2. Create talking photo
  console.log("Creating talking photo...");
  const talkingPhotoId = await createTalkingPhoto(
    `https://files.heygen.ai/asset/${assetId}`
  );

  // 3. Generate video
  console.log("Generating video...");
  const videoId = await generateVideo({
    video_inputs: [
      {
        character: {
          type: "talking_photo",
          talking_photo_id: talkingPhotoId,
        },
        voice: {
          type: "text",
          input_text: script,
          voice_id: voiceId,
        },
      },
    ],
    dimension: { width: 1920, height: 1080 },
  });

  // 4. Wait for completion
  console.log("Processing video...");
  const videoUrl = await waitForVideo(videoId);

  return videoUrl;
}
```

## Managing Photo Avatars

### Get Photo Avatar Details

```typescript
async function getPhotoAvatar(id: string) {
  const response = await fetch(
    `https://api.heygen.com/v2/photo_avatar/${id}`,
    { headers: { "X-Api-Key": process.env.HEYGEN_API_KEY! } }
  );

  return response.json();
}
```

### Delete Photo Avatar

```typescript
async function deletePhotoAvatar(id: string): Promise<void> {
  const response = await fetch(
    `https://api.heygen.com/v2/photo_avatar/${id}`,
    {
      method: "DELETE",
      headers: { "X-Api-Key": process.env.HEYGEN_API_KEY! },
    }
  );

  if (!response.ok) {
    throw new Error("Failed to delete photo avatar");
  }
}
```

## Best Practices

1. **Use high-quality photos** - Better input = better output
2. **Front-facing portraits** - Work best for animation
3. **Neutral expressions** - Allow for more natural animation
4. **Test different photos** - Results vary by image
5. **Consider Avatar IV** - For highest quality results
6. **Organize with groups** - Keep photo avatars organized

## Limitations

- Photo quality significantly affects output
- Side-profile photos have limited support
- Full-body photos may not animate properly
- Some expressions may look unnatural
- Processing time varies by complexity
