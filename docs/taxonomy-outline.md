---
title: "Maturity taxonomy outline"
summary: "Generated outline of the product areas and capabilities behind the OpenClaw maturity scorecard."
---

# Maturity taxonomy outline

## Core

### Gateway runtime

- Surface id: `gateway-runtime`

#### Approvals and Remote Execution

- Category id: `gateway-runtime.approvals-and-remote-execution`
- Exec approvals: `gateway.exec-approvals`
- Plugin approvals: `gateway.plugin-approvals`
- Node exec approvals: `gateway.node-exec-approvals`
- Approved node execution: `gateway.approved-node-execution`
- Approval mutation safety: `gateway.approval-mutation-safety`
- Delivery fallback behavior: `gateway.delivery-fallback-behavior`

#### HTTP APIs

- Category id: `gateway-runtime.http-apis`
- OpenAI-compatible APIs: `gateway.openai-compatible-apis`
- Tool invocation API: `gateway.tool-invocation-api`
- Admin API access: `gateway.admin-api-access`
- Hook ingress: `gateway.hook-ingress`

#### Hosted Web Surface

- Category id: `gateway-runtime.hosted-web-surface`
- Control UI: `gateway.control-ui-hosting`
- WebChat hosting: `gateway.webchat-hosting`
- Plugin web routes: `gateway.plugin-web-routes`
- Canvas and A2UI routes: `gateway.canvas-and-a2ui-routes`

#### Gateway RPC APIs and Events

- Category id: `gateway-runtime.gateway-rpc-apis-and-events`
- Health APIs: `gateway.health-apis`
- Identity and presence APIs: `gateway.identity-and-presence-apis`
- Model APIs: `gateway.model-apis`
- Usage and memory APIs: `gateway.usage-and-memory-apis`
- Session APIs: `agents.subagents`, `gateway.sessions-list`, `tools.session-status`
- Chat APIs: `gateway.chat-apis`
- Channel APIs: `gateway.channel-apis`
- Web login and wake APIs: `gateway.web-login-and-wake-apis`
- Config and secrets APIs: `gateway.config-and-secrets-apis`
- Update and setup APIs: `gateway.update-and-setup-apis`
- Agent and artifact APIs: `gateway.agent-and-artifact-apis`
- Task and automation APIs: `gateway.task-and-automation-apis`
- Tool and skill APIs: `gateway.tool-and-skill-apis`
- Request and event envelopes: `gateway.request-and-event-envelopes`
- Idempotent side effects: `gateway.idempotent-side-effects`
- Method discovery: `gateway.method-discovery`
- Event discovery: `gateway.event-discovery`
- Accepted-then-final results: `gateway.accepted-then-final-results`
- Event ordering: `gateway.event-ordering`
- State refresh after gaps: `gateway.state-refresh-after-gaps`

#### Device Auth and Pairing

- Category id: `gateway-runtime.device-auth-and-pairing`
- Shared-secret login: `gateway.shared-secret-login`
- Trusted proxy auth: `security.trusted-proxy-auth`
- Private ingress mode: `gateway.private-ingress-mode`
- Device challenge signing: `gateway.device-challenge-signing`
- Device tokens: `gateway.device-tokens`
- Setup-code bootstrap: `gateway.setup-code-bootstrap`
- Auth mismatch recovery: `gateway.auth-mismatch-recovery`
- Device auth migration: `gateway.device-auth-migration`
- Client pairing: `gateway.client-pairing`
- Node pairing: `security.node-pairing`

#### Network Access and Discovery

- Category id: `gateway-runtime.network-access-and-discovery`
- Loopback and LAN access: `gateway.loopback-and-lan-access`
- Tailnet access: `gateway.tailnet-access`
- SSH tunnels: `gateway.ssh-tunnels`
- Endpoint discovery: `gateway.endpoint-discovery`
- Saved endpoints: `gateway.saved-endpoints`
- TLS pinning: `gateway.tls-pinning`

#### Nodes and Remote Capabilities

- Category id: `gateway-runtime.nodes-and-remote-capabilities`
- Node presence: `gateway.node-presence`
- Node capabilities: `gateway.node-capabilities`
- Node inventory: `gateway.node-inventory`
- Node actions: `gateway.node-actions`
- Node events: `gateway.node-events`
- Pending work delivery: `gateway.pending-work-delivery`
- Remote device capabilities: `gateway.remote-device-capabilities`
- Remote host commands: `gateway.remote-host-commands`

#### Health, Diagnostics, and Repair

- Category id: `gateway-runtime.health-diagnostics-and-repair`
- Health snapshots: `telemetry.health-snapshots`
- Channel readiness: `gateway.channel-readiness`
- Stability diagnostics: `gateway.stability-diagnostics`
- Payload diagnostics: `gateway.payload-diagnostics`
- Diagnostics exports: `gateway.diagnostics-exports`
- Doctor checks: `telemetry.doctor-checks`
- Log tailing: `gateway.log-tailing`

#### Protocol Compatibility

- Category id: `gateway-runtime.protocol-compatibility`
- Published protocol schema: `gateway.published-protocol-schema`
- Runtime request validation: `gateway.runtime-request-validation`
- JSON Schema export: `gateway.json-schema-export`
- Swift client models: `gateway.swift-client-models`
- Version negotiation: `gateway.version-negotiation`
- Client transport defaults: `gateway.client-transport-defaults`
- Backward-compatible evolution: `gateway.backward-compatible-evolution`

#### Roles and Permissions

- Category id: `gateway-runtime.roles-and-permissions`
- Role negotiation: `gateway.role-negotiation`
- Operator permissions: `gateway.operator-permissions`
- Approval-gated actions: `gateway.approval-gated-actions`
- Untrusted node declarations: `gateway.untrusted-node-declarations`
- Event scoping: `gateway.event-scoping`

#### Gateway Lifecycle

- Category id: `gateway-runtime.gateway-lifecycle`
- Foreground startup: `gateway.foreground-startup`
- Service installation: `gateway.service-installation`
- Restart and stop: `config.restart-apply`, `plugins.capabilities`, `runtime.gateway-restart`
- Service status: `gateway.service-status`
- Bind and port settings: `gateway.bind-and-port-settings`
- Config reload: `config.hot-apply`, `plugins.hot-reload`, `plugins.lifecycle`, `plugins.skills`
- Multi-gateway isolation: `gateway.multi-gateway-isolation`

#### Security Controls

- Category id: `gateway-runtime.security-controls`
- Non-loopback auth: `gateway.non-loopback-auth`
- Trusted proxy exceptions: `gateway.trusted-proxy-exceptions`
- Gateway and node trust boundaries: `gateway.gateway-and-node-trust-boundaries`
- Trusted CIDR auto-approval: `gateway.trusted-cidr-auto-approval`
- Fail-closed protocol handling: `gateway.fail-closed-protocol-handling`
- Remote execution safeguards: `gateway.remote-execution-safeguards`

#### WebSocket Connection

- Category id: `gateway-runtime.websocket-connection`
- WebSocket transport: `gateway.websocket-transport`
- Connect challenge: `gateway.connect-challenge`
- Connect request: `gateway.connect-request`
- Protocol version negotiation: `gateway.protocol-version-negotiation`
- hello-ok snapshot: `gateway.hello-ok-snapshot`
- Startup retry: `gateway.startup-retry`
- Session limits: `gateway.session-limits`
- Plugin surface URLs: `gateway.plugin-surface-urls`

### CLI

- Surface id: `cli-install-update-onboard-doctor`

#### CLI Setup

- Category id: `cli-install-update-onboard-doctor.cli-setup`
- Installer scripts: `cli.installer-scripts`
- Local prefix install: `cli.local-prefix-install`
- Package-manager installs: `cli.package-manager-installs`
- Supported Node runtime: `cli.supported-node-runtime`
- Source checkout install: `cli.source-checkout-install`
- CLI entrypoint: `cli.entrypoint`

#### Onboarding and Auth Setup

- Category id: `cli-install-update-onboard-doctor.onboarding-and-auth-setup`
- Guided onboarding: `cli.guided-onboarding`
- Targeted reconfiguration: `cli.targeted-reconfiguration`
- Auth choices: `cli.auth-choices`
- Gateway auth storage: `cli.gateway-auth-storage`
- Remote onboarding: `cli.remote-onboarding`

#### Plugin and Channel Setup

- Category id: `cli-install-update-onboard-doctor.plugin-and-channel-setup`
- Channel picker: `cli.channel-picker`
- Plugin install sources: `cli.plugin-install-sources`
- Channel account setup: `cli.channel-account-setup`
- Post-setup probes: `cli.post-setup-probes`
- Remote gateway caveat: `cli.remote-gateway-caveat`

#### Gateway Service Management

- Category id: `cli-install-update-onboard-doctor.gateway-service-management`
- Foreground gateway runs: `cli.foreground-gateway-runs`
- Service install and control: `cli.service-install-and-control`
- Service auth wiring: `agents.create`, `channels.discord-config`, `config.crestodian-setup`
- Drift and reinstall recovery: `cli.drift-and-reinstall-recovery`
- Service health checks: `cli.service-health-checks`

#### CLI Observability

- Category id: `cli-install-update-onboard-doctor.cli-observability`
- Status snapshots: `cli.status-snapshots`
- Health snapshots: `telemetry.health-snapshots`
- Remote log tailing: `cli.remote-log-tailing`
- Diagnostics export: `cli.diagnostics-export`
- Support-safe redaction: `cli.support-safe-redaction`

#### Doctor

- Category id: `cli-install-update-onboard-doctor.doctor`
- Interactive repair: `cli.interactive-repair`
- Config migration: `cli.config-migration`
- Auth and SecretRef checks: `cli.auth-and-secretref-checks`
- Plugin validation and repair: `cli.plugin-validation-repair`
- Lint and JSON findings: `cli.lint-and-json-findings`
- Extra gateway discovery: `cli.extra-gateway-discovery`
- Supervisor drift repair: `cli.supervisor-drift-repair`
- Port and startup diagnosis: `cli.port-and-startup-diagnosis`
- Runtime path checks: `cli.runtime-path-checks`
- Restart guidance: `cli.restart-guidance`

#### Updates and Upgrades

- Category id: `cli-install-update-onboard-doctor.updates-and-upgrades`
- Update channels: `cli.update-channels`
- Install-kind switching: `cli.install-kind-switching`
- Managed gateway restart: `cli.managed-gateway-restart`
- Update status and RPC: `cli.update-status-and-rpc`
- Plugin convergence: `cli.plugin-convergence`

### Plugins

- Surface id: `plugin-sdk-and-bundled-plugin-architecture`

#### Authoring and Packaging plugins

- Category id: `plugin-sdk-and-bundled-plugin-architecture.authoring-and-packaging-plugins`
- Root SDK entrypoint: `plugins.root-sdk-entrypoint`
- Focused SDK imports: `plugins.focused-sdk-imports`
- Entrypoint discovery: `plugins.entrypoint-discovery`
- Migration shims: `plugins.migration-shims`
- Plugin manifest: `plugins.manifest`
- Package metadata: `plugins.package-metadata`
- Runtime compatibility: `plugins.runtime-compatibility`
- Validation feedback: `plugins.validation-feedback`

#### Bundled plugins

- Category id: `plugin-sdk-and-bundled-plugin-architecture.bundled-plugins`
- Bundled plugin listing: `plugins.bundled-plugin-listing`
- Bundled source overlays: `plugins.bundled-source-overlays`
- Packaged bundled plugins: `plugins.packaged-bundled-plugins`
- Generated plugin inventory: `plugins.generated-plugin-inventory`
- Bundled channel IDs: `plugins.bundled-channel-ids`

#### Canvas plugin

- Category id: `plugin-sdk-and-bundled-plugin-architecture.canvas-plugin`
- Hosted Canvas and A2UI surfaces: `plugins.hosted-canvas-and-a2ui-surfaces`
- Agent canvas tool: `plugins.agent-canvas-tool`
- Node Canvas commands: `plugins.node-canvas-commands`
- Control UI embeds: `plugins.control-ui-embeds`
- Canvas documents: `plugins.canvas-documents`
- A2UI transport and snapshots: `plugins.a2ui-transport-and-snapshots`

#### Installing and running plugins

- Category id: `plugin-sdk-and-bundled-plugin-architecture.installing-and-running-plugins`
- Plugin setup: `plugins.setup-flows`
- Runtime activation: `config.hot-apply`, `gateway.performance`, `models.live-openai`, `plugins.before-prompt-build`, `plugins.before-tool-call`, `plugins.hot-reload`, `plugins.kitchen-sink`, `plugins.lifecycle`, `plugins.plugin-tools`, `plugins.runtime`, `plugins.skills`, `runtime.gateway-log-sentinel.plugin-hooks`
- Enable and disable: `config.hot-apply`, `plugins.hot-reload`, `plugins.lifecycle`
- Safe load failures: `plugins.contracts.tools`, `runtime.gateway-log-sentinel.plugin-contracts`
- Dependency repair: `plugins.dependency-repair`
- Install update and uninstall: `plugins.hot-install`, `plugins.skills`, `runtime.gateway-restart`, `runtime.package-update`, `runtime.update-run`

#### Channel plugins

- Category id: `plugin-sdk-and-bundled-plugin-architecture.channel-plugins`
- Inbound event handling: `plugins.inbound-event-handling`
- Outbound delivery: `plugins.outbound-delivery`
- Ingress authorization: `plugins.ingress-authorization`
- Destination resolution: `plugins.destination-resolution`
- Native approval prompts: `plugins.native-approval-prompts`

#### Provider and tool plugins

- Category id: `plugin-sdk-and-bundled-plugin-architecture.provider-and-tool-plugins`
- Provider plugins: `plugins.provider-plugins`
- Tool plugins: `gateway.performance`, `models.live-openai`, `plugins.before-prompt-build`, `plugins.before-tool-call`, `plugins.kitchen-sink`, `plugins.lifecycle`, `plugins.mcp-tools`, `plugins.plugin-tools`, `runtime.gateway-log-sentinel.plugin-hooks`, `tools.invocation`
- Model catalogs: `plugins.model-catalogs`
- Provider auth: `plugins.provider-auth`
- Web search and fetch: `plugins.web-search-and-fetch`
- Mixed plugins: `config.hot-apply`, `config.restart-apply`, `plugins.capabilities`, `plugins.hot-install`, `plugins.runtime`, `plugins.skills`, `tools.invocation`, `tools.skill-invocation`

#### Plugin approvals

- Category id: `plugin-sdk-and-bundled-plugin-architecture.plugin-approvals`
- Approval requests: `plugins.approval-requests`
- Native approval delivery: `plugins.native-approval-delivery`
- Same-chat fallbacks: `plugins.same-chat-fallbacks`
- Exec and plugin separation: `plugins.exec-and-plugin-separation`
- Approval replay protection: `plugins.approval-replay-protection`
- Security helpers: `plugins.security-helpers`

#### Publishing plugins

- Category id: `plugin-sdk-and-bundled-plugin-architecture.publishing-plugins`
- Install sources: `plugins.install-sources`
- ClawHub publishing: `plugins.clawhub-publishing`
- npm publishing: `plugins.npm-publishing`
- Compatibility signaling: `plugins.compatibility-signaling`
- Update and rollback expectations: `plugins.update-and-rollback-expectations`
- Third-party publication rules: `plugins.third-party-publication-rules`

#### Testing plugins

- Category id: `plugin-sdk-and-bundled-plugin-architecture.testing-plugins`
- Test fixtures: `plugins.test-fixtures`
- Local test environment: `plugins.local-test-environment`
- Plugin runtime harness: `plugins.contracts.tools`, `runtime.gateway-log-sentinel.plugin-contracts`
- Unit and integration scaffolds: `plugins.unit-and-integration-scaffolds`
- Docker lifecycle suites: `plugins.docker-lifecycle-suites`
- Smoke tests: `gateway.performance`, `models.live-openai`, `plugins.kitchen-sink`, `plugins.lifecycle`, `plugins.plugin-tools`

### Agent Runtime

- Surface id: `agent-runtime-and-provider-execution`

#### Agent Turn Execution

- Category id: `agent-runtime-and-provider-execution.agent-turn-execution`
- Turn startup and runtime choice: `agents.create`, `agents.instructions`, `channels.discord-config`, `config.crestodian-setup`, `runtime.first-action`, `runtime.first-hour-20`, `runtime.long-context`
- Session and run coordination: `agents.subagents`, `channels.dedup`, `channels.dm`, `channels.qa-channel`, `channels.reconnect`, `channels.streaming`, `channels.threads`, `commitments.heartbeat-target-none`, `commitments.scope`, `personal.channel-replies`, `runtime.codex-plugin.lifecycle`, `runtime.delivery`, `runtime.fallback-delivery`, `runtime.gateway-restart`, `runtime.restart-recovery`, `runtime.turn-ordering`
- Abort and terminal outcomes: `channels.streaming`, `runtime.delivery`, `runtime.fallback-delivery`, `runtime.long-context`, `runtime.soak-100`

#### External Runtimes and Subagents

- Category id: `agent-runtime-and-provider-execution.external-runtimes-and-subagents`
- External harness selection: `agents.openclaw-harness`, `workspace.planning`
- CLI runtime aliases: `runtime.cli-runtime-aliases`
- Subagent turns: `agents.subagents`, `agents.synthesis`, `channels.qa-channel`, `gateway.sessions-list`, `runtime.delivery`, `tools.sessions-spawn`
- Runtime recovery: `runtime.recovery`

#### Hosted Provider Execution

- Category id: `agent-runtime-and-provider-execution.hosted-provider-execution`
- Hosted provider turns: `runtime.hosted-provider-turns`
- Provider-specific model options: `runtime.provider-specific-model-options`
- Hosted tool use: `runtime.hosted-tool-use`
- Reasoning and cache controls: `runtime.reasoning-and-cache-controls`
- Hosted streaming and replies: `runtime.hosted-streaming-and-replies`

