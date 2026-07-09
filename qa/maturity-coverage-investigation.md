# QA maturity coverage investigation

Snapshot: current worktree, 2026-06-24.

## Summary

- Taxonomy coverage IDs: 1665
- Primary-fulfilled coverage IDs today: 105 (6.3%)
- QA-linked coverage IDs today, including secondary metadata: 171 (10.3%)
- Unlinked coverage IDs with direct e2e/live/script candidates: 31
- Coverage IDs with no direct repo e2e candidate in this scan: 1463
- Scenario files: 129 total; 118 flow scenarios; 11 native scenario links.
- Existing unlinked e2e/live/script proof files scanned: 459.

This is intentionally conservative: a coverage ID counts as an existing-test candidate only when an unlinked e2e/live/proof script has matching owner/path plus coverage-ID or feature-name terms. Broad unit tests and vague category words do not count.

Coverage score math uses distinct primary-fulfilled coverage IDs over distinct required coverage IDs, so partial coverage of a multi-ID feature counts proportionately. Any-linked counts still include secondary metadata and are useful for inventory discovery, but they are not the release coverage score.

## Current Coverage By Profile

| Profile | Categories | Coverage IDs | Primary linked | Any linked | Candidate links | No direct e2e candidate | Primary % | Any-linked % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| smoke-ci | 34 | 290 | 94 | 149 | 3 | 138 | 32.4% | 51.4% |
| release | 167 | 1101 | 105 | 170 | 20 | 911 | 9.5% | 15.4% |
| all | 281 | 1665 | 105 | 171 | 31 | 1463 | 6.3% | 10.3% |

## Current Coverage By Surface

| Surface | Coverage IDs | Primary linked | Any linked | Candidate links | No direct e2e candidate | Primary % | Any-linked % | After candidate % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| agent-runtime-and-provider-execution<br>Agent Runtime | 94 | 43 | 76 | 0 | 18 | 45.7% | 80.9% | 80.9% |
| android-app<br>Android app | 10 | 0 | 0 | 0 | 10 | 0% | 0% | 0% |
| anthropic-provider-path<br>Anthropic provider path | 40 | 3 | 5 | 1 | 34 | 7.5% | 12.5% | 15% |
| automation-cron-hooks-tasks-polling<br>Automation: cron, hooks, tasks, polling | 68 | 5 | 9 | 2 | 57 | 7.4% | 13.2% | 16.2% |
| browser-automation-and-exec-sandbox-tools<br>Browser automation, exec, and sandbox tools | 22 | 5 | 6 | 0 | 16 | 22.7% | 27.3% | 27.3% |
| browser-control-ui-and-webchat<br>Gateway Web App | 56 | 5 | 10 | 2 | 44 | 8.9% | 17.9% | 21.4% |
| channel-framework<br>Channel framework | 65 | 25 | 36 | 1 | 28 | 38.5% | 55.4% | 56.9% |
| clawhub-and-external-plugin-distribution<br>ClawHub | 50 | 0 | 0 | 3 | 47 | 0% | 0% | 6% |
| cli-install-update-onboard-doctor<br>CLI | 43 | 1 | 7 | 1 | 35 | 2.3% | 16.3% | 18.6% |
| discord<br>Discord | 39 | 0 | 0 | 0 | 39 | 0% | 0% | 0% |
| docker-podman-hosting<br>Docker and Podman hosting | 27 | 2 | 4 | 7 | 16 | 7.4% | 14.8% | 40.7% |
| feishu-qq-bot-wechat-yuanbao-zalo-zalo-personal-regional-channels<br>Feishu, QQ Bot, WeChat, Yuanbao, Zalo, Zalo Personal, regional channels | 9 | 0 | 0 | 0 | 9 | 0% | 0% | 0% |
| gateway-runtime<br>Gateway runtime | 105 | 8 | 15 | 0 | 90 | 7.6% | 14.3% | 14.3% |
| google-chat<br>Google Chat | 45 | 0 | 0 | 0 | 45 | 0% | 0% | 0% |
| google-provider-path<br>Google provider path | 44 | 0 | 0 | 0 | 44 | 0% | 0% | 0% |
| image-video-music-generation-tools<br>Image, video, and music generation tools | 42 | 0 | 0 | 0 | 42 | 0% | 0% | 0% |
| imessage-bluebubbles<br>iMessage and BlueBubbles | 31 | 0 | 0 | 0 | 31 | 0% | 0% | 0% |
| ios-app<br>iOS app | 15 | 0 | 0 | 0 | 15 | 0% | 0% | 0% |
| kubernetes-hosting<br>Kubernetes hosting | 20 | 0 | 0 | 0 | 20 | 0% | 0% | 0% |
| linux-companion-app<br>Linux companion app | 26 | 0 | 0 | 0 | 26 | 0% | 0% | 0% |
| linux-gateway-host<br>Linux Gateway host | 23 | 0 | 0 | 0 | 23 | 0% | 0% | 0% |
| local-model-providers-ollama-vllm-sglang-lm-studio<br>Local model providers: Ollama, vLLM, SGLang, LM Studio | 37 | 0 | 0 | 1 | 36 | 0% | 0% | 2.7% |
| long-tail-hosted-providers<br>Long-tail hosted providers | 32 | 0 | 0 | 2 | 30 | 0% | 0% | 6.3% |
| macos-companion-app<br>macOS companion app | 35 | 0 | 0 | 0 | 35 | 0% | 0% | 0% |
| macos-gateway-host<br>macOS Gateway host | 41 | 0 | 0 | 0 | 41 | 0% | 0% | 0% |
| matrix<br>Matrix | 23 | 0 | 0 | 0 | 23 | 0% | 0% | 0% |
| mattermost-line-irc-nextcloud-talk-nostr-twitch-tlon-synology-chat<br>Mattermost, LINE, IRC, Nextcloud Talk, Nostr, Twitch, Tlon, Synology Chat | 4 | 0 | 0 | 0 | 4 | 0% | 0% | 0% |
| media-understanding-and-media-generation<br>Media understanding and media generation | 48 | 6 | 8 | 2 | 38 | 12.5% | 16.7% | 20.8% |
| microsoft-teams<br>Microsoft Teams | 33 | 0 | 0 | 0 | 33 | 0% | 0% | 0% |
| native-windows-cli-and-gateway<br>Native Windows | 28 | 0 | 0 | 0 | 28 | 0% | 0% | 0% |
| native-windows-companion-app<br>Native Windows companion app | 24 | 0 | 0 | 1 | 23 | 0% | 0% | 4.2% |
| nix-install-path<br>Nix install path | 30 | 0 | 0 | 0 | 30 | 0% | 0% | 0% |
| openai-codex-provider-path<br>OpenAI and Codex provider path | 26 | 10 | 17 | 0 | 9 | 38.5% | 65.4% | 65.4% |
| openclaw-app-sdk<br>OpenClaw App SDK | 31 | 1 | 2 | 0 | 29 | 3.2% | 6.5% | 6.5% |
| openrouter-provider-path<br>OpenRouter provider path | 41 | 0 | 0 | 0 | 41 | 0% | 0% | 0% |
| plugin-sdk-and-bundled-plugin-architecture<br>Plugins | 69 | 11 | 25 | 1 | 43 | 15.9% | 36.2% | 37.7% |
| raspberry-pi-small-linux-devices<br>Raspberry Pi and small Linux devices | 36 | 0 | 0 | 1 | 35 | 0% | 0% | 2.8% |
| security-auth-pairing-and-secrets<br>Security, auth, pairing, and secrets | 41 | 8 | 12 | 0 | 29 | 19.5% | 29.3% | 29.3% |
| session-memory-and-context-engine<br>Session, memory, and context engine | 57 | 32 | 48 | 0 | 9 | 56.1% | 84.2% | 84.2% |
| signal<br>Signal | 24 | 0 | 0 | 0 | 24 | 0% | 0% | 0% |
| slack<br>Slack | 25 | 0 | 0 | 0 | 25 | 0% | 0% | 0% |
| telegram<br>Telegram | 31 | 1 | 1 | 1 | 29 | 3.2% | 3.2% | 6.5% |
| telemetry-diagnostics-and-observability<br>Observability | 58 | 15 | 24 | 0 | 34 | 25.9% | 41.4% | 41.4% |
| tui-and-terminal-ux<br>TUI | 33 | 0 | 0 | 0 | 33 | 0% | 0% | 0% |
| voice-and-realtime-talk<br>Voice and realtime talk | 36 | 0 | 0 | 1 | 35 | 0% | 0% | 2.8% |
| voice-call-channel<br>Voice Call channel | 8 | 0 | 0 | 1 | 7 | 0% | 0% | 12.5% |
| watchos-companion-surfaces<br>watchOS companion surfaces | 26 | 0 | 0 | 2 | 24 | 0% | 0% | 7.7% |
| web-search-tools<br>Web search tools | 44 | 5 | 7 | 0 | 37 | 11.4% | 15.9% | 15.9% |
| whatsapp<br>WhatsApp | 20 | 0 | 0 | 0 | 20 | 0% | 0% | 0% |
| windows-via-wsl2<br>Windows via WSL2 | 49 | 3 | 3 | 1 | 45 | 6.1% | 6.1% | 8.2% |

## Existing Native QA Links

| Scenario | Kind | Path |
| --- | --- | --- |
| `qa/scenarios/channels/channel-message-flows.yaml` | vitest | `extensions/telegram/src/channel-message-flows.qa.e2e.test.ts` |
| `qa/scenarios/plugins/plugin-lifecycle-probe.yaml` | vitest | `test/e2e/qa-lab/plugins/plugin-lifecycle-probe.e2e.test.ts` |
| `qa/scenarios/runtime/gateway-smoke.yaml` | vitest | `test/e2e/qa-lab/runtime/gateway-smoke.e2e.test.ts` |
| `qa/scenarios/runtime/openai-compatible-chat-tools.yaml` | vitest | `test/e2e/qa-lab/runtime/openai-compatible-chat-tools.e2e.test.ts` |
| `qa/scenarios/runtime/openai-web-search-minimal.yaml` | vitest | `test/e2e/qa-lab/runtime/openai-web-search-minimal.e2e.test.ts` |
| `qa/scenarios/runtime/openai-web-search-native-assertions.yaml` | vitest | `test/e2e/qa-lab/runtime/openai-web-search-minimal-assertions.e2e.test.ts` |
| `qa/scenarios/runtime/openwebui-openai-compatible.yaml` | vitest | `test/e2e/qa-lab/runtime/openwebui-probe.e2e.test.ts` |
| `qa/scenarios/runtime/package-openclaw-for-docker.yaml` | vitest | `test/e2e/qa-lab/runtime/package-openclaw-for-docker.e2e.test.ts` |
| `qa/scenarios/runtime/qa-otel-smoke.yaml` | vitest | `test/e2e/qa-lab/runtime/qa-otel-smoke.e2e.test.ts` |
| `qa/scenarios/ui/control-ui-chat-flow-playwright.yaml` | playwright | `ui/src/ui/e2e/chat-flow.e2e.test.ts` |
| `qa/scenarios/ui/ux-matrix-evidence-dashboard.yaml` | script | `scripts/qa/ux-matrix-evidence-producer.ts` |

