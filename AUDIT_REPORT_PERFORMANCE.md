# Performance Audit Report -- Phase 1C

**Project:** OpenClaw / Activi
**Date:** 2026-02-23
**Auditor:** Code Analyzer Agent (Claude Opus 4.6)
**Scope:** Frontend bundle, build pipeline, render performance, lazy loading, asset optimization, API efficiency, backend bottlenecks

---

## 0. Prerequisites -- Build Baselines (Manual Verification Required)

The following commands must be run manually to capture baseline metrics. Bash execution was unavailable during this audit.

```bash
cd /Users/dsselmanovic/openclaw

# Bundle size baseline
pnpm ui:build 2>&1
du -sh dist/control-ui/
ls -la dist/control-ui/assets/ 2>/dev/null

# Full build baseline
time pnpm build 2>&1
du -sh dist/
```

Record the results here once available:

| Metric | Value |
|---|---|
| `dist/control-ui/` total size | _pending_ |
| Largest JS chunk | _pending_ |
| CSS bundle size | _pending_ |
| `dist/` total size | _pending_ |
| `pnpm build` wall time | _pending_ |

---

## 1. Vite Configuration Analysis

**File:** `/Users/dsselmanovic/openclaw/ui/vite.config.ts`

### Findings

| Setting | Current Value | Impact | Severity |
|---|---|---|---|
| `build.sourcemap` | `true` | Source maps shipped to production; roughly doubles JS output size | **High** |
| Code splitting | **Not configured** | No `rollupOptions.output.manualChunks` defined; Vite's default vendor splitting is active but not tuned | **High** |
| Chunk size warnings | **Not configured** | No `build.chunkSizeWarningLimit`; large chunks go undetected in CI | Medium |
| `optimizeDeps.include` | `["lit/directives/repeat.js"]` | Good -- pre-bundles a known CJS dep for dev | OK |
| CSS minification | Default (esbuild) | Acceptable | OK |
| `build.target` | Default (`modules`) | OK for modern browsers | OK |
| Tree-shaking | Default (Rollup) | OK | OK |

### Recommendations

1. **[Critical] Disable production source maps** or switch to `"hidden"` so they are not served to users:
   ```ts
   sourcemap: process.env.NODE_ENV === "production" ? "hidden" : true,
   ```
   **Estimated impact:** 40-60% reduction in shipped asset size.

2. **[High] Add manual chunk splitting** to separate vendor code from application code:
   ```ts
   build: {
     rollupOptions: {
       output: {
         manualChunks: {
           lit: ["lit", "lit/decorators.js", "lit/directives/repeat.js"],
           vendor: ["markdown-it"], // if used in UI
         },
       },
     },
   },
   ```
   **Estimated impact:** Better caching; vendor chunks change less often.

3. **[Medium] Set chunk size warning limit** for CI visibility:
   ```ts
   build: { chunkSizeWarningLimit: 250 },
   ```

---

## 2. Render Performance Analysis (Lit.js)

**File:** `/Users/dsselmanovic/openclaw/ui/src/ui/app.ts`

### State Property Count

| Decorator | Count | Notes |
|---|---|---|
| `@state()` | **~155** | Every `@state()` assignment triggers a re-render cycle |
| `@property()` | **0** | No external attributes exposed (expected for root app element) |
| Non-reactive fields | ~15 | `private` fields like `chatScrollFrame`, `toolStreamById`, etc. |

**This is an exceptionally high number of reactive state properties for a single component.** Each mutation to any of these 155+ properties triggers `requestUpdate()` which schedules a full `render()` call on the root `<activi-app>` element.

### Shadow DOM Status

```ts
createRenderRoot() {
  return this;  // Line 392-394
}
```

**Shadow DOM is bypassed.** The component renders directly into the Light DOM. This means:
- Global CSS applies (no style encapsulation) -- intentional for the theme system.
- No Shadow DOM overhead -- slightly faster initial render.
- All DOM mutations affect the global tree directly.