#### Local and Self-hosted Providers

- Category id: `agent-runtime-and-provider-execution.local-and-self-hosted-providers`
- Local provider profiles: `runtime.local-provider-profiles`
- Tool-capability flags: `runtime.tool-capability-flags`
- Timeouts and context windows: `runtime.timeouts-and-context-windows`
- Local smoke checks: `runtime.local-smoke-checks`
- Local failure handling: `runtime.local-failure-handling`

#### Model and Runtime Selection

- Category id: `agent-runtime-and-provider-execution.model-and-runtime-selection`
- Model reference selection: `models.claude-cli`, `models.provider-capabilities`
- Provider and runtime overrides: `models.switching`, `models.thinking`, `runtime.session-continuity`, `runtime.tool-continuity`
- Thinking and context settings: `models.switching`, `models.thinking`, `runtime.reasoning-visibility`, `runtime.session-continuity`
- Invalid route recovery: `runtime.invalid-route-recovery`

#### Provider Auth

- Category id: `agent-runtime-and-provider-execution.provider-auth`
- Login and API-key setup: `models.anthropic`, `models.provider-auth`
- Auth profile selection: `auth-profiles.provider-selection`, `runtime.codex-plugin.auth`
- Credential health checks: `gateway.performance`, `models.live-openai`, `plugins.kitchen-sink`, `plugins.lifecycle`, `plugins.plugin-tools`
- Auth failover: `runtime.auth-failover`
- Provider fallback recovery: `memory.failure-handling`, `runtime.fallbacks`
- Rate-limit and capacity recovery: `runtime.rate-limit-and-capacity-recovery`
- Missing-key and OAuth guidance: `runtime.missing-key-and-oauth-guidance`
- Restart and stale-route recovery: `runtime.restart-and-stale-route-recovery`
- Structured provider diagnostics: `runtime.structured-provider-diagnostics`
- Subagent credential propagation: `runtime.subagent-credential-propagation`

#### Streaming and Progress

- Category id: `agent-runtime-and-provider-execution.streaming-and-progress`
- Streaming replies: `channels.streaming`, `runtime.delivery`, `runtime.fallback-delivery`
- Progress visibility: `models.thinking`, `personal.failure-recovery`, `personal.no-fake-progress`, `personal.task-followthrough`, `runtime.reasoning-visibility`, `tools.evidence`

#### Tool Calls and Response Handling

- Category id: `agent-runtime-and-provider-execution.tool-calls-and-response-handling`
- Tool-call handling: `models.switching`, `personal.no-fake-progress`, `personal.task-followthrough`, `personal.tool-safety`, `runtime.approvals`, `runtime.codex-native-workspace.read`, `runtime.prompt-compatibility`, `runtime.tool-continuity`, `tools.apply-patch`, `tools.edit`, `tools.evidence`, `tools.followthrough`, `tools.fs.list`, `tools.fs.read`, `tools.fs.write`, `tools.grep`, `workspace.artifacts`
- Usage and response reporting: `agents.subagents`, `agents.synthesis`
- Failure recovery: `personal.failure-recovery`, `personal.no-fake-progress`, `runtime.empty-response-recovery`, `runtime.reasoning-only-recovery`, `runtime.retry-policy`, `tools.evidence`

#### Tool Execution Controls

- Category id: `agent-runtime-and-provider-execution.tool-execution-controls`
- Tool availability rules: `qa.artifact-safety`, `runtime.inventory`, `runtime.tool-policy`, `security.redaction`
- Sandboxed exec behavior: `runtime.sandboxed-exec-behavior`
- Approval flow: `personal.approval-denial`, `runtime.approvals`, `tools.followthrough`
- Elevated execution: `runtime.elevated-execution`
- Tool safety controls: `personal.tool-safety`, `tools.safety`
- Delegated tool access: `runtime.delegated-tool-access`

### Session, memory, and context engine

- Surface id: `session-memory-and-context-engine`

#### CLI Session and Transcript Management

- Category id: `session-memory-and-context-engine.cli-session-and-transcript-management`
- CLI Session: `session.cli-session`
- Transcript Management: `session.transcript-management`

#### Token Management

- Category id: `session-memory-and-context-engine.token-management`
- Compaction: `runtime.compaction`, `runtime.empty-response-recovery`, `runtime.reasoning-only-recovery`, `runtime.retry-policy`
- Pruning: `session.pruning`
- Token Pressure: `runtime.codex-app-server`, `runtime.first-hour-20`, `runtime.gateway-log-sentinel.codex-progress`, `runtime.long-context`, `runtime.soak-100`

#### Context Engine

- Category id: `session-memory-and-context-engine.context-engine`
- Context Engine: `docs.discovery`, `workspace.artifacts`, `workspace.long-running-task`, `workspace.repo-discovery`
- Runtime Assembly: `agents.openclaw-harness`, `models.codex-cli`, `workspace.planning`

#### Cross-client History and Session Parity

- Category id: `session-memory-and-context-engine.cross-client-history-and-session-parity`
- Cross-client History: `channels.threads`, `memory.thread-isolation`
- Session Parity: `models.switching`, `models.thinking`, `runtime.session-continuity`

#### Diagnostics, Maintenance, and Recovery

- Category id: `session-memory-and-context-engine.diagnostics-maintenance-and-recovery`
- Session diagnostic reports: `session.diagnostic-reports`
- Session maintenance warnings: `session.maintenance-warnings`
- Session and transcript recovery: `config.restart-apply`, `memory.failure-handling`, `runtime.delivery`, `runtime.fallbacks`, `runtime.gateway-restart`, `runtime.package-update`, `runtime.restart-recovery`, `runtime.update-run`

#### Core Prompts and Context

- Category id: `session-memory-and-context-engine.core-prompts-and-context`
- Instruction Profile: `agents.instructions`, `character.persona`, `runtime.first-action`, `workspace.artifacts`
- Context Visibility: `docs.discovery`, `models.codex-cli`, `runtime.no-meta-leak`, `workspace.repo-discovery`

#### Memory

- Category id: `session-memory-and-context-engine.memory`
- Memory Backend Storage: `session.memory-backend-storage`
- Embedding Search: `channels.qa-channel`, `memory.active-recall`, `memory.ranking`, `memory.recall`, `personal.memory-recall`
- Memory Files: `memory.dreaming`, `memory.promotion`, `qa.artifact-safety`
- Memory search and store tools: `channels.group-messages`, `channels.qa-channel`, `memory.active-recall`, `memory.ranking`, `memory.recall`, `memory.tools`, `personal.memory-recall`, `tools.memory.add`, `tools.memory.recall`
- Active Memory: `channels.qa-channel`, `memory.active-recall`, `memory.recall`, `personal.memory-recall`

#### Session Routing

- Category id: `session-memory-and-context-engine.session-routing`
- Session Routing: `memory.session-routing`
- Conversation routing: `channels.webchat`, `runtime.direct-reply-routing`, `tools.message`

#### Transcript Persistence

- Category id: `session-memory-and-context-engine.transcript-persistence`
- Transcript Persistence: `session.transcript-persistence`
- Durability: `session.durability`

### Channel framework

- Surface id: `channel-framework`

#### Channel Actions Commands and Approvals

- Category id: `channel-framework.channel-actions-commands-and-approvals`
- Channel-native commands: `channels.native-commands`
- Native command session target: `channels.native-command-session-target`
- Message actions: `channels.message-actions`
- Message tool API discovery: `channels.message-tool-api-discovery`
- Channel-native approval prompts: `channels.native-approval-prompts`

#### Channel Setup

- Category id: `channel-framework.channel-setup`
- Supported channel catalog: `channels.supported-channel-catalog`
- Channel status taxonomy in channels list: `channels.status-taxonomy-in-channels-list`
- Setup/onboarding flows: `agents.create`, `channels.discord-config`, `config.crestodian-setup`
- Install-on-demand: `channels.install-on-demand`
- Setup wizard metadata: `channels.setup-wizard-metadata`

#### Group Thread and Ambient Room Behavior

- Category id: `channel-framework.group-thread-and-ambient-room-behavior`
- Group/channel session isolation: `channels.group-messages`, `channels.qa-channel`, `memory.tools`
- Mention-required: `channels.group-visible-replies`, `channels.qa-channel`, `tools.message`
- Native threads: `channels.dm`, `channels.qa-channel`, `channels.threads`, `memory.thread-isolation`, `personal.channel-replies`
- Broadcast groups: `channels.broadcast-groups`
- Bot-loop protection: `channels.bot-loop-protection`

#### Inbound Access and Identity Gates

- Category id: `channel-framework.inbound-access-and-identity-gates`
- DM pairing: `security.dm-pairing`
- Group/channel allowlists: `channels.group-channel-allowlists`
- Access group expansion: `channels.access-group-expansion`
- Mention gating: `channels.mention-gating`
- Sanitized inbound identity/route projections: `channels.sanitized-inbound-identity-route-projections`

#### Media Attachments and Rich Channel Data

- Category id: `channel-framework.media-attachments-and-rich-channel-data`
- Inbound media normalization: `channels.inbound-media-normalization`
- Outbound direct text/media sends: `channels.outbound-direct-text-media-sends`
- Provider-specific channelData: `channels.provider-specific-channeldata`
- Media roots: `channels.media-roots`

#### Outbound Delivery and Reply Pipeline

- Category id: `channel-framework.outbound-delivery-and-reply-pipeline`
- Automatic final reply delivery: `agents.subagents`, `channels.dedup`, `channels.direct-visible-replies`, `channels.dm`, `channels.group-visible-replies`, `channels.qa-channel`, `channels.reconnect`, `channels.streaming`, `channels.threads`, `commitments.heartbeat-target-none`, `commitments.scope`, `personal.channel-replies`, `runtime.delivery`, `runtime.fallback-delivery`, `runtime.gateway-restart`, `runtime.restart-recovery`, `tools.message`
- Durable outbound send orchestration: `channels.dedup`, `channels.reconnect`, `runtime.delivery`
- Reply pipeline transforms: `channels.message-actions`, `channels.qa-channel`
- Provider outbound adapter bridge: `channels.direct-visible-replies`, `channels.group-visible-replies`, `channels.qa-channel`, `channels.webchat`, `runtime.direct-reply-routing`, `tools.message`, `tools.message-tool`

#### Conversation Routing and Delivery

- Category id: `channel-framework.conversation-routing-and-delivery`
- Inbound conversation routing: `channels.dm`, `channels.qa-channel`, `channels.threads`, `personal.channel-replies`
- Session key construction: `memory.session-key-construction`
- Agent selection precedence: `channels.agent-selection-precedence`
- Runtime conversation routing: `channels.runtime-conversation-routing`
- Thread/parent-child placement: `channels.thread-parent-child-placement`
- Plugin registry resolution: `agents.subagents`, `channels.direct-visible-replies`, `channels.dm`, `channels.group-messages`, `channels.group-visible-replies`, `channels.message-actions`, `channels.qa-channel`, `channels.threads`, `media.image-generation`, `media.image-understanding`, `memory.recall`, `personal.channel-replies`, `personal.memory-recall`, `personal.reminders`, `runtime.delivery`, `scheduling.cron`, `scheduling.dedup`, `tools.message`, `ui.control`
- Channel account startup: `channels.account-startup`
- Whole-channel lifecycle controls: `channels.whole-channel-lifecycle-controls`
- Config/secrets reload interactions: `channels.config-secrets-reload-interactions`
- Auto-restart: `channels.auto-restart`

#### Status Health and Operator Controls

- Category id: `channel-framework.status-health-and-operator-controls`
- channels.status: `channels.status`
- Channel health policy: `channels.dedup`, `channels.reconnect`, `runtime.delivery`
- Operator CLI controls: `channels.operator-cli-controls`
- Status read-model: `channels.status-read-model`

### Security, auth, pairing, and secrets

- Surface id: `security-auth-pairing-and-secrets`

#### Approval Policy and Tool Safeguards

- Category id: `security-auth-pairing-and-secrets.approval-policy-and-tool-safeguards`
- Approval Policy: `personal.approval-denial`, `personal.tool-safety`, `runtime.approvals`, `tools.followthrough`, `tools.safety`
- Dangerous Tool Safeguards: `security.dangerous-tool-safeguards`

#### Gateway Auth and Remote Access

- Category id: `security-auth-pairing-and-secrets.gateway-auth-and-remote-access`
- Shared Gateway token/password auth: `security.shared-gateway-token-password-auth`
- Gateway auth mode: `security.gateway-auth-mode`
- Trusted-proxy identity: `security.trusted-proxy-identity`
- Tailscale Serve/Funnel: `raspberry-pi.tailscale-serve-funnel`
- Bind and origin restrictions: `security.bind-and-origin-restrictions`
- WebSocket handshake auth: `security.websocket-handshake-auth`
- Operator-facing docs: `security.operator-facing-docs`
- Browser Control UI: `security.browser-control-ui`
- Remote Client Trust: `security.remote-client-trust`

#### Channel Access Control

- Category id: `security-auth-pairing-and-secrets.channel-access-control`
- Channel Identity: `security.channel-identity`
- Allowlists: `security.allowlists`
- Sender Pairing: `security.sender-pairing`

#### Device and Node Pairing

- Category id: `security-auth-pairing-and-secrets.device-and-node-pairing`
- Setup codes: `security.setup-codes`
- Device identity creation: `security.device-identity-creation`
- Device-token issuance: `security.device-token-issuance`
- Device pairing approvals for operator: `security.device-pairing-approvals-for-operator`
- Operator scopes that gate pairing: `security.operator-scopes-that-gate-pairing`
- Local Control UI: `security.local-control-ui`
- Auth migration: `security.auth-migration`
- Operator-facing docs: `security.operator-facing-docs`
- Node Pairing: `security.node-pairing`
- Capability Trust: `security.capability-trust`
- Remote Exec Approvals: `security.remote-exec-approvals`

#### Plugin Trust

- Category id: `security-auth-pairing-and-secrets.plugin-trust`
- Plugin Installation Trust: `security.plugin-installation-trust`
- Security Boundaries: `security.boundaries`

#### Credential and Secret Hygiene

- Category id: `security-auth-pairing-and-secrets.credential-and-secret-hygiene`
- Provider Auth Profiles: `security.provider-auth-profiles`
- API Key Health: `security.api-key-health`
- Secrets Storage: `security.secrets-storage`
- Redaction: `memory.dreaming`, `memory.promotion`, `personal.diagnostics`, `personal.redaction`, `qa.artifact-safety`, `runtime.tool-policy`, `security.redaction`
- Configuration Hygiene: `security.configuration-hygiene`

### Observability

- Surface id: `telemetry-diagnostics-and-observability`

#### Health and Repair

- Category id: `telemetry-diagnostics-and-observability.health-and-repair`
- Background health-monitor loop: `telemetry.background-health-monitor-loop`
- Per-account enable/disable settings: `telemetry.per-account-enable-disable-settings`
- Startup grace: `telemetry.startup-grace`
- Restart logging: `telemetry.restart-logging`
- openclaw doctor: `runtime.codex-plugin.auth`, `runtime.codex-plugin.lifecycle`, `runtime.doctor-repair`
- Structured health checks: `telemetry.structured-health-checks`
- Core doctor checks: `telemetry.core-doctor-checks`
- Plugin SDK doctor/health contracts: `telemetry.plugin-sdk-doctor-health-contracts`
- openclaw status: `windows.openclaw-status`
- openclaw health: `telemetry.openclaw-health`
- Gateway RPC health: `telemetry.gateway-rpc-health`
- Cached health snapshots: `gateway.performance`, `models.live-openai`, `plugins.kitchen-sink`, `plugins.lifecycle`, `plugins.plugin-tools`

#### Logging

- Category id: `telemetry-diagnostics-and-observability.logging`
- Rolling Gateway JSONL file logs: `telemetry.rolling-gateway-jsonl-file-logs`
- openclaw logs: `telemetry.openclaw-logs`
- Gateway RPC logs.tail: `telemetry.gateway-rpc-logs-tail`
- Redaction patterns and sinks: `telemetry.redaction-patterns-and-sinks`
- Trace correlation fields: `telemetry.trace-correlation-fields`

#### Diagnostic Collection

- Category id: `telemetry-diagnostics-and-observability.diagnostic-collection`
- openclaw gateway diagnostics export: `telemetry.openclaw-gateway-diagnostics-export`
- openclaw gateway stability --bundle: `telemetry.openclaw-gateway-stability-bundle`
- Chat /diagnostics: `telemetry.chat-diagnostics`
- Support zip composition: `personal.diagnostics`, `personal.redaction`, `qa.artifact-safety`
- Bounded in-process stability recorder: `telemetry.bounded-in-process-stability-recorder`
- openclaw gateway stability: `telemetry.openclaw-gateway-stability`
- Memory pressure events: `telemetry.memory-pressure-events`
- Critical memory pressure snapshot option: `telemetry.critical-memory-pressure-snapshot-option`

#### Telemetry Export

- Category id: `telemetry-diagnostics-and-observability.telemetry-export`
- Diagnostic event types: `telemetry.diagnostic-event-types`
- Async dispatch: `automation.async-dispatch`
- W3C trace context creation: `telemetry.w3c-trace-context-creation`
- Plugin SDK diagnostic runtime exports: `telemetry.plugin-sdk-runtime-exports`
- Model-call diagnostic events: `telemetry.model-call-diagnostic-events`
- diagnostics-otel plugin install: `telemetry.diagnostics-otel-plugin-install`
- OTLP/HTTP traces: `harness.qa-lab`, `telemetry.otel`
- Trusted trace context: `telemetry.trusted-trace-context`
- Model and runtime telemetry: `docker.e2e`, `harness.qa-lab`, `harness.tool-trace-visibility`, `personal.failure-recovery`, `personal.no-fake-progress`, `personal.task-followthrough`, `runtime.qa-bus`, `telemetry.otel`, `telemetry.prometheus`, `tools.evidence`, `tools.trace`
- diagnostics-prometheus plugin install: `telemetry.diagnostics-prometheus-plugin-install`
- Gateway-authenticated GET /api/diagnostics/prometheus: `telemetry.prometheus-authenticated-gateway-export`
- Prometheus text exposition: `docker.e2e`, `harness.qa-lab`, `telemetry.prometheus`
- Trusted diagnostic event subscription: `telemetry.trusted-diagnostic-event-subscription`