## Existing E2E Tests To Migrate Or Link

Add small native scenario YAML wrappers for these rather than duplicating the tests. Use `scenario.execution.kind: vitest` for `*.test.ts` files and `scenario.execution.kind: script` for shell/Node proof scripts.

| Coverage ID | Surface | Category | Existing test/proof path |
| --- | --- | --- | --- |
| `anthropic.auth-profile-health` | anthropic-provider-path | Provider Auth and Recovery | `src/agents/embedded-agent-runner.run-embedded-agent.auth-profile-rotation.e2e.test.ts` |
| `automation.active-hours` | automation-cron-hooks-tasks-polling | Heartbeat | `src/infra/heartbeat-runner.active-hours-schedule.e2e.test.ts` |
| `automation.heartbeat-scheduling` | automation-cron-hooks-tasks-polling | Heartbeat | `src/infra/heartbeat-runner.active-hours-schedule.e2e.test.ts` |
| `ui.assistant-media-tickets` | browser-control-ui-and-webchat | WebChat Conversations | `src/gateway/control-ui-assistant-media.e2e.test.ts` |
| `ui.browser-talk-start-stop` | browser-control-ui-and-webchat | Browser Realtime Talk | `ui/src/ui/realtime-talk-google-live.test.ts` |
| `clawhub.marketplace-list` | clawhub-and-external-plugin-distribution | Plugin Lifecycle and Health | `scripts/e2e/lib/plugins/marketplace.sh`<br>`scripts/e2e/lib/release-plugin-marketplace/scenario.sh` |
| `clawhub.npm-pack-local-release-candidate-installs` | clawhub-and-external-plugin-distribution | Plugin Lifecycle and Health | `scripts/release-candidate-checklist.mjs`<br>`test/scripts/release-candidate-checklist.test.ts` |
| `clawhub.skill-installs` | clawhub-and-external-plugin-distribution | Plugin Lifecycle and Health | `src/cli/skills-cli.clawhub-install.e2e.test.ts` |
| `cli.channel-picker` | cli-install-update-onboard-doctor | Plugin and Channel Setup | `src/commands/onboard-channels.e2e.test.ts` |
| `docker.backed-agent-sandbox-support` | docker-podman-hosting | Agent Sandbox and Tooling | `scripts/e2e/agent-bundle-mcp-tools-docker-client.ts`<br>`scripts/e2e/agent-bundle-mcp-tools-docker.sh`<br>`scripts/e2e/agents-delete-shared-workspace-docker.sh`<br>`scripts/e2e/npm-onboard-channel-agent-docker.sh` |
| `docker.compose` | docker-podman-hosting | Container Operations | `src/docker-setup.e2e.test.ts` |
| `docker.compose-network-access` | docker-podman-hosting | Container Operations | `scripts/e2e/gateway-network-docker.sh` |
| `docker.first-run-onboarding` | docker-podman-hosting | Container Setup | `scripts/e2e/crestodian-first-run-docker-client.ts`<br>`scripts/e2e/crestodian-first-run-docker.sh` |
| `docker.local-image-setup-script` | docker-podman-hosting | Container Setup | `scripts/e2e/build-image.sh`<br>`scripts/e2e/openai-image-auth-docker-client.ts`<br>`scripts/e2e/openai-image-auth-docker.sh` |
| `docker.only-first-run-notes` | docker-podman-hosting | Container Setup | `scripts/e2e/crestodian-first-run-docker.sh`<br>`scripts/e2e/crestodian-first-run-docker-client.ts`<br>`scripts/docker-e2e-rerun.mjs`<br>`scripts/docker/install-sh-e2e/run.sh` |
| `docker.release-workflow` | docker-podman-hosting | Image Release and Validation | `scripts/e2e/release-media-memory-docker.sh`<br>`scripts/e2e/release-plugin-marketplace-docker.sh`<br>`scripts/e2e/release-typed-onboarding-docker.sh`<br>`scripts/e2e/release-upgrade-user-journey-docker.sh` |
| `local-models.openai-compatible-chat-and-tool-semantics` | local-model-providers-ollama-vllm-sglang-lm-studio | OpenAI-Compatible Runtime Compatibility | `scripts/e2e/openai-chat-tools-docker.sh` |
| `hosted-providers.image-generation-providers` | long-tail-hosted-providers | Hosted Media Providers | `test/image-generation.infer-cli.live.test.ts`<br>`test/image-generation.runtime.live.test.ts` |
| `hosted-providers.video-generation-providers` | long-tail-hosted-providers | Hosted Media Providers | `extensions/video-generation-providers.live.test.ts` |
| `media.reference-image-video-and-audio-inputs` | media-understanding-and-media-generation | Media Generation | `extensions/video-generation-providers.live.test.ts` |
| `media.video-generation-tool-invocation` | media-understanding-and-media-generation | Media Generation | `extensions/video-generation-providers.live.test.ts` |
| `windows.native-windows-chat-window` | native-windows-companion-app | Chat Sessions | `scripts/e2e/parallels/windows-smoke.ts`<br>`scripts/e2e/parallels-windows-smoke.sh`<br>`scripts/e2e/parallels/windows-git.ts` |
| `plugins.packaged-bundled-plugins` | plugin-sdk-and-bundled-plugin-architecture | Bundled plugins | `scripts/e2e/lib/bundled-plugin-install-uninstall/probe.mjs` |
| `raspberry-pi.first-run-verification` | raspberry-pi-small-linux-devices | Setup and Compatibility | `scripts/e2e/crestodian-first-run-docker-client.ts`<br>`scripts/e2e/crestodian-first-run-docker.sh` |
| `telegram.bot-token` | telegram | Channel Setup and Operations | `extensions/telegram/src/bot.media.e2e-harness.ts`<br>`extensions/telegram/src/bot.media.stickers-and-fragments.e2e.test.ts`<br>`extensions/telegram/src/bot.media.downloads-media-file-path-no-file-download.e2e.test.ts` |
| `voice.active-talk-agent-run-status` | voice-and-realtime-talk | Realtime Talk Sessions | `src/agents/embedded-agent-runner.run-embedded-agent.auth-profile-rotation.e2e.test.ts`<br>`src/agents/test-helpers/embedded-agent-runner-e2e-fixtures.ts`<br>`src/auto-reply/reply/agent-runner.runreplyagent.e2e.test.ts`<br>`src/commands/doctor.warns-per-agent-sandbox-docker-browser-prune.e2e.test.ts` |
| `voice-call.cli-rpc-agent-tool` | voice-call-channel | Channel Setup and Operations | `src/agents/agent-tools.before-tool-call.e2e.test.ts` |
| `watchos.gateway-side-ios-exec-approval` | watchos-companion-surfaces | Delivery and Recovery | `src/agents/bash-tools.exec-gateway-approval.e2e.test.ts` |
| `watchos.watch-exec-approval-prompt` | watchos-companion-surfaces | Exec Approvals | `src/agents/bash-tools.exec-gateway-approval.e2e.test.ts` |
| `wsl2.npm-pnpm-git-package-root` | windows-via-wsl2 | CLI | `scripts/e2e/parallels/npm-update-smoke.ts` |

## New Exploration Groups

These are the largest no-direct-e2e-candidate groups. Start here after linking the existing candidates.

| Group | No direct e2e candidate | Action |
| --- | --- | --- |
| gateway-runtime<br>Gateway runtime | 90 | Add focused core QA Lab scenarios before broad live lanes. |
| automation-cron-hooks-tasks-polling<br>Automation: cron, hooks, tasks, polling | 57 | Add focused core QA Lab scenarios before broad live lanes. |
| clawhub-and-external-plugin-distribution<br>ClawHub | 47 | Add owner-level release/profile exploration; no direct scenario wrapper candidate found. |
| google-chat<br>Google Chat | 45 | Add or promote channel live transport scenario pack coverage. |
| windows-via-wsl2<br>Windows via WSL2 | 45 | Add platform install/update/gateway smoke exploration in Crabbox/Testbox. |
| browser-control-ui-and-webchat<br>Gateway Web App | 44 | Add owner-level release/profile exploration; no direct scenario wrapper candidate found. |
| google-provider-path<br>Google provider path | 44 | Add provider live smoke plus contract-normalization scenario wrappers. |
| plugin-sdk-and-bundled-plugin-architecture<br>Plugins | 43 | Add focused core QA Lab scenarios before broad live lanes. |
| image-video-music-generation-tools<br>Image, video, and music generation tools | 42 | Add owner-level release/profile exploration; no direct scenario wrapper candidate found. |
| macos-gateway-host<br>macOS Gateway host | 41 | Add platform install/update/gateway smoke exploration in Crabbox/Testbox. |
| openrouter-provider-path<br>OpenRouter provider path | 41 | Add provider live smoke plus contract-normalization scenario wrappers. |
| discord<br>Discord | 39 | Add or promote channel live transport scenario pack coverage. |
| media-understanding-and-media-generation<br>Media understanding and media generation | 38 | Add owner-level release/profile exploration; no direct scenario wrapper candidate found. |
| web-search-tools<br>Web search tools | 37 | Add focused core QA Lab scenarios before broad live lanes. |
| local-model-providers-ollama-vllm-sglang-lm-studio<br>Local model providers: Ollama, vLLM, SGLang, LM Studio | 36 | Add provider live smoke plus contract-normalization scenario wrappers. |
| cli-install-update-onboard-doctor<br>CLI | 35 | Add focused core QA Lab scenarios before broad live lanes. |
| macos-companion-app<br>macOS companion app | 35 | Add platform install/update/gateway smoke exploration in Crabbox/Testbox. |
| raspberry-pi-small-linux-devices<br>Raspberry Pi and small Linux devices | 35 | Add platform install/update/gateway smoke exploration in Crabbox/Testbox. |

## Full No-Direct-E2E-Candidate Coverage ID Appendix

### gateway-runtime (90)

