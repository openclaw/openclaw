---
name: remotion-integration
description: Using HeyGen avatar videos in Remotion compositions
metadata:
  tags: remotion, integration, workflow, video, composition
---

# HeyGen + Remotion Integration

This guide covers workflows for generating HeyGen avatar videos and using them in Remotion compositions.

## Quick Start

```typescript
// 1. Get avatar with default voice
const avatar = await getAvatarDetails(avatarId);

// 2. Generate video (MP4 with background - most common)
const videoId = await generateVideo({
  video_inputs: [{
    character: { type: "avatar", avatar_id: avatar.id, avatar_style: "normal" },
    voice: { type: "text", input_text: script, voice_id: avatar.default_voice_id },
    background: { type: "color", value: "#1a1a2e" },
  }],
  dimension: { width: 1920, height: 1080 },
});

// 3. Poll for completion (10-15+ min)
// 4. Use in Remotion with motion graphics overlaid on top
```

## Overview

A typical workflow:
1. Generate avatar video with HeyGen
2. Wait for completion and get video URL
3. Download or use URL directly in Remotion
4. Compose with other elements (backgrounds, overlays, animations)

## Choosing the Right Output Format

| Your Composition | Recommended | Why |
|------------------|-------------|-----|
| Avatar as presenter with overlays | MP4 + background | Simpler, overlays go on top |
| Loom-style (avatar over screen recording) | WebM + `closeUp`, mask in Remotion | Need transparency, apply circle mask in CSS |
| Avatar overlaid ON other video/content | WebM (transparent) | Need to see through to content behind |
| Full-screen avatar | MP4 + background | Standard approach |

**Use MP4 with background for most cases.** Use WebM when you need to see content *behind* the avatar.

**Note:** WebM only supports `normal` and `closeUp` styles. For circular framing, use CSS `border-radius: 50%` in Remotion.

## Recommended: Parallel Development Workflow

HeyGen video generation takes **10-15+ minutes**. Don't wait - work in parallel:

1. **Start HeyGen generation** - save `video_id` to a file, exit immediately
2. **Build Remotion composition** - use a placeholder or the avatar's `preview_video_url` (a short loop)
3. **Check HeyGen status** periodically or when done building
4. **Swap placeholder** for real video URL once ready

**Estimate duration from script**: ~150 words/minute speech rate, so `wordCount / 150 * 60 * fps` gives approximate frames.

**Composition tip**: Design components to work with or without the avatar video, so motion graphics can be tested independently.

## Dimension Alignment

**Critical**: Match HeyGen output dimensions to your Remotion composition.

### Common Dimension Presets

```typescript
// Shared dimension constants for both HeyGen and Remotion
const DIMENSIONS = {
  landscape_1080p: { width: 1920, height: 1080 },
  landscape_720p: { width: 1280, height: 720 },
  portrait_1080p: { width: 1080, height: 1920 },
  portrait_720p: { width: 720, height: 1280 },
  square_1080p: { width: 1080, height: 1080 },
  square_720p: { width: 720, height: 720 },
} as const;

type DimensionPreset = keyof typeof DIMENSIONS;
```

### HeyGen Video Generation

```typescript
// Generate HeyGen video with specific dimensions
async function generateHeyGenVideo(
  script: string,
  avatarId: string,
  voiceId: string,
  preset: DimensionPreset
): Promise<string> {
  const dimension = DIMENSIONS[preset];

  const response = await fetch("https://api.heygen.com/v2/video/generate", {
    method: "POST",
    headers: {
      "X-Api-Key": process.env.HEYGEN_API_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
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
            value: "#00FF00", // Green screen for compositing
          },
        },
      ],
      dimension,
    }),
  });

  const { data } = await response.json();
  return data.video_id;
}
```

### Remotion Composition Setup

```tsx
// remotion/src/Root.tsx
import { Composition } from "remotion";
import { AvatarComposition } from "./AvatarComposition";

const DIMENSIONS = {
  landscape_1080p: { width: 1920, height: 1080 },
  // ... same as above
};

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="AvatarVideo"
        component={AvatarComposition}
        durationInFrames={300} // Will be set dynamically
        fps={30}
        width={DIMENSIONS.landscape_1080p.width}
        height={DIMENSIONS.landscape_1080p.height}
        defaultProps={{
          avatarVideoUrl: "",
        }}
      />
    </>
  );
};
```

## Generating Avatar Video for Remotion

### Standard: MP4 with Background

Most Remotion compositions work best with MP4 + background. Overlays and motion graphics go on top:

```typescript
async function generateAvatarForRemotion(
  script: string,
  avatarId: string,
  voiceId: string,
  options: {
    style?: "normal" | "closeUp" | "circle";
    backgroundColor?: string;
  } = {}
): Promise<string> {
  const { style = "normal", backgroundColor = "#1a1a2e" } = options;

  const response = await fetch("https://api.heygen.com/v2/video/generate", {
    method: "POST",
    headers: {
      "X-Api-Key": process.env.HEYGEN_API_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      video_inputs: [{
        character: {
          type: "avatar",
          avatar_id: avatarId,
          avatar_style: style,
        },
        voice: {
          type: "text",
          input_text: script,
          voice_id: voiceId,
        },
        background: {
          type: "color",
          value: backgroundColor,
        },
      }],
      dimension: { width: 1920, height: 1080 },
    }),
  });

  const { data } = await response.json();
  return data.video_id;
}
```

### Transparent Background (WebM)

Only use when you need to see content *behind* the avatar (e.g., avatar overlaid on screen recording):

```typescript
// Use /v1/video.webm endpoint for transparent background
// Note: Different structure than /v2/video/generate
const response = await fetch("https://api.heygen.com/v1/video.webm", {
  method: "POST",
  headers: {
    "X-Api-Key": process.env.HEYGEN_API_KEY!,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    avatar_pose_id: avatarPoseId,  // Required: avatar pose ID
    avatar_style: "normal",        // Required: "normal" or "closeUp" only
    input_text: script,            // Required (with voice_id)
    voice_id: voiceId,             // Required (with input_text)
    dimension: { width: 1920, height: 1080 },
  }),
});
```

## Using HeyGen Video in Remotion

### Important: Use OffthreadVideo for Frame-Accurate Rendering

**Always use `OffthreadVideo` instead of `Video`** for HeyGen avatar videos. The basic `Video` component uses the browser's video decoder which isn't frame-accurate, causing jitter during rendering. `OffthreadVideo` extracts frames via FFmpeg for smooth, accurate playback.

`OffthreadVideo` is included in the core `remotion` package - no additional install needed.

### Basic Usage

```tsx
// remotion/src/AvatarComposition.tsx
import { OffthreadVideo, useVideoConfig } from "remotion";

interface AvatarCompositionProps {
  avatarVideoUrl: string;
}

export const AvatarComposition: React.FC<AvatarCompositionProps> = ({
  avatarVideoUrl,
}) => {
  return (
    <div style={{ flex: 1, backgroundColor: "#1a1a2e" }}>
      <OffthreadVideo
        src={avatarVideoUrl}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "contain",
        }}
      />
    </div>
  );
};
```

### WebM with Transparent Background (Recommended)

Using WebM from `/v1/video.webm` - no chroma keying needed:

```tsx
import { OffthreadVideo, AbsoluteFill, Sequence } from "remotion";

export const AvatarWithMotionGraphics: React.FC<{
  avatarWebmUrl: string
}> = ({ avatarWebmUrl }) => {
  return (
    <AbsoluteFill>
      {/* Layer 1: Your background/content */}
      <AbsoluteFill style={{ backgroundColor: "#1a1a2e" }}>
        <YourMotionGraphics />
      </AbsoluteFill>

      {/* Layer 2: Avatar with transparent background - use OffthreadVideo for frame-accurate rendering */}
      <OffthreadVideo
        src={avatarWebmUrl}
        transparent
        style={{
          position: "absolute",
          bottom: 0,
          right: 0,
          width: "50%",
          height: "auto",
        }}
      />

      {/* Layer 3: Overlays on top of avatar */}
      <Sequence from={30}>
        <AnimatedTitle text="Welcome!" />
      </Sequence>
    </AbsoluteFill>
  );
};
```

### Loom-Style: Circle Avatar Over Screen Recording

Use `closeUp` style + WebM, then apply circular mask in Remotion:

```tsx
import { OffthreadVideo, AbsoluteFill } from "remotion";

export const LoomStyleComposition: React.FC<{
  screenRecordingUrl: string;
  avatarWebmUrl: string; // Generated with avatar_style: "closeUp" via /v1/video.webm
}> = ({ screenRecordingUrl, avatarWebmUrl }) => {
  return (
    <AbsoluteFill>
      {/* Screen recording fills the frame */}
      <OffthreadVideo src={screenRecordingUrl} style={{ width: "100%", height: "100%" }} />

      {/* Avatar with circular mask - transparent bg shows screen behind */}
      <OffthreadVideo
        src={avatarWebmUrl}
        transparent
        style={{
          position: "absolute",
          bottom: 40,
          left: 40,
          width: 180,
          height: 180,
          borderRadius: "50%", // Circular mask applied in CSS
          overflow: "hidden",
          objectFit: "cover",
        }}
      />
    </AbsoluteFill>
  );
};
```

