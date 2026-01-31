---
name: ccg-generator
description: "AI Course Content Generator - Create course content, lessons, and curriculum. Generate slides, scripts, audio, and video materials."
metadata: {"moltbot":{"emoji":"📚","requires":{"bins":["npm","node"]},"os":["darwin","linux"],"paths":["~/Dev/02-ai-course/content-generator"]}}
---

# CCG Generator Skill

AI Course Content Generator for automated course creation with slides, scripts, audio, and video output.

## Quick Start

```bash
cd ~/Dev/02-ai-course/content-generator
npm run dev           # Web mode (Vite)
npm run electron:dev  # Electron desktop app
```

## Content Generation Pipeline

### Single Article Generation

```bash
cd ~/Dev/02-ai-course/content-generator
npm run single

# Follow prompts for topic, audience, style
```

### Batch Generation

```bash
npm run generate

# Generate multiple articles from config
```

## Output Formats

### Web Output
```bash
npm run dev
# Open http://localhost:5173
```

### Electron Desktop
```bash
npm run electron:dev
```

### iOS/Android (Capacitor)
```bash
npm run ios:build
npm run android:build
```

## Content Structure

Course content uses `[SLIDE-n]` tags for synchronization:

```markdown
# Course Title

[SLIDE-1]
Slide content here...

Narration for slide 1.

[SLIDE-2]
Next slide content...

Narration for slide 2.
```

## SaaS Platform Integration

```bash
cd ~/Dev/02-ai-course/saas-platform
npm run dev          # Next.js dev server
npm run db:studio    # Prisma Studio
```

## CLI Tools (via PPAL)

```bash
cd ~/Dev/03-products/PPAL/cli
npm run ccg "Generate course on Python basics"
```

## Environment Variables

```bash
# Required for Gemini API
GEMINI_API_KEY=xxx

# SaaS Platform
DATABASE_URL=xxx
STRIPE_SECRET_KEY=xxx
NEXTAUTH_SECRET=xxx
```

## Testing

```bash
cd ~/Dev/02-ai-course/content-generator
npm test               # Vitest unit tests
npm run test:e2e       # Playwright E2E
npm run test:coverage  # Coverage report
```

## Architecture

- **Frontend**: React + Vite
- **Desktop**: Electron wrapper
- **Mobile**: Capacitor (iOS/Android)
- **Backend**: SaaS Platform (Next.js + Prisma + Stripe)
- **AI**: Gemini API for content generation

## Key Features

- Automated slide generation
- Script writing with narration
- Audio synthesis (VOICEVOX integration)
- Video rendering (WebCodecks API)
- Multi-platform output

## Notes

- Content generation requires GEMINI_API_KEY
- Output uses `[SLIDE-n]` synchronization tags
- Supports batch generation for curriculum
- SaaS platform handles payment and delivery