- Approvals and Remote Execution (6): `gateway.approval-mutation-safety`, `gateway.approved-node-execution`, `gateway.delivery-fallback-behavior`, `gateway.exec-approvals`, `gateway.node-exec-approvals`, `gateway.plugin-approvals`
- HTTP APIs (3): `gateway.admin-api-access`, `gateway.hook-ingress`, `gateway.tool-invocation-api`
- Hosted Web Surface (3): `gateway.canvas-and-a2ui-routes`, `gateway.plugin-web-routes`, `gateway.webchat-hosting`
- Gateway RPC APIs and Events (18): `gateway.accepted-then-final-results`, `gateway.agent-and-artifact-apis`, `gateway.channel-apis`, `gateway.chat-apis`, `gateway.config-and-secrets-apis`, `gateway.event-discovery`, `gateway.event-ordering`, `gateway.idempotent-side-effects`, `gateway.identity-and-presence-apis`, `gateway.method-discovery`, `gateway.model-apis`, `gateway.request-and-event-envelopes`, `gateway.state-refresh-after-gaps`, `gateway.task-and-automation-apis`, `gateway.tool-and-skill-apis`, `gateway.update-and-setup-apis`, `gateway.usage-and-memory-apis`, `gateway.web-login-and-wake-apis`
- Device Auth and Pairing (10): `gateway.auth-mismatch-recovery`, `gateway.client-pairing`, `gateway.device-auth-migration`, `gateway.device-challenge-signing`, `gateway.device-tokens`, `gateway.private-ingress-mode`, `gateway.setup-code-bootstrap`, `gateway.shared-secret-login`, `security.node-pairing`, `security.trusted-proxy-auth`
- Network Access and Discovery (6): `gateway.endpoint-discovery`, `gateway.loopback-and-lan-access`, `gateway.saved-endpoints`, `gateway.ssh-tunnels`, `gateway.tailnet-access`, `gateway.tls-pinning`
- Nodes and Remote Capabilities (8): `gateway.node-actions`, `gateway.node-capabilities`, `gateway.node-events`, `gateway.node-inventory`, `gateway.node-presence`, `gateway.pending-work-delivery`, `gateway.remote-device-capabilities`, `gateway.remote-host-commands`
- Health, Diagnostics, and Repair (7): `gateway.channel-readiness`, `gateway.diagnostics-exports`, `gateway.log-tailing`, `gateway.payload-diagnostics`, `gateway.stability-diagnostics`, `telemetry.doctor-checks`, `telemetry.health-snapshots`
- Protocol Compatibility (7): `gateway.backward-compatible-evolution`, `gateway.client-transport-defaults`, `gateway.json-schema-export`, `gateway.published-protocol-schema`, `gateway.runtime-request-validation`, `gateway.swift-client-models`, `gateway.version-negotiation`
- Roles and Permissions (5): `gateway.approval-gated-actions`, `gateway.event-scoping`, `gateway.operator-permissions`, `gateway.role-negotiation`, `gateway.untrusted-node-declarations`
- Gateway Lifecycle (5): `gateway.bind-and-port-settings`, `gateway.foreground-startup`, `gateway.multi-gateway-isolation`, `gateway.service-installation`, `gateway.service-status`
- Security Controls (6): `gateway.fail-closed-protocol-handling`, `gateway.gateway-and-node-trust-boundaries`, `gateway.non-loopback-auth`, `gateway.remote-execution-safeguards`, `gateway.trusted-cidr-auto-approval`, `gateway.trusted-proxy-exceptions`
- WebSocket Connection (6): `gateway.connect-challenge`, `gateway.connect-request`, `gateway.plugin-surface-urls`, `gateway.protocol-version-negotiation`, `gateway.session-limits`, `gateway.startup-retry`

### cli-install-update-onboard-doctor (35)

- CLI Setup (4): `cli.installer-scripts`, `cli.local-prefix-install`, `cli.source-checkout-install`, `cli.supported-node-runtime`
- Onboarding and Auth Setup (5): `cli.auth-choices`, `cli.gateway-auth-storage`, `cli.guided-onboarding`, `cli.remote-onboarding`, `cli.targeted-reconfiguration`
- Plugin and Channel Setup (4): `cli.channel-account-setup`, `cli.plugin-install-sources`, `cli.post-setup-probes`, `cli.remote-gateway-caveat`
- Gateway Service Management (4): `cli.drift-and-reinstall-recovery`, `cli.foreground-gateway-runs`, `cli.service-health-checks`, `cli.service-install-and-control`
- CLI Observability (4): `cli.diagnostics-export`, `cli.remote-log-tailing`, `cli.support-safe-redaction`, `telemetry.health-snapshots`
- Doctor (9): `cli.auth-and-secretref-checks`, `cli.config-migration`, `cli.extra-gateway-discovery`, `cli.interactive-repair`, `cli.lint-and-json-findings`, `cli.port-and-startup-diagnosis`, `cli.restart-guidance`, `cli.runtime-path-checks`, `cli.supervisor-drift-repair`
- Updates and Upgrades (5): `cli.install-kind-switching`, `cli.managed-gateway-restart`, `cli.plugin-convergence`, `cli.update-channels`, `cli.update-status-and-rpc`

### plugin-sdk-and-bundled-plugin-architecture (43)

- Authoring and Packaging plugins (8): `plugins.entrypoint-discovery`, `plugins.focused-sdk-imports`, `plugins.manifest`, `plugins.migration-shims`, `plugins.package-metadata`, `plugins.root-sdk-entrypoint`, `plugins.runtime-compatibility`, `plugins.validation-feedback`
- Bundled plugins (4): `plugins.bundled-channel-ids`, `plugins.bundled-plugin-listing`, `plugins.bundled-source-overlays`, `plugins.generated-plugin-inventory`
- Canvas plugin (6): `plugins.a2ui-transport-and-snapshots`, `plugins.agent-canvas-tool`, `plugins.canvas-documents`, `plugins.control-ui-embeds`, `plugins.hosted-canvas-and-a2ui-surfaces`, `plugins.node-canvas-commands`
- Installing and running plugins (1): `plugins.dependency-repair`
- Channel plugins (5): `plugins.destination-resolution`, `plugins.inbound-event-handling`, `plugins.ingress-authorization`, `plugins.native-approval-prompts`, `plugins.outbound-delivery`
- Provider and tool plugins (3): `plugins.model-catalogs`, `plugins.provider-auth`, `plugins.provider-plugins`
- Plugin approvals (6): `plugins.approval-replay-protection`, `plugins.approval-requests`, `plugins.exec-and-plugin-separation`, `plugins.native-approval-delivery`, `plugins.same-chat-fallbacks`, `plugins.security-helpers`
- Publishing plugins (6): `plugins.clawhub-publishing`, `plugins.compatibility-signaling`, `plugins.install-sources`, `plugins.npm-publishing`, `plugins.third-party-publication-rules`, `plugins.update-and-rollback-expectations`
- Testing plugins (4): `plugins.docker-lifecycle-suites`, `plugins.local-test-environment`, `plugins.test-fixtures`, `plugins.unit-and-integration-scaffolds`

### agent-runtime-and-provider-execution (18)

- External Runtimes and Subagents (2): `runtime.cli-runtime-aliases`, `runtime.recovery`
- Hosted Provider Execution (1): `runtime.hosted-streaming-and-replies`
- Local and Self-hosted Providers (5): `runtime.local-failure-handling`, `runtime.local-provider-profiles`, `runtime.local-smoke-checks`, `runtime.timeouts-and-context-windows`, `runtime.tool-capability-flags`
- Model and Runtime Selection (1): `runtime.invalid-route-recovery`
- Provider Auth (6): `runtime.auth-failover`, `runtime.missing-key-and-oauth-guidance`, `runtime.rate-limit-and-capacity-recovery`, `runtime.restart-and-stale-route-recovery`, `runtime.structured-provider-diagnostics`, `runtime.subagent-credential-propagation`
- Tool Execution Controls (3): `runtime.delegated-tool-access`, `runtime.elevated-execution`, `runtime.sandboxed-exec-behavior`

### session-memory-and-context-engine (9)

- CLI Session and Transcript Management (2): `session.cli-session`, `session.transcript-management`
- Token Management (1): `session.pruning`
- Diagnostics, Maintenance, and Recovery (2): `session.diagnostic-reports`, `session.maintenance-warnings`
- Memory (1): `session.memory-backend-storage`
- Session Routing (1): `memory.session-routing`
- Transcript Persistence (2): `session.durability`, `session.transcript-persistence`

### channel-framework (28)

- Channel Actions Commands and Approvals (3): `channels.message-tool-api-discovery`, `channels.native-approval-prompts`, `channels.native-commands`
- Channel Setup (4): `channels.install-on-demand`, `channels.setup-wizard-metadata`, `channels.status-taxonomy-in-channels-list`, `channels.supported-channel-catalog`
- Group Thread and Ambient Room Behavior (2): `channels.bot-loop-protection`, `channels.broadcast-groups`
- Inbound Access and Identity Gates (5): `channels.access-group-expansion`, `channels.group-channel-allowlists`, `channels.mention-gating`, `channels.sanitized-inbound-identity-route-projections`, `security.dm-pairing`
- Media Attachments and Rich Channel Data (4): `channels.inbound-media-normalization`, `channels.media-roots`, `channels.outbound-direct-text-media-sends`, `channels.provider-specific-channeldata`
- Conversation Routing and Delivery (7): `channels.account-startup`, `channels.agent-selection-precedence`, `channels.auto-restart`, `channels.config-secrets-reload-interactions`, `channels.runtime-conversation-routing`, `channels.whole-channel-lifecycle-controls`, `memory.session-key-construction`
- Status Health and Operator Controls (3): `channels.operator-cli-controls`, `channels.status`, `channels.status-read-model`

### security-auth-pairing-and-secrets (30)

- Approval Policy and Tool Safeguards (1): `security.dangerous-tool-safeguards`
- Gateway Auth and Remote Access (9): `raspberry-pi.tailscale-serve-funnel`, `security.bind-and-origin-restrictions`, `security.browser-control-ui`, `security.gateway-auth-mode`, `security.operator-facing-docs`, `security.remote-client-trust`, `security.shared-gateway-token-password-auth`, `security.trusted-proxy-identity`, `security.websocket-handshake-auth`
- Channel Access Control (3): `security.allowlists`, `security.channel-identity`, `security.sender-pairing`
- Device and Node Pairing (11): `security.auth-migration`, `security.capability-trust`, `security.device-identity-creation`, `security.device-pairing-approvals-for-operator`, `security.device-token-issuance`, `security.local-control-ui`, `security.node-pairing`, `security.operator-facing-docs`, `security.operator-scopes-that-gate-pairing`, `security.remote-exec-approvals`, `security.setup-codes`
- Plugin Trust (2): `security.boundaries`, `security.plugin-installation-trust`
- Credential and Secret Hygiene (4): `security.api-key-health`, `security.configuration-hygiene`, `security.provider-auth-profiles`, `security.secrets-storage`

### telemetry-diagnostics-and-observability (34)

- Health and Repair (10): `telemetry.background-health-monitor-loop`, `telemetry.core-doctor-checks`, `telemetry.gateway-rpc-health`, `telemetry.openclaw-health`, `telemetry.per-account-enable-disable-settings`, `telemetry.plugin-sdk-doctor-health-contracts`, `telemetry.restart-logging`, `telemetry.startup-grace`, `telemetry.structured-health-checks`, `windows.openclaw-status`
- Logging (5): `telemetry.gateway-rpc-logs-tail`, `telemetry.openclaw-logs`, `telemetry.redaction-patterns-and-sinks`, `telemetry.rolling-gateway-jsonl-file-logs`, `telemetry.trace-correlation-fields`
- Diagnostic Collection (7): `telemetry.bounded-in-process-stability-recorder`, `telemetry.chat-diagnostics`, `telemetry.critical-memory-pressure-snapshot-option`, `telemetry.memory-pressure-events`, `telemetry.openclaw-gateway-diagnostics-export`, `telemetry.openclaw-gateway-stability`, `telemetry.openclaw-gateway-stability-bundle`
- Telemetry Export (8): `automation.async-dispatch`, `telemetry.diagnostic-event-types`, `telemetry.diagnostics-otel-plugin-install`, `telemetry.diagnostics-prometheus-plugin-install`, `telemetry.model-call-diagnostic-events`, `telemetry.trusted-diagnostic-event-subscription`, `telemetry.trusted-trace-context`, `telemetry.w3c-trace-context-creation`
- Session Diagnostics (4): `telemetry.diagnostic-session-activity-snapshots`, `telemetry.export-of-session-signals-to-stability`, `telemetry.model-usage`, `telemetry.session-state`

