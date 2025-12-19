---
summary: "Bundled bun gateway: packaging, launchd, signing, and bytecode"
read_when:
  - Packaging Clawdis.app
  - Debugging the bundled gateway binary
  - Changing bun build flags or codesigning
---

# Bundled bun Gateway (macOS)

Goal: ship **Clawdis.app** with a self-contained Gateway binary. No global `npm install -g clawdis`, no system Node requirement.

## What gets bundled

App bundle layout:

- `Clawdis.app/Contents/Resources/Relay/clawdis-gateway`
  - bun `--compile` executable built from `dist/macos/gateway-daemon.js`
- `Clawdis.app/Contents/Resources/Relay/package.json`
  - tiny “Pi compatibility” file (see below)
- `Clawdis.app/Contents/Resources/Relay/theme/`
  - Pi TUI theme payload (optional, but strongly recommended)

Why the sidecar files matter:
- `@mariozechner/pi-coding-agent` detects “bun binary mode” and then looks for `package.json` + `theme/` **next to `process.execPath`** (i.e. next to `clawdis-gateway`).
- So even if bun can embed assets, Pi currently expects filesystem paths. Keep the sidecar files.

## Build pipeline

Packaging script:
- `scripts/package-mac-app.sh`

It builds:
- TS: `pnpm exec tsc`
- Swift app + helper: `swift build …`
- bun gateway: `bun build dist/macos/gateway-daemon.js --compile --bytecode …`

Important bundler flags:
- `--compile`: produces a standalone executable
- `--bytecode`: reduces startup time / parsing overhead (works here)
- externals:
  - `-e playwright-core -e electron -e "chromium-bidi*"`
  - Reason: keep heavy/optional browser-control deps out of the embedded daemon path

Version injection:
- `--define "__CLAWDIS_VERSION__=\"<pkg version>\""`
- `src/version.ts` also supports `__CLAWDIS_VERSION__` (and `CLAWDIS_BUNDLED_VERSION`) so `--version` doesn’t depend on reading `package.json` at runtime.

## Launchd (Gateway as LaunchAgent)

Label:
- `com.steipete.clawdis.gateway`

Plist location (per-user):
- `~/Library/LaunchAgents/com.steipete.clawdis.gateway.plist`

Manager:
- `apps/macos/Sources/Clawdis/GatewayLaunchAgentManager.swift`

Behavior:
- “Clawdis Active” enables/disables the LaunchAgent.
- App quit does **not** stop the gateway (launchd keeps it alive).

Logging:
- launchd stdout/err: `/tmp/clawdis/clawdis-gateway.log`

Default LaunchAgent env:
- `CLAWDIS_SKIP_BROWSER_CONTROL_SERVER=1`
- `CLAWDIS_IMAGE_BACKEND=sips` (avoid sharp native addon under bun)

## Codesigning (hardened runtime + bun)

Symptom (when mis-signed):
- `Ran out of executable memory …` on launch

Fix:
- The bun executable needs JIT-ish permissions under hardened runtime.
- `scripts/codesign-mac-app.sh` signs `Relay/clawdis-gateway` with:
  - `com.apple.security.cs.allow-jit`
  - `com.apple.security.cs.allow-unsigned-executable-memory`

## Image processing under bun

Problem:
- bun can’t load some native Node addons like `sharp` (and we don’t want to ship native addon trees for the gateway).

Solution:
- Central helper `src/media/image-ops.ts`
  - Prefers `/usr/bin/sips` on macOS (esp. when running under bun)
  - Falls back to `sharp` when available (Node/dev)
- Used by:
  - `src/web/media.ts` (optimize inbound/outbound images)
  - `src/browser/screenshot.ts`
  - `src/agents/pi-tools.ts` (image sanitization)

## Browser control server (optional)

Browser control pulls in Playwright/Electron baggage. For the embedded gateway:
- `src/gateway/server.ts` starts browser control via lazy dynamic import.
- Embedded mode sets `CLAWDIS_SKIP_BROWSER_CONTROL_SERVER=1` so it never imports that module.

Override (dev only):
- set `CLAWDIS_BROWSER_CONTROL_MODULE` to force-load the module path.

## Tests / smoke checks

From a packaged app (local build):

```bash
dist/Clawdis.app/Contents/Resources/Relay/clawdis-gateway --version

CLAWDIS_SKIP_PROVIDERS=1 \
CLAWDIS_SKIP_BROWSER_CONTROL_SERVER=1 \
CLAWDIS_SKIP_CANVAS_HOST=1 \
dist/Clawdis.app/Contents/Resources/Relay/clawdis-gateway --port 18999 --bind loopback
```

Then, in another shell:

```bash
pnpm -s clawdis gateway call health --url ws://127.0.0.1:18999 --timeout 3000
```

## Repo hygiene

Bun may leave dotfiles like `*.bun-build` in the repo root or subfolders.
- These are ignored via `.gitignore` (`*.bun-build`).

## DMG styling (human installer)

`scripts/create-dmg.sh` styles the DMG via Finder AppleScript.

Rules of thumb:
- Use a **72dpi** background image that matches the Finder window size in points.
- Preferred asset: `assets/dmg-background-small.png` (**500×320**).
- Default icon positions: app `{125,160}`, Applications `{375,160}`.
