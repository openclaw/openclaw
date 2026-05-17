# Requirements — Computer-use loop with high-res vision

## Outcome

OpenClaw can run an Anthropic computer-use loop on Claude Opus 4.7: the agent inspects browser/canvas/device screenshots at the model's new max resolution (2576px / 3.75MP), reasons about pixels, and performs `click`/`type`/`key`/`scroll` actions back through the existing browser + canvas + screen.record tool surface. Long-horizon agentic tasks ("book me a flight", "fill this form", "summarize what's on my screen") work end-to-end without a human in the inner loop.

## Users affected

- Operators driving long-running agentic tasks via chat or voice.
- The browser tool — `src/browser/` (CDP-driven Chrome).
- The canvas tool — `src/canvas-host/` (A2UI host).
- The node tools — `src/node-host/` (screen.record, camera, system.run/notify on macOS).
- The agent runtime — model selection, vision payload assembly, tool dispatch.

## In scope

- New `src/agents/tools/computer-use.ts` aggregating the existing browser/canvas/screen.record/click/keyboard primitives behind Anthropic's computer-use tool schema (model emits coordinate-based actions).
- Vision pipeline upgrade: pass screenshots at up to 2576px on the longest edge (was previously downscaled). Adapt `src/media/image-ops.ts` to preserve resolution when the active model is Opus 4.7+.
- Action coordinate system normalized to logical screen pixels with a one-place DPR map for Retina/4K capture.
- Hard timeouts per action + per loop; whole-loop wall-clock budget configurable.
- Allowlist by `computerUse.allowedHosts` for the browser surface and `computerUse.allowedNodes` for device targets.
- Audit log of every action (URL, screenshot hash, click coords, typed text) under `~/.openclaw/agents/<agentId>/computer-use/<sessionKey>/`.

## Out of scope

- Replacing the existing browser/canvas tools — computer-use is a *layer* on top, not a rewrite.
- Mobile (iOS/Android) computer-use via screen capture — punt to a follow-up; the camera and screen.record primitives are reused via `node.invoke` but app-driving on mobile is much harder.
- Background headless agents running computer-use without operator presence — explicitly require an active session window.
- Anthropic Managed Agents-side compute (server-side) — stay client-side.

## Decisions

- Coordinate space: logical screen pixels at capture-time DPR, snap to physical via the canvas/browser tool layer. Reason: matches Anthropic's documented expectation and avoids drift across multi-monitor / Retina setups.
- Per-action wall clock 30s default. Reason: prevents the model from hanging on a stuck page.
- Allowlist enforced at the *navigation* moment, not after the screenshot. Reason: avoids leaking pixels from an out-of-scope page.
- Audit log retention = 7 days by default. Reason: enough for debugging without unbounded disk growth.
