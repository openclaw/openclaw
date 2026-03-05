---
name: ffmpeg
description: Using FFmpeg and FFprobe in Remotion
metadata:
  tags: ffmpeg, ffprobe, video, trimming
---

## FFmpeg in Remotion

`ffmpeg` and `ffprobe` do not need to be installed. They are available via the `bunx remotion ffmpeg` and `bunx remotion ffprobe`:

```bash
bunx remotion ffmpeg -i input.mp4 output.mp3
bunx remotion ffprobe input.mp4
```

### Trimming videos

You have 2 options for trimming videos:

1. Use the FFMpeg command line. You MUST re-encode the video to avoid frozen frames at the start of the video.

```bash
# Re-encodes from the exact frame
bunx remotion ffmpeg -ss 00:00:05 -i public/input.mp4 -to 00:00:10 -c:v libx264 -c:a aac public/output.mp4
```

2. Use the `trimBefore` and `trimAfter` props of the `<Video>` component. The benefit is that this is non-destructive and you can change the trim at any time.

```tsx
import { Video } from "@remotion/media";

<Video src={staticFile("video.mp4")} trimBefore={5 * fps} trimAfter={10 * fps} />;
```