**Note:** WebM doesn't support `circle` style - use `normal` or `closeUp` and apply circular masking via CSS.

### Legacy: Green Screen with Chroma Key

If using MP4 with green background (not recommended - use WebM instead):

```tsx
// Note: True chroma key requires WebGL or post-processing
// WebM transparent background is much simpler
<OffthreadVideo
  src={avatarVideoUrl}
  style={{
    mixBlendMode: "multiply", // Basic compositing only
  }}
/>
```

### Layered Composition

```tsx
import { OffthreadVideo, Sequence, useVideoConfig, Img } from "remotion";

interface LayeredAvatarProps {
  avatarVideoUrl: string;
  backgroundUrl: string;
  logoUrl: string;
  title: string;
}

export const LayeredAvatarComposition: React.FC<LayeredAvatarProps> = ({
  avatarVideoUrl,
  backgroundUrl,
  logoUrl,
  title,
}) => {
  const { fps } = useVideoConfig();

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {/* Layer 1: Background */}
      <Img
        src={backgroundUrl}
        style={{
          position: "absolute",
          width: "100%",
          height: "100%",
          objectFit: "cover",
        }}
      />

      {/* Layer 2: Avatar video - use OffthreadVideo to prevent jitter */}
      <OffthreadVideo
        src={avatarVideoUrl}
        style={{
          position: "absolute",
          bottom: 0,
          right: 0,
          width: "40%",
          height: "auto",
        }}
      />

      {/* Layer 3: Title (appears after 1 second) */}
      <Sequence from={fps}>
        <div
          style={{
            position: "absolute",
            top: 50,
            left: 50,
            color: "white",
            fontSize: 48,
            fontWeight: "bold",
          }}
        >
          {title}
        </div>
      </Sequence>

      {/* Layer 4: Logo */}
      <Img
        src={logoUrl}
        style={{
          position: "absolute",
          top: 20,
          right: 20,
          width: 100,
          height: "auto",
        }}
      />
    </div>
  );
};
```

## Complete Workflow

### Generate and Compose

```typescript
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";

async function generateAvatarVideoForRemotion(
  script: string,
  outputPath: string
) {
  // 1. Generate HeyGen video
  console.log("Generating HeyGen avatar video...");
  const videoId = await generateHeyGenVideo(
    script,
    "josh_lite3_20230714",
    "1bd001e7e50f421d891986aad5158bc8",
    "landscape_1080p"
  );

  // 2. Wait for completion
  console.log("Waiting for HeyGen video...");
  const avatarVideoUrl = await waitForVideo(videoId);
  console.log(`HeyGen video ready: ${avatarVideoUrl}`);

  // 3. Get video duration for Remotion
  const avatarDuration = await getVideoDuration(avatarVideoUrl);
  const durationInFrames = Math.ceil(avatarDuration * 30); // 30 fps

  // 4. Bundle Remotion project
  console.log("Bundling Remotion project...");
  const bundleLocation = await bundle({
    entryPoint: "./remotion/src/index.ts",
  });

  // 5. Select composition
  const composition = await selectComposition({
    serveUrl: bundleLocation,
    id: "AvatarVideo",
    inputProps: {
      avatarVideoUrl,
    },
  });

  // 6. Render final video
  console.log("Rendering final composition...");
  await renderMedia({
    composition: {
      ...composition,
      durationInFrames,
    },
    serveUrl: bundleLocation,
    codec: "h264",
    outputLocation: outputPath,
    inputProps: {
      avatarVideoUrl,
    },
  });

  console.log(`Final video rendered: ${outputPath}`);
  return outputPath;
}
```

### Dynamic Duration with calculateMetadata

```tsx
// remotion/src/AvatarComposition.tsx
import { CalculateMetadataFunction } from "remotion";

export const calculateAvatarMetadata: CalculateMetadataFunction<
  AvatarCompositionProps
> = async ({ props }) => {
  // Fetch video duration from HeyGen video
  const duration = await getVideoDurationInSeconds(props.avatarVideoUrl);

  return {
    durationInFrames: Math.ceil(duration * 30),
    fps: 30,
    width: 1920,
    height: 1080,
  };
};

// In Root.tsx
<Composition
  id="AvatarVideo"
  component={AvatarComposition}
  calculateMetadata={calculateAvatarMetadata}
  defaultProps={{
    avatarVideoUrl: "",
  }}
/>
```

