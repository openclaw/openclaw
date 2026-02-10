# OpenClaw Codebase Patterns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Always reuse existing code - no redundancy!**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tech Stack（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Runtime**: Node 22+ (Bun also supported for dev/scripts)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Language**: TypeScript (ESM, strict mode)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Package Manager**: pnpm (keep `pnpm-lock.yaml` in sync)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Lint/Format**: Oxlint, Oxfmt (`pnpm check`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Tests**: Vitest with V8 coverage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **CLI Framework**: Commander + clack/prompts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Build**: tsdown (outputs to `dist/`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Anti-Redundancy Rules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Avoid files that just re-export from another file. Import directly from the original source.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If a function already exists, import it - do NOT create a duplicate in another file.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Before creating any formatter, utility, or helper, search for existing implementations first.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Source of Truth Locations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Formatting Utilities (`src/infra/`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Time formatting**: `src\infra\format-time`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**NEVER create local `formatAge`, `formatDuration`, `formatElapsedTime` functions - import from centralized modules.**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Terminal Output (`src/terminal/`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tables: `src/terminal/table.ts` (`renderTable`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Themes/colors: `src/terminal/theme.ts` (`theme.success`, `theme.muted`, etc.)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Progress: `src/cli/progress.ts` (spinners, progress bars)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### CLI Patterns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI option wiring: `src/cli/`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Commands: `src/commands/`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Dependency injection via `createDefaultDeps`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Import Conventions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `.js` extension for cross-package imports (ESM)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Direct imports only - no re-export wrapper files（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Types: `import type { X }` for type-only imports（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Code Quality（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TypeScript (ESM), strict typing, avoid `any`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep files under ~700 LOC - extract helpers when larger（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Colocated tests: `*.test.ts` next to source files（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Run `pnpm check` before commits (lint + format)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Run `pnpm tsgo` for type checking（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Stack & Commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Package manager**: pnpm (`pnpm install`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Dev**: `pnpm openclaw ...` or `pnpm dev`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Type-check**: `pnpm tsgo`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Lint/format**: `pnpm check`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Tests**: `pnpm test`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Build**: `pnpm build`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you are coding together with a human, do NOT use scripts/committer, but git directly and run the above commands manually to ensure quality.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
