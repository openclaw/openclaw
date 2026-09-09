---
summary: "Live (network-touching) tests: model matrix, CLI backends, ACP, media providers, credentials"
read_when:
  - Running live model matrix / CLI backend / ACP / media-provider smokes
  - Debugging live-test credential resolution
  - Adding a new provider-specific live test
title: "Testing: live suites"
sidebarTitle: "Live tests"
---

For quick start, QA runners, unit/integration suites, and Docker flows, see
[Testing](/help/testing). This page covers **live** (network-touching) tests:
model matrix, CLI backends, ACP, media providers, and credential handling.

This page is an index. The live testing kit is documented on six pages, one
per reader job. Open the page that matches your task.

| Page                                                                                        | Read it when                                                                   |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [Quick live smokes and the Android node sweep](/help/testing-live/quick-smokes)             | You want a fast ad hoc smoke or an Android node sweep.                         |
| [Live model smoke (profile keys)](/help/testing-live/model-smoke)                           | You are smoking a provider or model through the direct and gateway layers.     |
| [CLI backend and APNs lanes](/help/testing-live/cli-backends)                               | You are driving a local CLI backend, or checking APNs proxy reachability.      |
| [ACP bind and Codex app-server lanes](/help/testing-live/acp-and-codex)                     | You are debugging an ACP bind or the Codex app-server harness.                 |
| [OpenAI long context and the live model matrix](/help/testing-live/long-context-and-matrix) | You need the long-context proof runs, the recipes, or the curated model lists. |
| [Media provider live lanes](/help/testing-live/media-providers)                             | You are running an image, music, video, or other media provider sweep.         |

## Live tests vs your real gateway

