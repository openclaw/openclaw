---
summary: "Named live and E2E shards in the release live/E2E child workflow"
read_when:
  - You are rerunning a failed live or E2E shard
  - You need the shard names for a manual one-shot run
title: "Live and E2E shards"
sidebarTitle: "Live and E2E shards"
---

The named live and E2E shards the release live/E2E child runs, and what each shard covers. Part of the [Release validation workflows](/ci/release-validation) index.

## Live and E2E shards

The release live/E2E child keeps broad native `pnpm test:live` coverage, but it runs it as named shards through `scripts/test-live-shard.mjs` instead of one serial job:

- `native-live-src-agents` and `native-live-src-agents-zai-coding`
- `native-live-src-gateway-core`
- provider-filtered `native-live-src-gateway-profiles` jobs
- `native-live-src-gateway-backends`
- `native-live-src-infra`
- `native-live-test`
- `native-live-extensions-a-k`
- `native-live-extensions-l-n`
- `native-live-extensions-moonshot`
- `native-live-extensions-openai`
- `native-live-extensions-o-z-other`
- `native-live-extensions-xai`
- split media audio/video shards and provider-filtered music shards

That keeps the same file coverage while making slow live provider failures easier to rerun and diagnose. The aggregate `native-live-src-gateway`, `native-live-extensions-o-z`, `native-live-extensions-media`, and `native-live-extensions-media-music` shard names remain valid for manual one-shot reruns.

Stable/full release validation includes the configless `agent exec --auth-env-only` Code Mode smoke in `native-live-test`. The test runner builds the runtime before starting workers. The smoke copies that built distribution outside the source checkout, applies the package's plugin exclusions, and reuses installed dependencies. It supplies only `OPENAI_API_KEY` to a fresh CLI environment, runs `openai/gpt-5.6-sol` without a runtime override, and verifies Code Mode engagement, nested tool calls, and an exact read-to-write artifact. This proves built-distribution behavior; Package Acceptance owns tarball installation proof. The shard requires passing evidence from this test; a missing key or skipped test cannot satisfy the release gate.

Gateway-profile shards and shards containing the image-tool provider or OpenAI plugin live tests prepare the `sourcePerformance` build profile before starting Vitest. This supplies executable provider and agent runtime artifacts without building declarations or the Control UI. Provider requests, assertions, and test deadlines remain unchanged; gateway diagnostic environment settings apply only to gateway-profile shards. Cold source-plugin Jiti import cost remains a separate performance follow-up, not live provider latency.

Stable/full release runs explicitly enable OpenAI AgentSession repeated compaction in `native-live-src-agents` with `OPENCLAW_LIVE_OPENAI_COMPACTION=1` and `OPENCLAW_LIVE_OPENAI_COMPACTION_FULL=0`. This uses the bounded 48k context profile and requires multiple compactions plus durable-marker recall. Manual shard runs retain the explicit opt-in; once enabled, a skipped compaction test fails the shard's pass-evidence gate. The separate 922k full-context stress profile remains a manual opt-in.

The native live media shards run in `ghcr.io/openclaw/openclaw-live-media-runner:ubuntu-24.04`, built by the `Live Media Runner Image` workflow. That image preinstalls `ffmpeg` and `ffprobe`; media jobs only verify the binaries before setup. Keep Docker-backed live suites on normal Blacksmith runners — container jobs are the wrong place to launch nested Docker tests.

Docker-backed live model/backend shards use a separate shared `ghcr.io/openclaw/openclaw-live-test:<sha>-<extensions>` image per selected commit. The live release workflow builds and pushes that image once, then the Docker live model, provider-sharded gateway, CLI backend, ACP bind, and Codex harness shards run with `OPENCLAW_SKIP_DOCKER_BUILD=1`. Gateway Docker shards carry explicit script-level `timeout` caps below the workflow job timeout so a stuck container or cleanup path fails fast instead of consuming the whole release-check budget. If those shards rebuild the full source Docker target independently, the release run is misconfigured and will waste wall clock on duplicate image builds.