### Update Guards

| Guard | Present? | Impact |
|---|---|---|
| `shouldUpdate()` | **No** | Every state change triggers render unconditionally |
| `willUpdate()` | **No** | No pre-render computation optimization |
| `guard()` directive | **No** | No memoization in template expressions |
| `until()` directive | **No** | No async render boundaries |

### Render Propagation Analysis

**Critical finding:** A single chat message arriving via WebSocket causes the following cascade:

1. `handleGatewayEvent()` in `app-gateway.ts` fires
2. `handleChatEvent()` mutates `chatMessages`, `chatStream`, `chatRunId`, etc.
3. Each `@state()` mutation schedules `requestUpdate()`
4. Lit batches these into a single microtask render
5. `render()` calls `renderApp()` which evaluates **all 16 tab conditionals** even though only the active tab renders content
6. The entire 1380-line `renderApp()` template is re-evaluated
7. `handleUpdated()` in `app-lifecycle.ts` runs scroll logic on every update

**Mitigating factor:** Lit uses a diffing algorithm, so only changed DOM is actually updated. The tab conditionals use `state.tab === "xxx" ? renderXxx(...) : nothing` which avoids rendering inactive tabs. However, all the **prop objects** for each view are still reconstructed on every render.

### Severity: CRITICAL

The "God Component" pattern with 155+ reactive state properties is the single largest performance risk in the UI.

### Recommendations

1. **[Critical] Decompose the monolithic state** into domain-specific controllers or context providers:
   - `ChatController` (20+ chat-related state props)
   - `ConfigController` (15+ config-related state props)
   - `UsageController` (25+ usage-related state props)
   - `AgentsController` (20+ agent-related state props)
   - `SessionsController` (12+ session-related state props)

   **Estimated impact:** 60-80% reduction in unnecessary render evaluations. A chat message would only re-render the chat subtree, not the config/usage/agents/sessions state.

2. **[High] Add `shouldUpdate()` guard** to skip renders when only non-visual state changes:
   ```ts
   shouldUpdate(changed: Map<PropertyKey, unknown>) {
     // Skip render for timer/bookkeeping-only changes
     if (changed.size === 1 && changed.has("overviewLogCursor")) return false;
     return true;
   }
   ```

3. **[High] Memoize view prop objects** to avoid reconstructing large objects on every render. Currently, every render of `renderApp()` creates new anonymous objects for `renderOverview({...})`, `renderChat({...})`, etc., even when none of their inputs changed.

4. **[Medium] Use `@lit-labs/signals`** (already in devDependencies) for fine-grained reactivity instead of `@state()` for high-frequency updates like `chatStream` and `chatStreamStartedAt`.

---

## 3. Lazy Loading and Code Splitting

**File:** `/Users/dsselmanovic/openclaw/ui/src/ui/app-render.ts`

### View Import Analysis

All 16+ view modules are imported via **static imports** at the top of `app-render.ts`:

```ts
import { renderAgents } from "./views/agents.ts";          // static
import { renderChannels } from "./views/channels.ts";      // static
import { renderChat } from "./views/chat.ts";              // static
import { renderConfig } from "./views/config.ts";          // static
import { renderCron } from "./views/cron.ts";              // static
import { renderDebug } from "./views/debug.ts";            // static
import { renderInstances } from "./views/instances.ts";    // static
import { renderLogs } from "./views/logs.ts";              // static
import { renderNodes } from "./views/nodes.ts";            // static
import { renderOverview } from "./views/overview.ts";      // static
import { renderSessions } from "./views/sessions.ts";      // static
import { renderSkills } from "./views/skills.ts";          // static
import { renderBroadcast } from "./views/broadcast.ts";    // static
// + usage tab, command palette, exec approval, etc.
```

**Result:** All 60+ view files in `ui/src/ui/views/` are bundled into a single chunk. There is **zero route-based code splitting**.