#### Session Diagnostics

- Category id: `telemetry-diagnostics-and-observability.session-diagnostics`
- session.state: `telemetry.session-state`
- Diagnostic session activity snapshots: `telemetry.diagnostic-session-activity-snapshots`
- Model usage: `telemetry.model-usage`
- Export of session signals to stability: `telemetry.export-of-session-signals-to-stability`

### Automation: cron, hooks, tasks, polling

- Surface id: `automation-cron-hooks-tasks-polling`

#### Cron Jobs

- Category id: `automation-cron-hooks-tasks-polling.cron-jobs`
- Create/edit/remove jobs: `automation.create-edit-remove-jobs`
- Schedule types: `automation.schedule-types`
- Timezone and stagger: `automation.timezone-and-stagger`
- Cron RPCs: `scheduling.cron-rpcs`
- Agent cron tool: `channels.qa-channel`, `personal.reminders`, `scheduling.cron`
- Manual cron runs: `scheduling.cron`
- Isolated cron execution: `scheduling.cron`, `scheduling.dedup`
- Model/provider preflight: `automation.model-provider-preflight`
- Run history: `channels.qa-channel`, `scheduling.cron`, `scheduling.dedup`
- Timeout and denial diagnostics: `automation.timeout-and-denial-diagnostics`
- Chat announce delivery: `scheduling.chat-announce-delivery`
- Webhook delivery: `automation.webhook-delivery`
- Failure destinations: `automation.failure-destinations`
- Skipped-run alerts: `automation.skipped-run-alerts`
- Delivery previews: `automation.delivery-previews`

#### Event Ingress

- Category id: `automation-cron-hooks-tasks-polling.event-ingress`
- Telegram long polling: `automation.telegram-long-polling`
- Telegram webhook mode: `automation.telegram-webhook-mode`
- Zalo polling/webhook mode: `automation.zalo-polling-webhook-mode`
- Polling stall diagnostics: `automation.polling-stall-diagnostics`
- iMessage watch fallback: `automation.imessage-watch-fallback`
- Gmail setup wizard: `automation.gmail-setup-wizard`
- Watcher start/serve: `automation.watcher-start-serve`
- Tailscale/public routing: `automation.tailscale-public-routing`
- Push token validation: `automation.push-token-validation`
- Gmail event routing: `automation.gmail-event-routing`
- POST /hooks/wake: `automation.post-hooks-wake`
- POST /hooks/agent: `automation.post-hooks-agent`
- Mapped hooks: `automation.mapped-hooks`
- Hook auth policy: `automation.hook-auth-policy`
- Async dispatch: `automation.async-dispatch`

#### Automation Hooks

- Category id: `automation-cron-hooks-tasks-polling.automation-hooks`
- HOOK.md authoring: `automation.hook-md-authoring`
- Hook discovery: `automation.hook-discovery`
- Hook CLI management: `automation.hook-cli-management`
- Hook packs: `automation.hook-packs`
- Lifecycle event dispatch: `automation.lifecycle-event-dispatch`
- api.on registration: `automation.api-on-registration`
- Tool-call policy hooks: `automation.tool-call-policy-hooks`
- Message hooks: `automation.message-hooks`
- Session/lifecycle hooks: `automation.session-lifecycle-hooks`
- Plugin approval requests: `automation.plugin-approval-requests`
- cron_changed: `automation.cron-changed`

#### Background Tasks and Flows

- Category id: `automation-cron-hooks-tasks-polling.background-tasks-and-flows`
- Task list/show/cancel: `automation.task-list-show-cancel`
- Task notifications: `automation.task-notifications`
- Task audit and maintenance: `automation.task-audit-and-maintenance`
- Chat task board: `automation.chat-task-board`
- Task pressure status: `automation.task-pressure-status`
- Managed flows: `automation.managed-flows`
- Mirrored flows: `automation.mirrored-flows`
- openclaw tasks flow: `automation.openclaw-tasks-flow`
- Flow audit and maintenance: `automation.flow-audit-and-maintenance`
- Plugin managedFlows: `automation.plugin-managedflows`

#### Heartbeat

- Category id: `automation-cron-hooks-tasks-polling.heartbeat`
- Heartbeat scheduling: `automation.heartbeat-scheduling`
- Active hours: `automation.active-hours`
- Wake and cooldown handling: `automation.wake-and-cooldown-handling`
- Due-only heartbeat tasks: `automation.due-only-heartbeat-tasks`
- Commitment check-ins: `commitments.heartbeat-target-none`, `commitments.scope`, `runtime.delivery`

#### Polling Controls

- Category id: `automation-cron-hooks-tasks-polling.polling-controls`
- openclaw message poll: `automation.openclaw-message-poll`
- Telegram polls: `automation.telegram-polls`
- Teams polls: `automation.teams-polls`
- Poll flags: `automation.poll-flags`
- Channel capability gates: `automation.channel-capability-gates`
- process poll: `automation.process-poll`
- process log: `automation.process-log`
- Background process status: `automation.background-process-status`
- No-progress loop detection: `automation.no-progress-loop-detection`
- Process input controls: `automation.process-input-controls`

### Media understanding and media generation

- Surface id: `media-understanding-and-media-generation`

#### Media Intake and Access

- Category id: `media-understanding-and-media-generation.media-intake-and-access`
- Local and remote media references: `media.local-and-remote-media-references`
- MIME and type detection: `media.mime-and-type-detection`
- Size caps and bounded reads: `media.size-caps-and-bounded-reads`
- Safe remote fetch: `media.safe-remote-fetch`
- Local root policy: `media.local-root-policy`
- Inbound media store: `media.inbound-media-store`
- PDF/document extraction dispatch: `media.pdf-document-extraction-dispatch`
- QR and media helper classification: `media.qr-and-media-helper-classification`

#### Channel Media Handling

- Category id: `media-understanding-and-media-generation.channel-media-handling`
- Inbound attachment staging: `media.inbound-attachment-staging`
- Sandbox media rewrites: `media.sandbox-media-rewrites`
- Reply media templating: `media.reply-media-templating`
- Message-tool attachment delivery: `media.message-tool-attachment-delivery`
- Duplicate delivery suppression: `media.duplicate-delivery-suppression`

#### Media Configuration

- Category id: `media-understanding-and-media-generation.media-configuration`
- Media capability configuration: `media.capability-configuration`

#### Text-to-Speech Delivery

- Category id: `media-understanding-and-media-generation.text-to-speech-delivery`
- TTS: `media.tts`
- Outbound Voice Audio Delivery: `media.outbound-voice-audio-delivery`

#### Media Understanding

- Category id: `media-understanding-and-media-generation.media-understanding`
- Audio attachment selection: `media.audio-attachment-selection`
- Batch STT provider and CLI fallback: `media.batch-stt-provider-and-cli-fallback`
- Voice-note mention preflight: `media.voice-note-mention-preflight`
- Transcript insertion and echo: `media.transcript-insertion-and-echo`
- Audio proxy and limit handling: `media.audio-proxy-and-limit-handling`
- Inbound image summarization: `channels.qa-channel`, `media.image-understanding`, `ui.control`
- Active vision model bypass: `media.active-vision-model-bypass`
- Text-only model media offload: `media.text-only-model-media-offload`
- Vision provider fallback: `media.vision-provider-fallback`
- Image and PDF input routing: `media.image-and-pdf-input-routing`
- Video Understanding: `media.video-understanding`
- Direct Video Analysis: `media.direct-video-analysis`

#### Media Generation

- Category id: `media-understanding-and-media-generation.media-generation`
- Image generation tool invocation: `channels.qa-channel`, `media.image-generation`, `tools.image-generate`, `tools.native-image-generation`
- Image generation provider routing: `media.image-generation`, `tools.native-image-generation`
- Reference image editing: `media.reference-image-editing`
- Generated image task lifecycle: `media.generated-image-task-lifecycle`
- Generated image persistence and delivery: `media.image-generation-delivery`
- Music generation tool invocation: `media.music-generation-tool-invocation`
- Music generation provider controls: `media.music-generation-provider-controls`
- Lyrics, instrumental, duration, and format controls: `media.lyrics-instrumental-duration-and-format-controls`
- Reference inputs where supported: `media.reference-inputs-where-supported`
- Music task lifecycle and duplicate status: `media.music-task-lifecycle-and-duplicate-status`
- Generated audio persistence and delivery: `tools.tts`
- Video generation tool invocation: `media.video-generation-tool-invocation`
- Mode and provider capability selection: `media.mode-and-provider-capability-selection`
- Reference image, video, and audio inputs: `media.reference-image-video-and-audio-inputs`
- Provider option validation: `media.provider-option-validation`
- Video task lifecycle and status: `media.video-task-lifecycle-and-status`
- Generated video persistence and delivery: `media.generated-video-persistence-and-delivery`

### Voice and realtime talk

- Surface id: `voice-and-realtime-talk`

#### Talk Providers

- Category id: `voice-and-realtime-talk.talk-providers`
- OpenAI Realtime voice backend bridge: `voice.openai-realtime-voice-backend-bridge`
- Google Gemini Live backend bridge: `voice.google-gemini-live-backend-bridge`
- Realtime voice provider SDK contracts: `voice.realtime-voice-provider-sdk-contracts`
- Provider diagnostics: `models.diagnostics`
- Talk catalog: `voice.talk-catalog`
- Talk provider config: `voice.talk-provider-config`
- Shared native config parsing: `voice.shared-native-config-parsing`

#### Realtime Talk Sessions

- Category id: `voice-and-realtime-talk.realtime-talk-sessions`
- Agent consult handoff: `voice.agent-consult-handoff`
- Active Talk agent-run status: `voice.active-talk-agent-run-status`
- Talkback runtime behavior: `voice.talkback-runtime-behavior`
- Forced consult scheduling: `voice.forced-consult-scheduling`
- Browser Talk start/stop UI: `voice.browser-talk-start-stop-ui`
- Browser WebRTC sessions: `voice.browser-webrtc-sessions`
- Browser relay mode: `voice.browser-relay-mode`
- Browser tool-call forwarding: `voice.browser-tool-call-forwarding`
- Realtime session controls: `voice.realtime-session-controls`
- Gateway relay sessions: `voice.gateway-relay-sessions`
- Audio-frame limits: `voice.audio-frame-limits`

#### Speech and Transcription

- Category id: `voice-and-realtime-talk.speech-and-transcription`
- Voice directives: `voice.directives`
- Talk speech playback: `voice.talk-speech-playback`
- Transcription relay sessions: `voice.transcription-relay-sessions`
- Realtime transcription providers: `models.realtime-transcription-providers`
- Native directive parsing: `voice.native-directive-parsing`

#### Native App Talk

- Category id: `voice-and-realtime-talk.native-app-talk`
- macOS native Talk mode: `voice.macos-native-talk-mode`
- iOS Talk mode: `voice.ios-talk-mode`
- Android Talk mode: `voice.android-talk-mode`
- Shared Talk config: `voice.shared-talk-config`

#### Voice Wake and Routing

- Category id: `voice-and-realtime-talk.voice-wake-and-routing`
- Wake-word settings: `voice.wake-word-settings`
- Wake routing: `voice.wake-routing`
- macOS Voice Wake runtime: `voice.macos-voice-wake-runtime`
- Mobile wake preferences: `voice.mobile-wake-preferences`

#### Talk Observability

- Category id: `voice-and-realtime-talk.talk-observability`
- Talk event logging: `voice.talk-event-logging`
- Session-log health: `voice.session-log-health`
- Live smoke output: `voice.live-smoke-output`
- Prometheus diagnostic counters: `voice.prometheus-diagnostic-counters`
- Operator visibility into setup: `voice.operator-visibility-into-setup`

### Gateway Web App

- Surface id: `browser-control-ui-and-webchat`

#### Browser Realtime Talk

- Category id: `browser-control-ui-and-webchat.browser-realtime-talk`
- Browser Talk start/stop: `ui.browser-talk-start-stop`
- Provider session selection: `ui.provider-session-selection`
- Gateway relay audio: `ui.gateway-relay-audio`
- Tool-call consults: `ui.tool-call-consults`
- Steer and cancel: `ui.steer-and-cancel`

#### Browser Access and Trust

- Category id: `browser-control-ui-and-webchat.browser-access-and-trust`
- Device pairing: `ui.device-pairing`
- Token/password auth: `ui.token-password-auth`
- Tailscale Serve auth: `ui.tailscale-serve-auth`
- Trusted proxy auth: `security.trusted-proxy-auth`
- Allowed origins/gatewayUrl: `ui.allowed-origins-gatewayurl`

#### Configuration

- Category id: `browser-control-ui-and-webchat.configuration`
- Config snapshots: `ui.config-snapshots`
- Schema form editing: `ui.schema-form-editing`
- Raw JSON editing: `ui.raw-json-editing`
- Base-hash guarded writes: `ui.base-hash-guarded-writes`
- Apply and restart: `ui.apply-and-restart`

#### Browser UI

- Category id: `browser-control-ui-and-webchat.browser-ui`
- Gateway-hosted UI: `channels.qa-channel`, `media.image-understanding`, `ui.control`
- Dashboard open/auth bootstrap: `ui.dashboard-auth-bootstrap`
- Base-path routing: `ui.base-path-routing`
- Static asset recovery: `ui.static-asset-recovery`
- Dev gatewayUrl target: `ui.dev-gatewayurl-target`
- PWA install metadata: `ui.pwa-install-metadata`
- Service worker updates: `ui.service-worker-updates`
- VAPID keys: `ui.vapid-keys`
- Subscribe/unsubscribe: `ui.subscribe-unsubscribe`
- Test notifications: `ui.test-notifications`

#### WebChat Conversations

- Category id: `browser-control-ui-and-webchat.webchat-conversations`
- Send and abort: `ui.send-and-abort`
- Session and agent picker: `ui.session-and-agent-picker`
- Model/thinking controls: `ui.model-thinking-controls`
- Attachments: `ui.attachments`
- Markdown/tool/media rendering: `ui.markdown-tool-media-rendering`
- chat.history projection: `ui.chat-history-projection`
- chat.send lifecycle: `channels.qa-channel`, `channels.webchat`, `media.image-understanding`, `runtime.direct-reply-routing`, `tools.message`, `ui.control`
- Abort/partial retention: `ui.abort-partial-retention`
- Injected assistant notes: `ui.injected-assistant-notes`
- Reconnect continuity: `ui.reconnect-continuity`
- Hosted embeds: `ui.hosted-embeds`
- External embed gating: `ui.external-embed-gating`
- Assistant media tickets: `ui.assistant-media-tickets`
- Authenticated avatars: `ui.authenticated-avatars`
- CSP image policy: `ui.csp-image-policy`

#### Operator Console

- Category id: `browser-control-ui-and-webchat.operator-console`
- Health/status/models: `ui.health-status-models`
- Live log tail: `ui.live-log-tail`
- Update run/status: `runtime.gateway-restart`, `runtime.package-update`, `runtime.update-run`
- Activity summaries: `ui.activity-summaries`
- RPC timing telemetry: `ui.rpc-timing-telemetry`
- Channels/login: `ui.channels-login`
- Session manager and history: `ui.session-manager-and-history`
- Cron: `ui.cron`
- Skills/nodes: `ui.skills-nodes`
- Exec approvals/agents: `ui.exec-approvals-agents`

### TUI

- Surface id: `tui-and-terminal-ux`

#### Runtime Modes

- Category id: `tui-and-terminal-ux.runtime-modes`
- Gateway TUI launch: `tui.gateway-tui-launch`
- Local chat launch: `tui.local-chat-launch`
- Terminal alias launch: `tui.terminal-alias-launch`
- Initial message launch: `tui.initial-message-launch`
- Launch option validation: `tui.launch-option-validation`
- Gateway connection: `tui.gateway-connection`
- Gateway authentication: `tui.gateway-authentication`
- History load on attach: `tui.history-load-on-attach`
- Reconnect visibility: `tui.reconnect-visibility`
- Gateway command RPCs: `tui.gateway-command-rpcs`
- Embedded local chat: `tui.embedded-local-chat`
- Local auth flow: `tui.local-auth-flow`
- Config repair loop: `tui.config-repair-loop`
- Gateway-free recovery: `tui.gateway-free-recovery`

#### Input and Commands

- Category id: `tui-and-terminal-ux.input-and-commands`
- Message composition: `tui.message-composition`
- Input history: `tui.input-history`
- Keyboard shortcuts: `tui.keyboard-shortcuts`
- Paste and busy-submit handling: `tui.paste-and-busy-submit-handling`
- IME and AltGr handling: `tui.ime-and-altgr-handling`
- Slash Commands: `slack.slash-commands`
- Pickers: `tui.pickers`
- Settings: `tui.settings`

#### Session Management

- Category id: `tui-and-terminal-ux.session-management`
- Session Lifecycle: `tui.session-lifecycle`
- History: `tui.history`
- Resume: `tui.resume`

#### Local Shell Execution

- Category id: `tui-and-terminal-ux.local-shell-execution`
- Bang-command routing: `tui.bang-command-routing`
- Approval prompt: `tui.approval-prompt`
- Command output display: `tui.command-output-display`
- Execution environment marker: `tui.execution-environment-marker`

#### Rendering and Output Safety

- Category id: `tui-and-terminal-ux.rendering-and-output-safety`
- Streaming Message Rendering: `tui.streaming-message-rendering`
- Tool Cards: `tui.tool-cards`
- Terminal Rendering Primitives: `tui.terminal-rendering-primitives`
- Output Safety: `tui.output-safety`

