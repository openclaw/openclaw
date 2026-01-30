---
name: backgrounds
description: Solid colors, images, and video backgrounds for HeyGen videos
metadata:
  tags: backgrounds, color, image, video, customization
---

# Video Backgrounds

HeyGen supports various background types to customize the appearance of your avatar videos.

## Background Types

| Type | Description |
|------|-------------|
| `color` | Solid color background |
| `image` | Static image background |
| `video` | Looping video background |

## Color Backgrounds

The simplest option - use a solid color:

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
        input_text: "Hello with a colored background!",
        voice_id: "1bd001e7e50f421d891986aad5158bc8",
      },
      background: {
        type: "color",
        value: "#FFFFFF", // White background
      },
    },
  ],
};
```

### Common Color Values

| Color | Hex Value | Use Case |
|-------|-----------|----------|
| White | `#FFFFFF` | Clean, professional |
| Black | `#000000` | Dramatic, cinematic |
| Blue | `#0066CC` | Corporate, trustworthy |
| Green | `#00FF00` | Chroma key (for compositing) |
| Gray | `#808080` | Neutral, modern |

### Using Transparent/Green Screen

For compositing in post-production:

```typescript
background: {
  type: "color",
  value: "#00FF00", // Green screen
}
```

## Image Backgrounds

Use a static image as background:

### From URL

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
        input_text: "Check out this custom background!",
        voice_id: "1bd001e7e50f421d891986aad5158bc8",
      },
      background: {
        type: "image",
        url: "https://example.com/my-background.jpg",
      },
    },
  ],
};
```

### From Uploaded Asset

First upload your image, then use the asset URL:

```typescript
// 1. Upload the image
const assetId = await uploadFile("./background.jpg", "image/jpeg");

// 2. Use in video config
const videoConfig = {
  video_inputs: [
    {
      character: {...},
      voice: {...},
      background: {
        type: "image",
        url: `https://files.heygen.ai/asset/${assetId}`,
      },
    },
  ],
};
```

### Image Requirements

- **Formats**: JPEG, PNG
- **Recommended size**: Match video dimensions (e.g., 1920x1080 for 1080p)
- **Aspect ratio**: Should match video aspect ratio
- **File size**: Under 10MB recommended

## Video Backgrounds

Use a looping video as background:

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
        input_text: "Dynamic video background!",
        voice_id: "1bd001e7e50f421d891986aad5158bc8",
      },
      background: {
        type: "video",
        url: "https://example.com/background-loop.mp4",
      },
    },
  ],
};
```

### Video Requirements

- **Format**: MP4 (H.264 codec recommended)
- **Looping**: Video will loop if shorter than avatar content
- **Audio**: Background video audio is typically muted
- **File size**: Under 100MB recommended

## Different Backgrounds Per Scene

Use different backgrounds for each scene:

```typescript
const multiBackgroundConfig = {
  video_inputs: [
    // Scene 1: Office background
    {
      character: {
        type: "avatar",
        avatar_id: "josh_lite3_20230714",
        avatar_style: "normal",
      },
      voice: {
        type: "text",
        input_text: "Let me start with an introduction.",
        voice_id: "1bd001e7e50f421d891986aad5158bc8",
      },
      background: {
        type: "image",
        url: "https://example.com/office-bg.jpg",
      },
    },
    // Scene 2: Product showcase
    {
      character: {
        type: "avatar",
        avatar_id: "josh_lite3_20230714",
        avatar_style: "closeUp",
      },
      voice: {
        type: "text",
        input_text: "Now let me show you our product.",
        voice_id: "1bd001e7e50f421d891986aad5158bc8",
      },
      background: {
        type: "image",
        url: "https://example.com/product-bg.jpg",
      },
    },
    // Scene 3: Call to action
    {
      character: {
        type: "avatar",
        avatar_id: "josh_lite3_20230714",
        avatar_style: "normal",
      },
      voice: {
        type: "text",
        input_text: "Get started today!",
        voice_id: "1bd001e7e50f421d891986aad5158bc8",
      },
      background: {
        type: "color",
        value: "#1a1a2e",
      },
    },
  ],
};
```

## Background Helper Functions

### TypeScript

```typescript
type BackgroundType = "color" | "image" | "video";

interface Background {
  type: BackgroundType;
  value?: string;
  url?: string;
}

function createColorBackground(hexColor: string): Background {
  return { type: "color", value: hexColor };
}

function createImageBackground(imageUrl: string): Background {
  return { type: "image", url: imageUrl };
}

function createVideoBackground(videoUrl: string): Background {
  return { type: "video", url: videoUrl };
}

// Preset backgrounds
const backgrounds = {
  white: createColorBackground("#FFFFFF"),
  black: createColorBackground("#000000"),
  greenScreen: createColorBackground("#00FF00"),
  corporate: createColorBackground("#0066CC"),
};
```

## Best Practices

1. **Match dimensions** - Background should match video dimensions
2. **Consider avatar position** - Leave space where avatar will appear
3. **Use contrasting colors** - Ensure avatar is visible against background
4. **Optimize file sizes** - Compress images/videos for faster processing
5. **Test with green screen** - For professional post-production workflows
6. **Keep backgrounds simple** - Avoid distracting elements behind the avatar

## Common Issues

### Background Not Showing

```typescript
// Wrong: missing url/value
background: {
  type: "image"
}

// Correct
background: {
  type: "image",
  url: "https://example.com/bg.jpg"
}
```

### Aspect Ratio Mismatch

If your background doesn't match the video dimensions, it may be cropped or stretched. Always match your background aspect ratio to your video dimensions:

```typescript
// For 1920x1080 video
// Use 1920x1080 background image

// For 1080x1920 portrait video
// Use 1080x1920 background image
```

### Video Background Audio

Background video audio is typically muted to avoid conflicting with the avatar's voice. If you need background music, add it as a separate audio track in post-production.