### automation-cron-hooks-tasks-polling (57)

- Cron Jobs (9): `automation.create-edit-remove-jobs`, `automation.delivery-previews`, `automation.failure-destinations`, `automation.model-provider-preflight`, `automation.schedule-types`, `automation.skipped-run-alerts`, `automation.timeout-and-denial-diagnostics`, `automation.timezone-and-stagger`, `automation.webhook-delivery`
- Event Ingress (15): `automation.async-dispatch`, `automation.gmail-event-routing`, `automation.gmail-setup-wizard`, `automation.hook-auth-policy`, `automation.imessage-watch-fallback`, `automation.mapped-hooks`, `automation.polling-stall-diagnostics`, `automation.post-hooks-agent`, `automation.post-hooks-wake`, `automation.push-token-validation`, `automation.tailscale-public-routing`, `automation.telegram-long-polling`, `automation.telegram-webhook-mode`, `automation.watcher-start-serve`, `automation.zalo-polling-webhook-mode`
- Automation Hooks (11): `automation.api-on-registration`, `automation.cron-changed`, `automation.hook-cli-management`, `automation.hook-discovery`, `automation.hook-md-authoring`, `automation.hook-packs`, `automation.lifecycle-event-dispatch`, `automation.message-hooks`, `automation.plugin-approval-requests`, `automation.session-lifecycle-hooks`, `automation.tool-call-policy-hooks`
- Background Tasks and Flows (10): `automation.chat-task-board`, `automation.flow-audit-and-maintenance`, `automation.managed-flows`, `automation.mirrored-flows`, `automation.openclaw-tasks-flow`, `automation.plugin-managedflows`, `automation.task-audit-and-maintenance`, `automation.task-list-show-cancel`, `automation.task-notifications`, `automation.task-pressure-status`
- Heartbeat (2): `automation.due-only-heartbeat-tasks`, `automation.wake-and-cooldown-handling`
- Polling Controls (10): `automation.background-process-status`, `automation.channel-capability-gates`, `automation.no-progress-loop-detection`, `automation.openclaw-message-poll`, `automation.poll-flags`, `automation.process-input-controls`, `automation.process-log`, `automation.process-poll`, `automation.teams-polls`, `automation.telegram-polls`

### media-understanding-and-media-generation (38)

- Media Intake and Access (8): `media.inbound-media-store`, `media.local-and-remote-media-references`, `media.local-root-policy`, `media.mime-and-type-detection`, `media.pdf-document-extraction-dispatch`, `media.qr-and-media-helper-classification`, `media.safe-remote-fetch`, `media.size-caps-and-bounded-reads`
- Channel Media Handling (5): `media.duplicate-delivery-suppression`, `media.inbound-attachment-staging`, `media.message-tool-attachment-delivery`, `media.reply-media-templating`, `media.sandbox-media-rewrites`
- Media Configuration (1): `media.capability-configuration`
- Text-to-Speech Delivery (2): `media.outbound-voice-audio-delivery`, `media.tts`
- Media Understanding (11): `media.active-vision-model-bypass`, `media.audio-attachment-selection`, `media.audio-proxy-and-limit-handling`, `media.batch-stt-provider-and-cli-fallback`, `media.direct-video-analysis`, `media.image-and-pdf-input-routing`, `media.text-only-model-media-offload`, `media.transcript-insertion-and-echo`, `media.video-understanding`, `media.vision-provider-fallback`, `media.voice-note-mention-preflight`
- Media Generation (11): `media.generated-image-task-lifecycle`, `media.generated-video-persistence-and-delivery`, `media.lyrics-instrumental-duration-and-format-controls`, `media.mode-and-provider-capability-selection`, `media.music-generation-provider-controls`, `media.music-generation-tool-invocation`, `media.music-task-lifecycle-and-duplicate-status`, `media.provider-option-validation`, `media.reference-image-editing`, `media.reference-inputs-where-supported`, `media.video-task-lifecycle-and-status`

### voice-and-realtime-talk (35)

- Talk Providers (7): `models.diagnostics`, `voice.google-gemini-live-backend-bridge`, `voice.openai-realtime-voice-backend-bridge`, `voice.realtime-voice-provider-sdk-contracts`, `voice.shared-native-config-parsing`, `voice.talk-catalog`, `voice.talk-provider-config`
- Realtime Talk Sessions (10): `voice.agent-consult-handoff`, `voice.audio-frame-limits`, `voice.browser-relay-mode`, `voice.browser-talk-start-stop-ui`, `voice.browser-tool-call-forwarding`, `voice.browser-webrtc-sessions`, `voice.forced-consult-scheduling`, `voice.gateway-relay-sessions`, `voice.realtime-session-controls`, `voice.talkback-runtime-behavior`
- Speech and Transcription (5): `models.realtime-transcription-providers`, `voice.directives`, `voice.native-directive-parsing`, `voice.talk-speech-playback`, `voice.transcription-relay-sessions`
- Native App Talk (4): `voice.android-talk-mode`, `voice.ios-talk-mode`, `voice.macos-native-talk-mode`, `voice.shared-talk-config`
- Voice Wake and Routing (4): `voice.macos-voice-wake-runtime`, `voice.mobile-wake-preferences`, `voice.wake-routing`, `voice.wake-word-settings`
- Talk Observability (5): `voice.live-smoke-output`, `voice.operator-visibility-into-setup`, `voice.prometheus-diagnostic-counters`, `voice.session-log-health`, `voice.talk-event-logging`

### browser-control-ui-and-webchat (44)

- Browser Realtime Talk (4): `ui.gateway-relay-audio`, `ui.provider-session-selection`, `ui.steer-and-cancel`, `ui.tool-call-consults`
- Browser Access and Trust (5): `security.trusted-proxy-auth`, `ui.allowed-origins-gatewayurl`, `ui.device-pairing`, `ui.tailscale-serve-auth`, `ui.token-password-auth`
- Configuration (5): `ui.apply-and-restart`, `ui.base-hash-guarded-writes`, `ui.config-snapshots`, `ui.raw-json-editing`, `ui.schema-form-editing`
- Browser UI (8): `ui.base-path-routing`, `ui.dev-gatewayurl-target`, `ui.pwa-install-metadata`, `ui.service-worker-updates`, `ui.static-asset-recovery`, `ui.subscribe-unsubscribe`, `ui.test-notifications`, `ui.vapid-keys`
- WebChat Conversations (13): `ui.abort-partial-retention`, `ui.attachments`, `ui.authenticated-avatars`, `ui.chat-history-projection`, `ui.csp-image-policy`, `ui.external-embed-gating`, `ui.hosted-embeds`, `ui.injected-assistant-notes`, `ui.markdown-tool-media-rendering`, `ui.model-thinking-controls`, `ui.reconnect-continuity`, `ui.send-and-abort`, `ui.session-and-agent-picker`
- Operator Console (9): `ui.activity-summaries`, `ui.channels-login`, `ui.cron`, `ui.exec-approvals-agents`, `ui.health-status-models`, `ui.live-log-tail`, `ui.rpc-timing-telemetry`, `ui.session-manager-and-history`, `ui.skills-nodes`

### tui-and-terminal-ux (33)

- Runtime Modes (14): `tui.config-repair-loop`, `tui.embedded-local-chat`, `tui.gateway-authentication`, `tui.gateway-command-rpcs`, `tui.gateway-connection`, `tui.gateway-free-recovery`, `tui.gateway-tui-launch`, `tui.history-load-on-attach`, `tui.initial-message-launch`, `tui.launch-option-validation`, `tui.local-auth-flow`, `tui.local-chat-launch`, `tui.reconnect-visibility`, `tui.terminal-alias-launch`
- Input and Commands (8): `slack.slash-commands`, `tui.ime-and-altgr-handling`, `tui.input-history`, `tui.keyboard-shortcuts`, `tui.message-composition`, `tui.paste-and-busy-submit-handling`, `tui.pickers`, `tui.settings`
- Session Management (3): `tui.history`, `tui.resume`, `tui.session-lifecycle`
- Local Shell Execution (4): `tui.approval-prompt`, `tui.bang-command-routing`, `tui.command-output-display`, `tui.execution-environment-marker`
- Rendering and Output Safety (4): `tui.output-safety`, `tui.streaming-message-rendering`, `tui.terminal-rendering-primitives`, `tui.tool-cards`

### clawhub-and-external-plugin-distribution (47)

- Publishing (7): `clawhub.external-code-plugin-package-contract-required`, `clawhub.npm-trusted-publishing-provenance`, `clawhub.openclaw-owned-package-release-validation-for-clawhub`, `clawhub.package-publishing-owner`, `clawhub.skill-package-metadata`, `clawhub.skill-publishing-flow`, `clawhub.version-bump-gates`
- Catalog Discovery (5): `clawhub.catalog-lookup-failure`, `clawhub.distinction-between-plugin-search`, `clawhub.openclaw-plugins-search-as-the-clawhub`, `clawhub.search-result-metadata`, `clawhub.skill-catalog-search`
- Compatibility and Trust (12): `clawhub.archive`, `clawhub.built-in-dangerous-code-scanner`, `clawhub.compatibility-docs`, `clawhub.npm-compatibility-fallback-to-the-newest`, `clawhub.npm-integrity-drift`, `clawhub.official-external-plugin-catalog-behavior`, `clawhub.openclaw-compat-pluginapi`, `clawhub.operator-trust-model-for-installing`, `clawhub.package-compatibility-validation`, `clawhub.publishing-review-hidden-release-behavior-as-upstream`, `clawhub.skill-archive-safety`, `clawhub.skill-audit-signals`
- Plugin Lifecycle and Health (23): `clawhub.bare-package-behavior-during-the-launch`, `clawhub.codex`, `clawhub.dependency-ownership-between-plugin-packages`, `clawhub.downgrade`, `clawhub.explicit-pinned-versions`, `clawhub.gateway-restart-reload-requirements-after`, `clawhub.legacy-dependency-root-cleanup`, `clawhub.local`, `clawhub.local-plugin-index`, `clawhub.managed-install-records-that-preserve-source`, `clawhub.peer-dependency-relinking`, `clawhub.per-plugin-managed-npm-project`, `clawhub.plugins-list`, `clawhub.reinstall-vs-update-semantics`, `clawhub.remote-marketplace-path-safety`, `clawhub.runtime-verification-after-gateway`, `clawhub.skill-dependency-installers`, `clawhub.skill-upload-install-path`, `clawhub.source-prefixes`, `clawhub.supported-mapped-features`, `clawhub.troubleshooting-stale-config`, `clawhub.uninstall-config-index-policy-file-cleanup`, `clawhub.update-by-plugin-id`

### openclaw-app-sdk (29)