The only dynamic import found is for the onboarding wizard controller:
```ts
// app-gateway.ts line 37
const { OnboardingWizardController } = await import("./controllers/onboarding-wizard.ts");
```

### View File Count

**60 files** in `ui/src/ui/views/` (including tests). At least 50 are production view modules.

### Severity: HIGH

### Recommendations

1. **[High] Implement dynamic imports for non-default tabs.** The user lands on "chat" or "overview"; all other tabs should be lazy-loaded:
   ```ts
   // Instead of static import at top:
   // import { renderConfig } from "./views/config.ts";

   // Use dynamic import in the tab conditional:
   ${state.tab === "config"
     ? html`${until(
         import("./views/config.ts").then(m => m.renderConfig({...})),
         html`<div class="loading">...</div>`
       )}`
     : nothing
   }
   ```
   **Estimated impact:** 30-50% reduction in initial bundle size. Users who never visit "debug", "config", "usage", "cron" tabs never download that code.

2. **[Medium] Split heavy sub-views** like `usage-render-details.ts`, `config-form.render.ts` which are likely large.

---

## 4. Asset Optimization

### 4.1 Font Loading

**File:** `/Users/dsselmanovic/openclaw/ui/src/styles/base.css` (Line 1)

```css
@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Playfair+Display:wght@400;700&family=JetBrains+Mono:wght@400;500;700&display=swap");
```

**Issues:**

| Issue | Severity | Detail |
|---|---|---|
| Render-blocking CSS import | **High** | `@import url()` in CSS is render-blocking; browser must fetch Google Fonts CSS before rendering any content |
| Three font families loaded | **Medium** | Inter (4 weights), Playfair Display (2 weights), JetBrains Mono (3 weights) = 9 font files |
| External CDN dependency | **Medium** | Offline/air-gapped installations will fail to load fonts |
| No `font-display: swap` in CSS | Low | The Google Fonts URL includes `&display=swap` which is good |
| Playfair Display usage | Low | Only used in the `fieldmanual` theme for title overrides; most users never see it |

**Recommendations:**

1. **[High] Self-host fonts** and use `<link rel="preload">` in the HTML:
   ```html
   <link rel="preload" href="/fonts/inter-var.woff2" as="font" type="font/woff2" crossorigin>
   ```
   **Estimated impact:** Eliminates 1-2 round trips to Google CDN; enables offline support.

2. **[Medium] Lazy-load Playfair Display and JetBrains Mono.** Only Inter is needed for initial render; the other two are theme-specific:
   ```css
   /* Load only Inter initially */
   @font-face { font-family: 'Inter'; src: url('/fonts/inter.woff2'); font-display: swap; }
   /* Load others via JS when theme requires them */
   ```
   **Estimated impact:** ~200-400KB fewer bytes on initial load.

3. **[Low] Use variable fonts** (Inter supports this) to reduce total font file count from 9 to 2-3.

### 4.2 Icons

**File:** `/Users/dsselmanovic/openclaw/ui/src/ui/icons.ts`

Icons are **inline SVG via Lit `html` tagged templates** (40+ icons). This is a reasonable approach:
- No additional HTTP requests (no sprite sheet, no icon font)
- Tree-shakeable (unused icons can be eliminated)
- Small per-icon overhead (~200-500 bytes each)
- Total estimate: ~15-20KB uncompressed for all icons

**Status: OK** -- No changes needed. Inline SVG is the recommended approach for Lit.js apps.

### 4.3 Public Assets

**Directory:** `/Users/dsselmanovic/openclaw/ui/public/`

| File | Format | Notes |
|---|---|---|
| `apple-touch-icon.png` | PNG | Standard iOS icon |
| `favicon-32.png` | PNG | Standard favicon |
| `favicon.ico` | ICO | Standard favicon |
| `logo-activi.png` | PNG | Should verify if optimized |
| `favicon-activi.png` | PNG | Should verify if optimized |
| `favicon.svg` | SVG | Good -- vector favicon |
| `logo-activi.svg` | SVG | Good -- vector logo |
| `logo-activi-animated.mp4` | MP4 | **Concern**: Video in public assets; verify size |

