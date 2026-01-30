---
name: dimensions
description: Resolution options (720p/1080p) and aspect ratios for HeyGen videos
metadata:
  tags: dimensions, resolution, aspect-ratio, 720p, 1080p, portrait, landscape
---

# Video Dimensions and Resolution

HeyGen supports various video dimensions and aspect ratios to fit different platforms and use cases.

## Standard Resolutions

### Landscape (16:9)

| Resolution | Width | Height | Use Case |
|------------|-------|--------|----------|
| 720p | 1280 | 720 | Standard quality, faster processing |
| 1080p | 1920 | 1080 | High quality, most common |

### Portrait (9:16)

| Resolution | Width | Height | Use Case |
|------------|-------|--------|----------|
| 720p | 720 | 1280 | Mobile-first content |
| 1080p | 1080 | 1920 | High quality vertical |

### Square (1:1)

| Resolution | Width | Height | Use Case |
|------------|-------|--------|----------|
| 720p | 720 | 720 | Social media posts |
| 1080p | 1080 | 1080 | High quality square |

## Setting Dimensions

### TypeScript

```typescript
// Landscape 1080p
const landscapeConfig = {
  video_inputs: [...],
  dimension: {
    width: 1920,
    height: 1080
  }
};

// Portrait 1080p
const portraitConfig = {
  video_inputs: [...],
  dimension: {
    width: 1080,
    height: 1920
  }
};

// Square 1080p
const squareConfig = {
  video_inputs: [...],
  dimension: {
    width: 1080,
    height: 1080
  }
};
```

### curl

```bash
# Landscape 1080p
curl -X POST "https://api.heygen.com/v2/video/generate" \
  -H "X-Api-Key: $HEYGEN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "video_inputs": [...],
    "dimension": {
      "width": 1920,
      "height": 1080
    }
  }'
```

## Dimension Helper Functions

```typescript
type AspectRatio = "16:9" | "9:16" | "1:1" | "4:3" | "4:5";
type Quality = "720p" | "1080p";

interface Dimensions {
  width: number;
  height: number;
}

function getDimensions(aspectRatio: AspectRatio, quality: Quality): Dimensions {
  const configs: Record<AspectRatio, Record<Quality, Dimensions>> = {
    "16:9": {
      "720p": { width: 1280, height: 720 },
      "1080p": { width: 1920, height: 1080 },
    },
    "9:16": {
      "720p": { width: 720, height: 1280 },
      "1080p": { width: 1080, height: 1920 },
    },
    "1:1": {
      "720p": { width: 720, height: 720 },
      "1080p": { width: 1080, height: 1080 },
    },
    "4:3": {
      "720p": { width: 960, height: 720 },
      "1080p": { width: 1440, height: 1080 },
    },
    "4:5": {
      "720p": { width: 576, height: 720 },
      "1080p": { width: 864, height: 1080 },
    },
  };

  return configs[aspectRatio][quality];
}

// Usage
const youTubeDimensions = getDimensions("16:9", "1080p");
const tikTokDimensions = getDimensions("9:16", "1080p");
const instagramDimensions = getDimensions("1:1", "1080p");
```

## Platform-Specific Recommendations

### YouTube

```typescript
const youtubeConfig = {
  video_inputs: [...],
  dimension: { width: 1920, height: 1080 }, // 16:9 landscape
};
```

### TikTok / Instagram Reels / YouTube Shorts

```typescript
const shortFormConfig = {
  video_inputs: [...],
  dimension: { width: 1080, height: 1920 }, // 9:16 portrait
};
```

### Instagram Feed Post

```typescript
const instagramFeedConfig = {
  video_inputs: [...],
  dimension: { width: 1080, height: 1080 }, // 1:1 square
};
```

### LinkedIn

```typescript
const linkedinConfig = {
  video_inputs: [...],
  dimension: { width: 1920, height: 1080 }, // 16:9 landscape preferred
};
```

### Twitter/X

```typescript
const twitterConfig = {
  video_inputs: [...],
  dimension: { width: 1280, height: 720 }, // 16:9, 720p is common
};
```

## Avatar IV Dimensions

For Avatar IV (photo-based avatars), dimensions are set via orientation:

```typescript
type VideoOrientation = "portrait" | "landscape" | "square";

function getAvatarIVDimensions(orientation: VideoOrientation): Dimensions {
  switch (orientation) {
    case "portrait":
      return { width: 720, height: 1280 };
    case "landscape":
      return { width: 1280, height: 720 };
    case "square":
      return { width: 720, height: 720 };
  }
}
```

## Custom Dimensions

HeyGen supports custom dimensions within limits:

```typescript
const customConfig = {
  video_inputs: [...],
  dimension: {
    width: 1600,
    height: 900  // Custom 16:9 at non-standard resolution
  }
};
```

### Dimension Constraints

- **Minimum**: 128px on any side
- **Maximum**: 4096px on any side
- **Must be even numbers**: Both width and height must be divisible by 2

```typescript
function validateDimensions(width: number, height: number): boolean {
  if (width < 128 || height < 128) {
    throw new Error("Dimensions must be at least 128px");
  }
  if (width > 4096 || height > 4096) {
    throw new Error("Dimensions cannot exceed 4096px");
  }
  if (width % 2 !== 0 || height % 2 !== 0) {
    throw new Error("Dimensions must be even numbers");
  }
  return true;
}
```

## Resolution vs. Credit Cost

Higher resolutions may consume more credits:

| Resolution | Relative Cost |
|------------|---------------|
| 720p | Base rate |
| 1080p | ~1.5x base rate |

Consider using 720p for drafts and testing, then 1080p for final output.

## Background Considerations

Match background image/video dimensions to your video dimensions:

```typescript
// For 1080p landscape video
const config = {
  video_inputs: [
    {
      character: {...},
      voice: {...},
      background: {
        type: "image",
        url: "https://example.com/1920x1080-background.jpg" // Match video dimensions
      }
    }
  ],
  dimension: { width: 1920, height: 1080 }
};
```

## Creating a Video Config Factory

```typescript
interface VideoConfigOptions {
  script: string;
  avatarId: string;
  voiceId: string;
  platform: "youtube" | "tiktok" | "instagram_feed" | "instagram_story" | "linkedin";
  quality?: "720p" | "1080p";
}

function createVideoConfig(options: VideoConfigOptions) {
  const platformDimensions: Record<string, Dimensions> = {
    youtube: { width: 1920, height: 1080 },
    tiktok: { width: 1080, height: 1920 },
    instagram_feed: { width: 1080, height: 1080 },
    instagram_story: { width: 1080, height: 1920 },
    linkedin: { width: 1920, height: 1080 },
  };

  const dimension = platformDimensions[options.platform];

  // Scale down for 720p if requested
  if (options.quality === "720p") {
    dimension.width = Math.round((dimension.width * 720) / 1080);
    dimension.height = Math.round((dimension.height * 720) / 1080);
  }

  return {
    video_inputs: [
      {
        character: {
          type: "avatar",
          avatar_id: options.avatarId,
          avatar_style: "normal",
        },
        voice: {
          type: "text",
          input_text: options.script,
          voice_id: options.voiceId,
        },
      },
    ],
    dimension,
  };
}

// Usage
const tiktokVideo = createVideoConfig({
  script: "Hey everyone! Check this out!",
  avatarId: "josh_lite3_20230714",
  voiceId: "1bd001e7e50f421d891986aad5158bc8",
  platform: "tiktok",
  quality: "1080p",
});
```