- Client API (4): `app-sdk.app-plugin-boundary`, `app-sdk.namespace-layout`, `app-sdk.package-split`, `app-sdk.sdk-entrypoints`
- Gateway Access (5): `app-sdk.auto-gateway`, `app-sdk.custom-transport`, `app-sdk.gateway-connect`, `app-sdk.scopes-and-redaction`, `app-sdk.url-and-token-config`
- Agent Conversations (6): `app-sdk.agent-handles`, `app-sdk.agent-runs`, `app-sdk.run-results`, `app-sdk.session-controls`, `app-sdk.session-creation`, `app-sdk.session-send`
- Events and Approvals (5): `app-sdk.approval-callbacks`, `app-sdk.event-envelope`, `app-sdk.event-stream`, `app-sdk.questions`, `app-sdk.replay-cursors`
- Resource Helpers (4): `app-sdk.environments`, `app-sdk.models`, `app-sdk.tasks`, `app-sdk.toolspace`
- Compatibility (5): `app-sdk.ergonomic-wrappers`, `app-sdk.generated-client`, `app-sdk.public-package-contract`, `app-sdk.schema-alignment`, `app-sdk.unsupported-calls`

### macos-gateway-host (41)

- CLI Setup (4): `macos.app-triggered-cli-install`, `macos.hosted-installer`, `macos.node-24-recommendation`, `macos.shell-path-and-version-manager-drift`
- Local Gateway Integration (9): `macos.app-local-remote-connection-mode`, `macos.app-managed-gateway-launchagent-install-restart-uninstall`, `macos.attach-to-existing-local-gateway-compatibility`, `macos.bonjour-discovery`, `macos.cli-install-detection`, `macos.gateway-endpoint`, `macos.gateway-mode-local-configuration`, `macos.local-app-endpoint-resolution`, `macos.loopback-bind`
- Remote Gateway Mode (5): `macos.app-remote-over-ssh`, `macos.local-node-host-startup`, `macos.remote-endpoint-token-password-tls-fingerprint`, `macos.ssh-tunnel-setup`, `macos.tailscale-magicdns`
- Gateway Service Lifecycle (10): `macos.app-managed-launchagent-handoff`, `macos.gateway-token-env-handling`, `macos.launchagent-labels`, `macos.launchctl-bootstrap`, `macos.managed-service-refresh`, `macos.openclaw-uninstall`, `macos.openclaw-update-package-git-handoff`, `macos.per-user-gateway-launchagent-install`, `macos.stale-updater-launchd-job-detection`, `macos.stranded-service-recovery`
- Diagnostics and Observability (4): `macos.gateway-silently-stops-responding`, `macos.launchagent-log-paths`, `macos.openclaw-gateway-status-deep`, `macos.stale-updater-jobs`
- Permissions and Native Capabilities (4): `macos.native-node-capability-exposure`, `macos.permission-driven-support`, `macos.system-run-policy`, `macos.tcc-permission-prompts-status`
- Profiles and Isolation (5): `macos.derived-ports`, `macos.extra-gateway-process-detection`, `macos.profile-specific-launchagent-labels`, `macos.profile-specific-state-config-workspace-roots`, `macos.rescue-bot-setup`

### macos-companion-app (35)

- Canvas (4): `macos.a2ui-host-auto-navigation`, `macos.canvas-enable-disable-setting`, `macos.canvas-panel-open-hide-navigate-eval-snapshot`, `macos.local-custom-url-scheme`
- Local Setup (7): `macos.cli-discovery`, `macos.existing-listener-detection`, `macos.launchagent-install-update-restart-uninstall`, `macos.local-mode-gateway-attach-start-stop`, `macos.local-workspace-selection`, `macos.native-first-run-onboarding-flow`, `macos.onboarding-webchat-session-separation`
- Status and Settings (5): `macos.activity-state-ingestion`, `macos.channels-settings`, `macos.health-polling`, `macos.menu-bar-status`, `macos.settings-navigation`
- Native Capabilities (5): `macos.exec-approval-policy`, `macos.mac-node-session-connection`, `macos.permission-requests`, `macos.system-run`, `macos.tcc-persistence`
- Remote Connections (3): `gateway.discovery`, `macos.remote-connection-mode-selection`, `macos.ssh-tunnel`
- Voice and Talk (3): `macos.push-to-talk`, `macos.talk-provider-playback-plan`, `macos.voice-wake-runtime`
- WebChat (3): `gateway.chat-transport`, `macos.local-and-remote-data-plane-reuse`, `macos.native-swiftui-webchat-window`
- Remote WebChat (5): `macos.direct-ws-wss-remote-mode`, `macos.remote-troubleshooting`, `macos.ssh-tunnel-data-plane`, `macos.webchat-transport`, `memory.session-continuity`

### linux-gateway-host (23)

- Host Setup and Updates (4): `linux.cli-install`, `linux.node-runtime-prerequisites`, `linux.package-manager-policy`, `linux.update-path`
- Gateway Runtime and Service Control (6): `linux.foreground-gateway-runtime`, `linux.process-control`, `linux.systemd-user-service-lifecycle-operation`, `linux.systemd-user-service-lifecycle-recovery`, `linux.systemd-user-service-lifecycle-setup`, `linux.systemd-user-service-lifecycle-status`
- Remote Access and Security (6): `linux.gateway-authentication-modes`, `linux.gateway-exposure-safeguards`, `linux.remote-network-exposure`, `linux.secret-handling`, `linux.tailscale`, `linux.tls`
- Diagnostics and Repair (4): `linux.gateway-diagnostic-reports`, `linux.gateway-log-tailing`, `linux.operator-repair-guidance`, `telemetry.doctor-checks`
- Deployment Targets (3): `linux.cloud-deployment-guidance`, `linux.container`, `linux.vps`

### linux-companion-app (26)

- App Distribution (3): `linux.distro-package-targets`, `linux.native-app-package`, `linux.official-release-metadata`
- Gateway Connectivity (4): `linux.gateway-pairing-and-auth`, `linux.local-and-remote-resource-boundaries`, `linux.local-gateway-attach-and-status`, `linux.remote-mode`
- Chat and Sessions (3): `gateway.chat-transport`, `linux.native-linux-chat-window`, `linux.transcript`
- Desktop Capabilities (9): `linux.desktop-permissions`, `linux.desktop-tools`, `linux.microphone-capture`, `linux.native-media-permissions`, `linux.native-node-identity`, `linux.native-talk`, `linux.sandbox-package-posture`, `linux.secret-storage`, `tools.host-command-execution`
- Status and Diagnostics (7): `linux.desktop-environment-integration`, `linux.doctor-repair-affordances`, `linux.gateway-health-status-display`, `linux.log-transcript-opening`, `linux.native-linux-app-readiness`, `linux.runtime-status-row`, `linux.tray-status-item`

### windows-via-wsl2 (45)

- WSL Setup (6): `wsl2.linux-install-flow-inside-wsl2`, `wsl2.network-family-requirements`, `wsl2.node-runtime`, `wsl2.runtime-boundary`, `wsl2.source-install-and-build-inside-wsl2`, `wsl2.ubuntu-installation`
- CLI (7): `windows.openclaw-onboard`, `wsl2.cli-entrypoints`, `wsl2.managed-systemd-gateway-restart`, `wsl2.openclaw-doctor-status-and-logs`, `wsl2.openclaw-update`, `wsl2.package-manager-caveats`, `wsl2.service-metadata-refresh`
- Gateway Service Lifecycle (10): `wsl2.clear-expectations-around-pc-power`, `wsl2.doctor-service-repair`, `wsl2.gateway-service-install`, `wsl2.onboarded-systemd-install`, `wsl2.systemd-availability-after-windows-boot`, `wsl2.systemd-user-unit-rendering`, `wsl2.verification-before-windows-sign-in`, `wsl2.windows-startup-task-for-wsl`, `wsl2.wsl-aware-systemd-unavailable-hints`, `wsl2.wsl-user-service-linger`
- Gateway Access and Exposure (11): `security.provider-credentials`, `wsl2.gateway-auth-secretrefs`, `wsl2.gateway-token-password-auth`, `wsl2.ipv4-networking`, `wsl2.loopback-and-lan-exposure`, `wsl2.reachable-gateway-urls`, `wsl2.remote-url-credential-precedence`, `wsl2.tailscale-remote-access`, `wsl2.windows-firewall-rules`, `wsl2.windows-portproxy-setup`, `wsl2.wsl-virtual-network`
- Diagnostics and Repair (5): `telemetry.openclaw-logs`, `windows.openclaw-status`, `wsl2.operator-repair-guidance-after-wsl2-service`, `wsl2.secretref`, `wsl2.wsl-systemd-unavailable-hints`
- Browser and Control UI (6): `wsl2.browser-profile-cdpurl`, `wsl2.gateway-with-windows-browser`, `wsl2.host-local-chrome-mcp`, `wsl2.layered-diagnostics`, `wsl2.raw-remote-cdp-to-windows-chrome`, `wsl2.windows-control-ui-url`

### native-windows-cli-and-gateway (28)

- CLI (9): `windows.command-shims`, `windows.daemon-install-flags`, `windows.local-gateway-config`, `windows.native-vs-wsl-setup-boundary`, `windows.node-and-package-manager-bootstrap`, `windows.npm-global-install`, `windows.openclaw-onboard`, `windows.packaged-cli-launcher`, `windows.powershell-installer`
- Gateway Management (11): `windows.foreground-runtime-health-readiness`, `windows.gateway-launcher-files`, `windows.openclaw-gateway`, `windows.openclaw-gateway-install`, `windows.openclaw-status`, `windows.post-install-diagnostics`, `windows.scheduled-task-runtime-status`, `windows.service-inspection`, `windows.specific-restart-signal`, `windows.startup-folder-fallback`, `windows.unmanaged-foreground-mode`
- Networking (4): `windows.gateway-status-and-probe-output`, `windows.loopback-lan-and-wsl-boundary`, `windows.native-windows-host-networking`, `windows.netsh-interface-portproxy`
- Updates (4): `windows.detached-update-handoff`, `windows.managed-gateway-stop-restart`, `windows.openclaw-update-on-native-windows-package`, `windows.package-locks`

### native-windows-companion-app (23)

- Installation and Updates (4): `windows.app-release-channel`, `windows.architecture-handling-for-x64`, `windows.msi-msix-app-installer-winget-style-packaging`, `windows.official-app-download`
- Gateway Connection (3): `windows.app-managed-local-gateway-attach-start`, `windows.device-node-pairing`, `windows.remote-gateway-connection-modes`
- Chat Sessions (1): `gateway.chat-transport`
- Status and Repair (5): `windows.app-health-states`, `windows.app-specific-notification-permission`, `windows.app-specific-repair`, `windows.status-indicators`, `windows.system-tray-app`
- Desktop Tools and Permissions (10): `tools.host-command-execution`, `windows.acl`, `windows.app-approval-prompts`, `windows.app-secrets`, `windows.canvas-host-behavior`, `windows.command-approval`, `windows.desktop-command-policy`, `windows.node-identity`, `windows.screen-and-media-capture`, `windows.shell-integrations`

### android-app (10)

- Media Capture (1): `android.camera-and-media-capture`
- Mobile Chat (1): `android.chat-tab`
- Connection Setup (1): `gateway.discovery`
- Distribution (3): `android.manual-install-path`, `android.public-google-play-install-path`, `android.release-smoke-and-startup-performance`
- Settings (1): `android.settings-sheet`
- Voice (1): `android.voice-tab`
- Device Runtime (2): `android.background-reconnect-and-presence`, `android.device-command-availability`