### ClawHub

- Surface id: `clawhub-and-external-plugin-distribution`

#### Publishing

- Category id: `clawhub-and-external-plugin-distribution.publishing`
- ClawHub package publishing owner: `clawhub.package-publishing-owner`
- OpenClaw-owned package release validation for ClawHub: `clawhub.openclaw-owned-package-release-validation-for-clawhub`
- Version bump gates: `clawhub.version-bump-gates`
- npm trusted publishing provenance: `clawhub.npm-trusted-publishing-provenance`
- External code plugin package contract required: `clawhub.external-code-plugin-package-contract-required`
- Skill package metadata: `clawhub.skill-package-metadata`
- Skill publishing flow: `clawhub.skill-publishing-flow`

#### Catalog Discovery

- Category id: `clawhub-and-external-plugin-distribution.catalog-discovery`
- Plugin catalog search: `clawhub.openclaw-plugins-search-as-the-clawhub`
- Search result metadata: `clawhub.search-result-metadata`
- Plugin and skill search separation: `clawhub.distinction-between-plugin-search`
- Catalog lookup failure: `clawhub.catalog-lookup-failure`
- Skill catalog search: `clawhub.skill-catalog-search`

#### Compatibility and Trust

- Category id: `clawhub-and-external-plugin-distribution.compatibility-and-trust`
- openclaw.compat.pluginApi: `clawhub.openclaw-compat-pluginapi`
- ClawHub package compatibility validation: `clawhub.package-compatibility-validation`
- npm compatibility fallback to the newest: `clawhub.npm-compatibility-fallback-to-the-newest`
- Official external plugin catalog behavior: `clawhub.official-external-plugin-catalog-behavior`
- Compatibility docs: `clawhub.compatibility-docs`
- Operator trust model for installing: `clawhub.operator-trust-model-for-installing`
- ClawHub archive: `clawhub.archive`
- npm integrity drift: `clawhub.npm-integrity-drift`
- Built-in dangerous-code scanner: `clawhub.built-in-dangerous-code-scanner`
- ClawHub publishing review/hidden-release behavior as upstream: `clawhub.publishing-review-hidden-release-behavior-as-upstream`
- Skill archive safety: `clawhub.skill-archive-safety`
- Skill audit signals: `clawhub.skill-audit-signals`

#### Plugin Lifecycle and Health

- Category id: `clawhub-and-external-plugin-distribution.plugin-lifecycle-and-health`
- Source prefixes: `clawhub.source-prefixes`
- Bare package launch behavior: `clawhub.bare-package-behavior-during-the-launch`
- Explicit pinned versions: `clawhub.explicit-pinned-versions`
- Managed install records that preserve source: `clawhub.managed-install-records-that-preserve-source`
- Codex: `clawhub.codex`
- Local: `clawhub.local`
- Marketplace list: `clawhub.marketplace-list`
- Supported mapped features: `clawhub.supported-mapped-features`
- Remote marketplace path safety: `clawhub.remote-marketplace-path-safety`
- Update by plugin id: `clawhub.update-by-plugin-id`
- Reinstall vs update semantics: `clawhub.reinstall-vs-update-semantics`
- Downgrade: `clawhub.downgrade`
- Uninstall config/index/policy/file cleanup: `clawhub.uninstall-config-index-policy-file-cleanup`
- Gateway restart and reload requirements: `clawhub.gateway-restart-reload-requirements-after`
- Per-plugin managed npm project: `clawhub.per-plugin-managed-npm-project`
- npm-pack local release-candidate installs: `clawhub.npm-pack-local-release-candidate-installs`
- Dependency ownership between plugin packages: `clawhub.dependency-ownership-between-plugin-packages`
- Peer dependency relinking: `clawhub.peer-dependency-relinking`
- Legacy dependency root cleanup: `clawhub.legacy-dependency-root-cleanup`
- Plugin inventory commands: `clawhub.plugins-list`
- Local plugin index: `clawhub.local-plugin-index`
- Troubleshooting stale config: `clawhub.troubleshooting-stale-config`
- Runtime verification after Gateway: `clawhub.runtime-verification-after-gateway`
- ClawHub skill installs: `clawhub.skill-installs`
- Skill upload install path: `clawhub.skill-upload-install-path`
- Skill dependency installers: `clawhub.skill-dependency-installers`

### OpenClaw App SDK

- Surface id: `openclaw-app-sdk`

#### Client API

- Category id: `openclaw-app-sdk.client-api`
- SDK entrypoints: `app-sdk.sdk-entrypoints`
- Namespace layout: `app-sdk.namespace-layout`
- Package split: `app-sdk.package-split`
- App/plugin boundary: `app-sdk.app-plugin-boundary`

#### Gateway Access

- Category id: `openclaw-app-sdk.gateway-access`
- Gateway connect: `app-sdk.gateway-connect`
- URL and token config: `app-sdk.url-and-token-config`
- Auto gateway: `app-sdk.auto-gateway`
- Custom transport: `app-sdk.custom-transport`
- Scopes and redaction: `app-sdk.scopes-and-redaction`

#### Agent Conversations

- Category id: `openclaw-app-sdk.agent-conversations`
- Agent handles: `app-sdk.agent-handles`
- Agent runs: `app-sdk.agent-runs`
- Run results: `app-sdk.run-results`
- Session creation: `app-sdk.session-creation`
- Session send: `app-sdk.session-send`
- Session controls: `app-sdk.session-controls`

#### Events and Approvals

- Category id: `openclaw-app-sdk.events-and-approvals`
- Event stream: `app-sdk.event-stream`
- Event envelope: `app-sdk.event-envelope`
- Replay cursors: `app-sdk.replay-cursors`
- Approval callbacks: `app-sdk.approval-callbacks`
- Questions: `app-sdk.questions`

#### Resource Helpers

- Category id: `openclaw-app-sdk.resource-helpers`
- Models: `app-sdk.models`
- ToolSpace: `app-sdk.toolspace`
- Artifact resources: `workspace.artifacts`, `workspace.builds`
- Tasks: `app-sdk.tasks`
- Environments: `app-sdk.environments`

#### Compatibility

- Category id: `openclaw-app-sdk.compatibility`
- Generated client: `app-sdk.generated-client`
- Ergonomic wrappers: `app-sdk.ergonomic-wrappers`
- Unsupported calls: `app-sdk.unsupported-calls`
- Schema alignment: `app-sdk.schema-alignment`
- Public package contract: `app-sdk.public-package-contract`

## Platform

### macOS Gateway host

- Surface id: `macos-gateway-host`

#### CLI Setup

- Category id: `macos-gateway-host.cli-setup`
- Hosted installer: `macos.hosted-installer`
- Node 24 recommendation: `macos.node-24-recommendation`
- App-triggered CLI install: `macos.app-triggered-cli-install`
- Shell PATH and version-manager drift: `macos.shell-path-and-version-manager-drift`

#### Local Gateway Integration

- Category id: `macos-gateway-host.local-gateway-integration`
- App local/remote connection mode: `macos.app-local-remote-connection-mode`
- App-managed Gateway LaunchAgent install/restart/uninstall: `macos.app-managed-gateway-launchagent-install-restart-uninstall`
- CLI install detection: `macos.cli-install-detection`
- Attach-to-existing local Gateway compatibility: `macos.attach-to-existing-local-gateway-compatibility`
- Gateway endpoint: `macos.gateway-endpoint`
- gateway.mode=local configuration: `macos.gateway-mode-local-configuration`
- Loopback bind: `macos.loopback-bind`
- Local app endpoint resolution: `macos.local-app-endpoint-resolution`
- Bonjour discovery: `macos.bonjour-discovery`

#### Remote Gateway Mode

- Category id: `macos-gateway-host.remote-gateway-mode`
- macOS app "Remote over SSH": `macos.app-remote-over-ssh`
- SSH tunnel setup: `macos.ssh-tunnel-setup`
- Tailscale MagicDNS: `macos.tailscale-magicdns`
- Remote endpoint token/password/TLS fingerprint: `macos.remote-endpoint-token-password-tls-fingerprint`
- Local node host startup: `macos.local-node-host-startup`

#### Gateway Service Lifecycle

- Category id: `macos-gateway-host.gateway-service-lifecycle`
- Per-user Gateway LaunchAgent install: `macos.per-user-gateway-launchagent-install`
- launchctl bootstrap: `macos.launchctl-bootstrap`
- LaunchAgent labels: `macos.launchagent-labels`
- Gateway token/env handling: `macos.gateway-token-env-handling`
- App-managed LaunchAgent handoff: `macos.app-managed-launchagent-handoff`
- openclaw update package/git handoff: `macos.openclaw-update-package-git-handoff`
- Managed service refresh: `macos.managed-service-refresh`
- Stale updater launchd job detection: `macos.stale-updater-launchd-job-detection`
- openclaw uninstall: `macos.openclaw-uninstall`
- Stranded service recovery: `macos.stranded-service-recovery`

#### Diagnostics and Observability

- Category id: `macos-gateway-host.diagnostics-and-observability`
- LaunchAgent log paths: `macos.launchagent-log-paths`
- openclaw gateway status --deep: `macos.openclaw-gateway-status-deep`
- Gateway silently stops responding: `macos.gateway-silently-stops-responding`
- Stale updater jobs: `macos.stale-updater-jobs`

#### Permissions and Native Capabilities

- Category id: `macos-gateway-host.permissions-and-native-capabilities`
- macOS TCC permission prompts/status: `macos.tcc-permission-prompts-status`
- Native node capability exposure: `macos.native-node-capability-exposure`
- system.run policy: `macos.system-run-policy`
- Permission-driven support: `macos.permission-driven-support`

#### Profiles and Isolation

- Category id: `macos-gateway-host.profiles-and-isolation`
- Profile-specific LaunchAgent labels: `macos.profile-specific-launchagent-labels`
- Profile-specific state/config/workspace roots: `macos.profile-specific-state-config-workspace-roots`
- Derived ports: `macos.derived-ports`
- Rescue bot setup: `macos.rescue-bot-setup`
- Extra Gateway process detection: `macos.extra-gateway-process-detection`

### macOS companion app

- Surface id: `macos-companion-app`

#### Canvas

- Category id: `macos-companion-app.canvas`
- Canvas panel open/hide/navigate/eval/snapshot: `macos.canvas-panel-open-hide-navigate-eval-snapshot`
- Local custom URL scheme: `macos.local-custom-url-scheme`
- A2UI host auto-navigation: `macos.a2ui-host-auto-navigation`
- Canvas enable/disable setting: `macos.canvas-enable-disable-setting`

#### Local Setup

- Category id: `macos-companion-app.local-setup`
- Local mode Gateway attach/start/stop: `macos.local-mode-gateway-attach-start-stop`
- LaunchAgent install/update/restart/uninstall: `macos.launchagent-install-update-restart-uninstall`
- Existing-listener detection: `macos.existing-listener-detection`
- Native first-run onboarding flow: `macos.native-first-run-onboarding-flow`
- CLI discovery: `macos.cli-discovery`
- Local workspace selection: `macos.local-workspace-selection`
- Onboarding WebChat session separation: `macos.onboarding-webchat-session-separation`

#### Status and Settings

- Category id: `macos-companion-app.status-and-settings`
- Menu-bar status: `macos.menu-bar-status`
- Activity state ingestion: `macos.activity-state-ingestion`
- Settings navigation: `macos.settings-navigation`
- Health polling: `macos.health-polling`
- Channels settings: `macos.channels-settings`

#### Native Capabilities

- Category id: `macos-companion-app.native-capabilities`
- Mac node session connection: `macos.mac-node-session-connection`
- system.run: `macos.system-run`
- Exec approval policy: `macos.exec-approval-policy`
- Permission requests: `macos.permission-requests`
- TCC persistence: `macos.tcc-persistence`

#### Remote Connections

- Category id: `macos-companion-app.remote-connections`
- Remote connection mode selection: `macos.remote-connection-mode-selection`
- SSH tunnel: `macos.ssh-tunnel`
- Gateway discovery: `gateway.discovery`

#### Voice and Talk

- Category id: `macos-companion-app.voice-and-talk`
- Voice Wake runtime: `macos.voice-wake-runtime`
- Push-to-talk: `macos.push-to-talk`
- Talk provider playback plan: `macos.talk-provider-playback-plan`

#### WebChat

- Category id: `macos-companion-app.webchat`
- Native SwiftUI WebChat window: `macos.native-swiftui-webchat-window`
- Gateway chat transport: `gateway.chat-transport`
- Local and remote data-plane reuse: `macos.local-and-remote-data-plane-reuse`

#### Remote WebChat

- Category id: `macos-companion-app.remote-webchat`
- macOS WebChat transport: `macos.webchat-transport`
- SSH tunnel data plane: `macos.ssh-tunnel-data-plane`
- Direct ws/wss remote mode: `macos.direct-ws-wss-remote-mode`
- Session continuity: `memory.session-continuity`
- Remote troubleshooting: `macos.remote-troubleshooting`

### Linux Gateway host

- Surface id: `linux-gateway-host`

#### Host Setup and Updates

- Category id: `linux-gateway-host.host-setup-and-updates`
- Linux CLI install: `linux.cli-install`
- Node runtime prerequisites: `linux.node-runtime-prerequisites`
- Package-manager policy: `linux.package-manager-policy`
- Update path: `linux.update-path`

#### Gateway Runtime and Service Control

- Category id: `linux-gateway-host.gateway-runtime-and-service-control`
- Foreground Gateway Runtime: `linux.foreground-gateway-runtime`
- Process Control: `linux.process-control`
- Systemd User Service Lifecycle setup: `linux.systemd-user-service-lifecycle-setup`
- Systemd User Service Lifecycle operation: `linux.systemd-user-service-lifecycle-operation`
- Systemd User Service Lifecycle status: `linux.systemd-user-service-lifecycle-status`
- Systemd User Service Lifecycle recovery: `linux.systemd-user-service-lifecycle-recovery`

#### Remote Access and Security

- Category id: `linux-gateway-host.remote-access-and-security`
- Remote Network Exposure: `linux.remote-network-exposure`
- TLS: `linux.tls`
- Tailscale: `linux.tailscale`
- Gateway exposure safeguards: `linux.gateway-exposure-safeguards`
- Gateway authentication modes: `linux.gateway-authentication-modes`
- Secret Handling: `linux.secret-handling`

#### Diagnostics and Repair

- Category id: `linux-gateway-host.diagnostics-and-repair`
- Gateway diagnostic reports: `linux.gateway-diagnostic-reports`
- Gateway log tailing: `linux.gateway-log-tailing`
- Doctor checks: `telemetry.doctor-checks`
- Operator repair guidance: `linux.operator-repair-guidance`

#### Deployment Targets

- Category id: `linux-gateway-host.deployment-targets`
- VPS: `linux.vps`
- Container: `linux.container`
- Cloud Deployment Guidance: `linux.cloud-deployment-guidance`

### Linux companion app

- Surface id: `linux-companion-app`

#### App Distribution

- Category id: `linux-companion-app.app-distribution`
- Native app package: `linux.native-app-package`
- Distro package targets: `linux.distro-package-targets`
- Official release metadata: `linux.official-release-metadata`

#### Gateway Connectivity

- Category id: `linux-companion-app.gateway-connectivity`
- Local Gateway attach and status: `linux.local-gateway-attach-and-status`
- Gateway pairing and auth: `linux.gateway-pairing-and-auth`
- Remote mode: `linux.remote-mode`
- Local and remote resource boundaries: `linux.local-and-remote-resource-boundaries`

#### Chat and Sessions

- Category id: `linux-companion-app.chat-and-sessions`
- Native Linux chat window: `linux.native-linux-chat-window`
- Transcript: `linux.transcript`
- Gateway chat transport: `gateway.chat-transport`

#### Desktop Capabilities

- Category id: `linux-companion-app.desktop-capabilities`
- Linux desktop permissions: `linux.desktop-permissions`
- Secret storage: `linux.secret-storage`
- Sandbox/package posture: `linux.sandbox-package-posture`
- Linux native node identity: `linux.native-node-identity`
- Host command execution: `tools.host-command-execution`
- Desktop tools: `linux.desktop-tools`
- Linux native Talk: `linux.native-talk`
- Microphone capture: `linux.microphone-capture`
- Native media permissions: `linux.native-media-permissions`

#### Status and Diagnostics

- Category id: `linux-companion-app.status-and-diagnostics`
- Native Linux app readiness: `linux.native-linux-app-readiness`
- Gateway health/status display: `linux.gateway-health-status-display`
- Log/transcript opening: `linux.log-transcript-opening`
- Doctor/repair affordances: `linux.doctor-repair-affordances`
- Linux tray/status item: `linux.tray-status-item`
- Runtime status row: `linux.runtime-status-row`
- Desktop-environment integration: `linux.desktop-environment-integration`

### Windows via WSL2

- Surface id: `windows-via-wsl2`

#### WSL Setup

- Category id: `windows-via-wsl2.wsl-setup`
- WSL2 + Ubuntu installation: `wsl2.ubuntu-installation`
- Node runtime: `wsl2.node-runtime`
- Linux install flow inside WSL2: `wsl2.linux-install-flow-inside-wsl2`
- WSL2 runtime boundary: `wsl2.runtime-boundary`
- WSL2 network-family requirements: `wsl2.network-family-requirements`
- Source install and build inside WSL2: `wsl2.source-install-and-build-inside-wsl2`

#### CLI

- Category id: `windows-via-wsl2.cli`
- WSL2 CLI entrypoints: `wsl2.cli-entrypoints`
- openclaw onboard: `windows.openclaw-onboard`
- openclaw doctor status and logs: `wsl2.openclaw-doctor-status-and-logs`
- openclaw update: `wsl2.openclaw-update`
- npm/pnpm/git package-root: `wsl2.npm-pnpm-git-package-root`
- Managed systemd Gateway restart: `wsl2.managed-systemd-gateway-restart`
- Service metadata refresh: `wsl2.service-metadata-refresh`
- Package-manager caveats: `wsl2.package-manager-caveats`