Live suites and ad hoc smokes must never disturb a gateway that is already
serving real traffic (yours or another operator's):

- Bring your own gateway: use the in-process gateway (Layer 2 on
  [Live model smoke](/help/testing-live/model-smoke)) or start a
  dev instance with an isolated state dir (`OPENCLAW_STATE_DIR=<scratch>`) and a
  free port. Do not bind the default gateway port (18789) while a real gateway
  is running on it.
- Do not `openclaw gateway stop`/`restart` (or `launchctl`/`systemctl`/tmux
  equivalents) a service you did not start in this session — that is the
  operator's live instance. Get explicit approval first.
- Need realistic data? Copy the live state/DB into your dev state dir and test
  against the copy. In-place migrations of a live gateway's state also require
  explicit approval.

## Credentials (never commit)

Live tests discover credentials the same way the CLI does. Practical implications:

- If the CLI works, live tests should find the same keys.
- If a live test says "no creds", debug the same way you'd debug `openclaw models list` / model selection.
- An OpenClaw live suite that cannot resolve its credentials must skip visibly in the reporter with Vitest test-context `skip(reason)` or fail; it must never pass green without reaching the provider, because a green run that did not reach the provider is not live evidence.

- Per-agent auth profiles: SQLite credential rows in `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite` (this is what "profile keys" means in the live tests)
- Config: `~/.openclaw/openclaw.json` (or `OPENCLAW_CONFIG_PATH`)
- Legacy OAuth dir: `~/.openclaw/credentials/` (copied into the staged live home when present, but not the main profile-key store)
- Local live runs copy the active config (with `agents.*.workspace` / `agentDir` overrides stripped) and stage each agent's canonical SQLite auth credential/state rows through the auth-store reader/writer APIs, not by copying its database or the rest of its directory. Agent sessions, `workspace/`, and `sandboxes/` data are not staged. The runner also copies the legacy `credentials/` dir and supported external CLI auth files/dirs (`.claude.json`, `.claude/.credentials.json`, `.claude/settings*.json`, `.claude/backups`, `.codex/auth.json`, `.codex/config.toml`, `.gemini`, `.minimax`) into a temp test home.

If you want to rely on env keys, export them before local tests or use the
Docker runners on the lane pages listed above with an explicit
`OPENCLAW_PROFILE_FILE`.

## Where each section moved

Every section heading from the previous single-page version keeps its anchor
here, so an existing link such as
`/help/testing-live#live-codex-app-server-harness-smoke` still resolves. Each
entry points at the page that now holds the content.

- <a id="live%3A-local-smoke-commands" /><a id="live-local-smoke-commands" />[Live: local smoke commands](/help/testing-live/quick-smokes#live-local-smoke-commands)
- <a id="live%3A-android-node-capability-sweep" /><a id="live-android-node-capability-sweep" />[Live: Android node capability sweep](/help/testing-live/quick-smokes#live-android-node-capability-sweep)
- <a id="live%3A-model-smoke-(profile-keys)" /><a id="live-model-smoke-profile-keys" />[Live: model smoke (profile keys)](/help/testing-live/model-smoke#live-model-smoke-profile-keys)
- <a id="layer-1%3A-direct-model-completion-(no-gateway)" /><a id="layer-1-direct-model-completion-no-gateway" />[Layer 1: Direct model completion (no gateway)](/help/testing-live/model-smoke#layer-1-direct-model-completion-no-gateway)
- <a id="layer-2%3A-gateway-%2B-dev-agent-smoke-(what-%22%40openclaw%22-actually-does)" /><a id="layer-2-gateway-+-dev-agent-smoke-what-@openclaw-actually-does" />[Layer 2: Gateway + dev agent smoke](/help/testing-live/model-smoke#layer-2-gateway-+-dev-agent-smoke-what-@openclaw-actually-does)
- <a id="live%3A-cli-backend-smoke-(claude%2C-gemini%2C-or-other-local-clis)" /><a id="live-cli-backend-smoke-claude-gemini-or-other-local-clis" />[Live: CLI backend smoke (Claude, Gemini, or other local CLIs)](/help/testing-live/cli-backends#live-cli-backend-smoke-claude-gemini-or-other-local-clis)
- <a id="live%3A-apns-http%2F2-proxy-reachability" /><a id="live-apns-http/2-proxy-reachability" />[Live: APNs HTTP/2 proxy reachability](/help/testing-live/cli-backends#live-apns-http/2-proxy-reachability)
- <a id="live%3A-acp-bind-smoke-(%2Facp-spawn-...---bind-here)" /><a id="live-acp-bind-smoke-/acp-spawn-bind-here" />[Live: ACP bind smoke](/help/testing-live/acp-and-codex#live-acp-bind-smoke-/acp-spawn-bind-here)
- <a id="live%3A-codex-app-server-harness-smoke" /><a id="live-codex-app-server-harness-smoke" />[Live: Codex app-server harness smoke](/help/testing-live/acp-and-codex#live-codex-app-server-harness-smoke)
- <a id="live%3A-openai-long-context" /><a id="live-openai-long-context" />[Live: OpenAI long context](/help/testing-live/long-context-and-matrix#live-openai-long-context)
- <a id="long-context-hard-oracles" />[Long-context hard oracles](/help/testing-live/long-context-and-matrix#long-context-hard-oracles)
- <a id="recommended-live-recipes" />[Recommended live recipes](/help/testing-live/long-context-and-matrix#recommended-live-recipes)
- <a id="live%3A-model-matrix-(what-we-cover)" /><a id="live-model-matrix-what-we-cover" />[Live: model matrix (what we cover)](/help/testing-live/long-context-and-matrix#live-model-matrix-what-we-cover)
- <a id="aggregators-%2F-alternate-gateways" /><a id="aggregators-/-alternate-gateways" />[Aggregators / alternate gateways](/help/testing-live/long-context-and-matrix#aggregators-/-alternate-gateways)
- <a id="deepgram-live-(audio-transcription)" /><a id="deepgram-live-audio-transcription" />[Deepgram live (audio transcription)](/help/testing-live/media-providers#deepgram-live-audio-transcription)
- <a id="byteplus-coding-plan-live" />[BytePlus coding plan live](/help/testing-live/media-providers#byteplus-coding-plan-live)
- <a id="comfyui-workflow-media-live" />[ComfyUI workflow media live](/help/testing-live/media-providers#comfyui-workflow-media-live)
- <a id="image-generation-live" />[Image generation live](/help/testing-live/media-providers#image-generation-live)
- <a id="music-generation-live" />[Music generation live](/help/testing-live/media-providers#music-generation-live)
- <a id="video-generation-live" />[Video generation live](/help/testing-live/media-providers#video-generation-live)
- <a id="media-live-harness" />[Media live harness](/help/testing-live/media-providers#media-live-harness)

## Related

- [Testing](/help/testing) - unit, integration, QA, and Docker suites
