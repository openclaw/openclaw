---
name: remotion
description: Video creation in React using Remotion. Use when creating, editing, or rendering programmatic videos with React components. Covers compositions, animations, transitions, audio/video handling, subtitles, captions, charts, 3D, maps, and best practices for automated video generation.
---

# Remotion - Video Creation in React

Remotion is a framework for creating videos programmatically using React components.

## Quick Start

```bash
# Create new project
npx create-video@latest my-video

# Start Studio
npx remotion studio

# Render video
npx remotion render src/index.ts MyComp out/video.mp4
```

## Core Concepts

### Compositions

Define video components with dimensions, duration, and FPS:

```tsx
import { Composition } from "remotion";

<Composition
  id="MyVideo"
  component={MyVideo}
  durationInFrames={150}
  fps={30}
  width={1920}
  height={1080}
/>;
```

### Animations

All animations use `useCurrentFrame()` - CSS animations are forbidden:

```tsx
import { useCurrentFrame, interpolate } from "remotion";

const frame = useCurrentFrame();
const opacity = interpolate(frame, [0, 30], [0, 1]);
```

## Rule Categories

### Core

- [rules/compositions.md](rules/compositions.md) - Compositions, Stills, Folders
- [rules/animations.md](rules/animations.md) - Animation fundamentals
- [rules/timing.md](rules/timing.md) - interpolate, spring, easing
- [rules/sequencing.md](rules/sequencing.md) - Sequence, Series timing
- [rules/transitions.md](rules/transitions.md) - Scene transitions
- [rules/trimming.md](rules/trimming.md) - Trimming patterns

### Media

- [rules/videos.md](rules/videos.md) - Video embedding
- [rules/audio.md](rules/audio.md) - Audio handling
- [rules/images.md](rules/images.md) - Image components
- [rules/gifs.md](rules/gifs.md) - GIF animations
- [rules/fonts.md](rules/fonts.md) - Font loading
- [rules/lottie.md](rules/lottie.md) - Lottie animations

### Text & Captions

- [rules/text-animations.md](rules/text-animations.md) - Typography animations
- [rules/display-captions.md](rules/display-captions.md) - TikTok-style captions
- [rules/subtitles.md](rules/subtitles.md) - Subtitle formats
- [rules/import-srt-captions.md](rules/import-srt-captions.md) - Import SRT files
- [rules/transcribe-captions.md](rules/transcribe-captions.md) - Transcribe audio

### Advanced

- [rules/3d.md](rules/3d.md) - Three.js integration
- [rules/charts.md](rules/charts.md) - Data visualization
- [rules/maps.md](rules/maps.md) - Mapbox maps
- [rules/audio-visualization.md](rules/audio-visualization.md) - Spectrum/waveforms
- [rules/parameters.md](rules/parameters.md) - Zod parameterization
- [rules/voiceover.md](rules/voiceover.md) - ElevenLabs TTS
- [rules/light-leaks.md](rules/light-leaks.md) - Light leak effects
- [rules/transparent-videos.md](rules/transparent-videos.md) - Alpha channel

### Utility

- [rules/assets.md](rules/assets.md) - staticFile usage
- [rules/tailwind.md](rules/tailwind.md) - TailwindCSS
- [rules/ffmpeg.md](rules/ffmpeg.md) - FFmpeg commands
- [rules/calculate-metadata.md](rules/calculate-metadata.md) - Dynamic metadata
- [rules/can-decode.md](rules/can-decode.md) - Browser decode check
- [rules/extract-frames.md](rules/extract-frames.md) - Frame extraction
- [rules/get-audio-duration.md](rules/get-audio-duration.md) - Audio duration
- [rules/get-video-dimensions.md](rules/get-video-dimensions.md) - Video dimensions
- [rules/get-video-duration.md](rules/get-video-duration.md) - Video duration
- [rules/measuring-dom-nodes.md](rules/measuring-dom-nodes.md) - Measure DOM
- [rules/measuring-text.md](rules/measuring-text.md) - Measure text
- [rules/sfx.md](rules/sfx.md) - Sound effects

## Common Packages

```bash
# Media
npx remotion add @remotion/media
npx remotion add @remotion/media-utils

# Transitions
npx remotion add @remotion/transitions
npx remotion add @remotion/light-leaks

# Captions
npx remotion add @remotion/captions

# Fonts
npx remotion add @remotion/google-fonts
npx remotion add @remotion/fonts