## Best Practices

### 1. Use Green Screen for Flexibility

Generate HeyGen videos with green screen background when you want to composite:

```typescript
background: {
  type: "color",
  value: "#00FF00", // Pure green for chroma key
}
```

### 2. Match Frame Rates

HeyGen default is 25 fps. Consider this when setting Remotion fps:

```typescript
// Option 1: Match HeyGen's 25 fps
fps: 25

// Option 2: Use 30 fps with playback rate adjustment
<OffthreadVideo
  src={avatarVideoUrl}
  playbackRate={25/30} // Slow down slightly to match
/>
```

### 3. URL vs Download: When to Use Each

**Use URL directly** when:
- Previewing in Remotion Studio (`npm run dev`)
- URL won't expire before render completes
- You want faster iteration during development

```tsx
// Direct URL usage - simpler, faster for dev
<OffthreadVideo src={avatarVideoUrl} />
```

**Download first** when:
- URL has expiration (HeyGen URLs expire after ~24 hours)
- Rendering will happen later or repeatedly
- Network reliability is a concern
- You need offline rendering

```typescript
// Download with retry for reliability
async function downloadVideoWithRetry(
  url: string,
  outputPath: string,
  maxRetries = 5
): Promise<string> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const buffer = await response.arrayBuffer();
      await fs.promises.writeFile(outputPath, Buffer.from(buffer));
      return outputPath;
    } catch (error) {
      const delay = 2000 * Math.pow(2, attempt);
      console.log(`Retry ${attempt + 1}/${maxRetries} in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("Download failed after retries");
}

// Use local file in Remotion
const localPath = await downloadVideoWithRetry(avatarVideoUrl, "./public/avatar.mp4");
```

**Hybrid approach** (recommended for production):
```typescript
// Save both URL and local path in metadata
const metadata = {
  videoUrl: result.video_url,           // For quick preview
  localPath: "./public/avatar.mp4",     // For reliable rendering
  expiresAt: Date.now() + 24 * 60 * 60 * 1000, // URL expiration
};

// In Remotion component, prefer local if available
const videoSrc = fs.existsSync(localPath) ? staticFile("avatar.mp4") : avatarVideoUrl;
```

### 4. Handle Avatar Positioning

Common avatar positions in compositions:

```typescript
const AVATAR_POSITIONS = {
  fullscreen: { width: "100%", height: "100%", position: "center" },
  bottomRight: { width: "40%", bottom: 0, right: 0 },
  bottomLeft: { width: "40%", bottom: 0, left: 0 },
  pictureInPicture: { width: "25%", bottom: 20, right: 20 },
  leftThird: { width: "33%", left: 0, height: "100%" },
};
```

## Output Formats

### HeyGen Output
- Format: MP4 (H.264)
- Audio: AAC
- Resolution: As specified in request

### Remotion Output
- Codec: H.264 (default), VP8, VP9, ProRes
- Match or exceed HeyGen quality settings

```typescript
await renderMedia({
  codec: "h264",
  crf: 18, // High quality
  // ...
});
```

## Troubleshooting

### Video Not Playing in Remotion

1. Check URL accessibility (CORS issues)
2. Verify video format compatibility
3. Try downloading locally first

### Dimension Mismatch

Ensure both HeyGen and Remotion use identical dimensions:

```typescript
// Shared config
const VIDEO_CONFIG = {
  width: 1920,
  height: 1080,
  fps: 30,
};

// HeyGen
dimension: { width: VIDEO_CONFIG.width, height: VIDEO_CONFIG.height }

// Remotion
<Composition width={VIDEO_CONFIG.width} height={VIDEO_CONFIG.height} />
```

### Video Jitter During Rendering

If avatar video appears jittery or stuttery in rendered output:

1. **Use `OffthreadVideo` instead of `Video`** - The basic `Video` component uses the browser's video decoder which isn't frame-accurate
2. Update imports (no additional install needed - it's in core `remotion`):
   ```tsx
   // Before (causes jitter)
   import { Video } from "remotion";

   // After (frame-accurate)
   import { OffthreadVideo } from "remotion";
   ```
3. For WebM with transparency, add the `transparent` prop:
   ```tsx
   <OffthreadVideo src={avatarWebmUrl} transparent />
   ```

### Audio Sync Issues

If avatar audio drifts:
- Verify source video frame rate
- Check for encoding issues
- Consider re-encoding with consistent settings
