---
name: text-overlays
description: Adding text overlays with fonts and positioning to HeyGen videos
metadata:
  tags: text, overlays, fonts, positioning, graphics
---

# Text Overlays

Add text overlays to your HeyGen videos for titles, captions, lower thirds, and other on-screen text elements.

## Basic Text Overlay

```typescript
const videoConfig = {
  video_inputs: [
    {
      character: {
        type: "avatar",
        avatar_id: "josh_lite3_20230714",
        avatar_style: "normal",
      },
      voice: {
        type: "text",
        input_text: "Welcome to our presentation!",
        voice_id: "1bd001e7e50f421d891986aad5158bc8",
      },
      background: {
        type: "color",
        value: "#1a1a2e",
      },
    },
  ],
  // Text overlay configuration (if supported in your API tier)
  // Note: Availability varies by plan
};
```

## Text Overlay Configuration

Text overlays typically support these properties:

```typescript
interface TextOverlay {
  text: string;
  x: number;          // X position (pixels or percentage)
  y: number;          // Y position (pixels or percentage)
  width?: number;     // Text box width
  height?: number;    // Text box height
  font_family?: string;
  font_size?: number;
  font_color?: string;
  background_color?: string;
  text_align?: "left" | "center" | "right";
  duration?: {
    start: number;    // Start time in seconds
    end: number;      // End time in seconds
  };
}
```

## Positioning Text

### Coordinate System

- **Origin**: Top-left corner (0, 0)
- **X-axis**: Increases to the right
- **Y-axis**: Increases downward
- **Units**: Typically pixels or percentage of video dimensions

### Common Positions

For a 1920x1080 video:

| Position | X | Y | Description |
|----------|---|---|-------------|
| Top-left | 50 | 50 | Upper left corner |
| Top-center | 960 | 50 | Top center |
| Top-right | 1870 | 50 | Upper right corner |
| Center | 960 | 540 | Dead center |
| Bottom-left | 50 | 1030 | Lower third left |
| Bottom-center | 960 | 1030 | Lower third center |

### Position Helper Function

```typescript
interface Position {
  x: number;
  y: number;
}

function getTextPosition(
  location: "top-left" | "top-center" | "top-right" | "center" | "bottom-left" | "bottom-center" | "bottom-right",
  videoWidth: number,
  videoHeight: number,
  padding: number = 50
): Position {
  const positions: Record<string, Position> = {
    "top-left": { x: padding, y: padding },
    "top-center": { x: videoWidth / 2, y: padding },
    "top-right": { x: videoWidth - padding, y: padding },
    "center": { x: videoWidth / 2, y: videoHeight / 2 },
    "bottom-left": { x: padding, y: videoHeight - padding },
    "bottom-center": { x: videoWidth / 2, y: videoHeight - padding },
    "bottom-right": { x: videoWidth - padding, y: videoHeight - padding },
  };

  return positions[location];
}
```

## Font Styling

### Available Font Properties

```typescript
const textStyle = {
  font_family: "Arial",
  font_size: 48,
  font_color: "#FFFFFF",
  font_weight: "bold",
  background_color: "rgba(0, 0, 0, 0.5)",
  text_align: "center",
};
```

### Common Font Families

| Font | Style | Use Case |
|------|-------|----------|
| Arial | Sans-serif | Clean, universal |
| Helvetica | Sans-serif | Modern, professional |
| Times New Roman | Serif | Traditional, formal |
| Georgia | Serif | Elegant, readable |
| Roboto | Sans-serif | Modern, digital |
| Open Sans | Sans-serif | Friendly, accessible |

## Common Text Overlay Patterns

### Title Card

```typescript
const titleOverlay = {
  text: "Product Demo",
  x: 960,
  y: 540,
  font_family: "Arial",
  font_size: 72,
  font_color: "#FFFFFF",
  text_align: "center",
  duration: {
    start: 0,
    end: 3,
  },
};
```

### Lower Third (Name/Title)

```typescript
const lowerThirdOverlay = {
  text: "John Smith\nCEO, Company Inc.",
  x: 100,
  y: 900,
  font_family: "Arial",
  font_size: 36,
  font_color: "#FFFFFF",
  background_color: "rgba(0, 102, 204, 0.9)",
  text_align: "left",
  duration: {
    start: 2,
    end: 8,
  },
};
```

### Call to Action

```typescript
const ctaOverlay = {
  text: "Visit example.com",
  x: 960,
  y: 1000,
  font_family: "Arial",
  font_size: 42,
  font_color: "#FFD700",
  text_align: "center",
  duration: {
    start: 25,
    end: 30,
  },
};
```

## Creating Text Overlay Templates

```typescript
interface TextOverlayTemplate {
  name: string;
  style: Partial<TextOverlay>;
}

const templates: TextOverlayTemplate[] = [
  {
    name: "title",
    style: {
      font_family: "Arial",
      font_size: 72,
      font_color: "#FFFFFF",
      text_align: "center",
    },
  },
  {
    name: "subtitle",
    style: {
      font_family: "Arial",
      font_size: 42,
      font_color: "#CCCCCC",
      text_align: "center",
    },
  },
  {
    name: "lower-third",
    style: {
      font_family: "Arial",
      font_size: 36,
      font_color: "#FFFFFF",
      background_color: "rgba(0, 0, 0, 0.7)",
      text_align: "left",
    },
  },
  {
    name: "caption",
    style: {
      font_family: "Arial",
      font_size: 32,
      font_color: "#FFFFFF",
      background_color: "rgba(0, 0, 0, 0.5)",
      text_align: "center",
    },
  },
];

function createTextOverlay(
  text: string,
  templateName: string,
  position: Position,
  duration?: { start: number; end: number }
): TextOverlay {
  const template = templates.find((t) => t.name === templateName);

  if (!template) {
    throw new Error(`Template "${templateName}" not found`);
  }

  return {
    text,
    x: position.x,
    y: position.y,
    ...template.style,
    duration,
  };
}
```

## Timing Text Overlays

Coordinate text appearance with your script:

```typescript
// Script with timing markers
const script = `
Hello and welcome. [0:00 - 0:03]
Let me show you our features. [0:03 - 0:08]
First, we have analytics. [0:08 - 0:15]
Get started today! [0:15 - 0:20]
`;

// Matching text overlays
const overlays = [
  {
    text: "Welcome",
    duration: { start: 0, end: 3 },
    ...titleStyle,
  },
  {
    text: "Feature Overview",
    duration: { start: 3, end: 8 },
    ...subtitleStyle,
  },
  {
    text: "Analytics Dashboard",
    duration: { start: 8, end: 15 },
    ...lowerThirdStyle,
  },
  {
    text: "www.example.com",
    duration: { start: 15, end: 20 },
    ...ctaStyle,
  },
];
```

## Best Practices

1. **Readability** - Use sufficient contrast between text and background
2. **Size** - Ensure text is large enough to read on mobile devices
3. **Duration** - Give viewers enough time to read (rule of thumb: 3 seconds minimum)
4. **Positioning** - Don't overlap with the avatar's face
5. **Consistency** - Use consistent fonts and styles throughout
6. **Accessibility** - Consider color-blind friendly palettes

## Limitations

- Text overlay support varies by subscription tier
- Some advanced styling options may not be available via API
- Complex animations may require post-production tools
- For auto-generated captions, see [captions.md](captions.md)
