# PR #37427 Review Rejections & Fix Plan

> Reviewers: **Greptile** (automated, CONTRIBUTOR) and **Codex** (automated)
> Confidence score: **1/5** — "Not safe to merge"
> Positive: "The core `--dev-mode` flag infrastructure is cleanly implemented"
> Branch: `pr-ready`

---

## Status Overview

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| R1 | OPENCLAW_PORT defaults to 0 | Blocking | ACCEPTED (via GitHub suggestion) |
| R2 | Unused ARIEL_PHONE variable | Low | ACCEPTED (via GitHub suggestion) |
| R3 | Hardcoded "Jarvis" + WhatsApp | Medium | TODO |
| R4 | Bare `except:` clauses | Medium | ACCEPTED but BROKEN (indentation lost) |
| R5 | README replaced with fork content | Critical | TODO |
| R6 | Hub auto-starts on every CLI command | Medium-High | TODO |
| R7 | Config load before bypass check | High (P1) | TODO |
| R8 | Dev mode not applied for routed commands | Medium (P2) | TODO |
| R9 | spawn error not handled | Medium (P2) | MERGED into R6 |

---

## R1. OPENCLAW_PORT defaults to 0 — ACCEPTED
**Reviewer**: Greptile | **File**: `dev-mode/hub/server.py:23`

Changed to default `"18789"`. Done via GitHub suggestion commit `af951ff9a`.

---

## R2. Unused ARIEL_PHONE variable — ACCEPTED
**Reviewer**: Greptile | **File**: `dev-mode/hub/server.py:25`

Line removed. Done via GitHub suggestion commit `7a412c685`.

---

## R3. Hardcoded "Jarvis" name and WhatsApp channel — TODO
**Reviewer**: Greptile | **Files**: `server.py`, `index.ts`, `openclaw.plugin.json`, `hub/README.md`

**Problem**: Multiple files hardcode personal agent name "Jarvis" and WhatsApp as the delivery channel. Needs to be configurable via env vars so users can set their own agent and channel.

**Solution**: Add two env vars to `server.py` with sensible defaults and a comment nudging users to customize:

```python
OPENCLAW_AGENT = os.environ.get("OPENCLAW_AGENT", "agent:main")  # default value, please update in .env
HUB_CHANNEL = os.environ.get("HUB_CHANNEL", "WhatsApp")  # default value, please update in .env
```

Then use them dynamically:
- `OPENCLAW_AGENT` → the `model` field in `/v1/chat/completions` call (replaces hardcoded `"agent:main"`)
- `HUB_CHANNEL` → prompt instruction says `f"Forward this to the user on {HUB_CHANNEL} NOW"` (replaces hardcoded WhatsApp)

**Full scope of references to fix:**

**server.py** — rename + use env vars:
- Line 4: module docstring `"wakes Jarvis -> Jarvis responds"` → `"wakes agent -> agent responds"`
- Line 102: `def wake_jarvis(...)` → `def wake_agent(...)`
- Line 103: docstring → `"Send notification to agent via chat API"`
- Line 110: comment → `"Build prompt that instructs agent to forward notification"`
- Line 118: prompt → `f"Forward this to the user on {HUB_CHANNEL} NOW ..."`
- Line 121: model field → `"model": OPENCLAW_AGENT` (instead of hardcoded `"agent:main"`)
- Line 131: log → `"Agent processed"`
- Line 134: log → `"ERROR calling agent API"`
- Line 197: comment → `"# Wake agent"`
- Line 198: call → `wake_agent(...)`
- Line 203: response → `"Notification sent to agent"`

**index.ts** (1 occurrence):
- Line 70: `"the agent forwards to the user on WhatsApp."` → `"the agent forwards to the user via the configured channel."`

**openclaw.plugin.json** (1 occurrence):
- Line 4: `"through WhatsApp or any active channel"` → `"through the configured channel"`

