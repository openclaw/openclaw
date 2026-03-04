---
name: display-captions
description: Displaying captions in Remotion with TikTok-style pages and word highlighting
metadata:
  tags: captions, subtitles, display, tiktok, highlight
---

# Displaying captions in Remotion

This guide explains how to display captions in Remotion, assuming you already have captions in the [`Caption`](https://www.remotion.dev/docs/captions/caption) format.

## Prerequisites

Read [Transcribing audio](transcribe-captions.md) for how to generate captions.

First, the [`@remotion/captions`](https://www.remotion.dev/docs/captions) package needs to be installed.
If it is not installed, use the following command:

```bash
npx remotion add @remotion/captions
```

## Fetching captions

First, fetch your captions JSON file. Use [`useDelayRender()`](https://www.remotion.dev/docs/use-delay-render) to hold the render until the captions are loaded:

```tsx
import { useState, useEffect, useCallback } from "react";
import { AbsoluteFill, staticFile, useDelayRender } from "remotion";
import type { Caption } from "@remotion/captions";

export const MyComponent: React.FC = () => {
  const [captions, setCaptions] = useState<Caption[] | null>(null);
  const { delayRender, continueRender, cancelRender } = useDelayRender();
  const [handle] = useState(() => delayRender());

  const fetchCaptions = useCallback(async () => {
    try {
      // Replace with your actual captions file path
      const response = await fetch(staticFile("captions.json"));
      const data = await response.json();
      setCaptions(data);
      continueRender(handle);
    } catch (e) {
      cancelRender(e);
    }
  }, [continueRender, cancelRender, handle]);

  useEffect(() => {
    fetchCaptions();
  }, [fetchCaptions]);

  if (!captions) {
    return null;
  }

  return <AbsoluteFill>{/* Render captions here */}</AbsoluteFill>;
};
```

## Creating pages

Use `createTikTokStyleCaptions()` to group captions into pages. The `combineTokensWithinMilliseconds` option controls how many words appear at once:

```tsx
import { useMemo } from "react";
import { createTikTokStyleCaptions } from "@remotion/captions";
import type { Caption } from "@remotion/captions";

// How often captions should switch (in milliseconds)
// Higher values = more words per page
const combineTokensWithinMilliseconds = 2000;

const pages = useMemo(() => {
  return createTikTokStyleCaptions({
    combineTokensWithinMilliseconds,
    captions: captions!,
  });
}, [captions]);
```

## Displaying words

Map through the pages and words to render captions with highlighting:

```tsx
import { useCurrentFrame } from "remotion";

const frame = useCurrentFrame();

// Find the current page based on frame time
const currentPage = pages.find((page) => {
  const startFrame = Math.floor((page.startMs / 1000) * fps);
  const endFrame = Math.floor((page.endMs / 1000) * fps);
  return frame >= startFrame && frame <= endFrame;
});

// Render each word with highlighting
return (
  <AbsoluteFill>
    {currentPage?.tokens.map((token, index) => {
      const wordStartFrame = Math.floor((token.startMs / 1000) * fps);
      const isActive = frame >= wordStartFrame;

      return (
        <span
          key={index}
          style={{
            color: isActive ? "white" : "rgba(255,255,255,0.5)",
            fontWeight: isActive ? "bold" : "normal",
          }}
        >
          {token.text}{" "}
        </span>
      );
    })}
  </AbsoluteFill>
);
```

## Best Practices

- Place captions file in the `public/` folder and use `staticFile()`
- Use `useDelayRender()` to prevent rendering before captions load
- Consider responsive design for different video dimensions
- Test with different `combineTokensWithinMilliseconds` values to find optimal pacing
