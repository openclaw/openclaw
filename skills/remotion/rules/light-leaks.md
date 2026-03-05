---
name: light-leaks
description: Light leak overlay effects for Remotion using @remotion/light-leaks.
metadata:
  tags: light-leaks, overlays, effects, transitions
---

## Light Leaks

This only works from Remotion 4.0.415 and up. Use `npx remotion versions` to check your Remotion version and `npx remotion upgrade` to upgrade your Remotion version.

`<LightLeak>` from `@remotion/light-leaks` renders a WebGL-based light leak effect. It reveals during the first half of its duration and retracts during the second half.

Typically used inside a `<TransitionSeries.Overlay>` to play over the cut point between two scenes. See the **transitions** rule for `<TransitionSeries>` and overlay usage.

## Prerequisites

```bash
npx remotion add @remotion/light-leaks
```

## Basic usage with TransitionSeries

```tsx
import { TransitionSeries } from "@remotion/transitions";
import { LightLeak } from "@remotion/light-leaks";

<TransitionSeries>
  <TransitionSeries.Sequence durationInFrames={60}>
    <SceneA />
  </TransitionSeries.Sequence>
  <TransitionSeries.Overlay durationInFrames={30}>
    <LightLeak />
  </TransitionSeries.Overlay>
  <TransitionSeries.Sequence durationInFrames={60}>
    <SceneB />
  </TransitionSeries.Sequence>
</TransitionSeries>;
```

## Props

- `durationInFrames?` — defaults to the parent sequence/composition duration. The effect reveals during the first half and retracts during the second half.
- `seed?` — determines the shape of the light leak pattern. Different seeds produce different patterns. Default: `0`.
- `hueShift?` — rotates the hue in degrees (`0`–`360`). Default: `0` (yellow-to-orange). `120` = green, `240` = blue.

## Customizing the look

```tsx
import { LightLeak } from "@remotion/light-leaks";

// Blue-tinted light leak with a different pattern
<LightLeak seed={5} hueShift={240} />;

// Green-tinted light leak
<LightLeak seed={2} hueShift={120} />;
```

## Standalone usage

`<LightLeak>` can also be used outside of `<TransitionSeries>`, for example as a decorative overlay in any composition:

```tsx
import { AbsoluteFill } from "remotion";
import { LightLeak } from "@remotion/light-leaks";

const MyComp: React.FC = () => (
  <AbsoluteFill>
    <MyContent />
    <LightLeak durationInFrames={60} seed={3} />
  </AbsoluteFill>
);
```