**Recommendations:**

1. **[Low] Verify `logo-activi-animated.mp4` file size.** Video files can be large and are copied to the build output. If > 1MB, consider hosting externally or converting to a lighter animation format (Lottie, CSS animation, WebP animation).

2. **[Low] Ensure PNG assets are optimized** with tools like `pngquant` or `squoosh`. Run: `du -sh ui/public/*.png`

### 4.4 No WebP/AVIF Usage

No modern image formats detected. The app is primarily SVG-based (good), but any raster assets should use WebP.

---

## 5. API Call Efficiency

### 5.1 WebSocket Client

**File:** `/Users/dsselmanovic/openclaw/ui/src/ui/gateway.ts`

| Aspect | Implementation | Assessment |
|---|---|---|
| Protocol | WebSocket with JSON-RPC style request/response | Good |
| Reconnection | Exponential backoff: 800ms * 1.7, max 15s | Good |
| Backoff reset | On successful hello | Good |
| Pending request cleanup | Flushed on disconnect | Good |
| Sequence gap detection | Detects and reports gaps | Good |
| Challenge-response auth | 2s timeout for connect challenge | Good |
| Device token caching | Stored in localStorage, cleared on auth failure | Good |

**No major issues with the WebSocket client itself.**

### 5.2 Polling

**File:** `/Users/dsselmanovic/openclaw/ui/src/ui/app-polling.ts`

| Poll | Interval | Tab-gated? | Assessment |
|---|---|---|---|
| Nodes | 5000ms | **No** -- always running | **High concern** |
| Logs | 2000ms | Yes -- only on "logs" tab | OK |
| Debug | 3000ms | Yes -- only on "debug" tab | OK |

**Critical finding:** `startNodesPolling()` runs unconditionally after connect with a 5-second interval, making HTTP requests to the gateway even when the user is on the "chat" tab and does not need node status.

### 5.3 Connect-time Data Loading

When a WebSocket connection succeeds (`onHello`), the app fires **6 concurrent async requests** (from `app-gateway.ts` lines 176-181):

```ts
void loadAssistantIdentity(host);
void loadAgents(host);
void loadHealthState(host);
void loadNodes(host, { quiet: true });
void loadDevices(host, { quiet: true });
void refreshActiveTab(host);
```

Plus the nodes polling starts immediately. This is a burst of 6-7 requests on connect.

### 5.4 Event-driven Updates vs. Polling

The gateway uses a push model for many events (`agent`, `chat`, `presence`, `cron`, `exec.approval.*`, `device.pair.*`, `update.available`). This is excellent. However:
- Health state is not pushed (requires polling or request)
- Node status is polled instead of pushed

### Severity: MEDIUM

### Recommendations

1. **[High] Gate nodes polling to the "nodes" tab only**, matching the pattern used for logs and debug:
   ```ts
   export function startNodesPolling(host: PollingHost) {
     if (host.nodesPollInterval != null) return;
     host.nodesPollInterval = window.setInterval(() => {
       if (host.tab !== "nodes") return;  // Add tab guard
       void loadNodes(host, { quiet: true });
     }, 5000);
   }
   ```
   **Estimated impact:** Eliminates background HTTP requests on every tab except "nodes".

2. **[Medium] Stagger connect-time requests** to avoid a thundering-herd effect on reconnect, especially after a service restart when many clients reconnect simultaneously.

3. **[Medium] Use the gateway snapshot for initial state** instead of separate requests. The `hello.snapshot` already includes `presence` and `health`. Consider adding `agents` and `nodes` to the snapshot to eliminate 2 of the 6 connect-time requests.

4. **[Low] Consider push-based node status updates** via the existing WebSocket event system to eliminate polling entirely.

---

## 6. Node.js Backend Performance

### 6.1 Architecture Overview

The gateway is a WebSocket server with an Express HTTP layer. Key files:

- `server.impl.ts` -- Main server implementation
- `server-methods.ts` -- Request routing (27+ handler modules)
- `server-chat.ts` -- Chat event processing
- `server-http.ts` -- HTTP endpoint handling
- `server-ws-runtime.ts` -- WebSocket runtime

### 6.2 Request Handling

`server-methods.ts` uses a flat handler dispatch pattern:
```ts
export const coreGatewayHandlers: GatewayRequestHandlers = {
  ...connectHandlers,
  ...logsHandlers,
  ...chatHandlers,
  // ... 20+ more handler groups
};
```

This is efficient -- object spread at startup, then O(1) method lookup at runtime. **No performance concern.**

### 6.3 Config Loading in Hot Path

**File:** `server-chat.ts` (Lines 12-21, 46-53)

```ts
function resolveHeartbeatAckMaxChars(): number {
  try {
    const cfg = loadConfig();  // Called on every heartbeat check
    return Math.max(0, cfg.agents?.defaults?.heartbeat?.ackMaxChars ?? DEFAULT_HEARTBEAT_ACK_MAX_CHARS);
  } catch {
    return DEFAULT_HEARTBEAT_ACK_MAX_CHARS;
  }
}
```

`loadConfig()` is called in the hot chat event path. If `loadConfig()` reads from disk on every call, this is a bottleneck under high message throughput. **Needs verification**: check if `loadConfig()` caches.

### 6.4 Event Log Buffer

In `app-gateway.ts` (frontend), the event log buffer is capped at 250 entries with `.slice(0, 250)` on every event, which creates a new array allocation each time. Under high event throughput, this creates GC pressure. **Low severity** -- only affects the UI, not the backend.

### Severity: LOW-MEDIUM

### Recommendations

1. **[Medium] Verify `loadConfig()` caching.** If it reads from disk, it should be cached with invalidation on file change (using `chokidar` which is already a dependency).

2. **[Low] Use a circular buffer** for the event log instead of `slice()`:
   ```ts
   // Instead of: this.eventLogBuffer = [...new, ...old].slice(0, 250)
   // Use a fixed-size ring buffer
   ```

3. **[Low] Profile the startup sequence.** The build script runs 8+ sequential steps (`pnpm canvas:a2ui:bundle && tsdown && ...`). Consider parallelizing independent steps.

---

## 7. CSS Performance

**File:** `/Users/dsselmanovic/openclaw/ui/src/styles/base.css` (885 lines)

### Findings

| Issue | Severity | Detail |
|---|---|---|
| 5 theme definitions in single file | Medium | All theme CSS variables are loaded regardless of active theme (~500 lines of unused vars) |
| `body::after` star animations | Low | `box-shadow` with 15 points + infinite animation; GPU-composited but still work |
| Glassmorphism `backdrop-filter` | Low | Used in multiple themes; can cause compositing layers |
| No CSS containment | Medium | No `contain: content` or `contain: layout` on major layout sections |

### Recommendations

1. **[Medium] Add CSS containment** to major layout sections:
   ```css
   .content { contain: content; }
   .sidebar { contain: layout style; }
   ```
   **Estimated impact:** Reduces layout recalculation scope during re-renders.

2. **[Low] Consider splitting theme CSS** into separate files loaded on demand. Currently all 5 themes (~500 CSS variables) are in a single file.

---

## 8. Summary of Findings

### Critical (Must Fix)

| # | Finding | File | Est. Impact |
|---|---|---|---|
| C1 | 155+ `@state()` properties in single God Component | `app.ts` | 60-80% fewer wasted renders |
| C2 | Source maps shipped to production (`sourcemap: true`) | `vite.config.ts` | 40-60% smaller output |

### High (Should Fix)

