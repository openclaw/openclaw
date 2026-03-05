# Getting Started

This guide helps you set up the Remotion Studio monorepo, create your first project, and use the shared packages.

## Prerequisites

- Node.js 20+ (recommended 22)
- pnpm 10+

## Install

Install dependencies at the repository root:

```bash
pnpm install
```

## Create your first app

You can start from the demo or generate a fresh project from the template.

### Option A: Run an example app

Start Remotion Studio:

```bash
cd apps/examples/animations-showcase
pnpm dev
```

### Option B: Create a new app

1. Generate from the template via CLI:
   - `pnpm create:project`

2. Follow prompts (name, width, height, FPS, duration).

3. Start developing:
   - `cd apps/<your-app> && pnpm dev`

## Using packages

All shared packages are available under the `@studio/*` alias (see `packages/@studio/*`).

- Timing utilities:

  ```ts
  import { frameToMs, secondsToFrames } from "@studio/timing";
  ```

- Hooks:

  ```ts
  import { useFrameProgress } from "@studio/hooks";
  ```

- Transitions:

  ```tsx
  import { FadeIn } from "@studio/transitions";
  ```
