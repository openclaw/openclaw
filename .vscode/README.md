# OpenClaw Debug Environment Setup

This document describes how to set up debugging for the OpenClaw project in Visual Studio Code.

## Prerequisites

1. **Node.js 22+** - Required runtime
2. **pnpm** - Package manager (version 10.23.0 as specified in package.json)
3. **VS Code** - With extensions:
   - `oxc.oxc-vscode` (recommended in extensions.json)

## Quick Start

### 1. Install Dependencies

```bash
# Install pnpm if not already installed
npm install -g pnpm

# Install project dependencies
cd d:\code\openclaw\openclaw
pnpm install
```

### 2. Build the Project

```bash
# Build TypeScript (required before debugging)
pnpm build
```

Or use the VS Code task: `Terminal > Run Task > Build TypeScript (tsdown)`

### 3. Debug Configurations

The `.vscode/launch.json` includes the following debug configurations:

| Configuration | Description |
|--------------|-------------|
| `Debug: Gateway (openclaw.mjs gateway)` | **Recommended** - Debug gateway via openclaw.mjs |
| `Debug: Gateway (pnpm gateway:dev)` | Debug gateway via pnpm gateway:dev |
| `Debug: Gateway (scripts/run-node.mjs --dev gateway)` | Debug gateway via run-node.mjs |
| `Debug: Gateway (built dist/entry.js)` | Debug gateway using dist/entry.js |
| `Debug: CLI Entry (openclaw.mjs)` | Debug CLI with openclaw.mjs |
| `Debug: CLI Entry (src/index.ts)` | Debug src/index.ts directly |
| `Debug: Run Node Script` | Debug scripts/run-node.mjs |
| `Debug: TUI` | Debug the TUI interface |
| `Debug: Vitest Unit Tests` | Run unit tests in debug mode |
| `Debug: Vitest Watch Mode` | Run tests in watch mode |
| `Debug: Current Test File` | Debug the currently open test file |
| `Debug: Attach to Gateway` | Attach to a running gateway on port 18789 |

## Recommended Debug Workflow

1. **Build first** (if not built):
   ```bash
   pnpm build
   ```

2. **Start debugging**:
   - Press `F5` in VS Code
   - Select "Debug: Gateway (openclaw.mjs gateway)"
   - Set breakpoints in source files

## Common Issues

### Breakpoints are Gray (Unverified)

If breakpoints appear gray in VS Code:

1. **Source maps are enabled** - The tsconfig.json has `sourceMap: true` and `inlineSources: true`

2. **Build the project first** - Run `pnpm build` before debugging:
   ```bash
   pnpm build
   ```

3. **Verify the correct TypeScript version is selected**:
   - Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac)
   - Type "TypeScript: Select TypeScript Version"
   - Make sure "Use Workspace Version" is selected

4. **Check the debug configuration**:
   - Ensure `runtimeArgs` includes `--import tsx`
   - The skipFiles should include `node_modules/**`

5. **For Vitest tests**:
   - Use the provided "Debug: Current Test File" configuration
   - Make sure you're debugging the test file, not the source file

### Usage: openclaw [options] [command]

If you see this message, it means:
1. The gateway argument is missing from the debug configuration
2. The project is not built (dist files are missing)

Make sure to:
1. Use a configuration with `gateway` argument (e.g., "Debug: Gateway (openclaw.mjs gateway)")
2. Run `pnpm build` before debugging

## VS Code Tasks

The `.vscode/tasks.json` includes:

| Task | Description |
|------|-------------|
| Build TypeScript (tsdown) | Build with tsdown only |
| Build TypeScript (full) | Full build with all steps |
| Install Dependencies | Run pnpm install |

## Testing

Run tests with debugging:

```bash
# Run unit tests
pnpm test:fast

# Or debug specific test file
# Open the test file in VS Code and use "Debug: Current Test File"
```