**hub/README.md** (multiple occurrences):
- Line 3: `"the agent forwards to WhatsApp (or any channel)"` → `"the agent forwards via the configured channel"`
- Line 9: `"Source: [YourJarvisHub]..."` — remove or generalize
- Line 160: `"Notification sent to Jarvis"` → `"Notification sent to agent"`
- Line 165: `"after forwarding to WhatsApp"` → `"after forwarding the notification"`
- Line 170/257: `"Forwarded to WhatsApp"` → `"Forwarded to user"`
- Line 284: `ARIEL_PHONE` row → replace with `OPENCLAW_AGENT` and `HUB_CHANNEL` rows
- Line 355: `"Built by Jarvis de la Ari"` — remove or generalize

---

## R4. Bare `except:` clauses — ACCEPTED but BROKEN
**Reviewer**: Greptile | **File**: `dev-mode/hub/server.py:179,214`

**Problem**: Ariel accepted the GitHub code suggestions, but GitHub's suggestion feature stripped the leading whitespace. Both `except` lines are now at column 0:

```python
# Line 179 — currently broken:
except (ValueError, json.JSONDecodeError):
            data = {}

# Should be:
        except (ValueError, json.JSONDecodeError):
            data = {}
```

```python
# Line 214 — currently broken:
except ValueError:
                self.send_json({"error": "Invalid ID"}, 400)

# Should be:
            except ValueError:
                self.send_json({"error": "Invalid ID"}, 400)
```

**Fix**: Restore proper indentation. This is a **syntax error** that will crash server.py on import.

---

## R5. README replaced with fork content — TODO
**Reviewer**: Greptile | **File**: `README.md`

**Problem**: The entire upstream README (559 lines — badges, architecture, channels, security docs, config reference, contributor resources) was replaced with fork-specific install instructions. This is a critical documentation regression for the PR.

**Fix**:
1. Move our current README.md content to `dev-mode/README.md` (our install guide, feature table, etc.)
2. Restore the original upstream README.md from fork point: `git checkout 029c47372 -- README.md`

The PR diff will have zero README.md changes — no conflicts possible.

---

## R6. Hub auto-starts on every CLI command — TODO
**Reviewer**: Greptile + Codex | **File**: `src/cli/program/preaction.ts:136-160`

**Problem**: preAction hook fires before **every** CLI command. The hub auto-start block does an HTTP probe + potential spawn on every invocation, adding ~1s latency to even read-only commands like `config get`. No PID tracking, no lifecycle management.

**Fix**: Remove the entire hub auto-start block (lines 136-160) from `preaction.ts`. The hub server should only be woken **once**, at gateway start/restart.

**Where to put it**: In `src/gateway/server.impl.ts`, right after the existing `gateway_start` plugin hook block (line 906). This runs once per start/restart cycle. The code checks if devMode is on, probes port 10020, and spawns `python3 server.py` if not running — with proper error handling (covers R9):

```typescript
// [dev-mode] Attempt to start Hub notification server (once, at gateway start)
// Hub is presented as a plugin. If management agrees, we'd like it to be
// a built-in tool for agents — enabling in-session alert and response
// without requiring a separate server process.
if (!minimalTestGateway && isDevMode()) {
  try {
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const hubServerPath = path.resolve(thisDir, "../../dev-mode/hub/server.py");
    const fs = await import("node:fs");
    if (fs.existsSync(hubServerPath)) {
      const http = await import("node:http");
      const isRunning = await new Promise<boolean>((resolve) => {
        const req = http.request(
          { hostname: "127.0.0.1", port: 10020, path: "/pending", method: "GET", timeout: 1000 },
          () => resolve(true),
        );
        req.on("error", () => resolve(false));
        req.on("timeout", () => { req.destroy(); resolve(false); });
        req.end();
      });
      if (!isRunning) {
        const { spawn } = await import("node:child_process");
        const child = spawn("python3", [hubServerPath], {
          detached: true,
          stdio: "ignore",
        });
        child.on("error", (err) => {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            console.error("[dev-mode] Hub server requires python3 — please install it to use the Hub notification plugin.");
          } else {
            console.error(`[dev-mode] Failed to start Hub server: ${err.message}`);
          }
        });
        child.unref();
      }
    }
  } catch (err) {
    console.error(`[dev-mode] Hub server auto-start failed: ${err instanceof Error ? err.message : err}`);
  }
}
```

