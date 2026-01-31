---
name: gen-studio
description: "Gen Studio (MUSE) - Desktop AI content creation app with dual-pane interface for chat and artifact editing. Image generation and media management."
metadata: {"moltbot":{"emoji":"🎨","requires":{"bins":["npm","node"]},"os":["darwin","linux"],"paths":["~/Dev/03-products/Gen-Studio"]}}
---

# Gen Studio Skill (MUSE)

Desktop AI content creation application powered by Tauri and Gemini API. Dual-pane interface with conversational AI chat and artifact editing.

## Quick Start

```bash
cd ~/Dev/03-products/Gen-Studio
npm run tauri:dev    # Full desktop app with hot reload
npm run dev          # Web only (port 5173)
```

## Application Structure

### Dual-Pane Interface
- **Left Pane (Agent)**: Conversational AI chat for research and ideation
- **Right Pane (Studio)**: Artifact editing and content preview

### Tauri Backend
- WebSocket server (port 9527) for Chrome extension
- File system access for media management
- Native OS integration

## Development Commands

```bash
cd ~/Dev/03-products/Gen-Studio

npm run dev              # Vite dev server (5173)
npm run tauri:dev        # Full Tauri desktop app
npm run tauri:build      # Production build
npm run lint             # ESLint
```

## Environment Variables

```bash
# .env.local
VITE_GEMINI_API_KEY=xxx  # Required for Gemini API
```

## Prompt System

Prompts are defined as YAML in `prompts/prompts.ts`:

```typescript
// Example prompt structure
const prompts = {
  generateImage: `
    Generate an image based on: {prompt}
    Style: {style}
    Aspect ratio: {ratio}
  `
};
```

## Gemini API Integration

### Retry Logic
```typescript
// Auto-retry with exponential backoff
const result = await retryWithBackoff(
  () => generateContent(prompt),
  { maxRetries: 3, baseDelay: 1000 }
);
```

### Image Generation
```bash
# Via CLI
cd ~/Dev/03-products/PPAL/cli
npm run gen "Generate image of a futuristic city"

# Via Gen-Studio app
# Open app → Agent pane → Enter prompt
```

## Chrome Extension Integration

```bash
# WebSocket server runs on port 9527
# Extension connects for browser automation

# Check server status
lsof -i :9527
```

## CLI Tool (via PPAL)

```bash
cd ~/Dev/03-products/PPAL/cli
npm run gen "Create content for..."

# Available commands
npm run gen -- --help
```

## Media Management

Generated content is stored in:
- `~/Dev/03-products/Gen-Studio/src-tauri/tauri.conf.json` - App config
- `~/Dev/03-products/Gen-Studio/src/assets/` - Static assets
- User data directory (OS-specific)

## Architecture

```
┌─────────────────────────────────────┐
│          Gen Studio (Tauri)         │
├──────────────┬──────────────────────┤
│ Agent (Chat) │ Studio (Artifact)    │
│              │                      │
│ Gemini API   │ Content Editing      │
└──────────────┴──────────────────────┘
         │
    WebSocket (9527)
         │
┌────────▼────────┐
│ Chrome Extension │
└─────────────────┘
```

## Testing

```bash
cd ~/Dev/03-products/Gen-Studio
npm run lint    # ESLint (if configured)
```

## Common Workflows

### Generate Image
```
1. Open Gen Studio app
2. In Agent pane: "Generate an image of a sunset over mountains"
3. View result in Studio pane
4. Edit/export as needed
```

### Content Creation
```
1. Use Agent for research and ideation
2. Edit content in Studio pane
3. Save/export artifact
```

## Notes

- Requires VITE_GEMINI_API_KEY to be set
- Tauri handles native OS integration
- WebSocket server enables browser extension
- Dual-pane design separates conversation from content
- Auto-retry logic handles API failures
