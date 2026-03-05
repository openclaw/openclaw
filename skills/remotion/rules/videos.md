---
name: videos
description: Embedding videos in Remotion - trimming, volume, speed, looping, pitch
metadata:
  tags: video, media, trim, volume, speed, loop, pitch
---

# Using videos in Remotion

## Prerequisites

First, the @remotion/media package needs to be installed.
If it is not, use the following command:

```bash
npx remotion add @remotion/media # If project uses npm
bunx remotion add @remotion/media # If project uses bun
yarn remotion add @remotion/media # If project uses yarn
pnpm exec remotion add @remotion/media # If project uses pnpm
```

Use `<Video>` from `@remotion/media` to embed videos into your composition.

```tsx
import { Video } from "@remotion/media";
import { staticFile } from "remotion";

export const MyComposition = () => {
  return <Video src={staticFile("video.mp4")} />;
};
```

Remote URLs are also supported:

```tsx
<Video src="https://remotion.media/video.mp4" />
```

## Trimming

Use `trimBefore` and `trimAfter` to remove portions of the video. Values are in frames.

```tsx
import { staticFile, useVideoConfig } from "remotion";

const { fps } = useVideoConfig();

return (
  <Video
    src={staticFile("video.mp4")}
    trimBefore={2 * fps} // Skip the first 2 seconds (2 * fps frames)
    trimAfter={10 * fps} // End at the 10 second mark (10 * fps frames)
  />
);
```

## Delaying

Wrap the video in a `<Sequence>` to delay when it appears:

```tsx
import { Sequence, staticFile, useVideoConfig } from "remotion";
import { Video } from "@remotion/media";

const { fps } = useVideoConfig();

return (
  <Sequence from={1 * fps}>
    <Video src={staticFile("video.mp4")} />
  </Sequence>
);
```

The video will appear after 1 second.

## Sizing and Position

Use the `style` prop to control size and position:

```tsx
<Video
  src={staticFile("video.mp4")}
  style={{
    width: 500,
    height: 300,
    position: "absolute",
    top: 100,
    left: 50,
    objectFit: "cover",
  }}
/>
```

## Volume

Set a static volume (0 to 1):

```tsx
<Video src={staticFile("video.mp4")} volume={0.5} />
```

Or use a callback for dynamic volume based on the current frame:

```tsx
import { interpolate, useVideoConfig } from "remotion";

const { fps } = useVideoConfig();

return (
  <Video
    src={staticFile("video.mp4")}
    volume={(f) => interpolate(f, [0, 1 * fps], [0, 1], { extrapolateRight: "clamp" })}
  />
);
```

Use `muted` to disable audio:

```tsx
<Video src={staticFile("video.mp4")} muted />
```

## Playback Speed

Control playback speed (0.5 = half speed, 2 = double speed):

```tsx
<Video src={staticFile("video.mp4")} playbackRate={1.5} />
```

## Looping

Enable looping:

```tsx
<Video src={staticFile("video.mp4")} loop />
```

## Pitch Correction

Preserve audio pitch when changing playback speed:

```tsx
<Video src={staticFile("video.mp4")} playbackRate={2} preservePitch />
```