**In server.impl.ts**: Add `isDevMode` to imports: `import { isDevMode } from "../globals.js"`.

**In preaction.ts**: Keep only the hub plugin path registration (lines 125-134) so hub tools are available to agents. Remove the entire auto-start block (lines 136-160).

---

## R7. Config load before bypass check — TODO
**Reviewer**: Codex (P1) | **File**: `src/cli/program/preaction.ts:119-162`

**Problem**: Our dev-mode block calls `loadConfig()` at line 121, which runs **before** `shouldBypassConfigGuard()` at line 170. If config is broken (invalid JSON, missing env substitutions, schema errors), recovery commands like `doctor` and `config validate` will crash in preAction instead of reaching their handlers.

**Understanding**: The original preaction code carefully delays config loading until after the bypass check. We broke this ordering by inserting our block at line 118.

**Fix**: Wrap our `loadConfig()` call in a try-catch. If it fails, skip dev-mode but **clearly tell the user** what happened and why.

```typescript
// Load dev-mode flag from config (fail-safe: don't break recovery commands)
try {
  const { loadConfig } = await import("../../config/config.js");
  const cfg = loadConfig();
  if (cfg.cli?.devMode) {
    setDevMode(true);
    // ... rest of hub plugin registration ...
  }
} catch (err) {
  console.error(`[dev-mode] Failed to activate dev-mode: ${err instanceof Error ? err.message : err}`);
  console.error("[dev-mode] Config may be broken. Run 'openclaw doctor' to diagnose.");
}
```

User sees exactly what went wrong and what to do about it, while recovery commands (`doctor`, `config validate`) still work.

---

## R8. Dev mode not applied for route-first commands — TODO
**Reviewer**: Codex (P2) | **File**: `src/cli/program/preaction.ts:123`

**Problem**: `setDevMode(true)` only runs inside the Commander preAction hook. But `runCli()` in `run-main.ts` calls `tryRouteCli()` at line 102 **before** Commander hooks run. Routed commands include: `config get`, `config unset`, `health`, `status`, `sessions`, `agents list`, `models list/status`.

So `openclaw config get models.providers` (routed) won't see dev-mode from persisted config — API keys stay redacted. The `isDevMode()` function checks `process.env.OPENCLAW_DEV_MODE === "1"` as fallback, but that env var isn't set by the config path.

**Fix**: In `run-main.ts`, after we parse the profile args and before `tryRouteCli()`, load config and set the env var:

```typescript
// After line 91 (after --dev-mode handling), before tryRouteCli():
// Apply persisted dev-mode for route-first commands
try {
  const { loadConfig } = await import("../config/config.js");
  const cfg = loadConfig();
  if (cfg.cli?.devMode) {
    process.env.OPENCLAW_DEV_MODE = "1";
  }
} catch (err) {
  console.error(`[dev-mode] Failed to load dev-mode config: ${err instanceof Error ? err.message : err}`);
}
```

This ensures `isDevMode()` returns true via its env var fallback for all code paths, including routed commands. Errors are shown to the user.

---

## R9. spawn error not handled — MERGED into R6
**Reviewer**: Codex (P2) | **Original file**: `src/cli/program/preaction.ts:153-157`

**Problem**: `spawn("python3", ...)` emits an `error` event if `python3` isn't found (ENOENT). Since there's no listener, this becomes an unhandled error that crashes the CLI.

**Fix**: Handled as part of R6 — the spawn moves to `server.impl.ts` (gateway start only) with a proper `child.on("error", ...)` handler that tells the user python3 is a dependency if ENOENT, or shows the actual error otherwise.