| # | Finding | File | Est. Impact |
|---|---|---|---|
| H1 | Zero route-based code splitting; all views statically imported | `app-render.ts` | 30-50% smaller initial bundle |
| H2 | Render-blocking Google Fonts CSS import | `base.css` | 200-500ms faster FCP |
| H3 | No manual chunk splitting configured in Vite | `vite.config.ts` | Better cache efficiency |
| H4 | Nodes polling runs unconditionally on all tabs | `app-polling.ts` | Eliminates unnecessary network |
| H5 | No `shouldUpdate()` guard on root component | `app.ts` | Reduced render overhead |

### Medium (Should Plan)

| # | Finding | File | Est. Impact |
|---|---|---|---|
| M1 | View prop objects reconstructed on every render | `app-render.ts` | Fewer object allocations |
| M2 | Connect-time request burst (6+ simultaneous) | `app-gateway.ts` | Smoother reconnect |
| M3 | No CSS containment on layout sections | `base.css` | Faster layout |
| M4 | No chunk size warning limit in Vite | `vite.config.ts` | CI visibility |
| M5 | 3 font families loaded (9 weights total) | `base.css` | 200-400KB less on load |
| M6 | Verify `loadConfig()` caching in chat hot path | `server-chat.ts` | Avoid disk I/O per message |

### Low (Nice to Have)

| # | Finding | File | Est. Impact |
|---|---|---|---|
| L1 | Event log buffer uses `slice()` creating array copies | `app-gateway.ts` | Less GC pressure |
| L2 | `logo-activi-animated.mp4` in public assets | `ui/public/` | Verify size |
| L3 | Theme CSS not split by theme | `base.css` | Smaller per-theme CSS |
| L4 | Build script runs 8+ sequential steps | `package.json` | Faster CI builds |

---

## 9. Prioritized Action Plan

### Phase 1 (Quick Wins -- 1-2 hours)
1. Disable production source maps in `vite.config.ts` (**C2**)
2. Gate nodes polling to "nodes" tab only (**H4**)
3. Add chunk size warning limit (**M4**)

### Phase 2 (Short-term -- 1-2 days)
4. Self-host fonts and eliminate render-blocking CSS import (**H2**, **M5**)
5. Add `shouldUpdate()` guard to `ActiviApp` (**H5**)
6. Add manual chunk splitting in Vite (**H3**)

### Phase 3 (Medium-term -- 1-2 weeks)
7. Implement dynamic imports for non-default tabs (**H1**)
8. Begin decomposing God Component into domain controllers (**C1**)
9. Add CSS containment (**M3**)

### Phase 4 (Long-term -- ongoing)
10. Complete state decomposition (**C1** continued)
11. Migrate high-frequency state to `@lit-labs/signals` (**M1**)
12. Optimize build pipeline parallelism (**L4**)

---

## Appendix: File References

| File | Path |
|---|---|
| Vite config | `/Users/dsselmanovic/openclaw/ui/vite.config.ts` |
| App root component | `/Users/dsselmanovic/openclaw/ui/src/ui/app.ts` |
| App render function | `/Users/dsselmanovic/openclaw/ui/src/ui/app-render.ts` |
| App lifecycle | `/Users/dsselmanovic/openclaw/ui/src/ui/app-lifecycle.ts` |
| App gateway | `/Users/dsselmanovic/openclaw/ui/src/ui/app-gateway.ts` |
| App polling | `/Users/dsselmanovic/openclaw/ui/src/ui/app-polling.ts` |
| App view state type | `/Users/dsselmanovic/openclaw/ui/src/ui/app-view-state.ts` |
| WebSocket client | `/Users/dsselmanovic/openclaw/ui/src/ui/gateway.ts` |
| Base CSS | `/Users/dsselmanovic/openclaw/ui/src/styles/base.css` |
| Icons | `/Users/dsselmanovic/openclaw/ui/src/ui/icons.ts` |
| Server chat | `/Users/dsselmanovic/openclaw/src/gateway/server-chat.ts` |
| Server methods | `/Users/dsselmanovic/openclaw/src/gateway/server-methods.ts` |
| Package.json | `/Users/dsselmanovic/openclaw/package.json` |