#### Gateway Service Lifecycle

- Category id: `windows-via-wsl2.gateway-service-lifecycle`
- Onboarded systemd install: `wsl2.onboarded-systemd-install`
- Gateway service install: `wsl2.gateway-service-install`
- systemd user unit rendering: `wsl2.systemd-user-unit-rendering`
- WSL-aware systemd unavailable hints: `wsl2.wsl-aware-systemd-unavailable-hints`
- Doctor service repair: `wsl2.doctor-service-repair`
- WSL user-service linger: `wsl2.wsl-user-service-linger`
- Systemd availability after Windows boot: `wsl2.systemd-availability-after-windows-boot`
- Windows startup task for WSL: `wsl2.windows-startup-task-for-wsl`
- Verification before Windows sign-in: `wsl2.verification-before-windows-sign-in`
- Clear expectations around PC power: `wsl2.clear-expectations-around-pc-power`

#### Gateway Access and Exposure

- Category id: `windows-via-wsl2.gateway-access-and-exposure`
- Gateway token/password auth: `wsl2.gateway-token-password-auth`
- Provider credentials: `security.provider-credentials`
- Gateway auth SecretRefs: `wsl2.gateway-auth-secretrefs`
- Remote URL credential precedence: `wsl2.remote-url-credential-precedence`
- WSL virtual network: `wsl2.wsl-virtual-network`
- Windows portproxy setup: `wsl2.windows-portproxy-setup`
- Windows Firewall rules: `wsl2.windows-firewall-rules`
- Reachable Gateway URLs: `wsl2.reachable-gateway-urls`
- Loopback and LAN exposure: `wsl2.loopback-and-lan-exposure`
- WSL2 IPv4 networking: `wsl2.ipv4-networking`
- Tailscale remote access: `wsl2.tailscale-remote-access`

#### Diagnostics and Repair

- Category id: `windows-via-wsl2.diagnostics-and-repair`
- openclaw doctor: `runtime.codex-plugin.auth`, `runtime.codex-plugin.lifecycle`, `runtime.doctor-repair`
- openclaw status: `windows.openclaw-status`
- openclaw logs: `telemetry.openclaw-logs`
- SecretRef: `wsl2.secretref`
- WSL/systemd unavailable hints: `wsl2.wsl-systemd-unavailable-hints`
- Operator repair guidance after WSL2 service: `wsl2.operator-repair-guidance-after-wsl2-service`

#### Browser and Control UI

- Category id: `windows-via-wsl2.browser-and-control-ui`
- WSL2 Gateway with Windows browser: `wsl2.gateway-with-windows-browser`
- Windows Control UI URL: `wsl2.windows-control-ui-url`
- Raw remote CDP to Windows Chrome: `wsl2.raw-remote-cdp-to-windows-chrome`
- Host-local Chrome MCP: `wsl2.host-local-chrome-mcp`
- Browser profile cdpUrl: `wsl2.browser-profile-cdpurl`
- Layered diagnostics: `wsl2.layered-diagnostics`

### Native Windows

- Surface id: `native-windows-cli-and-gateway`

#### CLI

- Category id: `native-windows-cli-and-gateway.cli`
- PowerShell installer: `windows.powershell-installer`
- Node and package-manager bootstrap: `windows.node-and-package-manager-bootstrap`
- npm global install: `windows.npm-global-install`
- Packaged CLI launcher: `windows.packaged-cli-launcher`
- Windows command shims: `windows.command-shims`
- openclaw onboard: `windows.openclaw-onboard`
- Local Gateway config: `windows.local-gateway-config`
- Daemon install flags: `windows.daemon-install-flags`
- Native-vs-WSL setup boundary: `windows.native-vs-wsl-setup-boundary`

#### Gateway Management

- Category id: `native-windows-cli-and-gateway.gateway-management`
- openclaw gateway: `windows.openclaw-gateway`
- Foreground runtime health/readiness: `windows.foreground-runtime-health-readiness`
- Windows-specific restart/signal: `windows.specific-restart-signal`
- Unmanaged foreground mode: `windows.unmanaged-foreground-mode`
- openclaw gateway install: `windows.openclaw-gateway-install`
- Gateway launcher files: `windows.gateway-launcher-files`
- Scheduled Task runtime status: `windows.scheduled-task-runtime-status`
- Startup-folder fallback: `windows.startup-folder-fallback`
- openclaw status: `windows.openclaw-status`
- Windows service inspection: `windows.service-inspection`
- Post-install diagnostics: `windows.post-install-diagnostics`

#### Networking

- Category id: `native-windows-cli-and-gateway.networking`
- Native Windows host networking: `windows.native-windows-host-networking`
- netsh interface portproxy: `windows.netsh-interface-portproxy`
- Gateway status and probe output: `windows.gateway-status-and-probe-output`
- Loopback, LAN, and WSL boundary: `windows.loopback-lan-and-wsl-boundary`

#### Updates

- Category id: `native-windows-cli-and-gateway.updates`
- openclaw update on native Windows package: `windows.openclaw-update-on-native-windows-package`
- Managed Gateway stop/restart: `windows.managed-gateway-stop-restart`
- Detached update handoff: `windows.detached-update-handoff`
- Windows package locks: `windows.package-locks`

### Native Windows companion app

- Surface id: `native-windows-companion-app`

#### Installation and Updates

- Category id: `native-windows-companion-app.installation-and-updates`
- Official app download: `windows.official-app-download`
- MSI/MSIX/App Installer/winget-style packaging: `windows.msi-msix-app-installer-winget-style-packaging`
- Windows architecture handling for x64: `windows.architecture-handling-for-x64`
- App release channel: `windows.app-release-channel`

#### Gateway Connection

- Category id: `native-windows-companion-app.gateway-connection`
- App-managed local Gateway attach/start: `windows.app-managed-local-gateway-attach-start`
- Remote Gateway connection modes: `windows.remote-gateway-connection-modes`
- Device/node pairing: `windows.device-node-pairing`

#### Chat Sessions

- Category id: `native-windows-companion-app.chat-sessions`
- Native Windows chat window: `windows.native-windows-chat-window`
- Gateway chat transport: `gateway.chat-transport`

#### Status and Repair

- Category id: `native-windows-companion-app.status-and-repair`
- App health states: `windows.app-health-states`
- App-specific repair: `windows.app-specific-repair`
- Windows system tray app: `windows.system-tray-app`
- Status indicators: `windows.status-indicators`
- App-specific notification permission: `windows.app-specific-notification-permission`

#### Desktop Tools and Permissions

- Category id: `native-windows-companion-app.desktop-tools-and-permissions`
- Windows node identity: `windows.node-identity`
- Host command execution: `tools.host-command-execution`
- Desktop command policy: `windows.desktop-command-policy`
- App approval prompts: `windows.app-approval-prompts`
- Screen and media capture: `windows.screen-and-media-capture`
- Canvas host behavior: `windows.canvas-host-behavior`
- Windows shell integrations: `windows.shell-integrations`
- App secrets: `windows.app-secrets`
- Windows ACL: `windows.acl`
- Command approval: `windows.command-approval`

### Android app

- Surface id: `android-app`

#### Media Capture

- Category id: `android-app.media-capture`
- Camera and media capture: `android.camera-and-media-capture`

#### Mobile Chat

- Category id: `android-app.mobile-chat`
- Chat tab: `android.chat-tab`

#### Connection Setup

- Category id: `android-app.connection-setup`
- Gateway discovery: `gateway.discovery`

#### Distribution

- Category id: `android-app.distribution`
- Public Google Play install path: `android.public-google-play-install-path`
- Manual install path: `android.manual-install-path`
- Release smoke and startup performance: `android.release-smoke-and-startup-performance`

#### Settings

- Category id: `android-app.settings`
- Settings sheet: `android.settings-sheet`

#### Voice

- Category id: `android-app.voice`
- Voice tab: `android.voice-tab`

#### Device Runtime

- Category id: `android-app.device-runtime`
- Background reconnect and presence: `android.background-reconnect-and-presence`
- Device command availability: `android.device-command-availability`

### iOS app

- Surface id: `ios-app`

#### Media and Sharing

- Category id: `ios-app.media-and-sharing`
- Camera list/snap/clip: `ios.camera-list-snap-clip`

#### Canvas and Screen

- Category id: `ios-app.canvas-and-screen`
- Canvas present/hide/navigate/eval/snapshot: `ios.canvas-present-hide-navigate-eval-snapshot`

#### Chat and Sessions

- Category id: `ios-app.chat-and-sessions`
- Chat sessions and operator controls: `ios.chat-sessions-and-operator-controls`

#### Gateway Setup and Diagnostics

- Category id: `ios-app.gateway-setup-and-diagnostics`
- Bonjour/local: `ios.bonjour-local`
- Manual host/port: `ios.manual-host-port`
- Gateway connect configuration persistence: `ios.gateway-connect-configuration-persistence`
- TLS fingerprint trust prompt: `ios.tls-fingerprint-trust-prompt`
- Pairing approval: `ios.pairing-approval`
- Pairing/auth diagnostics for users: `ios.pairing-auth-diagnostics-for-users`
- Settings tab: `ios.settings-tab`

#### Distribution

- Category id: `ios-app.distribution`
- Internal preview status: `ios.internal-preview-status`

#### Device Commands

- Category id: `ios-app.device-commands`
- Location modes: `ios.location-modes`
- Device command handling: `ios.device-command-handling`

#### Notifications and Background

- Category id: `ios-app.notifications-and-background`
- APNs registration and relay delivery: `ios.apns-registration-and-relay-delivery`

#### Voice

- Category id: `ios-app.voice`
- Voice wake: `ios.voice-wake`

### watchOS companion surfaces

- Surface id: `watchos-companion-surfaces`

#### Delivery and Recovery

- Category id: `watchos-companion-surfaces.delivery-and-recovery`
- APNs relay/direct registration as it affects: `watchos.apns-relay-direct-registration-as-it-affects`
- Silent push: `watchos.silent-push`
- Pending approval recovery IDs: `watchos.pending-approval-recovery-ids`
- Gateway-side iOS exec approval: `watchos.gateway-side-ios-exec-approval`
- iPhone-side WatchConnectivity transport: `watchos.iphone-side-watchconnectivity-transport`
- Watch-side receiver activation: `watchos.watch-side-receiver-activation`
- Delivery fallback among reachable messages: `watchos.delivery-fallback-among-reachable-messages`

#### Exec Approvals

- Category id: `watchos-companion-surfaces.exec-approvals`
- Watch exec approval prompt: `watchos.watch-exec-approval-prompt`
- Watch approval list/detail UI: `watchos.watch-approval-list-detail-ui`
- iPhone-side prompt caching: `watchos.iphone-side-prompt-caching`

#### Distribution and Support

- Category id: `watchos-companion-surfaces.distribution-and-support`
- Watch app: `watchos.watch-app`
- Signing/profile variables: `watchos.signing-profile-variables`
- Public/support status: `watchos.public-support-status`
- Changelog: `watchos.changelog`
- Release metadata: `watchos.release-metadata`
- Historical bug/regression themes relevant to scoring: `watchos.historical-bug-regression-themes-relevant-to-scoring`

#### Notifications and Replies

- Category id: `watchos-companion-surfaces.notifications-and-replies`
- watch.status: `watchos.watch-status`
- Payload normalization: `watchos.payload-normalization`
- Mirrored iOS notification fallback when watch: `watchos.mirrored-ios-notification-fallback-when-watch`
- Watch action buttons from generic prompt: `watchos.watch-action-buttons-from-generic-prompt`
- Watch-to-iPhone reply payloads: `watchos.watch-to-iphone-reply-payloads`
- iPhone-side dedupe: `watchos.iphone-side-dedupe`
- Mirrored iOS notification action: `watchos.mirrored-ios-notification-action`

#### Watch App UI

- Category id: `watchos-companion-surfaces.watch-app-ui`
- Watch app entry point: `watchos.watch-app-entry-point`
- Generic inbox: `watchos.generic-inbox`
- Persistent watch inbox state: `watchos.persistent-watch-inbox-state`

### Raspberry Pi / small Linux devices

- Surface id: `raspberry-pi-small-linux-devices`

#### Setup and Compatibility

- Category id: `raspberry-pi-small-linux-devices.setup-and-compatibility`
- Hardware and 64-bit OS requirements: `raspberry-pi.hardware-and-64-bit-os-requirements`
- Node runtime setup: `raspberry-pi.node-runtime-setup`
- OpenClaw install and onboarding: `raspberry-pi.openclaw-install-and-onboarding`
- First-run verification: `raspberry-pi.first-run-verification`
- Supported Pi model selection: `raspberry-pi.supported-pi-model-selection`
- 64-bit ARM boundary: `raspberry-pi.64-bit-arm-boundary`
- Unsupported device guidance: `raspberry-pi.unsupported-device-guidance`
- Slow-device caveats: `raspberry-pi.slow-device-caveats`
- npm/pnpm/Bun install modes: `raspberry-pi.npm-pnpm-bun-install-modes`
- Installer architecture detection: `raspberry-pi.installer-architecture-detection`
- Optional ARM binary checks: `raspberry-pi.optional-arm-binary-checks`
- Fallback/build guidance: `raspberry-pi.fallback-build-guidance`

#### Remote Access and Auth

- Category id: `raspberry-pi-small-linux-devices.remote-access-and-auth`
- Headless API-key auth: `raspberry-pi.headless-api-key-auth`
- Gateway shared-secret auth: `raspberry-pi.gateway-shared-secret-auth`
- Device pairing approvals: `raspberry-pi.device-pairing-approvals`
- SecretRef handling: `raspberry-pi.secretref-handling`
- Token drift recovery: `raspberry-pi.token-drift-recovery`
- SSH tunnel dashboard access: `raspberry-pi.ssh-tunnel-dashboard-access`
- Tailscale Serve/Funnel: `raspberry-pi.tailscale-serve-funnel`
- Loopback/non-loopback exposure controls: `raspberry-pi.loopback-non-loopback-exposure-controls`
- Authenticated Control UI access: `raspberry-pi.authenticated-control-ui-access`

#### Gateway Runtime

- Category id: `raspberry-pi-small-linux-devices.gateway-runtime`
- Always-on Gateway process: `raspberry-pi.always-on-gateway-process`
- Cloud model configuration: `raspberry-pi.cloud-model-configuration`
- Channel startup: `raspberry-pi.channel-startup`
- Gateway health/status: `raspberry-pi.gateway-health-status`
- User service install: `raspberry-pi.user-service-install`
- linger/boot persistence: `raspberry-pi.linger-boot-persistence`
- Service drop-ins: `raspberry-pi.service-drop-ins`
- Restart tuning: `raspberry-pi.restart-tuning`
- Status/log inspection: `raspberry-pi.status-log-inspection`
- Backup/restore: `raspberry-pi.backup-restore`

#### Performance and Diagnostics

- Category id: `raspberry-pi-small-linux-devices.performance-and-diagnostics`
- Swap and low-RAM tuning: `raspberry-pi.swap-and-low-ram-tuning`
- USB SSD guidance: `raspberry-pi.usb-ssd-guidance`
- Compile cache/no-respawn settings: `raspberry-pi.compile-cache-no-respawn-settings`
- OOM/performance troubleshooting: `raspberry-pi.oom-performance-troubleshooting`
- Diagnostics bundles: `raspberry-pi.diagnostics-bundles`

### Docker / Podman hosting

- Surface id: `docker-podman-hosting`

#### Container Setup

- Category id: `docker-podman-hosting.container-setup`
- Local Image Setup Script: `docker.local-image-setup-script`
- Docker Compose gateway: `docker.compose-gateway`
- First-run onboarding: `docker.first-run-onboarding`
- Docker-only first-run notes: `docker.only-first-run-notes`
- Podman setup scripts and Quadlet template: `docker.setup-scripts-and-quadlet-template`
- Rootless Podman image setup: `docker.rootless-podman-image-setup`

#### Container Operations

- Category id: `docker-podman-hosting.container-operations`
- Host CLI routing into running Docker/Podman: `docker.host-cli-routing-into-running-docker-podman`
- Container Targeting: `docker.container-targeting`
- Container update/rebuild/restart guidance for Docker: `docker.container-update-rebuild-restart-guidance-for-docker`
- Docker Compose mounts and secrets: `docker.compose`
- Gateway token generation: `docker.gateway-token-generation`
- Ownership: `docker.ownership`
- Docker Compose network access: `docker.compose-network-access`
- Container health endpoints: `docker.container-health-endpoints`
- Provider/VPS Docker hosting docs: `docker.provider-vps-docker-hosting-docs`
- Docker VM persistence/update guidance: `docker.vm-persistence-update-guidance`
- Operator-facing update: `docker.operator-facing-update`

#### Image Release and Validation

- Category id: `docker-podman-hosting.image-release-and-validation`
- Root Dockerfile build stages: `docker.root-dockerfile-build-stages`
- Docker release workflow: `docker.release-workflow`
- Docker E2E package artifact generation: `docker.package-artifact-generation`
- Docker E2E plan/scheduler scripts: `docker.e2e`, `harness.qa-lab`, `telemetry.prometheus`
- Release-path install: `docker.release-path-install`

#### Agent Sandbox and Tooling

- Category id: `docker-podman-hosting.agent-sandbox-and-tooling`
- Docker gateway setup: `docker.gateway-setup`
- Docker-backed agent sandbox support: `docker.backed-agent-sandbox-support`
- Container image dependency baking: `docker.container-image-dependency-baking`

### Kubernetes hosting

- Surface id: `kubernetes-hosting`

#### Deployment Setup