### ios-app (15)

- Media and Sharing (1): `ios.camera-list-snap-clip`
- Canvas and Screen (1): `ios.canvas-present-hide-navigate-eval-snapshot`
- Chat and Sessions (1): `ios.chat-sessions-and-operator-controls`
- Gateway Setup and Diagnostics (7): `ios.bonjour-local`, `ios.gateway-connect-configuration-persistence`, `ios.manual-host-port`, `ios.pairing-approval`, `ios.pairing-auth-diagnostics-for-users`, `ios.settings-tab`, `ios.tls-fingerprint-trust-prompt`
- Distribution (1): `ios.internal-preview-status`
- Device Commands (2): `ios.device-command-handling`, `ios.location-modes`
- Notifications and Background (1): `ios.apns-registration-and-relay-delivery`
- Voice (1): `ios.voice-wake`

### watchos-companion-surfaces (24)

- Delivery and Recovery (6): `watchos.apns-relay-direct-registration-as-it-affects`, `watchos.delivery-fallback-among-reachable-messages`, `watchos.iphone-side-watchconnectivity-transport`, `watchos.pending-approval-recovery-ids`, `watchos.silent-push`, `watchos.watch-side-receiver-activation`
- Exec Approvals (2): `watchos.iphone-side-prompt-caching`, `watchos.watch-approval-list-detail-ui`
- Distribution and Support (6): `watchos.changelog`, `watchos.historical-bug-regression-themes-relevant-to-scoring`, `watchos.public-support-status`, `watchos.release-metadata`, `watchos.signing-profile-variables`, `watchos.watch-app`
- Notifications and Replies (7): `watchos.iphone-side-dedupe`, `watchos.mirrored-ios-notification-action`, `watchos.mirrored-ios-notification-fallback-when-watch`, `watchos.payload-normalization`, `watchos.watch-action-buttons-from-generic-prompt`, `watchos.watch-status`, `watchos.watch-to-iphone-reply-payloads`
- Watch App UI (3): `watchos.generic-inbox`, `watchos.persistent-watch-inbox-state`, `watchos.watch-app-entry-point`

### raspberry-pi-small-linux-devices (35)

- Setup and Compatibility (11): `raspberry-pi.64-bit-arm-boundary`, `raspberry-pi.fallback-build-guidance`, `raspberry-pi.hardware-and-64-bit-os-requirements`, `raspberry-pi.installer-architecture-detection`, `raspberry-pi.node-runtime-setup`, `raspberry-pi.npm-pnpm-bun-install-modes`, `raspberry-pi.openclaw-install-and-onboarding`, `raspberry-pi.optional-arm-binary-checks`, `raspberry-pi.slow-device-caveats`, `raspberry-pi.supported-pi-model-selection`, `raspberry-pi.unsupported-device-guidance`
- Remote Access and Auth (9): `raspberry-pi.authenticated-control-ui-access`, `raspberry-pi.device-pairing-approvals`, `raspberry-pi.gateway-shared-secret-auth`, `raspberry-pi.headless-api-key-auth`, `raspberry-pi.loopback-non-loopback-exposure-controls`, `raspberry-pi.secretref-handling`, `raspberry-pi.ssh-tunnel-dashboard-access`, `raspberry-pi.tailscale-serve-funnel`, `raspberry-pi.token-drift-recovery`
- Gateway Runtime (10): `raspberry-pi.always-on-gateway-process`, `raspberry-pi.backup-restore`, `raspberry-pi.channel-startup`, `raspberry-pi.cloud-model-configuration`, `raspberry-pi.gateway-health-status`, `raspberry-pi.linger-boot-persistence`, `raspberry-pi.restart-tuning`, `raspberry-pi.service-drop-ins`, `raspberry-pi.status-log-inspection`, `raspberry-pi.user-service-install`
- Performance and Diagnostics (5): `raspberry-pi.compile-cache-no-respawn-settings`, `raspberry-pi.diagnostics-bundles`, `raspberry-pi.oom-performance-troubleshooting`, `raspberry-pi.swap-and-low-ram-tuning`, `raspberry-pi.usb-ssd-guidance`

### docker-podman-hosting (16)

- Container Setup (3): `docker.compose-gateway`, `docker.rootless-podman-image-setup`, `docker.setup-scripts-and-quadlet-template`
- Container Operations (9): `docker.container-health-endpoints`, `docker.container-targeting`, `docker.container-update-rebuild-restart-guidance-for-docker`, `docker.gateway-token-generation`, `docker.host-cli-routing-into-running-docker-podman`, `docker.operator-facing-update`, `docker.ownership`, `docker.provider-vps-docker-hosting-docs`, `docker.vm-persistence-update-guidance`
- Image Release and Validation (2): `docker.release-path-install`, `docker.root-dockerfile-build-stages`
- Agent Sandbox and Tooling (2): `docker.container-image-dependency-baking`, `docker.gateway-setup`

### kubernetes-hosting (20)

- Deployment Setup (5): `kubernetes.cluster-prerequisites`, `kubernetes.kind-validation`, `kubernetes.kustomize-packaging`, `kubernetes.manifest-apply`, `kubernetes.quick-deploy`
- Configuration and Secrets (5): `kubernetes.agent-instructions`, `kubernetes.gateway-config`, `kubernetes.image-and-namespace`, `kubernetes.provider-secrets`, `kubernetes.secret-rotation`
- Access and Exposure (5): `kubernetes.auth-and-tls`, `kubernetes.ingress-exposure`, `kubernetes.localhost-posture`, `kubernetes.port-forward-access`, `kubernetes.service-endpoint`
- Cluster Lifecycle (5): `kubernetes.redeploy`, `kubernetes.resource-layout`, `kubernetes.security-context`, `kubernetes.state-persistence`, `kubernetes.teardown`

### nix-install-path (30)

- Install Handoff (4): `nix.install-discoverability`, `nix.install-overview`, `nix.openclaw-source-of-truth`, `nix.verification-handoff`
- Plugin Lifecycle (4): `nix.declarative-plugin-selection`, `nix.hardlink-safety`, `nix.lifecycle-command-refusal`, `nix.store-plugin-loading`
- Activation and App UX (7): `nix.environment-activation`, `nix.macos-defaults-activation`, `nix.managed-by-nix-banner`, `nix.onboarding-skip`, `nix.read-only-config-controls`, `nix.runtime-nix-mode-detection`, `nix.stable-nix-defaults`
- Config and State (7): `nix.agent-first-nix-edits`, `nix.config-writer-refusal`, `nix.explicit-config-path`, `nix.immutable-config-guard`, `nix.immutable-store-config-support`, `nix.state-integrity-checks`, `nix.writable-state-directory`
- Service Runtime and Guards (8): `nix.doctor-repair-refusal`, `nix.profile-path-discovery`, `nix.profile-precedence`, `nix.service-lifecycle-handoff`, `nix.service-path-fallback`, `nix.setup-write-refusal`, `nix.trusted-binary-boundaries`, `nix.update-handoff`

### discord (39)

- Channel Setup and Operations (10): `discord.account-monitor-startup`, `discord.application-and-bot-setup`, `discord.gateway-websocket-lifecycle`, `discord.multi-account-bot-configuration`, `discord.rate-limits-and-gateway-metadata`, `discord.reconnect-and-heartbeat-handling`, `discord.setup-wizard-and-account-inspection`, `discord.status-doctor-and-intent-checks`, `discord.status-probe-and-health-monitor-recovery`, `discord.token-and-application-id-configuration`
- Access and Identity (6): `discord.access-group-authorization`, `discord.allowlist-inheritance`, `discord.dm-policy-modes`, `discord.group-dm-authorization`, `security.pairing-code-approval`, `security.sender-authorization`
- Conversation Routing and Delivery (12): `channels.mention-gating`, `discord.acp-agent-routing`, `discord.configured-and-runtime-routing`, `discord.forum-and-media-channel-thread-posts`, `discord.guild-and-channel-admission`, `discord.inbound-context-visibility`, `discord.routing-lifecycle`, `discord.session-key-isolation`, `discord.target-parsing`, `discord.thread-actions`, `discord.thread-bound-session-routing`, `discord.thread-context-resolution`
- Media and Rich Content (1): `channels.media-rich-content`
- Native Controls and Approvals (5): `discord.callback-ttl`, `discord.components-v2-messages`, `discord.model-picker-commands`, `discord.native-slash-command-execution`, `discord.native-slash-command-registration`
- Realtime Voice and Calls (5): `discord.auto-join-and-follow-users`, `discord.realtime-voice-modes`, `discord.voice-channel-lifecycle`, `discord.voice-codec-and-dave-recovery`, `discord.wake-barge-in-and-echo-handling`

### telegram (29)

- Channel Setup and Operations (9): `telegram.account-scoped-outbound`, `telegram.botfather-token-creation`, `telegram.channel-status`, `telegram.cli-message-tool-targets`, `telegram.directory-adapters`, `telegram.doctor-status-surfacing`, `telegram.named-account-configuration`, `telegram.setup-wizard-credential-capture`, `telegram.startup-getme`
- Access and Identity (10): `memory.session-key-construction`, `security.group-allowlists`, `security.pairing-code-approval`, `telegram.acp-topic-routing`, `telegram.allowfrom`, `telegram.dmpolicy-modes`, `telegram.forum-topic-session-keys`, `telegram.numeric-telegram-user-id-normalization-with-telegram`, `telegram.supergroup-negative-chat-ids`, `telegram.unauthorized-dm`
- Conversation Routing and Delivery (1): `channels.conversation-routing-delivery`
- Media and Rich Content (1): `channels.media-rich-content`
- Native Controls and Approvals (8): `telegram.action-capability-discovery`, `telegram.built-in-commands`, `telegram.command-authorization-in-dms`, `telegram.command-name-description-normalization`, `telegram.exec-approvals-in-dms`, `telegram.inline-keyboard-rendering`, `telegram.model-buttons`, `telegram.native-setmycommands-startup-sync`

### whatsapp (20)

- Channel Setup and Operations (5): `whatsapp.baileys-socket-lifecycle`, `whatsapp.channel-config-schema`, `whatsapp.official-openclaw-whatsapp-plugin-metadata`, `whatsapp.openclaw-plugin-install-whatsapp`, `whatsapp.operator-troubleshooting`
- Access and Identity (7): `whatsapp.baileys-multi-file-auth-persistence`, `whatsapp.direct-message-dmpolicy`, `whatsapp.dm-pairing-challenge`, `whatsapp.multi-account-default-account-resolution`, `whatsapp.privacy-controls-for-plugin-hooks`, `whatsapp.qr-login`, `whatsapp.sender-identity-extraction`
- Conversation Routing and Delivery (4): `security.group-allowlists`, `whatsapp.group-session-keys`, `whatsapp.outbound-text-sends`, `whatsapp.provider-accepted-receipts`
- Media and Rich Content (2): `whatsapp.inbound-media-download`, `whatsapp.outbound-image`
- Native Controls and Approvals (2): `whatsapp.approver-target-resolution`, `whatsapp.native-exec`

