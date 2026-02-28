# SKILL: REMOTION-ELITE

> "Code the Motion. React-based Video Architecture."

This skill provides Rykiri with the ability to generate programmatic videos using React and the Remotion framework.

## 1. CAPABILITIES
- **Dynamic UI Recording**: Transform React components into video frames.
- **Data-Driven Animation**: Generate videos based on real-time project data (e.g., Solana transaction flows).
- **Headless Rendering**: Render videos in a headless CI/CD or server environment using `npx remotion render`.

## 2. CLI USAGE
- **Initialize**: `npx create-remotion@latest`
- **Preview**: `npx remotion preview`
- **Render**: `npx remotion render <composition-id> <output-path>`
- **Headless**: `pnpm exec remotion render src/index.ts MyComp out/video.mp4 --browser=chromium`

## 3. INTEGRATION DIRECTIVE
When generating programmatic video for projects:
1. **Mark the Component**: Define the React component and its props.
2. **Analyze the Motion**: Ensure smooth 60fps animations using `useCurrentFrame()` and `interpolate()`.
3. **Execute the Render**: Run the `render` command in the background and monitor progress.

## 4. EXAMPLE COMPONENT (Remotion)
```tsx
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';

export const MyComposition = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 30], [0, 1]);

  return (
    <AbsoluteFill style={{ backgroundColor: 'black', opacity }}>
      <h1 style={{ color: 'white', fontFamily: 'Inter' }}>Solana Pulse</h1>
    </AbsoluteFill>
  );
};
```