- Category id: `kubernetes-hosting.deployment-setup`
- Kustomize packaging: `kubernetes.kustomize-packaging`
- Cluster prerequisites: `kubernetes.cluster-prerequisites`
- Quick deploy: `kubernetes.quick-deploy`
- Manifest apply: `kubernetes.manifest-apply`
- Kind validation: `kubernetes.kind-validation`

#### Configuration and Secrets

- Category id: `kubernetes-hosting.configuration-and-secrets`
- Agent instructions: `kubernetes.agent-instructions`
- Gateway config: `kubernetes.gateway-config`
- Provider secrets: `kubernetes.provider-secrets`
- Secret rotation: `kubernetes.secret-rotation`
- Image and namespace: `kubernetes.image-and-namespace`

#### Access and Exposure

- Category id: `kubernetes-hosting.access-and-exposure`
- Port-forward access: `kubernetes.port-forward-access`
- Service endpoint: `kubernetes.service-endpoint`
- Ingress exposure: `kubernetes.ingress-exposure`
- Auth and TLS: `kubernetes.auth-and-tls`
- Localhost posture: `kubernetes.localhost-posture`

#### Cluster Lifecycle

- Category id: `kubernetes-hosting.cluster-lifecycle`
- Resource layout: `kubernetes.resource-layout`
- State persistence: `kubernetes.state-persistence`
- Redeploy: `kubernetes.redeploy`
- Teardown: `kubernetes.teardown`
- Security context: `kubernetes.security-context`

### Nix install path

- Surface id: `nix-install-path`

#### Install Handoff

- Category id: `nix-install-path.install-handoff`
- Nix install overview: `nix.install-overview`
- nix-openclaw source-of-truth: `nix.openclaw-source-of-truth`
- Install discoverability: `nix.install-discoverability`
- Verification handoff: `nix.verification-handoff`

#### Plugin Lifecycle

- Category id: `nix-install-path.plugin-lifecycle`
- Lifecycle command refusal: `nix.lifecycle-command-refusal`
- Declarative plugin selection: `nix.declarative-plugin-selection`
- Nix-store plugin loading: `nix.store-plugin-loading`
- Hardlink safety: `nix.hardlink-safety`

#### Activation and App UX

- Category id: `nix-install-path.activation-and-app-ux`
- Environment activation: `nix.environment-activation`
- macOS defaults activation: `nix.macos-defaults-activation`
- Runtime Nix-mode detection: `nix.runtime-nix-mode-detection`
- Stable Nix defaults: `nix.stable-nix-defaults`
- Managed-by-Nix banner: `nix.managed-by-nix-banner`
- Read-only config controls: `nix.read-only-config-controls`
- Onboarding skip: `nix.onboarding-skip`

#### Config and State

- Category id: `nix-install-path.config-and-state`
- Immutable config guard: `nix.immutable-config-guard`
- Config writer refusal: `nix.config-writer-refusal`
- Agent-first Nix edits: `nix.agent-first-nix-edits`
- Explicit config path: `nix.explicit-config-path`
- Writable state directory: `nix.writable-state-directory`
- Immutable-store config support: `nix.immutable-store-config-support`
- State integrity checks: `nix.state-integrity-checks`

#### Service Runtime and Guards

- Category id: `nix-install-path.service-runtime-and-guards`
- Nix profile PATH discovery: `nix.profile-path-discovery`
- Profile precedence: `nix.profile-precedence`
- Service PATH fallback: `nix.service-path-fallback`
- Trusted binary boundaries: `nix.trusted-binary-boundaries`
- Setup write refusal: `nix.setup-write-refusal`
- Doctor repair refusal: `nix.doctor-repair-refusal`
- Update handoff: `nix.update-handoff`
- Service lifecycle handoff: `nix.service-lifecycle-handoff`

## Channel

### Discord

- Surface id: `discord`

#### Channel Setup and Operations

- Category id: `discord.channel-setup-and-operations`
- Application and bot setup: `discord.application-and-bot-setup`
- Token and application ID configuration: `discord.token-and-application-id-configuration`
- Setup wizard and account inspection: `discord.setup-wizard-and-account-inspection`
- Status, doctor, and intent checks: `discord.status-doctor-and-intent-checks`
- Multi-account bot configuration: `discord.multi-account-bot-configuration`
- Account monitor startup: `discord.account-monitor-startup`
- Gateway WebSocket lifecycle: `discord.gateway-websocket-lifecycle`
- Reconnect and heartbeat handling: `discord.reconnect-and-heartbeat-handling`
- Rate limits and gateway metadata: `discord.rate-limits-and-gateway-metadata`
- Status, probe, and health-monitor recovery: `discord.status-probe-and-health-monitor-recovery`

#### Access and Identity

- Category id: `discord.access-and-identity`
- DM policy modes: `discord.dm-policy-modes`
- Allowlist inheritance: `discord.allowlist-inheritance`
- Pairing-code approval: `security.pairing-code-approval`
- Sender authorization: `security.sender-authorization`
- Access-group authorization: `discord.access-group-authorization`
- Group DM authorization: `discord.group-dm-authorization`

#### Conversation Routing and Delivery

- Category id: `discord.conversation-routing-and-delivery`
- Guild and channel admission: `discord.guild-and-channel-admission`
- Mention gating: `channels.mention-gating`
- Session key isolation: `discord.session-key-isolation`
- Configured and runtime routing: `discord.configured-and-runtime-routing`
- Inbound context visibility: `discord.inbound-context-visibility`
- Forum and media-channel thread posts: `discord.forum-and-media-channel-thread-posts`
- Thread actions: `discord.thread-actions`
- Target parsing: `discord.target-parsing`
- Thread context resolution: `discord.thread-context-resolution`
- Thread-bound session routing: `discord.thread-bound-session-routing`
- ACP agent routing: `discord.acp-agent-routing`
- Routing lifecycle: `discord.routing-lifecycle`

#### Media and Rich Content

- Category id: `discord.media-and-rich-content`
- Media and Rich Content: `channels.media-rich-content`

#### Native Controls and Approvals

- Category id: `discord.native-controls-and-approvals`
- Native slash command registration: `discord.native-slash-command-registration`
- Native slash command execution: `discord.native-slash-command-execution`
- Model Picker Commands: `discord.model-picker-commands`
- Components v2 messages: `discord.components-v2-messages`
- Callback TTL: `discord.callback-ttl`

#### Realtime Voice and Calls

- Category id: `discord.realtime-voice-and-calls`
- Voice Channel Lifecycle: `discord.voice-channel-lifecycle`
- Auto-join and follow-users: `discord.auto-join-and-follow-users`
- Realtime voice modes: `discord.realtime-voice-modes`
- Wake, barge-in, and echo handling: `discord.wake-barge-in-and-echo-handling`
- Voice codec and DAVE recovery: `discord.voice-codec-and-dave-recovery`

### Telegram

- Surface id: `telegram`

#### Channel Setup and Operations

- Category id: `telegram.channel-setup-and-operations`
- BotFather token creation: `telegram.botfather-token-creation`
- TELEGRAM_BOT_TOKEN: `telegram.bot-token`
- Setup wizard credential capture: `telegram.setup-wizard-credential-capture`
- Startup getMe: `telegram.startup-getme`
- Doctor/status surfacing: `telegram.doctor-status-surfacing`
- Named account configuration: `telegram.named-account-configuration`
- CLI/message-tool targets: `telegram.cli-message-tool-targets`
- Directory adapters: `telegram.directory-adapters`
- Channel status: `telegram.channel-status`
- Account-scoped outbound: `telegram.account-scoped-outbound`

#### Access and Identity

- Category id: `telegram.access-and-identity`
- dmPolicy modes: `telegram.dmpolicy-modes`
- Pairing-code approval: `security.pairing-code-approval`
- Numeric Telegram user ID normalization with telegram: `telegram.numeric-telegram-user-id-normalization-with-telegram`
- allowFrom: `telegram.allowfrom`
- Unauthorized DM: `telegram.unauthorized-dm`
- Group allowlists: `security.group-allowlists`
- Supergroup negative chat IDs: `telegram.supergroup-negative-chat-ids`
- Forum topic session keys: `telegram.forum-topic-session-keys`
- ACP topic routing: `telegram.acp-topic-routing`
- Session key construction: `memory.session-key-construction`

#### Conversation Routing and Delivery

- Category id: `telegram.conversation-routing-and-delivery`
- Conversation Routing and Delivery: `channels.conversation-routing-delivery`

#### Media and Rich Content

- Category id: `telegram.media-and-rich-content`
- Media and Rich Content: `channels.media-rich-content`

#### Native Controls and Approvals

- Category id: `telegram.native-controls-and-approvals`
- Inline keyboard rendering: `telegram.inline-keyboard-rendering`
- Exec approvals in DMs: `telegram.exec-approvals-in-dms`
- Message actions: `channels.message-actions`
- Action capability discovery: `telegram.action-capability-discovery`
- Native setMyCommands startup sync: `telegram.native-setmycommands-startup-sync`
- Command name/description normalization: `telegram.command-name-description-normalization`
- Built-in commands: `telegram.built-in-commands`
- Command authorization in DMs: `telegram.command-authorization-in-dms`
- Model buttons: `telegram.model-buttons`

### WhatsApp

- Surface id: `whatsapp`

#### Channel Setup and Operations

- Category id: `whatsapp.channel-setup-and-operations`
- Official @openclaw/whatsapp plugin metadata: `whatsapp.official-openclaw-whatsapp-plugin-metadata`
- openclaw plugin install whatsapp: `whatsapp.openclaw-plugin-install-whatsapp`
- Channel config schema: `whatsapp.channel-config-schema`
- Baileys socket lifecycle: `whatsapp.baileys-socket-lifecycle`
- Operator troubleshooting: `whatsapp.operator-troubleshooting`

#### Access and Identity

- Category id: `whatsapp.access-and-identity`
- QR login: `whatsapp.qr-login`
- Baileys multi-file auth persistence: `whatsapp.baileys-multi-file-auth-persistence`
- DM pairing challenge: `whatsapp.dm-pairing-challenge`
- Multi-account/default-account resolution: `whatsapp.multi-account-default-account-resolution`
- Direct-message dmPolicy: `whatsapp.direct-message-dmpolicy`
- Sender identity extraction: `whatsapp.sender-identity-extraction`
- Privacy controls for plugin hooks: `whatsapp.privacy-controls-for-plugin-hooks`

#### Conversation Routing and Delivery

- Category id: `whatsapp.conversation-routing-and-delivery`
- Group allowlists: `security.group-allowlists`
- Group session keys: `whatsapp.group-session-keys`
- Outbound text sends: `whatsapp.outbound-text-sends`
- Provider-accepted receipts: `whatsapp.provider-accepted-receipts`

#### Media and Rich Content

- Category id: `whatsapp.media-and-rich-content`
- Inbound media download: `whatsapp.inbound-media-download`
- Outbound image: `whatsapp.outbound-image`

#### Native Controls and Approvals

- Category id: `whatsapp.native-controls-and-approvals`
- Native exec: `whatsapp.native-exec`
- Approver target resolution: `whatsapp.approver-target-resolution`

### Slack

- Surface id: `slack`

#### Channel Setup and Operations

- Category id: `slack.channel-setup-and-operations`
- App Install: `slack.app-install`
- Slack app credentials: `slack.app-credentials`
- Manifest: `slack.manifest`
- Scopes: `slack.scopes`
- Channel status diagnostics: `slack.channel-status-diagnostics`
- Slack account status: `slack.account-status`
- Operator Repair: `codex.operator-repair`
- Socket: `slack.socket`
- HTTP transport: `slack.http-transport`
- Runtime Lifecycle: `slack.runtime-lifecycle`

#### Access and Identity

- Category id: `slack.access-and-identity`
- Access and Identity: `channels.access-and-identity`

#### Conversation Routing and Delivery

- Category id: `slack.conversation-routing-and-delivery`
- Channel allowlists: `slack.channel-allowlists`
- Thread routing: `slack.thread-routing`
- Session Isolation: `slack.session-isolation`
- DM Pairing: `security.dm-pairing`
- Sender Authorization: `security.sender-authorization`

#### Media and Rich Content

- Category id: `slack.media-and-rich-content`
- Media and Rich Content: `channels.media-rich-content`

#### Native Controls and Approvals

- Category id: `slack.native-controls-and-approvals`
- Slash Commands: `slack.slash-commands`
- Native Command Routing: `slack.native-command-routing`
- Interactive Replies: `slack.interactive-replies`
- App Home: `slack.app-home`
- Assistant Events: `slack.assistant-events`
- Native Approvals: `security.native-approvals`
- Actions: `slack.actions`
- Security-sensitive Ops: `slack.security-sensitive-ops`

### iMessage / BlueBubbles

- Surface id: `imessage-bluebubbles`

#### Channel Setup and Operations

- Category id: `imessage-bluebubbles.channel-setup-and-operations`
- Translate legacy config: `imessage.translate-legacy-config`
- Cut over safely: `imessage.cut-over-safely`
- Handle migration caveats: `imessage.handle-migration-caveats`
- Run local imsg: `imessage.run-local-imsg`
- Run through SSH wrapper: `imessage.run-through-ssh-wrapper`
- Grant macOS permissions: `imessage.grant-macos-permissions`
- Probe runtime health: `imessage.probe-runtime-health`
- Account setup prompts: `imessage.account-setup-prompts`
- Account status checks: `imessage.account-status-checks`
- Doctor repair checks: `imessage.doctor-repair-checks`
- Account Config: `imessage.account-config`

#### Access and Identity

- Category id: `imessage-bluebubbles.access-and-identity`
- Authorize direct senders: `imessage.authorize-direct-senders`
- Route direct conversations: `imessage.route-direct-conversations`
- Bind ACP sessions: `imessage.bind-acp-sessions`
- Group Policy: `imessage.group-policy`
- Mentions: `imessage.mentions`
- System Prompts: `imessage.system-prompts`

#### Conversation Routing and Delivery

- Category id: `imessage-bluebubbles.conversation-routing-and-delivery`
- Watch live messages: `imessage.watch-live-messages`
- Coalesce split-send DMs: `imessage.coalesce-split-send-dms`
- Replay missed messages: `imessage.replay-missed-messages`
- Seed conversation history: `imessage.seed-conversation-history`

#### Media and Rich Content

- Category id: `imessage-bluebubbles.media-and-rich-content`
- Media: `imessage.media`
- Attachments: `ui.attachments`
- Remote Fetch: `imessage.remote-fetch`
- Chunking: `imessage.chunking`
- Native Actions: `imessage.native-actions`
- Private API: `imessage.private-api`
- Message Tool: `imessage.message-tool`

#### Native Controls and Approvals

- Category id: `imessage-bluebubbles.native-controls-and-approvals`
- Native Approvals: `security.native-approvals`
- Reactions: `imessage.reactions`
- Operator Control: `imessage.operator-control`

### Signal

- Surface id: `signal`

#### Channel Setup and Operations

- Category id: `signal.channel-setup-and-operations`
- QR link setup: `signal.qr-link-setup`
- SMS registration: `signal.sms-registration`
- Installer and binary setup: `signal.installer-and-binary-setup`
- Container account provisioning: `signal.container-account-provisioning`
- Status probes: `signal.status-probes`
- Setup diagnostics: `signal.setup-diagnostics`
- Account safety guardrails: `signal.account-safety-guardrails`

#### Access and Identity

- Category id: `signal.access-and-identity`
- DM pairing: `security.dm-pairing`
- DM allowlists: `signal.dm-allowlists`
- Sender identity normalization: `signal.sender-identity-normalization`
- Group allowlists: `security.group-allowlists`
- Mention gates: `matrix.mention-gates`
- Pending group history: `signal.pending-group-history`

#### Conversation Routing and Delivery

- Category id: `signal.conversation-routing-and-delivery`
- Conversation Routing and Delivery: `channels.conversation-routing-delivery`

#### Media and Rich Content

- Category id: `signal.media-and-rich-content`
- Text delivery targets: `signal.text-delivery-targets`
- Media delivery and limits: `signal.media-delivery-and-limits`
- Typing and read receipts: `signal.typing-and-read-receipts`
- Styled/chunked output: `signal.styled-chunked-output`
- Reaction action discovery: `signal.reaction-action-discovery`
- Add/remove reactions: `signal.add-remove-reactions`
- Group reaction targeting: `signal.group-reaction-targeting`

#### Native Controls and Approvals

- Category id: `signal.native-controls-and-approvals`
- Native approval routing: `signal.native-approval-routing`
- Reaction approval responses: `signal.reaction-approval-responses`
- Approver targeting: `signal.approver-targeting`

### Google Chat

- Surface id: `google-chat`

#### Channel Setup and Operations

- Category id: `google-chat.channel-setup-and-operations`
- Google Cloud project setup: `google-chat.google-cloud-project-setup`
- Chat app configuration: `google-chat.chat-app-configuration`
- Service account setup: `google-chat.service-account-setup`
- Webhook audience and path: `google-chat.webhook-audience-and-path`
- Workspace visibility and app status: `google-chat.workspace-visibility-and-app-status`
- Guided channel setup: `google-chat.guided-channel-setup`
- Account resolution: `google-chat.account-resolution`
- Service account SecretRefs: `google-chat.service-account-secretrefs`
- Env file and inline credentials: `google-chat.env-file-and-inline-credentials`
- Channel status and probes: `google-chat.channel-status-and-probes`
- Directory and mutable-id diagnostics: `google-chat.directory-and-mutable-id-diagnostics`
- NPM and ClawHub install: `google-chat.npm-and-clawhub-install`
- Plugin docs and catalog routing: `google-chat.plugin-docs-and-catalog-routing`
- Channel aliases and labels: `google-chat.channel-aliases-and-labels`
- Operator status UI: `google-chat.operator-status-ui`
- Install/update metadata: `google-chat.install-update-metadata`

#### Access and Identity

