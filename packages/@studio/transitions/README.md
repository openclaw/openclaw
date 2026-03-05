# @studio/transitions

Transition components for Remotion projects.

## Installation

```bash
pnpm add @studio/transitions
```

## Usage

### Fade Transitions

```typescript
import { FadeIn, FadeOut, Fade } from '@studio/transitions';

// Fade in
<FadeIn startFrame={0} duration={30}>
  <div>Content</div>
</FadeIn>

// Fade out
<FadeOut startFrame={60} duration={30}>
  <div>Content</div>
</FadeOut>

// Generic (specify type)
<Fade startFrame={0} duration={30} type="in">
  <div>Content</div>
</Fade>
```

### Slide Transitions

```typescript
import { SlideIn, SlideOut, Slide } from '@studio/transitions';

// Slide in from right
<SlideIn startFrame={0} duration={30} direction="right">
  <div>Content</div>
</SlideIn>

// Slide out to left with custom distance
<SlideOut startFrame={60} duration={30} direction="left" distance={150}>
  <div>Content</div>
</SlideOut>

// All directions: 'up', 'down', 'left', 'right'
<Slide startFrame={0} duration={30} direction="up" type="in">
  <div>Content</div>
</Slide>
```

### Scale Transitions

```typescript
import { ScaleIn, ScaleOut, Scale } from '@studio/transitions';

// Scale in from 0
<ScaleIn startFrame={0} duration={30}>
  <div>Content</div>
</ScaleIn>

// Scale out with custom scale and origin
<ScaleOut
  startFrame={60}
  duration={30}
  scale={0.5}
  origin="top left"
>
  <div>Content</div>
</ScaleOut>

// Pop effect (scale from larger)
<ScaleIn startFrame={0} duration={30} scale={1.5}>
  <div>Content</div>
</ScaleIn>
```

### Wipe Transitions

```typescript
import { WipeIn, WipeOut, Wipe } from '@studio/transitions';

// Wipe in from right
<WipeIn startFrame={0} duration={30} direction="right">
  <div>Content</div>
</WipeIn>

// Wipe out to left
<WipeOut startFrame={60} duration={30} direction="left">
  <div>Content</div>
</WipeOut>

// All directions: 'up', 'down', 'left', 'right'
<Wipe startFrame={0} duration={30} direction="down" type="in">
  <div>Content</div>
</Wipe>
```

## Component Props

### Common Props

All transition components accept these props:

- `children`: ReactNode - Content to animate
- `startFrame`: number - Frame when transition starts
- `duration`: number - Duration in frames
- `type?`: 'in' | 'out' - Type of transition (for generic components)

### Slide Props

- `direction?`: 'up' | 'down' | 'left' | 'right' - Slide direction (default: 'right')
- `distance?`: number - Distance in percentage (default: 100)

### Scale Props

- `scale?`: number - Initial/final scale (default: 0)
- `origin?`: string - Transform origin (default: 'center')

### Wipe Props

- `direction?`: 'up' | 'down' | 'left' | 'right' - Wipe direction (default: 'right')

## Combining Transitions

```typescript
import { FadeIn, SlideIn } from '@studio/transitions';

// Fade + Slide combo
<FadeIn startFrame={0} duration={30}>
  <SlideIn startFrame={0} duration={30} direction="up">
    <div>Content with combined effect</div>
  </SlideIn>
</FadeIn>
```

## With Easing Functions

Use with `@studio/easings` for smoother animations:

```typescript
import { interpolate, useCurrentFrame } from "remotion";
import { easeOutCubic } from "@studio/easings";

const frame = useCurrentFrame();
const opacity = interpolate(frame, [0, 30], [0, 1], {
  easing: easeOutCubic,
});
```

## Examples

### Sequence of Transitions

```typescript
export const MyComposition = () => {
  return (
    <>
      {/* Title fades in */}
      <FadeIn startFrame={0} duration={20}>
        <h1>Title</h1>
      </FadeIn>

      {/* Subtitle slides in after title */}
      <SlideIn startFrame={20} duration={20} direction="up">
        <h2>Subtitle</h2>
      </SlideIn>

      {/* Content scales in */}
      <ScaleIn startFrame={40} duration={20}>
        <div>Main content</div>
      </ScaleIn>

      {/* Everything fades out */}
      <FadeOut startFrame={200} duration={30}>
        <div>All content</div>
      </FadeOut>
    </>
  );
};
```
