# Packages Guide

Complete guide to available packages and libraries in Remotion Studio Monorepo.

## Table of Contents

- [Official @remotion/\* Packages](#official-remotion-packages)
- [Internal Packages](#internal-packages)
- [Version Management](#version-management)
- [Installation Examples](#installation-examples)
- [Peer Dependencies](#peer-dependencies)

---

## Official @remotion/\* Packages

Keep all versions aligned with `remotion` and remove `^`. Use `npx remotion versions` to verify consistency.

### Core / Toolchain

Essential packages for development and rendering.

| Package                   | Purpose                                       |
| ------------------------- | --------------------------------------------- |
| `@remotion/cli`           | Command-line interface (studio, render, etc.) |
| `@remotion/studio`        | Timeline UI & API                             |
| `@remotion/player`        | Embed player in any React app                 |
| `@remotion/renderer`      | Node/Bun server-side rendering API            |
| `@remotion/bundler`       | SSR bundling utilities                        |
| `@remotion/eslint-plugin` | ESLint rules for Remotion                     |
| `@remotion/eslint-config` | Recommended ESLint configuration              |

### Cloud Rendering

| Package              | Purpose                                 |
| -------------------- | --------------------------------------- |
| `@remotion/lambda`   | AWS Lambda rendering (production-ready) |
| `@remotion/cloudrun` | GCP Cloud Run rendering (alpha)         |

### Video / Animation

Extend Remotion with additional animation and graphics capabilities.

| Package                     | Purpose                               |
| --------------------------- | ------------------------------------- |
| `@remotion/three`           | Three.js integration                  |
| `@remotion/skia`            | React Native Skia integration         |
| `@remotion/lottie`          | Lottie animation support              |
| `@remotion/gif`             | GIF rendering support                 |
| `@remotion/rive`            | Rive animation support                |
| `@remotion/shapes`          | Geometric shapes library              |
| `@remotion/paths`           | SVG path utilities                    |
| `@remotion/motion-blur`     | Motion blur effects                   |
| `@remotion/transitions`     | Transition effects (fade, wipe, etc.) |
| `@remotion/animation-utils` | Animation helper utilities            |
| `@remotion/animated-emoji`  | Animated emoji support                |
| `@remotion/layout-utils`    | Layout calculation utilities          |
| `@remotion/noise`           | Perlin noise generators               |

### Media I/O / Visualization

| Package                  | Purpose                                           |
| ------------------------ | ------------------------------------------------- |
| `@remotion/media`        | Media handling utilities                          |
| `@remotion/media-utils`  | Media metadata extraction                         |
| `@remotion/media-parser` | Media file parsing                                |
| `@remotion/webcodecs`    | WebCodecs API (deprecated → moving to Mediabunny) |
| `@remotion/captions`     | Subtitle/caption support (SRT, VTT, etc.)         |
| `@remotion/fonts`        | Font utilities                                    |
| `@remotion/google-fonts` | Google Fonts integration                          |
| `@remotion/preload`      | Asset preloading (images, videos, audio, fonts)   |

### Speech Recognition (Whisper)

| Package                         | Purpose                             |
| ------------------------------- | ----------------------------------- |
| `@remotion/install-whisper-cpp` | Local Whisper.cpp setup             |
| `@remotion/whisper-web`         | Browser WASM Whisper (experimental) |
| `@remotion/openai-whisper`      | OpenAI Whisper API integration      |

### Styling

| Package                 | Purpose                 |
| ----------------------- | ----------------------- |
| `@remotion/tailwind`    | Tailwind CSS v3 support |
| `@remotion/tailwind-v4` | Tailwind CSS v4 support |
| `@remotion/enable-scss` | SCSS/SASS support       |

### Types / Licensing

| Package               | Purpose                              |
| --------------------- | ------------------------------------ |
| `@remotion/zod-types` | Zod schema integration for UI        |
| `@remotion/licensing` | Enterprise license usage measurement |

---

## Internal Packages

Optional internal packages (not included by default in templates).

### Foundation

| Package              | Purpose                                              |
| -------------------- | ---------------------------------------------------- |
| `@studio/timing`     | Timeline utilities (progress, frame conversion)      |
| `@studio/core-hooks` | Shared hooks (`useAnimationFrame`, `useMediaTiming`) |
| `@studio/core-types` | Shared TypeScript types                              |

### Animation

| Package                | Purpose                                       | Peer Dependencies |
| ---------------------- | --------------------------------------------- | ----------------- |
| `@studio/anime-bridge` | Anime.js bridge + `useAnime` hook             | `animejs`         |
| `@studio/transitions`  | Transition components (FadeIn, FadeOut, etc.) | -                 |
| `@studio/easings`      | Easing functions + Anime.js conversions       | -                 |

### Visual

| Package                   | Purpose                                   | Peer Dependencies             |
| ------------------------- | ----------------------------------------- | ----------------------------- |
| `@studio/visual-canvas2d` | Pixi.js / Konva integration               | `pixi.js`, `konva`            |
| `@studio/visual-three`    | R3F wrappers, camera/light presets        | `three`, `@react-three/fiber` |
| `@studio/visual-shaders`  | WebGL shader canvas                       | -                             |
| `@studio/visual-effects`  | Shader-based effects (glitch, blur, glow) | -                             |

### Design

| Package          | Purpose                                     |
| ---------------- | ------------------------------------------- |
| `@design/assets` | Shared assets (sync via `pnpm sync:assets`) |

---

## Version Management

### Automatic Remotion Upgrades

Upgrade `remotion` and all `@remotion/*` packages across the entire monorepo:

```bash
# Upgrade to latest stable
pnpm upgrade:remotion

# Dry run (preview changes)
pnpm upgrade:remotion --dry-run

# Upgrade to specific version
pnpm upgrade:remotion 4.0.406

# Upgrade without running install
pnpm upgrade:remotion --skip-install
```

**What it does:**

- Updates `pnpm-workspace.yaml` `catalog` entries for `remotion` and `@remotion/*`
- Ensures workspace `package.json` files reference those dependencies via `catalog:` (when applicable)
- Runs `pnpm install` to sync `pnpm-lock.yaml`

**Note:** `pnpm create:project` automatically reads the repo's pinned Remotion version, so every newly scaffolded app matches the current version.

### Verify Version Consistency

```bash
# Check all @remotion/* packages are aligned
pnpm remotion versions
```

---

## Installation Examples

### Per-App Installation

Install packages for a specific app:

```bash
# Animation packages
pnpm -C apps/<name> add @remotion/transitions @remotion/shapes @remotion/paths

# Three.js support
pnpm -C apps/<name> add @remotion/three three @react-three/fiber @react-three/drei

# Media utilities
pnpm -C apps/<name> add @remotion/media-utils @remotion/captions

# Styling
pnpm -C apps/<name> add @remotion/tailwind
```

### Workspace Filter Syntax

Alternative syntax using workspace filters:

```bash
pnpm add @remotion/transitions --filter @studio/<app>
pnpm add three @react-three/fiber --filter @studio/<app>
```

### Dev Dependencies

Install as dev dependencies:

```bash
pnpm -C apps/<name> add -D @remotion/eslint-plugin @remotion/eslint-config
```

---

## Peer Dependencies

Some packages require peer dependencies to be installed separately.

### Animation

| Package                | Required Peers |
| ---------------------- | -------------- |
| `@studio/anime-bridge` | `animejs`      |

**Install:**

```bash
pnpm -C apps/<name> add animejs
```

### Visual (2D)

| Package                   | Required Peers     |
| ------------------------- | ------------------ |
| `@studio/visual-canvas2d` | `pixi.js`, `konva` |

**Install:**

```bash
pnpm -C apps/<name> add pixi.js konva
```

### Visual (3D)

| Package                | Required Peers                |
| ---------------------- | ----------------------------- |
| `@studio/visual-three` | `three`, `@react-three/fiber` |
| `@remotion/three`      | `three`, `@react-three/fiber` |

**Install:**

```bash
pnpm -C apps/<name> add three @react-three/fiber @react-three/drei
```

### Type Definitions

Don't forget TypeScript type definitions for libraries:

```bash
# Example: Anime.js types
pnpm -C apps/<name> add -D @types/animejs

# Three.js includes types by default (no @types needed)
```

---

## Use Cases & Recommendations

Choose packages based on your project needs.

### Simple Video Production

**Packages:** Just the core (already in template)

- `remotion`
- `@remotion/cli`

### With Transitions & Animations

**Packages:**

```bash
pnpm -C apps/<name> add @remotion/transitions @remotion/animation-utils
```

### Advanced Tweening (Anime.js)

**Packages:**

```bash
pnpm -C apps/<name> add animejs
# Optional: add @studio/anime-bridge if available
```

### 2D Graphics (Canvas)

**Packages:**

```bash
pnpm -C apps/<name> add pixi.js konva
# Optional: add @studio/visual-canvas2d if available
```

### 3D Graphics (Three.js)

**Packages:**

```bash
pnpm -C apps/<name> add three @react-three/fiber @react-three/drei @remotion/three
```

### Audio & Lyrics Sync (LRC)

**No additional packages needed!**

- Place `.lrc` files in `public/assets/audio/`
- Fetch and parse with built-in `fetch` API
- Optional: `@remotion/captions` for SRT/VTT support

---

## Important Notes

### Browser Execution Context

**Warning:** Composition code runs in the browser, not Node.js.

- ❌ **Cannot use:** `fs`, `path`, `net`, `process`, etc.
- ✅ **Can use:** Browser APIs, React, external libraries

**Solution:** Move Node.js code to:

- `scripts/` directory
- `remotion.config.ts` (runs in Node)
- Build-time preprocessing

### CSS Imports

Some libraries require explicit CSS imports:

```ts
// src/index.ts
import "your-library/dist/styles.css";
```

### Bundle Size Considerations

Large dependencies impact render times. Consider:

- Tree-shaking (import only what you need)
- Code splitting for large apps
- Using lighter alternatives when possible

---

## Further Reading

- [Adding Dependencies Guide](./adding-deps.md)
- [3D / R3F Notes](./3d-notes.md)
- [Official Remotion Packages](https://www.remotion.dev/docs/packages)
- [Upgrading Remotion](./upgrading-remotion.md)