- Category id: `google-chat.access-and-identity`
- DM pairing approval: `google-chat.dm-pairing-approval`
- Sender allowlists: `google-chat.sender-allowlists`
- Google Chat identity matching: `google-chat.identity-matching`
- Direct session routing: `google-chat.direct-session-routing`
- Pairing diagnostics: `google-chat.pairing-diagnostics`
- Space allowlists: `google-chat.space-allowlists`
- Mention gating: `channels.mention-gating`
- Sender access groups: `google-chat.sender-access-groups`
- Group session isolation: `google-chat.group-session-isolation`
- Bot-loop protection: `channels.bot-loop-protection`
- Space diagnostics: `google-chat.space-diagnostics`

#### Conversation Routing and Delivery

- Category id: `google-chat.conversation-routing-and-delivery`
- Conversation Routing and Delivery: `channels.conversation-routing-delivery`

#### Media and Rich Content

- Category id: `google-chat.media-and-rich-content`
- Media and Rich Content: `channels.media-rich-content`

#### Native Controls and Approvals

- Category id: `google-chat.native-controls-and-approvals`
- Inbound attachments: `google-chat.inbound-attachments`
- Outbound media replies: `google-chat.outbound-media-replies`
- Message upload action: `google-chat.message-upload-action`
- Media source and size controls: `google-chat.media-source-and-size-controls`
- Media receipts and thread placement: `google-chat.media-receipts-and-thread-placement`
- Text send action: `google-chat.text-send-action`
- Upload-file action: `google-chat.upload-file-action`
- Reaction actions: `google-chat.reaction-actions`
- Action capability gates: `google-chat.action-capability-gates`
- Approval sender matching: `google-chat.approval-sender-matching`
- Thread-aware replies: `google-chat.thread-aware-replies`
- Streaming and chunked replies: `google-chat.streaming-and-chunked-replies`
- Typing placeholder lifecycle: `google-chat.typing-placeholder-lifecycle`
- Message-tool current-source replies: `google-chat.message-tool-current-source-replies`
- NO_REPLY cleanup: `google-chat.no-reply-cleanup`
- Markdown/text rendering: `google-chat.markdown-text-rendering`

### Matrix

- Surface id: `matrix`

#### Channel Setup and Operations

- Category id: `matrix.channel-setup-and-operations`
- Matrix plugin identity: `matrix.plugin-identity`
- Setup wizard: `matrix.setup-wizard`
- Account discovery: `matrix.account-discovery`
- Matrix doctor warnings: `matrix.doctor-warnings`
- Matrix probe/status: `matrix.probe-status`

#### Access and Identity

- Category id: `matrix.access-and-identity`
- DM policy: `matrix.dm-policy`
- Direct-room classification: `matrix.direct-room-classification`
- Inbound route selection across sender-bound DMs: `matrix.inbound-route-selection-across-sender-bound-dms`
- Mention gates: `matrix.mention-gates`
- Matrix thread reply routing: `matrix.thread-reply-routing`
- Persisted Matrix thread routing managers: `matrix.persisted-matrix-thread-routing-managers`
- ACP/subagent spawn hooks: `matrix.acp-subagent-spawn-hooks`

#### Conversation Routing and Delivery

- Category id: `matrix.conversation-routing-and-delivery`
- Conversation Routing and Delivery: `channels.conversation-routing-delivery`

#### Media and Rich Content

- Category id: `matrix.media-and-rich-content`
- Media and Rich Content: `channels.media-rich-content`

#### Native Controls and Approvals

- Category id: `matrix.native-controls-and-approvals`
- Channel action discovery: `matrix.channel-action-discovery`
- Message send/read/edit/delete: `matrix.message-send-read-edit-delete`
- Profile media loading: `matrix.profile-media-loading`
- Outbound Matrix text: `matrix.outbound-matrix-text`
- Message presentation metadata: `matrix.message-presentation-metadata`
- Inbound media failure handling: `matrix.inbound-media-failure-handling`

#### Encryption and Verification

- Category id: `matrix.encryption-and-verification`
- Encryption setup: `matrix.encryption-setup`
- Encrypted media upload/download: `matrix.encrypted-media-upload-download`
- Legacy state: `matrix.legacy-state`

### Microsoft Teams

- Surface id: `microsoft-teams`

#### Channel Setup and Operations

- Category id: `microsoft-teams.channel-setup-and-operations`
- Teams CLI app creation: `microsoft-teams.teams-cli-app-creation`
- Bot registration and manifest upload: `microsoft-teams.bot-registration-and-manifest-upload`
- Credential configuration: `microsoft-teams.credential-configuration`
- Teams app install verification: `microsoft-teams.teams-app-install-verification`
- Setup status: `microsoft-teams.setup-status`
- Probe and scope reporting: `microsoft-teams.probe-and-scope-reporting`
- Teams app doctor: `microsoft-teams.teams-app-doctor`
- Webhook and health diagnostics: `microsoft-teams.webhook-and-health-diagnostics`
- Operator repair paths: `microsoft-teams.operator-repair-paths`

#### Access and Identity

- Category id: `microsoft-teams.access-and-identity`
- DM pairing: `security.dm-pairing`
- Stable sender identity: `microsoft-teams.stable-sender-identity`
- Allowlists and access groups: `microsoft-teams.allowlists-and-access-groups`
- Invoke and command authorization: `microsoft-teams.invoke-and-command-authorization`
- Teams-originated config writes: `microsoft-teams.teams-originated-config-writes`
- Bot Framework SSO invokes: `microsoft-teams.bot-framework-sso-invokes`
- Delegated token storage: `microsoft-teams.delegated-token-storage`
- Graph directory lookup: `microsoft-teams.graph-directory-lookup`
- Member profile lookup: `microsoft-teams.member-profile-lookup`

#### Conversation Routing and Delivery

- Category id: `microsoft-teams.conversation-routing-and-delivery`
- Team and channel allowlists: `microsoft-teams.team-and-channel-allowlists`
- Deterministic channel replies: `microsoft-teams.deterministic-channel-replies`
- Mention-gated group access: `microsoft-teams.mention-gated-group-access`
- Session routing: `memory.session-routing`
- Reply and thread context: `microsoft-teams.reply-and-thread-context`

#### Media and Rich Content

- Category id: `microsoft-teams.media-and-rich-content`
- Inbound attachments: `google-chat.inbound-attachments`
- Graph-hosted media: `microsoft-teams.graph-hosted-media`
- File consent: `microsoft-teams.file-consent`
- SharePoint and OneDrive sharing: `microsoft-teams.sharepoint-and-onedrive-sharing`
- Media fetch safety: `microsoft-teams.media-fetch-safety`

#### Native Controls and Approvals

- Category id: `microsoft-teams.native-controls-and-approvals`
- Message action discovery: `microsoft-teams.message-action-discovery`
- Polls and reactions: `microsoft-teams.polls-and-reactions`
- Read, edit, delete, and pin: `microsoft-teams.read-edit-delete-and-pin`
- Native approval cards: `microsoft-teams.native-approval-cards`
- Feedback and group actions: `microsoft-teams.feedback-and-group-actions`

### Mattermost, LINE, IRC, Nextcloud Talk, Nostr, Twitch, Tlon, Synology Chat

- Surface id: `mattermost-line-irc-nextcloud-talk-nostr-twitch-tlon-synology-chat`

#### Channel Setup and Operations

- Category id: `mattermost-line-irc-nextcloud-talk-nostr-twitch-tlon-synology-chat.channel-setup-and-operations`
- Channel Setup and Operations: `channels.setup-operations`

#### Access and Identity

- Category id: `mattermost-line-irc-nextcloud-talk-nostr-twitch-tlon-synology-chat.access-and-identity`
- Access and Identity: `channels.access-and-identity`

#### Conversation Routing and Delivery

- Category id: `mattermost-line-irc-nextcloud-talk-nostr-twitch-tlon-synology-chat.conversation-routing-and-delivery`
- Conversation Routing and Delivery: `channels.conversation-routing-delivery`

#### Media and Rich Content

- Category id: `mattermost-line-irc-nextcloud-talk-nostr-twitch-tlon-synology-chat.media-and-rich-content`
- Media and Rich Content: `channels.media-rich-content`

### Feishu, QQ Bot, WeChat, Yuanbao, Zalo, Zalo Personal, regional channels

- Surface id: `feishu-qq-bot-wechat-yuanbao-zalo-zalo-personal-regional-channels`

#### Channel Setup and Operations

- Category id: `feishu-qq-bot-wechat-yuanbao-zalo-zalo-personal-regional-channels.channel-setup-and-operations`
- Docs channel index: `regional-channels.docs-channel-index`
- Official external channel catalog entries: `regional-channels.official-external-channel-catalog-entries`
- Core channel-plugin catalog: `regional-channels.core-channel-plugin-catalog`
- Channel setup wizard: `regional-channels.channel-setup-wizard`
- Missing-plugin: `regional-channels.missing-plugin`
- Cross-channel ingress/access/refactor concerns: `regional-channels.cross-channel-ingress-access-refactor-concerns`

#### Access and Identity

- Category id: `feishu-qq-bot-wechat-yuanbao-zalo-zalo-personal-regional-channels.access-and-identity`
- Access and Identity: `channels.access-and-identity`

#### Conversation Routing and Delivery

- Category id: `feishu-qq-bot-wechat-yuanbao-zalo-zalo-personal-regional-channels.conversation-routing-and-delivery`
- Conversation Routing and Delivery: `channels.conversation-routing-delivery`

#### Media and Rich Content

- Category id: `feishu-qq-bot-wechat-yuanbao-zalo-zalo-personal-regional-channels.media-and-rich-content`
- Media and Rich Content: `channels.media-rich-content`

### Voice Call channel

- Surface id: `voice-call-channel`

#### Channel Setup and Operations

- Category id: `voice-call-channel.channel-setup-and-operations`
- Voice call CLI, RPC, and agent tool: `voice-call.cli-rpc-agent-tool`
- Voice call setup smoke: `voice-call.setup-smoke`

#### Access and Identity

- Category id: `voice-call-channel.access-and-identity`
- Voice call webhook security: `voice-call.webhook-security`

#### Conversation Routing and Delivery

- Category id: `voice-call-channel.conversation-routing-and-delivery`
- Voice call inbound routing: `voice-call.inbound-routing`

#### Media and Rich Content

- Category id: `voice-call-channel.media-and-rich-content`
- Voice call provider transports: `voice-call.provider-transports`
- Voice call telephony audio: `voice-call.telephony-audio`

#### Realtime Voice and Calls

- Category id: `voice-call-channel.realtime-voice-and-calls`
- Voice call realtime consult: `voice-call.realtime-consult`
- Voice call streaming transcription: `voice-call.streaming-transcription`

## Provider and tool

### OpenAI / Codex provider path

- Surface id: `openai-codex-provider-path`

#### Model and Auth

- Category id: `openai-codex-provider-path.model-and-auth`
- Canonical OpenAI Model Routing: `models.openai`, `tools.web-search`
- Catalog: `codex.catalog`
- Codex OAuth Profiles: `auth-profiles.provider-selection`, `runtime.codex-plugin.auth`, `runtime.doctor-repair`
- Subscription Usage: `codex.subscription-usage`
- Doctor Diagnostics: `runtime.codex-plugin.version`
- Operator Repair: `codex.operator-repair`

#### Responses and Tool Compatibility

- Category id: `openai-codex-provider-path.responses-and-tool-compatibility`
- Codex Responses Transport: `codex.responses-transport`
- Payload Compatibility: `runtime.prompt-compatibility`, `tools.fs.read`
- Tool Context: `runtime.codex-native-workspace.read`, `tools.fs.read`
- Capability Compatibility: `codex.capability-compatibility`

#### Native Codex Harness

- Category id: `openai-codex-provider-path.native-codex-harness`
- Native Codex App-server Harness: `models.codex-cli`, `runtime.codex-app-server`, `runtime.gateway-log-sentinel.codex-progress`, `runtime.long-context`, `runtime.no-meta-leak`, `workspace.planning`
- Thread Lifecycle: `runtime.codex-app-server`, `runtime.codex-plugin.lifecycle`, `runtime.doctor-repair`, `runtime.gateway-log-sentinel.codex-progress`, `runtime.long-context`, `runtime.turn-ordering`

#### Image and Multimodal Input

- Category id: `openai-codex-provider-path.image-and-multimodal-input`
- Image Generation Editing: `codex.image-generation-editing`
- Multimodal Input: `codex.multimodal-input`

#### Voice and Realtime Audio

- Category id: `openai-codex-provider-path.voice-and-realtime-audio`
- Realtime Voice Transcription: `codex.realtime-voice-transcription`
- Speech: `codex.speech`

### Anthropic provider path

- Surface id: `anthropic-provider-path`

#### Provider Auth and Recovery

- Category id: `anthropic-provider-path.provider-auth-and-recovery`
- API-key onboarding: `gateway.api-key-onboarding`
- Claude CLI credential reuse: `anthropic.claude-cli-credential-reuse`
- Setup-token auth: `anthropic.setup-token-auth`
- Auth profile health: `anthropic.auth-profile-health`
- Model status: `anthropic.model-status`
- Usage windows: `anthropic.usage-windows`
- Cooldown/profile reporting: `anthropic.cooldown-profile-reporting`
- Long-context recovery: `anthropic.long-context-recovery`
- Fallback guidance: `anthropic.fallback-guidance`

#### Model and Runtime Selection

- Category id: `anthropic-provider-path.model-and-runtime-selection`
- Bundled Claude catalog: `anthropic.bundled-claude-catalog`
- Canonical anthropic refs: `models.anthropic`, `models.provider-auth`
- Claude CLI compatibility: `models.claude-cli`, `models.provider-capabilities`
- Model picker availability: `models.picker-availability`
- Capability metadata: `anthropic.capability-metadata`
- Runtime selection: `anthropic.runtime-selection`
- Session continuity: `memory.session-continuity`
- MCP/tool bridge: `anthropic.mcp-tool-bridge`
- Permission-mode mapping: `anthropic.permission-mode-mapping`
- Fallback prelude: `anthropic.fallback-prelude`

#### Request Transport and Turn Semantics

- Category id: `anthropic-provider-path.request-transport-and-turn-semantics`
- API-key/OAuth transport: `anthropic.api-key-oauth-transport`
- Messages payloads: `anthropic.messages-payloads`
- Streaming decode: `anthropic.streaming-decode`
- Usage and stop reasons: `anthropic.usage-and-stop-reasons`
- Abort/error handling: `anthropic.abort-error-handling`
- Tool-use blocks: `anthropic.tool-use-blocks`
- Tool-result replay: `anthropic.tool-result-replay`
- Partial JSON recovery: `anthropic.partial-json-recovery`
- Native thinking: `anthropic.native-thinking`
- Signed/redacted thinking replay: `anthropic.signed-redacted-thinking-replay`

#### Prompt Cache and Context

- Category id: `anthropic-provider-path.prompt-cache-and-context`
- Cache retention: `anthropic.cache-retention`
- System-prompt cache boundary: `anthropic.system-prompt-cache-boundary`
- 1M context: `anthropic.1m-context`
- Fast mode/service tier: `anthropic.fast-mode-service-tier`
- Cache diagnostics: `anthropic.cache-diagnostics`

#### Media Inputs

- Category id: `anthropic-provider-path.media-inputs`
- Image input: `anthropic.image-input`
- PDF document input: `anthropic.pdf-document-input`
- Media model fallback: `anthropic.media-model-fallback`
- Image tool results: `anthropic.image-tool-results`

### Google provider path

- Surface id: `google-provider-path`

#### Provider Setup and Credentials

- Category id: `google-provider-path.provider-setup-and-credentials`
- API key onboarding: `gateway.api-key-onboarding`
- Auth choice metadata: `google.auth-choice-metadata`
- Gemini CLI OAuth setup: `google.gemini-cli-oauth-setup`
- Vertex ADC setup: `google.vertex-adc-setup`
- Daemon and fallback credentials: `google.daemon-and-fallback-credentials`
- CLI runtime selection: `google.cli-runtime-selection`
- OAuth login and refresh: `google.oauth-login-and-refresh`
- Canonical Google model refs: `google.canonical-google-model-refs`
- CLI usage normalization: `google.cli-usage-normalization`
- OAuth diagnostics: `google.oauth-diagnostics`

#### Model Routing and Endpoints

- Category id: `google-provider-path.model-routing-and-endpoints`
- Catalog rows and aliases: `google.catalog-rows-and-aliases`
- Dynamic model resolution: `google.dynamic-model-resolution`
- Provider routing: `google.provider-routing`
- Google-native config normalization: `google.native-config-normalization`
- Model picker availability: `models.picker-availability`
- Vertex provider selection: `google.vertex-provider-selection`
- ADC/service-account auth: `google.adc-service-account-auth`
- Project/location endpoints: `google.project-location-endpoints`
- Custom base URL policy: `google.custom-base-url-policy`
- Compatibility boundaries: `google.compatibility-boundaries`

#### Direct Gemini Runtime

- Category id: `google-provider-path.direct-gemini-runtime`
- Direct Gemini chat: `google.direct-gemini-chat`
- Multimodal inputs: `google.multimodal-inputs`
- Tool-call streaming: `google.tool-call-streaming`
- Usage and stop reasons: `anthropic.usage-and-stop-reasons`
- Direct Gemini transport payloads: `google.direct-gemini-transport-payloads`
- Thinking-level mapping: `google.thinking-level-mapping`
- Thought-signature replay policy: `google.thought-signature-replay`
- Tool turn ordering: `google.tool-turn-ordering`
- Incomplete-turn recovery: `google.incomplete-turn-recovery`

#### Media, Search, and Realtime

