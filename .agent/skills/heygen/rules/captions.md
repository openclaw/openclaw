---
name: captions
description: Auto-generated captions and subtitle options for HeyGen videos
metadata:
  tags: captions, subtitles, accessibility, srt
---

# Video Captions

HeyGen can automatically generate captions (subtitles) for your videos, improving accessibility and engagement.

## Enabling Captions

Captions can be enabled when generating a video:

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
        input_text: "Hello! This video will have automatic captions.",
        voice_id: "1bd001e7e50f421d891986aad5158bc8",
      },
    },
  ],
  // Caption settings (availability varies by plan)
  caption: true,
};
```

## Caption Configuration Options

```typescript
interface CaptionConfig {
  // Enable/disable captions
  enabled: boolean;

  // Caption style
  style?: {
    font_family?: string;
    font_size?: number;
    font_color?: string;
    background_color?: string;
    position?: "top" | "bottom";
  };

  // Language for caption generation
  language?: string;
}
```

## Caption Styles

### Basic Captions

```typescript
const config = {
  video_inputs: [...],
  caption: true, // Enable with default styling
};
```

### Styled Captions

```typescript
const config = {
  video_inputs: [...],
  caption: {
    enabled: true,
    style: {
      font_family: "Arial",
      font_size: 32,
      font_color: "#FFFFFF",
      background_color: "rgba(0, 0, 0, 0.7)",
      position: "bottom",
    },
  },
};
```

## Multi-Language Captions

For videos in different languages, captions are generated based on the voice language:

```typescript
// Spanish video with Spanish captions
const spanishConfig = {
  video_inputs: [
    {
      character: {
        type: "avatar",
        avatar_id: "josh_lite3_20230714",
        avatar_style: "normal",
      },
      voice: {
        type: "text",
        input_text: "¡Hola! Este video tendrá subtítulos en español.",
        voice_id: "spanish_voice_id",
      },
    },
  ],
  caption: true,
};
```

## Working with SRT Files

### Downloading SRT

After video generation, you may be able to download the SRT file:

```typescript
async function downloadSrt(videoId: string): Promise<string> {
  const response = await fetch(
    `https://api.heygen.com/v1/video/${videoId}/srt`,
    { headers: { "X-Api-Key": process.env.HEYGEN_API_KEY! } }
  );

  if (!response.ok) {
    throw new Error("Failed to download SRT");
  }

  return response.text();
}
```

### SRT File Format

Standard SRT format:

```srt
1
00:00:00,000 --> 00:00:03,000
Hello! This video will have

2
00:00:03,000 --> 00:00:06,000
automatic captions generated.

3
00:00:06,000 --> 00:00:09,000
They sync with the audio.
```

### Using Custom SRT

For video translation, you can provide your own SRT:

```typescript
const translationConfig = {
  input_video_id: "original_video_id",
  output_languages: ["es-ES", "fr-FR"],
  srt_key: "path/to/custom.srt", // Custom SRT file
  srt_role: "input", // "input" or "output"
};
```

## Caption Positioning

### Bottom (Default)

Standard position for most videos:

```typescript
caption: {
  enabled: true,
  style: {
    position: "bottom"
  }
}
```

### Top

For videos where bottom space is occupied:

```typescript
caption: {
  enabled: true,
  style: {
    position: "top"
  }
}
```

## Accessibility Best Practices

1. **Always enable captions** - Improves accessibility for deaf/hard-of-hearing viewers
2. **Use high contrast** - White text on dark background or vice versa
3. **Readable font size** - At least 24px for standard video, larger for mobile
4. **Don't cover important content** - Position captions away from key visual elements
5. **Sync timing** - Ensure captions match audio timing accurately

## Caption Helper Functions

```typescript
interface CaptionStyle {
  font_family: string;
  font_size: number;
  font_color: string;
  background_color: string;
  position: "top" | "bottom";
}

const captionPresets: Record<string, CaptionStyle> = {
  default: {
    font_family: "Arial",
    font_size: 32,
    font_color: "#FFFFFF",
    background_color: "rgba(0, 0, 0, 0.7)",
    position: "bottom",
  },
  minimal: {
    font_family: "Arial",
    font_size: 28,
    font_color: "#FFFFFF",
    background_color: "transparent",
    position: "bottom",
  },
  bold: {
    font_family: "Arial",
    font_size: 36,
    font_color: "#FFFFFF",
    background_color: "rgba(0, 0, 0, 0.9)",
    position: "bottom",
  },
  branded: {
    font_family: "Roboto",
    font_size: 30,
    font_color: "#00D1FF",
    background_color: "rgba(26, 26, 46, 0.9)",
    position: "bottom",
  },
};

function createCaptionConfig(preset: keyof typeof captionPresets) {
  return {
    enabled: true,
    style: captionPresets[preset],
  };
}
```

## Social Media Caption Considerations

### TikTok / Instagram Reels

- Position captions in center or upper portion
- Avoid bottom 20% (covered by UI elements)
- Use larger font sizes for mobile viewing

```typescript
const socialCaptions = {
  enabled: true,
  style: {
    font_size: 42,
    position: "top", // Avoid bottom UI elements
  },
};
```

### YouTube

- Standard bottom captions work well
- YouTube also supports closed captions upload

### LinkedIn

- Captions highly recommended (many watch without sound)
- Professional styling preferred

## Limitations

- Caption styles may be limited depending on your subscription tier
- Some advanced caption features may require the web interface
- Multi-speaker caption detection may have limited availability
- Caption accuracy depends on audio quality and speech clarity

## Integration with Video Translation

When using video translation, captions are automatically handled:

```typescript
// Video translation includes caption generation
const translationConfig = {
  input_video_id: "original_video_id",
  output_languages: ["es-ES"],
  // Captions generated in target language
};
```

See [video-translation.md](video-translation.md) for more details.
