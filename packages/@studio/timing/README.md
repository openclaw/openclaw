# @studio/timing

Timing utilities and helpers for Remotion projects.

## Installation

```bash
pnpm add @studio/timing
```

## Usage

```typescript
import {
  secondsToFrames,
  getProgress,
  createSegment,
  stagger,
  FPS,
} from "@studio/timing";

// Convert seconds to frames
const frames = secondsToFrames(2.5, FPS.WEB); // 75 frames at 30fps

// Calculate animation progress
const progress = getProgress(frame, 0, 100); // 0-1

// Create timing segments
const intro = createSegment(0, 60);
const main = createSegment(60, 120);

// Stagger animations
const startFrame = stagger(index, 5); // 0, 5, 10, 15...
```

## API

### Constants

- `FPS`: Common frame rate constants (24, 25, 29.97, 30, 60, 120)
- `DURATION`: Common duration constants in seconds

### Frame Utilities

- `secondsToFrames(seconds, fps)`: Convert seconds to frames
- `framesToSeconds(frames, fps)`: Convert frames to seconds
- `msToFrame(timeMs, fps)`: Convert milliseconds to frame number
- `frameToMs(frame, fps)`: Convert frame number to milliseconds
- `clampFrame(frame, min, max)`: Clamp frame within range
- `getProgress(frame, start, end)`: Calculate progress (0-1)

### Timing Helpers

- `createSegment(start, duration)`: Create timing segment
- `getSegmentEnd(segment)`: Get end frame of segment
- `isInSegment(frame, segment)`: Check if frame is in segment
- `getLocalFrame(frame, segment)`: Get local frame within segment
- `createSequentialSegments(durations, startFrame)`: Create sequential segments
- `stagger(index, staggerDelay, startFrame)`: Calculate staggered timing