- Category id: `google-provider-path.media-search-and-realtime`
- Bundled plugin distribution: `google.bundled-plugin-distribution`
- Provider auto-enable metadata: `google.provider-auto-enable-metadata`
- Image and media adapters: `google.image-and-media-adapters`
- Speech and realtime adapters: `google.speech-and-realtime-adapters`
- Search and generation tools: `google.search-and-generation-tools`
- Realtime voice sessions: `google.realtime-voice-sessions`
- Constrained browser tokens: `google.constrained-browser-tokens`
- Audio and transcript events: `google.audio-and-transcript-events`
- Live tool calls: `google.live-tool-calls`
- Session reconnects: `google.session-reconnects`

#### Prompt Caching

- Category id: `google-provider-path.prompt-caching`
- Cache retention config: `google.cache-retention-config`
- Managed cachedContents: `google.managed-cachedcontents`
- Manual cachedContent handles: `google.manual-cachedcontent-handles`
- Cache usage accounting: `google.cache-usage-accounting`
- Cache diagnostics and live proof: `google.cache-diagnostics-and-live-proof`

### OpenRouter provider path

- Surface id: `openrouter-provider-path`

#### Provider Setup and Auth

- Category id: `openrouter-provider-path.provider-setup-and-auth`
- First-run setup: `openrouter.first-run-setup`
- Default model selection: `openrouter.default-model-selection`
- Provider plugin registration: `openrouter.provider-plugin-registration`
- Model-ref examples: `openrouter.model-ref-examples`
- OPENROUTER_API_KEY: `openrouter.api-key`
- Auth profiles and auth order: `openrouter.auth-profiles-and-auth-order`
- Status/probe and removal: `openrouter.status-probe-and-removal`
- Provider-entry SecretRef/API-key resolution: `openrouter.provider-entry-secretref-api-key-resolution`
- Gateway env inheritance: `openrouter.gateway-env-inheritance`
- Static catalog rows: `openrouter.static-catalog-rows`
- Dynamic /models discovery: `openrouter.dynamic-models-discovery`
- openrouter/auto and nested refs: `openrouter.auto-and-nested-refs`
- Free-model scan/probe: `openrouter.free-model-scan-probe`
- Model list/picker cache: `openrouter.model-list-picker-cache`

#### Chat Runtime and Normalization

- Category id: `openrouter-provider-path.chat-runtime-and-normalization`
- Chat completions route: `openrouter.chat-completions-route`
- Provider routing params: `openrouter.provider-routing-params`
- Per-model route overrides: `openrouter.per-model-route-overrides`
- Reasoning payload policy: `openrouter.reasoning-payload-policy`
- Anthropic/Gemini/DeepSeek variants: `openrouter.anthropic-gemini-deepseek-variants`
- Streamed content parsing: `openrouter.streamed-content-parsing`
- reasoning_details visible output: `openrouter.reasoning-details-visible-output`
- Tool-call delta preservation: `openrouter.tool-call-delta-preservation`
- Family-specific replay policy: `openrouter.family-specific-replay-policy`
- Response-model and usage normalization: `openrouter.response-model-and-usage-normalization`
- Attribution headers: `openrouter.attribution-headers`
- Response-cache headers/TTL/clear: `openrouter.response-cache-headers-ttl-clear`
- Anthropic cache-control markers: `openrouter.anthropic-cache-control-markers`
- Cache usage mapping: `openrouter.cache-usage-mapping`
- Custom proxy exclusions: `openrouter.custom-proxy-exclusions`

#### Provider Recovery and Diagnostics

- Category id: `openrouter-provider-path.provider-recovery-and-diagnostics`
- Timeout/retry classification: `openrouter.timeout-retry-classification`
- Auth/billing/key-limit classification: `openrouter.auth-billing-key-limit-classification`
- Context overflow: `openrouter.context-overflow`
- Model fallback notices: `openrouter.model-fallback-notices`
- Guarded fetch/pricing warnings: `openrouter.guarded-fetch-pricing-warnings`

#### Media Generation and Speech

- Category id: `openrouter-provider-path.media-generation-and-speech`
- image_generate OpenRouter route: `openrouter.image-generate-openrouter-route`
- video_generate async jobs/polling/download: `openrouter.video-generate-async-jobs-polling-download`
- music_generate audio route: `openrouter.music-generate-audio-route`
- Text-to-speech: `openrouter.text-to-speech`
- Speech-to-text transcription: `openrouter.speech-to-text-transcription`
- Inbound media understanding: `openrouter.inbound-media-understanding`
- Generated artifact delivery: `openrouter.generated-artifact-delivery`

### Local model providers: Ollama, vLLM, SGLang, LM Studio

- Surface id: `local-model-providers-ollama-vllm-sglang-lm-studio`

#### Provider Setup, Lifecycle, and Diagnostics

- Category id: `local-model-providers-ollama-vllm-sglang-lm-studio.provider-setup-lifecycle-and-diagnostics`
- Provider Selection: `local-models.provider-selection`
- Onboarding: `local-models.onboarding`
- localService configuration: `local-models.localservice-configuration`
- Process startup and readiness: `local-models.process-startup-and-readiness`
- Request leases and idle shutdown: `local-models.request-leases-and-idle-shutdown`
- Health checks and restart: `local-models.health-checks-and-restart`
- Provider recipes: `local-models.provider-recipes`
- Local provider status: `local-models.local-provider-status`
- Backend reachability probes: `local-models.backend-reachability-probes`
- Model availability errors: `local-models.model-availability-errors`
- Memory readiness diagnostics: `local-models.memory-readiness-diagnostics`
- Provider troubleshooting docs: `local-models.provider-troubleshooting-docs`

#### Native Provider Plugins

- Category id: `local-model-providers-ollama-vllm-sglang-lm-studio.native-provider-plugins`
- Ollama setup and model pulling: `local-models.ollama-setup-and-model-pulling`
- Model discovery: `local-models.model-discovery`
- Streaming and vision: `local-models.streaming-and-vision`
- Ollama embeddings: `local-models.ollama-embeddings`
- Web-search support: `local-models.web-search-support`
- LM Studio setup: `local-models.lm-studio-setup`
- Model discovery and auth: `local-models.model-discovery-and-auth`
- Model preload and JIT loading: `local-models.model-preload-and-jit-loading`
- Streaming compatibility: `local-models.streaming-compatibility`
- LM Studio embeddings: `local-models.lm-studio-embeddings`

#### OpenAI-Compatible Runtime Compatibility

- Category id: `local-model-providers-ollama-vllm-sglang-lm-studio.openai-compatible-runtime-compatibility`
- Bundled provider setup: `local-models.bundled-provider-setup`
- Model Discovery Endpoint: `local-models.model-discovery-endpoint`
- Non-interactive configuration: `local-models.non-interactive-configuration`
- vLLM thinking controls: `local-models.vllm-thinking-controls`
- OpenAI-compatible chat and tool semantics: `local-models.openai-compatible-chat-and-tool-semantics`
- SGLang compatibility guidance: `local-models.sglang-compatibility-guidance`
- Request Stream Compatibility: `local-models.request-stream-compatibility`
- Tool Calling: `local-models.tool-calling`

#### Local Memory and Embeddings

- Category id: `local-model-providers-ollama-vllm-sglang-lm-studio.local-memory-and-embeddings`
- Embedding provider selection: `local-models.embedding-provider-selection`
- Memory search readiness: `local-models.memory-search-readiness`
- memoryFlush model override: `local-models.memoryflush-model-override`
- Fallback lexical search: `local-models.fallback-lexical-search`
- Provider mismatch guidance: `local-models.provider-mismatch-guidance`

#### Network Safety and Prompt Controls

- Category id: `local-model-providers-ollama-vllm-sglang-lm-studio.network-safety-and-prompt-controls`
- Safety Network: `local-models.safety-network`
- Prompt Pressure Controls: `local-models.prompt-pressure-controls`

### Long-tail hosted providers

- Surface id: `long-tail-hosted-providers`

#### Hosted LLM Providers

- Category id: `long-tail-hosted-providers.hosted-llm-providers`
- Bedrock setup: `hosted-providers.bedrock-setup`
- Gateway/proxy routing: `hosted-providers.gateway-proxy-routing`
- Copilot/OpenCode hosted access: `hosted-providers.copilot-opencode-hosted-access`
- Proxy capability diagnostics: `hosted-providers.proxy-capability-diagnostics`
- Hosted text completion: `hosted-providers.hosted-text-completion`
- Tool-call and streaming compatibility: `hosted-providers.tool-call-and-streaming-compatibility`
- Model catalog resolution: `hosted-providers.model-catalog-resolution`
- Provider-specific request shaping: `hosted-providers.provider-specific-request-shaping`
- Regional provider setup: `hosted-providers.regional-provider-setup`
- Region and plan routing: `hosted-providers.region-and-plan-routing`
- Regional live smoke: `hosted-providers.regional-live-smoke`
- Account prerequisite diagnostics: `hosted-providers.account-prerequisite-diagnostics`

#### Hosted Media Providers

- Category id: `long-tail-hosted-providers.hosted-media-providers`
- Image generation providers: `hosted-providers.image-generation-providers`
- Video generation providers: `hosted-providers.video-generation-providers`
- Music generation providers: `hosted-providers.music-generation-providers`
- Media mode coverage: `hosted-providers.media-mode-coverage`
- Text-to-speech providers: `hosted-providers.text-to-speech-providers`
- Speech-to-text providers: `hosted-providers.speech-to-text-providers`
- Realtime transcription providers: `models.realtime-transcription-providers`
- Audio format diagnostics: `hosted-providers.audio-format-diagnostics`

#### Provider Operations

- Category id: `long-tail-hosted-providers.provider-operations`
- Provider directory: `hosted-providers.provider-directory`
- Provider install catalog: `hosted-providers.provider-install-catalog`
- Model catalog metadata: `hosted-providers.model-catalog-metadata`
- Catalog parity checks: `hosted-providers.catalog-parity-checks`
- Provider setup descriptors: `hosted-providers.provider-setup-descriptors`
- Auth profiles and aliases: `hosted-providers.auth-profiles-and-aliases`
- Credential health probes: `hosted-providers.credential-health-probes`
- Key rotation and recovery: `hosted-providers.key-rotation-and-recovery`
- Direct provider smoke: `hosted-providers.direct-provider-smoke`
- Gateway live smoke: `hosted-providers.gateway-live-smoke`
- Models status probes: `hosted-providers.models-status-probes`
- Fallback trace and repair: `hosted-providers.fallback-trace-and-repair`

### Web search tools

- Surface id: `web-search-tools`

#### Search Providers

- Category id: `web-search-tools.search-providers`
- API-backed providers: `tools.tavily-search`
- Keyless and self-hosted providers: `web-search.keyless-and-self-hosted-providers`
- Provider comparison and auto-detection: `web-search.provider-comparison-and-auto-detection`
- Provider-specific filters and extraction: `web-search.provider-specific-filters-and-extraction`
- Result normalization: `web-search.result-normalization`
- OpenAI native web_search: `web-search.openai-native-web-search`
- Codex native web_search: `web-search.codex-native-web-search`
- Gemini grounding: `web-search.gemini-grounding`
- Grok web grounding: `web-search.grok-web-grounding`
- Kimi web search: `web-search.kimi-web-search`
- Provider-native citations: `web-search.provider-native-citations`
- Model and filter routing: `web-search.model-and-filter-routing`
- webSearchProviders: `web-search.websearchproviders`
- registerWebSearchProvider: `web-search.registerwebsearchprovider`
- webFetchProviders: `web-search.webfetchproviders`
- registerWebFetchProvider: `web-search.registerwebfetchprovider`
- public-artifact loading: `web-search.public-artifact-loading`
- runtime resolution: `web-search.runtime-resolution`
- contract tests: `web-search.contract-tests`

#### Setup and Diagnostics

- Category id: `web-search-tools.setup-and-diagnostics`
- Provider credentials: `security.provider-credentials`
- Default provider selection: `web-search.default-provider-selection`
- Credential repair: `web-search.credential-repair`
- Status checks: `web-search.status-checks`
- Quota errors: `web-search.quota-errors`
- Cache controls: `web-search.cache-controls`
- Provider diagnostics: `models.diagnostics`
- Retry and fallback: `web-search.retry-and-fallback`
- Operator repair: `codex.operator-repair`

#### Network Safety

- Category id: `web-search-tools.network-safety`
- Network Safety: `web-search.network-safety`
- SSRF: `browser-tools.ssrf`
- Redirects: `web-search.redirects`
- Untrusted Content: `web-search.untrusted-content`

#### Tool Availability and Fetch

- Category id: `web-search-tools.tool-availability-and-fetch`
- web_search exposure: `models.openai`, `tools.web-search`
- web_fetch exposure: `tools.web-fetch`
- x_search exposure: `web-search.x-search-exposure`
- group:web policy: `web-search.group-web-policy`
- disabled-state diagnostics: `web-search.disabled-state-diagnostics`
- provider/model gating: `web-search.provider-model-gating`
- URL fetch: `web-search.url-fetch`
- HTML extraction: `tools.tavily-extract`
- PDF/text extraction: `web-search.pdf-text-extraction`
- Safe truncation: `web-search.safe-truncation`
- Content citation handoff: `web-search.content-citation-handoff`

### Browser automation and exec/sandbox tools

- Surface id: `browser-automation-and-exec-sandbox-tools`

#### Browser Automation

- Category id: `browser-automation-and-exec-sandbox-tools.browser-automation`
- Browser Actions: `browser-tools.browser-actions`
- Snapshots: `browser-tools.snapshots`
- Artifacts: `workspace.artifacts`
- Browser Plugin Service: `browser-tools.browser-plugin-service`
- Profiles: `browser-tools.profiles`
- Browser Security: `browser-tools.browser-security`
- SSRF: `browser-tools.ssrf`
- Remote Control: `browser-tools.remote-control`

#### Tool Invocation and Execution

- Category id: `browser-automation-and-exec-sandbox-tools.tool-invocation-and-execution`
- Exec Routing: `tools.bash`, `tools.exec`
- Process Lifecycle: `workspace.long-running-task`
- Direct Tool Invoke API: `plugins.mcp-tools`, `tools.invocation`
- Node System.run: `browser-tools.node-system-run`
- Host Exec Approvals: `browser-tools.host-exec-approvals`
- Elevated Mode: `browser-tools.elevated-mode`

#### Sandbox and Tool Policy

- Category id: `browser-automation-and-exec-sandbox-tools.sandbox-and-tool-policy`
- Sandbox Backends: `browser-tools.sandbox-backends`
- Workspace Isolation: `browser-tools.workspace-isolation`
- Sandboxed Browser: `browser-tools.sandboxed-browser`
- Codex Dynamic Tools: `browser-tools.codex-dynamic-tools`
- Tool Policy: `browser-tools.tool-policy`
- Sandbox Tool Gates: `browser-tools.sandbox-tool-gates`

### Image/video/music generation tools

- Surface id: `image-video-music-generation-tools`

#### Media Routing and Discovery

- Category id: `image-video-music-generation-tools.media-routing-and-discovery`
- default media model config: `media-tools.default-media-model-config`
- per-call model refs and fallbacks: `media-tools.per-call-model-refs-and-fallbacks`
- auth-backed tool discovery: `media-tools.auth-backed-tool-discovery`
- action=list provider inspection: `media-tools.action-list-provider-inspection`

#### Task Lifecycle and Delivery

- Category id: `image-video-music-generation-tools.task-lifecycle-and-delivery`
- background task creation: `media-tools.background-task-creation`
- task status/list/show/cancel: `media-tools.task-status-list-show-cancel`
- duplicate guards: `media-tools.duplicate-guards`
- progress keepalive: `media-tools.progress-keepalive`
- completion/failure wake: `media-tools.completion-failure-wake`
- no-session inline fallback: `media-tools.no-session-inline-fallback`
- local media persistence: `media-tools.local-media-persistence`
- MIME/filename inference: `media-tools.mime-filename-inference`
- Hosted URL fallback: `media-tools.hosted-url-fallback`
- message-tool handoff: `media-tools.message-tool-handoff`
- idempotent missing-media fallback: `media-tools.idempotent-missing-media-fallback`
- channel attachment proof: `media-tools.channel-attachment-proof`

#### Image Generation

- Category id: `image-video-music-generation-tools.image-generation`
- text-to-image: `media-tools.text-to-image`
- reference-image editing: `media.reference-image-editing`
- output hints: `media-tools.output-hints`
- action=status: `media-tools.action-status`
- provider attempt metadata: `media-tools.provider-attempt-metadata`
- OpenAI/Codex OAuth: `media-tools.openai-codex-oauth`
- API-key OpenAI: `media-tools.api-key-openai`
- OpenRouter/xAI/fal/LiteLLM/DeepInfra/Google/MiniMax/ComfyUI auth: `media-tools.openrouter-xai-fal-litellm-deepinfra-google-minimax-comfyui-auth`
- provider error diagnostics: `media-tools.provider-error-diagnostics`

#### Video Generation

- Category id: `image-video-music-generation-tools.video-generation`
- text-to-video: `media-tools.text-to-video`
- image-to-video: `media-tools.image-to-video`
- video-to-video: `media-tools.video-to-video`
- reference role validation: `media-tools.reference-role-validation`
- audio refs: `media-tools.audio-refs`
- typed providerOptions: `media-tools.typed-provideroptions`
- queue-backed jobs: `media-tools.queue-backed-jobs`
- polling/timeout handling: `media-tools.polling-timeout-handling`
- Hosted URL download: `media-tools.hosted-url-download`
- provider skip explanations: `media-tools.provider-skip-explanations`
- returned asset metadata: `media-tools.returned-asset-metadata`

#### Music Generation

- Category id: `image-video-music-generation-tools.music-generation`
- prompt and lyrics input: `media-tools.prompt-and-lyrics-input`
- instrumental mode: `media-tools.instrumental-mode`
- duration/format controls: `media-tools.duration-format-controls`
- image-reference edit lanes: `media-tools.image-reference-edit-lanes`
- generated audio outputs: `media-tools.generated-audio-outputs`
- provider fallback: `media-tools.provider-fallback`