### slack (25)

- Channel Setup and Operations (10): `codex.operator-repair`, `slack.account-status`, `slack.app-credentials`, `slack.app-install`, `slack.channel-status-diagnostics`, `slack.http-transport`, `slack.manifest`, `slack.runtime-lifecycle`, `slack.scopes`, `slack.socket`
- Access and Identity (1): `channels.access-and-identity`
- Conversation Routing and Delivery (5): `security.dm-pairing`, `security.sender-authorization`, `slack.channel-allowlists`, `slack.session-isolation`, `slack.thread-routing`
- Media and Rich Content (1): `channels.media-rich-content`
- Native Controls and Approvals (8): `security.native-approvals`, `slack.actions`, `slack.app-home`, `slack.assistant-events`, `slack.interactive-replies`, `slack.native-command-routing`, `slack.security-sensitive-ops`, `slack.slash-commands`

### imessage-bluebubbles (31)

- Channel Setup and Operations (11): `imessage.account-config`, `imessage.account-setup-prompts`, `imessage.account-status-checks`, `imessage.cut-over-safely`, `imessage.doctor-repair-checks`, `imessage.grant-macos-permissions`, `imessage.handle-migration-caveats`, `imessage.probe-runtime-health`, `imessage.run-local-imsg`, `imessage.run-through-ssh-wrapper`, `imessage.translate-legacy-config`
- Access and Identity (6): `imessage.authorize-direct-senders`, `imessage.bind-acp-sessions`, `imessage.group-policy`, `imessage.mentions`, `imessage.route-direct-conversations`, `imessage.system-prompts`
- Conversation Routing and Delivery (4): `imessage.coalesce-split-send-dms`, `imessage.replay-missed-messages`, `imessage.seed-conversation-history`, `imessage.watch-live-messages`
- Media and Rich Content (7): `imessage.chunking`, `imessage.media`, `imessage.message-tool`, `imessage.native-actions`, `imessage.private-api`, `imessage.remote-fetch`, `ui.attachments`
- Native Controls and Approvals (3): `imessage.operator-control`, `imessage.reactions`, `security.native-approvals`

### signal (24)

- Channel Setup and Operations (7): `signal.account-safety-guardrails`, `signal.container-account-provisioning`, `signal.installer-and-binary-setup`, `signal.qr-link-setup`, `signal.setup-diagnostics`, `signal.sms-registration`, `signal.status-probes`
- Access and Identity (6): `matrix.mention-gates`, `security.dm-pairing`, `security.group-allowlists`, `signal.dm-allowlists`, `signal.pending-group-history`, `signal.sender-identity-normalization`
- Conversation Routing and Delivery (1): `channels.conversation-routing-delivery`
- Media and Rich Content (7): `signal.add-remove-reactions`, `signal.group-reaction-targeting`, `signal.media-delivery-and-limits`, `signal.reaction-action-discovery`, `signal.styled-chunked-output`, `signal.text-delivery-targets`, `signal.typing-and-read-receipts`
- Native Controls and Approvals (3): `signal.approver-targeting`, `signal.native-approval-routing`, `signal.reaction-approval-responses`

### google-chat (45)

- Channel Setup and Operations (16): `google-chat.account-resolution`, `google-chat.channel-aliases-and-labels`, `google-chat.channel-status-and-probes`, `google-chat.chat-app-configuration`, `google-chat.directory-and-mutable-id-diagnostics`, `google-chat.env-file-and-inline-credentials`, `google-chat.google-cloud-project-setup`, `google-chat.guided-channel-setup`, `google-chat.install-update-metadata`, `google-chat.npm-and-clawhub-install`, `google-chat.operator-status-ui`, `google-chat.plugin-docs-and-catalog-routing`, `google-chat.service-account-secretrefs`, `google-chat.service-account-setup`, `google-chat.webhook-audience-and-path`, `google-chat.workspace-visibility-and-app-status`
- Access and Identity (11): `channels.bot-loop-protection`, `channels.mention-gating`, `google-chat.direct-session-routing`, `google-chat.dm-pairing-approval`, `google-chat.group-session-isolation`, `google-chat.identity-matching`, `google-chat.pairing-diagnostics`, `google-chat.sender-access-groups`, `google-chat.sender-allowlists`, `google-chat.space-allowlists`, `google-chat.space-diagnostics`
- Conversation Routing and Delivery (1): `channels.conversation-routing-delivery`
- Media and Rich Content (1): `channels.media-rich-content`
- Native Controls and Approvals (16): `google-chat.action-capability-gates`, `google-chat.approval-sender-matching`, `google-chat.inbound-attachments`, `google-chat.markdown-text-rendering`, `google-chat.media-receipts-and-thread-placement`, `google-chat.media-source-and-size-controls`, `google-chat.message-tool-current-source-replies`, `google-chat.message-upload-action`, `google-chat.no-reply-cleanup`, `google-chat.outbound-media-replies`, `google-chat.reaction-actions`, `google-chat.streaming-and-chunked-replies`, `google-chat.text-send-action`, `google-chat.thread-aware-replies`, `google-chat.typing-placeholder-lifecycle`, `google-chat.upload-file-action`

### matrix (23)

- Channel Setup and Operations (5): `matrix.account-discovery`, `matrix.doctor-warnings`, `matrix.plugin-identity`, `matrix.probe-status`, `matrix.setup-wizard`
- Access and Identity (7): `matrix.acp-subagent-spawn-hooks`, `matrix.direct-room-classification`, `matrix.dm-policy`, `matrix.inbound-route-selection-across-sender-bound-dms`, `matrix.mention-gates`, `matrix.persisted-matrix-thread-routing-managers`, `matrix.thread-reply-routing`
- Conversation Routing and Delivery (1): `channels.conversation-routing-delivery`
- Media and Rich Content (1): `channels.media-rich-content`
- Native Controls and Approvals (6): `matrix.channel-action-discovery`, `matrix.inbound-media-failure-handling`, `matrix.message-presentation-metadata`, `matrix.message-send-read-edit-delete`, `matrix.outbound-matrix-text`, `matrix.profile-media-loading`
- Encryption and Verification (3): `matrix.encrypted-media-upload-download`, `matrix.encryption-setup`, `matrix.legacy-state`

### microsoft-teams (33)

- Channel Setup and Operations (9): `microsoft-teams.bot-registration-and-manifest-upload`, `microsoft-teams.credential-configuration`, `microsoft-teams.operator-repair-paths`, `microsoft-teams.probe-and-scope-reporting`, `microsoft-teams.setup-status`, `microsoft-teams.teams-app-doctor`, `microsoft-teams.teams-app-install-verification`, `microsoft-teams.teams-cli-app-creation`, `microsoft-teams.webhook-and-health-diagnostics`
- Access and Identity (9): `microsoft-teams.allowlists-and-access-groups`, `microsoft-teams.bot-framework-sso-invokes`, `microsoft-teams.delegated-token-storage`, `microsoft-teams.graph-directory-lookup`, `microsoft-teams.invoke-and-command-authorization`, `microsoft-teams.member-profile-lookup`, `microsoft-teams.stable-sender-identity`, `microsoft-teams.teams-originated-config-writes`, `security.dm-pairing`
- Conversation Routing and Delivery (5): `memory.session-routing`, `microsoft-teams.deterministic-channel-replies`, `microsoft-teams.mention-gated-group-access`, `microsoft-teams.reply-and-thread-context`, `microsoft-teams.team-and-channel-allowlists`
- Media and Rich Content (5): `google-chat.inbound-attachments`, `microsoft-teams.file-consent`, `microsoft-teams.graph-hosted-media`, `microsoft-teams.media-fetch-safety`, `microsoft-teams.sharepoint-and-onedrive-sharing`
- Native Controls and Approvals (5): `microsoft-teams.feedback-and-group-actions`, `microsoft-teams.message-action-discovery`, `microsoft-teams.native-approval-cards`, `microsoft-teams.polls-and-reactions`, `microsoft-teams.read-edit-delete-and-pin`

### mattermost-line-irc-nextcloud-talk-nostr-twitch-tlon-synology-chat (4)

- Channel Setup and Operations (1): `channels.setup-operations`
- Access and Identity (1): `channels.access-and-identity`
- Conversation Routing and Delivery (1): `channels.conversation-routing-delivery`
- Media and Rich Content (1): `channels.media-rich-content`

### feishu-qq-bot-wechat-yuanbao-zalo-zalo-personal-regional-channels (9)

- Channel Setup and Operations (6): `regional-channels.channel-setup-wizard`, `regional-channels.core-channel-plugin-catalog`, `regional-channels.cross-channel-ingress-access-refactor-concerns`, `regional-channels.docs-channel-index`, `regional-channels.missing-plugin`, `regional-channels.official-external-channel-catalog-entries`
- Access and Identity (1): `channels.access-and-identity`
- Conversation Routing and Delivery (1): `channels.conversation-routing-delivery`
- Media and Rich Content (1): `channels.media-rich-content`

### voice-call-channel (7)

- Channel Setup and Operations (1): `voice-call.setup-smoke`
- Access and Identity (1): `voice-call.webhook-security`
- Conversation Routing and Delivery (1): `voice-call.inbound-routing`
- Media and Rich Content (2): `voice-call.provider-transports`, `voice-call.telephony-audio`
- Realtime Voice and Calls (2): `voice-call.realtime-consult`, `voice-call.streaming-transcription`

### openai-codex-provider-path (9)

- Model and Auth (3): `codex.catalog`, `codex.operator-repair`, `codex.subscription-usage`
- Responses and Tool Compatibility (2): `codex.capability-compatibility`, `codex.responses-transport`
- Image and Multimodal Input (2): `codex.image-generation-editing`, `codex.multimodal-input`
- Voice and Realtime Audio (2): `codex.realtime-voice-transcription`, `codex.speech`

### anthropic-provider-path (34)

- Provider Auth and Recovery (8): `anthropic.claude-cli-credential-reuse`, `anthropic.cooldown-profile-reporting`, `anthropic.fallback-guidance`, `anthropic.long-context-recovery`, `anthropic.model-status`, `anthropic.setup-token-auth`, `anthropic.usage-windows`, `gateway.api-key-onboarding`
- Model and Runtime Selection (8): `anthropic.bundled-claude-catalog`, `anthropic.capability-metadata`, `anthropic.fallback-prelude`, `anthropic.mcp-tool-bridge`, `anthropic.permission-mode-mapping`, `anthropic.runtime-selection`, `memory.session-continuity`, `models.picker-availability`
- Request Transport and Turn Semantics (9): `anthropic.abort-error-handling`, `anthropic.api-key-oauth-transport`, `anthropic.messages-payloads`, `anthropic.native-thinking`, `anthropic.partial-json-recovery`, `anthropic.streaming-decode`, `anthropic.tool-result-replay`, `anthropic.tool-use-blocks`, `anthropic.usage-and-stop-reasons`
- Prompt Cache and Context (5): `anthropic.1m-context`, `anthropic.cache-diagnostics`, `anthropic.cache-retention`, `anthropic.fast-mode-service-tier`, `anthropic.system-prompt-cache-boundary`
- Media Inputs (4): `anthropic.image-input`, `anthropic.image-tool-results`, `anthropic.media-model-fallback`, `anthropic.pdf-document-input`

