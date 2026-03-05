# @studio/easings

Easing functions for smooth animations in Remotion projects.

## Installation

```bash
pnpm add @studio/easings
```

## Usage

### Preset Easings

```typescript
import { easeOutCubic, easeInOutBack, smooth } from '@studio/easings';
import { interpolate, useCurrentFrame } from 'remotion';

export const MyComponent = () => {
  const frame = useCurrentFrame();

  const opacity = interpolate(
    frame,
    [0, 30],
    [0, 1],
    {
      extrapolateRight: 'clamp',
      easing: easeOutCubic
    }
  );

  return <div style={{ opacity }}>Hello</div>;
};
```

### Custom Cubic Bezier

```typescript
import { cubicBezier } from "@studio/easings";

// Create custom easing (same as CSS cubic-bezier)
const customEase = cubicBezier(0.4, 0.0, 0.2, 1.0);

const scale = interpolate(frame, [0, 60], [0, 1], { easing: customEase });
```

### Utility Functions

```typescript
import {
  reverseEasing,
  mirrorEasing,
  steps,
  combineEasings,
  easeInCubic,
  easeOutCubic,
} from "@studio/easings";

// Reverse an easing (ease-in becomes ease-out)
const reversed = reverseEasing(easeInCubic);

// Create stepped animation
const stepped = steps(5); // 5 steps

// Combine two easings
const combined = combineEasings(easeInCubic, easeOutCubic, 0.5);
```

## Available Presets

### Standard CSS Easings

**Linear:**

- `linear`

**Ease:**

- `ease` (default CSS ease)
- `easeIn`, `easeOut`, `easeInOut`

**Sine:**

- `easeInSine`, `easeOutSine`, `easeInOutSine`

**Quad (Power of 2):**

- `easeInQuad`, `easeOutQuad`, `easeInOutQuad`

**Cubic (Power of 3):**

- `easeInCubic`, `easeOutCubic`, `easeInOutCubic`

**Quart (Power of 4):**

- `easeInQuart`, `easeOutQuart`, `easeInOutQuart`

**Quint (Power of 5):**

- `easeInQuint`, `easeOutQuint`, `easeInOutQuint`

**Expo (Exponential):**

- `easeInExpo`, `easeOutExpo`, `easeInOutExpo`

**Circ (Circular):**

- `easeInCirc`, `easeOutCirc`, `easeInOutCirc`

**Back (Overshoot):**

- `easeInBack`, `easeOutBack`, `easeInOutBack`

### Custom Presets

- `smooth` - Smooth and natural motion
- `swift` - Quick and responsive
- `bounce` - Bouncy effect
- `elastic` - Elastic spring effect
- `anticipate` - Slight backward motion before forward
- `overshoot` - Overshoots target then settles

## API

### `cubicBezier(x1, y1, x2, y2)`

Create a cubic bezier easing function (same as CSS).

### `reverseEasing(easing)`

Reverse an easing function (mirror on Y axis).

### `mirrorEasing(easing)`

Convert ease-in to ease-in-out style.

### `steps(steps, jumpStart?)`

Create a stepped easing function.

### `combineEasings(easing1, easing2, split?)`

Combine two easings with a split point.

### `scaleEasing(easing, min, max)`

Scale easing output to a specific range.

### `interpolate(from, to, progress, easing)`

Interpolate between values with easing.

## Visualizations

See [easings.net](https://easings.net) for visual representations of standard easing functions.