### google-provider-path (44)

- Provider Setup and Credentials (10): `gateway.api-key-onboarding`, `google.auth-choice-metadata`, `google.canonical-google-model-refs`, `google.cli-runtime-selection`, `google.cli-usage-normalization`, `google.daemon-and-fallback-credentials`, `google.gemini-cli-oauth-setup`, `google.oauth-diagnostics`, `google.oauth-login-and-refresh`, `google.vertex-adc-setup`
- Model Routing and Endpoints (10): `google.adc-service-account-auth`, `google.catalog-rows-and-aliases`, `google.compatibility-boundaries`, `google.custom-base-url-policy`, `google.dynamic-model-resolution`, `google.native-config-normalization`, `google.project-location-endpoints`, `google.provider-routing`, `google.vertex-provider-selection`, `models.picker-availability`
- Direct Gemini Runtime (9): `anthropic.usage-and-stop-reasons`, `google.direct-gemini-chat`, `google.direct-gemini-transport-payloads`, `google.incomplete-turn-recovery`, `google.multimodal-inputs`, `google.thinking-level-mapping`, `google.thought-signature-replay`, `google.tool-call-streaming`, `google.tool-turn-ordering`
- Media, Search, and Realtime (10): `google.audio-and-transcript-events`, `google.bundled-plugin-distribution`, `google.constrained-browser-tokens`, `google.image-and-media-adapters`, `google.live-tool-calls`, `google.provider-auto-enable-metadata`, `google.realtime-voice-sessions`, `google.search-and-generation-tools`, `google.session-reconnects`, `google.speech-and-realtime-adapters`
- Prompt Caching (5): `google.cache-diagnostics-and-live-proof`, `google.cache-retention-config`, `google.cache-usage-accounting`, `google.managed-cachedcontents`, `google.manual-cachedcontent-handles`

### openrouter-provider-path (41)

- Provider Setup and Auth (14): `openrouter.api-key`, `openrouter.auth-profiles-and-auth-order`, `openrouter.auto-and-nested-refs`, `openrouter.default-model-selection`, `openrouter.dynamic-models-discovery`, `openrouter.first-run-setup`, `openrouter.free-model-scan-probe`, `openrouter.gateway-env-inheritance`, `openrouter.model-list-picker-cache`, `openrouter.model-ref-examples`, `openrouter.provider-entry-secretref-api-key-resolution`, `openrouter.provider-plugin-registration`, `openrouter.static-catalog-rows`, `openrouter.status-probe-and-removal`
- Chat Runtime and Normalization (15): `openrouter.anthropic-cache-control-markers`, `openrouter.anthropic-gemini-deepseek-variants`, `openrouter.attribution-headers`, `openrouter.cache-usage-mapping`, `openrouter.chat-completions-route`, `openrouter.custom-proxy-exclusions`, `openrouter.family-specific-replay-policy`, `openrouter.per-model-route-overrides`, `openrouter.provider-routing-params`, `openrouter.reasoning-details-visible-output`, `openrouter.reasoning-payload-policy`, `openrouter.response-cache-headers-ttl-clear`, `openrouter.response-model-and-usage-normalization`, `openrouter.streamed-content-parsing`, `openrouter.tool-call-delta-preservation`
- Provider Recovery and Diagnostics (5): `openrouter.auth-billing-key-limit-classification`, `openrouter.context-overflow`, `openrouter.guarded-fetch-pricing-warnings`, `openrouter.model-fallback-notices`, `openrouter.timeout-retry-classification`
- Media Generation and Speech (7): `openrouter.generated-artifact-delivery`, `openrouter.image-generate-openrouter-route`, `openrouter.inbound-media-understanding`, `openrouter.music-generate-audio-route`, `openrouter.speech-to-text-transcription`, `openrouter.text-to-speech`, `openrouter.video-generate-async-jobs-polling-download`

### local-model-providers-ollama-vllm-sglang-lm-studio (36)

- Provider Setup, Lifecycle, and Diagnostics (12): `local-models.backend-reachability-probes`, `local-models.health-checks-and-restart`, `local-models.local-provider-status`, `local-models.localservice-configuration`, `local-models.memory-readiness-diagnostics`, `local-models.model-availability-errors`, `local-models.onboarding`, `local-models.process-startup-and-readiness`, `local-models.provider-recipes`, `local-models.provider-selection`, `local-models.provider-troubleshooting-docs`, `local-models.request-leases-and-idle-shutdown`
- Native Provider Plugins (10): `local-models.lm-studio-embeddings`, `local-models.lm-studio-setup`, `local-models.model-discovery`, `local-models.model-discovery-and-auth`, `local-models.model-preload-and-jit-loading`, `local-models.ollama-embeddings`, `local-models.ollama-setup-and-model-pulling`, `local-models.streaming-and-vision`, `local-models.streaming-compatibility`, `local-models.web-search-support`
- OpenAI-Compatible Runtime Compatibility (7): `local-models.bundled-provider-setup`, `local-models.model-discovery-endpoint`, `local-models.non-interactive-configuration`, `local-models.request-stream-compatibility`, `local-models.sglang-compatibility-guidance`, `local-models.tool-calling`, `local-models.vllm-thinking-controls`
- Local Memory and Embeddings (5): `local-models.embedding-provider-selection`, `local-models.fallback-lexical-search`, `local-models.memory-search-readiness`, `local-models.memoryflush-model-override`, `local-models.provider-mismatch-guidance`
- Network Safety and Prompt Controls (2): `local-models.prompt-pressure-controls`, `local-models.safety-network`

### long-tail-hosted-providers (30)

- Hosted LLM Providers (12): `hosted-providers.account-prerequisite-diagnostics`, `hosted-providers.bedrock-setup`, `hosted-providers.copilot-opencode-hosted-access`, `hosted-providers.gateway-proxy-routing`, `hosted-providers.hosted-text-completion`, `hosted-providers.model-catalog-resolution`, `hosted-providers.provider-specific-request-shaping`, `hosted-providers.proxy-capability-diagnostics`, `hosted-providers.region-and-plan-routing`, `hosted-providers.regional-live-smoke`, `hosted-providers.regional-provider-setup`, `hosted-providers.tool-call-and-streaming-compatibility`
- Hosted Media Providers (6): `hosted-providers.audio-format-diagnostics`, `hosted-providers.media-mode-coverage`, `hosted-providers.music-generation-providers`, `hosted-providers.speech-to-text-providers`, `hosted-providers.text-to-speech-providers`, `models.realtime-transcription-providers`
- Provider Operations (12): `hosted-providers.auth-profiles-and-aliases`, `hosted-providers.catalog-parity-checks`, `hosted-providers.credential-health-probes`, `hosted-providers.direct-provider-smoke`, `hosted-providers.fallback-trace-and-repair`, `hosted-providers.gateway-live-smoke`, `hosted-providers.key-rotation-and-recovery`, `hosted-providers.model-catalog-metadata`, `hosted-providers.models-status-probes`, `hosted-providers.provider-directory`, `hosted-providers.provider-install-catalog`, `hosted-providers.provider-setup-descriptors`

### web-search-tools (37)

- Search Providers (16): `web-search.codex-native-web-search`, `web-search.contract-tests`, `web-search.gemini-grounding`, `web-search.grok-web-grounding`, `web-search.keyless-and-self-hosted-providers`, `web-search.kimi-web-search`, `web-search.provider-comparison-and-auto-detection`, `web-search.provider-native-citations`, `web-search.provider-specific-filters-and-extraction`, `web-search.public-artifact-loading`, `web-search.registerwebfetchprovider`, `web-search.registerwebsearchprovider`, `web-search.result-normalization`, `web-search.runtime-resolution`, `web-search.webfetchproviders`, `web-search.websearchproviders`
- Setup and Diagnostics (9): `codex.operator-repair`, `models.diagnostics`, `security.provider-credentials`, `web-search.cache-controls`, `web-search.credential-repair`, `web-search.default-provider-selection`, `web-search.quota-errors`, `web-search.retry-and-fallback`, `web-search.status-checks`
- Network Safety (4): `browser-tools.ssrf`, `web-search.network-safety`, `web-search.redirects`, `web-search.untrusted-content`
- Tool Availability and Fetch (8): `web-search.content-citation-handoff`, `web-search.disabled-state-diagnostics`, `web-search.group-web-policy`, `web-search.pdf-text-extraction`, `web-search.provider-model-gating`, `web-search.safe-truncation`, `web-search.url-fetch`, `web-search.x-search-exposure`

### browser-automation-and-exec-sandbox-tools (16)

- Browser Automation (7): `browser-tools.browser-actions`, `browser-tools.browser-plugin-service`, `browser-tools.browser-security`, `browser-tools.profiles`, `browser-tools.remote-control`, `browser-tools.snapshots`, `browser-tools.ssrf`
- Tool Invocation and Execution (3): `browser-tools.elevated-mode`, `browser-tools.host-exec-approvals`, `browser-tools.node-system-run`
- Sandbox and Tool Policy (6): `browser-tools.codex-dynamic-tools`, `browser-tools.sandbox-backends`, `browser-tools.sandbox-tool-gates`, `browser-tools.sandboxed-browser`, `browser-tools.tool-policy`, `browser-tools.workspace-isolation`

### image-video-music-generation-tools (42)

- Media Routing and Discovery (4): `media-tools.action-list-provider-inspection`, `media-tools.auth-backed-tool-discovery`, `media-tools.default-media-model-config`, `media-tools.per-call-model-refs-and-fallbacks`
- Task Lifecycle and Delivery (12): `media-tools.background-task-creation`, `media-tools.channel-attachment-proof`, `media-tools.completion-failure-wake`, `media-tools.duplicate-guards`, `media-tools.hosted-url-fallback`, `media-tools.idempotent-missing-media-fallback`, `media-tools.local-media-persistence`, `media-tools.message-tool-handoff`, `media-tools.mime-filename-inference`, `media-tools.no-session-inline-fallback`, `media-tools.progress-keepalive`, `media-tools.task-status-list-show-cancel`
- Image Generation (9): `media-tools.action-status`, `media-tools.api-key-openai`, `media-tools.openai-codex-oauth`, `media-tools.openrouter-xai-fal-litellm-deepinfra-google-minimax-comfyui-auth`, `media-tools.output-hints`, `media-tools.provider-attempt-metadata`, `media-tools.provider-error-diagnostics`, `media-tools.text-to-image`, `media.reference-image-editing`
- Video Generation (11): `media-tools.audio-refs`, `media-tools.hosted-url-download`, `media-tools.image-to-video`, `media-tools.polling-timeout-handling`, `media-tools.provider-skip-explanations`, `media-tools.queue-backed-jobs`, `media-tools.reference-role-validation`, `media-tools.returned-asset-metadata`, `media-tools.text-to-video`, `media-tools.typed-provideroptions`, `media-tools.video-to-video`
- Music Generation (6): `media-tools.duration-format-controls`, `media-tools.generated-audio-outputs`, `media-tools.image-reference-edit-lanes`, `media-tools.instrumental-mode`, `media-tools.prompt-and-lyrics-input`, `media-tools.provider-fallback`
