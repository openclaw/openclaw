import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { n as VERSION } from "./version-CQfgAE7_.js";
import "./agent-scope-CtLXGcWm.js";
import { c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir } from "./agent-scope-config-CMp71_27.js";
import { i as loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot-C-_V3F5M.js";
import { v as getCurrentPluginMetadataSnapshot } from "./plugin-registry-CgH_ZSlH.js";
import { R as ZodNever, W as ZodObject, Z as ZodRecord, dt as ZodUnion, k as ZodIntersection, n as ZodArray, v as ZodDiscriminatedUnion } from "./schemas-Del5uzR8.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { D as collectPluginSchemaMetadata, E as collectChannelSchemaMetadata, O as GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA, i as getRuntimeConfig, u as readConfigFileSnapshot } from "./io-DoswVvYe.js";
import { t as sensitive } from "./zod-schema.sensitive-3GVmnUbm.js";
import { t as OpenClawSchema } from "./zod-schema-Dsy5tXpj.js";
import "./config-B6Oplu5W.js";
import { r as isSensitiveUrlConfigPath, t as SENSITIVE_URL_HINT_TAG } from "./redact-sensitive-url-NNYIE41N.js";
import { a as isSensitiveConfigPath } from "./redact-snapshot-DLK0iGBB.js";
import crypto from "node:crypto";
//#region src/config/media-audio-field-metadata.ts
const MEDIA_AUDIO_FIELD_HELP = {
	"tools.media.audio.enabled": "Enable audio understanding so voice notes or audio clips can be transcribed/summarized for agent context. Disable when audio ingestion is outside policy or unnecessary for your workflows.",
	"tools.media.audio.maxBytes": "Maximum accepted audio payload size in bytes before processing is rejected or clipped by policy. Set this based on expected recording length and upstream provider limits.",
	"tools.media.audio.maxChars": "Maximum characters retained from audio understanding output to prevent oversized transcript injection. Increase for long-form dictation, or lower to keep conversational turns compact.",
	"tools.media.audio.prompt": "Instruction template guiding audio understanding output style, such as concise summary versus near-verbatim transcript. Keep wording consistent so downstream automations can rely on output format.",
	"tools.media.audio.timeoutSeconds": "Timeout in seconds for audio understanding execution before the operation is cancelled. Use longer timeouts for long recordings and tighter ones for interactive chat responsiveness.",
	"tools.media.audio.language": "Preferred language hint for audio understanding/transcription when provider support is available. Set this to improve recognition accuracy for known primary languages.",
	"tools.media.audio.attachments": "Attachment policy for audio inputs indicating which uploaded files are eligible for audio processing. Keep restrictive defaults in mixed-content channels to avoid unintended audio workloads.",
	"tools.media.audio.models": "Ordered model preferences specifically for audio understanding, used before shared media model fallback. Choose models optimized for transcription quality in your primary language/domain.",
	"tools.media.audio.scope": "Scope selector for when audio understanding runs across inbound messages and attachments. Keep focused scopes in high-volume channels to reduce cost and avoid accidental transcription.",
	"tools.media.audio.echoTranscript": "Echo the audio transcript back to the originating chat before agent processing. When enabled, users immediately see what was heard from their voice note, helping them verify transcription accuracy before the agent acts on it. Default: false.",
	"tools.media.audio.echoFormat": "Format string for the echoed transcript message. Use `{transcript}` as a placeholder for the transcribed text. Default: '📝 \"{transcript}\"'.",
	"tools.media.audio.request": "Low-level HTTP request overrides for audio providers, including custom headers, auth, proxy routing, and TLS client settings. Use this for proxy-backed or self-hosted transcription endpoints when plain baseUrl/apiKey fields are not enough.",
	"tools.media.audio.request.headers": "Additional HTTP headers merged into audio provider requests after provider defaults. Use this for tenant routing or proxy integration headers, and keep secrets in env-backed values.",
	"tools.media.audio.request.auth": "Optional auth override for audio provider requests. Use this when the upstream expects a non-default bearer token or custom auth header shape.",
	"tools.media.audio.request.auth.mode": "Auth override mode for audio requests: \"provider-default\" keeps the normal provider auth, \"authorization-bearer\" forces an Authorization bearer token, and \"header\" sends a custom header/value pair.",
	"tools.media.audio.request.auth.token": "Bearer token used when audio request auth.mode is authorization-bearer. Keep this in secret storage rather than inline config.",
	"tools.media.audio.request.auth.headerName": "Header name used when audio request auth.mode is header. Match the exact upstream expectation, such as x-api-key or authorization.",
	"tools.media.audio.request.auth.value": "Header value used when audio request auth.mode is header. Keep secrets in env-backed values and avoid duplicating provider-default auth unnecessarily.",
	"tools.media.audio.request.auth.prefix": "Optional prefix prepended to the custom auth header value, such as Bearer. Leave unset when the upstream expects the raw credential only.",
	"tools.media.audio.request.proxy": "Proxy transport override for audio requests. Use env-proxy to respect process proxy settings, or explicit-proxy to force a dedicated proxy URL for this provider path.",
	"tools.media.audio.request.proxy.mode": "Proxy mode for audio requests: \"env-proxy\" uses environment proxy settings, while \"explicit-proxy\" uses the configured proxy URL only for this request path.",
	"tools.media.audio.request.proxy.url": "Explicit proxy URL for audio provider traffic when proxy.mode is explicit-proxy. Keep credentials out of inline URLs when possible and prefer secret-backed env injection.",
	"tools.media.audio.request.proxy.tls": "TLS settings applied when connecting to the configured audio proxy, such as custom CA trust for an internal proxy gateway.",
	"tools.media.audio.request.tls": "Direct TLS client settings for audio provider requests, including custom CA trust, client certs, or SNI overrides for managed gateways and internal endpoints."
};
const MEDIA_AUDIO_FIELD_LABELS = {
	"tools.media.audio.enabled": "Enable Audio Understanding",
	"tools.media.audio.maxBytes": "Audio Understanding Max Bytes",
	"tools.media.audio.maxChars": "Audio Understanding Max Chars",
	"tools.media.audio.prompt": "Audio Understanding Prompt",
	"tools.media.audio.timeoutSeconds": "Audio Understanding Timeout (sec)",
	"tools.media.audio.language": "Audio Understanding Language",
	"tools.media.audio.attachments": "Audio Understanding Attachment Policy",
	"tools.media.audio.models": "Audio Understanding Models",
	"tools.media.audio.scope": "Audio Understanding Scope",
	"tools.media.audio.echoTranscript": "Echo Transcript to Chat",
	"tools.media.audio.echoFormat": "Transcript Echo Format",
	"tools.media.audio.request": "Audio Request Overrides",
	"tools.media.audio.request.headers": "Audio Request Headers",
	"tools.media.audio.request.auth": "Audio Request Auth Override",
	"tools.media.audio.request.auth.mode": "Audio Request Auth Mode",
	"tools.media.audio.request.auth.token": "Audio Request Bearer Token",
	"tools.media.audio.request.auth.headerName": "Audio Request Auth Header Name",
	"tools.media.audio.request.auth.value": "Audio Request Auth Header Value",
	"tools.media.audio.request.auth.prefix": "Audio Request Auth Header Prefix",
	"tools.media.audio.request.proxy": "Audio Request Proxy",
	"tools.media.audio.request.proxy.mode": "Audio Request Proxy Mode",
	"tools.media.audio.request.proxy.url": "Audio Request Proxy URL",
	"tools.media.audio.request.proxy.tls": "Audio Request Proxy TLS",
	"tools.media.audio.request.tls": "Audio Request TLS"
};
//#endregion
//#region src/config/talk-defaults.ts
const TALK_SILENCE_TIMEOUT_MS_BY_PLATFORM = {
	macos: 700,
	android: 700,
	ios: 900
};
function describeTalkSilenceTimeoutDefaults() {
	return `${TALK_SILENCE_TIMEOUT_MS_BY_PLATFORM.macos} ms on macOS and Android, ${TALK_SILENCE_TIMEOUT_MS_BY_PLATFORM.ios} ms on iOS`;
}
//#endregion
//#region src/config/schema.help.ts
const FIELD_HELP = {
	meta: "Metadata fields automatically maintained by OpenClaw to record write/version history for this config file. Keep these values system-managed and avoid manual edits unless debugging migration history.",
	"meta.lastTouchedVersion": "Auto-set when OpenClaw writes the config.",
	"meta.lastTouchedAt": "ISO timestamp of the last config write (auto-set).",
	env: "Environment import and override settings used to supply runtime variables to the gateway process. Use this section to control shell-env loading and explicit variable injection behavior.",
	"env.shellEnv": "Shell environment import controls for loading variables from your login shell during startup. Keep this enabled when you depend on profile-defined secrets or PATH customizations.",
	"env.shellEnv.enabled": "Enables loading environment variables from the user shell profile during startup initialization. Keep enabled for developer machines, or disable in locked-down service environments with explicit env management.",
	"env.shellEnv.timeoutMs": "Maximum time in milliseconds allowed for shell environment resolution before fallback behavior applies. Use tighter timeouts for faster startup, or increase when shell initialization is heavy.",
	"env.vars": "Explicit key/value environment variable overrides merged into runtime process environment for OpenClaw. Use this for deterministic env configuration instead of relying only on shell profile side effects.",
	wizard: "Setup wizard state tracking fields that record the most recent guided setup run details. Keep these fields for observability and troubleshooting of setup flows across upgrades.",
	"wizard.lastRunAt": "ISO timestamp for when the setup wizard most recently completed on this host. Use this to confirm setup recency during support and operational audits.",
	"wizard.lastRunVersion": "OpenClaw version recorded at the time of the most recent wizard run on this config. Use this when diagnosing behavior differences across version-to-version setup changes.",
	"wizard.lastRunCommit": "Source commit identifier recorded for the last wizard execution in development builds. Use this to correlate setup behavior with exact source state during debugging.",
	"wizard.lastRunCommand": "Command invocation recorded for the latest wizard run to preserve execution context. Use this to reproduce setup steps when verifying setup regressions.",
	"wizard.lastRunMode": "Wizard execution mode recorded as \"local\" or \"remote\" for the most recent setup flow. Use this to understand whether setup targeted direct local runtime or remote gateway topology.",
	diagnostics: "Diagnostics controls for targeted tracing, telemetry export, and cache inspection during debugging. Keep baseline diagnostics minimal in production and enable deeper signals only when investigating issues.",
	"diagnostics.memoryPressureSnapshot": "Whether critical memory pressure automatically captures a redacted stability snapshot. Default: false. Enable only when this host can tolerate the extra file-system scan and snapshot write during critical memory pressure.",
	"diagnostics.otel": "OpenTelemetry export settings for traces, metrics, and logs emitted by gateway components. Use this when integrating with centralized observability backends and distributed tracing pipelines.",
	"diagnostics.cacheTrace": "Cache-trace logging settings for observing cache decisions and payload context in embedded runs. Enable this temporarily for debugging and disable afterward to reduce sensitive log footprint.",
	logging: "Logging behavior controls for severity, output destinations, formatting, and sensitive-data redaction. Keep levels and redaction strict enough for production while preserving useful diagnostics.",
	"logging.level": "Primary log level threshold for runtime logger output: \"silent\", \"fatal\", \"error\", \"warn\", \"info\", \"debug\", or \"trace\". Keep \"info\" or \"warn\" for production, and use debug/trace only during investigation.",
	"logging.file": "Optional file path for persisted log output in addition to or instead of console logging. Use a managed writable path and align retention/rotation with your operational policy.",
	"logging.consoleLevel": "Console-specific log threshold: \"silent\", \"fatal\", \"error\", \"warn\", \"info\", \"debug\", or \"trace\" for terminal output control. Use this to keep local console quieter while retaining richer file logging if needed.",
	"logging.consoleStyle": "Console output format style: \"pretty\", \"compact\", or \"json\" based on operator and ingestion needs. Use json for machine parsing pipelines and pretty/compact for human-first terminal workflows.",
	"logging.redactSensitive": "Sensitive log/transcript redaction mode: \"off\" disables general log and transcript masking, while \"tools\" redacts sensitive tool/config payload fields in those sinks. Safety-boundary UI, tool, and diagnostic payloads may still redact even when this is \"off\".",
	"logging.redactPatterns": "Additional custom redact regex patterns applied to log output, persisted transcript text, and safety-boundary UI/tool/diagnostic payloads before emission. Use this to mask org-specific tokens and identifiers not covered by built-in redaction rules.",
	cli: "CLI presentation controls for local command output behavior such as banner and tagline style. Use this section to keep startup output aligned with operator preference without changing runtime behavior.",
	"cli.banner": "CLI startup banner controls for title/version line and tagline style behavior. Keep banner enabled for fast version/context checks, then tune tagline mode to your preferred noise level.",
	"cli.banner.taglineMode": "Controls tagline style in the CLI startup banner: \"random\" (default) picks from the rotating tagline pool, \"default\" always shows the neutral default tagline, and \"off\" hides tagline text while keeping the banner version line.",
	update: "Update-channel and startup-check behavior for keeping OpenClaw runtime versions current. Use conservative channels in production and more experimental channels only in controlled environments.",
	"update.channel": "Update channel for git + npm installs (\"stable\", \"beta\", or \"dev\").",
	"update.checkOnStart": "Check for npm updates when the gateway starts (default: true).",
	"update.auto.enabled": "Enable background auto-update for package installs (default: false).",
	"update.auto.stableDelayHours": "Minimum delay before stable-channel auto-apply starts (default: 6).",
	"update.auto.stableJitterHours": "Extra stable-channel rollout spread window in hours (default: 12).",
	"update.auto.betaCheckIntervalHours": "How often beta-channel checks run in hours (default: 1).",
	gateway: "Gateway runtime surface for bind mode, auth, control UI, remote transport, and operational safety controls. Keep conservative defaults unless you intentionally expose the gateway beyond trusted local interfaces.",
	"gateway.port": "TCP port used by the gateway listener for API, control UI, and channel-facing ingress paths. Use a dedicated port and avoid collisions with reverse proxies or local developer services.",
	"gateway.mode": "Gateway operation mode: \"local\" runs channels and agent runtime on this host, while \"remote\" connects through remote transport. Keep \"local\" unless you intentionally run a split remote gateway topology.",
	"gateway.bind": "Network bind profile: \"auto\", \"lan\", \"loopback\", \"custom\", or \"tailnet\" to control interface exposure. Keep \"loopback\" or \"auto\" for safest local operation unless external clients must connect.",
	"gateway.customBindHost": "Explicit bind host/IP used when gateway.bind is set to custom for manual interface targeting. Use a precise address and avoid wildcard binds unless external exposure is required.",
	"gateway.controlUi": "Control UI hosting settings including enablement, pathing, and browser-origin/auth hardening behavior. Keep UI exposure minimal and pair with strong auth controls before internet-facing deployments.",
	"gateway.controlUi.enabled": "Enables serving the gateway Control UI from the gateway HTTP process when true. Keep enabled for local administration, and disable when an external control surface replaces it.",
	"gateway.auth": "Authentication policy for gateway HTTP/WebSocket access including mode, credentials, trusted-proxy behavior, and rate limiting. Keep auth enabled for every non-loopback deployment.",
	"gateway.auth.mode": "Gateway auth mode: \"none\", \"token\", \"password\", or \"trusted-proxy\" depending on your edge architecture. Use token/password for direct exposure, and trusted-proxy only behind hardened identity-aware proxies.",
	"gateway.auth.allowTailscale": "Allows trusted Tailscale identity paths to satisfy gateway auth checks when configured. Use this only when your tailnet identity posture is strong and operator workflows depend on it.",
	"gateway.auth.rateLimit": "Login/auth attempt throttling controls to reduce credential brute-force risk at the gateway boundary. Keep enabled in exposed environments and tune thresholds to your traffic baseline.",
	"gateway.auth.trustedProxy": "Trusted-proxy auth header mapping for upstream identity providers that inject user claims. Use only with known proxy CIDRs and strict header allowlists to prevent spoofed identity headers.",
	"gateway.trustedProxies": "CIDR/IP allowlist of upstream proxies permitted to provide forwarded client identity headers. Keep this list narrow so untrusted hops cannot impersonate users.",
	"gateway.allowRealIpFallback": "Enables x-real-ip fallback when x-forwarded-for is missing in proxy scenarios. Keep disabled unless your ingress stack requires this compatibility behavior.",
	"gateway.tools": "Gateway-level tool exposure allow/deny policy that can restrict runtime tool availability independent of agent/tool profiles. Use this for coarse emergency controls and production hardening.",
	"gateway.tools.allow": "Explicit gateway-level tool allowlist when you want a narrow set of tools available at runtime. Use this for locked-down environments where tool scope must be tightly controlled.",
	"gateway.tools.deny": "Explicit gateway-level tool denylist to block risky tools even if lower-level policies allow them. Use deny rules for emergency response and defense-in-depth hardening.",
	"gateway.handshakeTimeoutMs": "Pre-auth Gateway WebSocket handshake timeout in milliseconds. Use higher values on loaded or low-powered hosts where local clients can connect during startup warmup. OPENCLAW_HANDSHAKE_TIMEOUT_MS still takes precedence.",
	"gateway.channelHealthCheckMinutes": "Interval in minutes for automatic channel health probing and status updates. Use lower intervals for faster detection, or higher intervals to reduce periodic probe noise.",
	"gateway.channelStaleEventThresholdMinutes": "How many minutes a connected channel can go without provider-proven transport activity before the health monitor treats it as a stale socket and triggers a restart. Default: 30.",
	"gateway.channelMaxRestartsPerHour": "Maximum number of health-monitor-initiated channel restarts allowed within a rolling one-hour window. Once hit, further restarts are skipped until the window expires. Default: 10.",
	"gateway.tailscale": "Tailscale integration settings for Serve/Funnel exposure and lifecycle handling on gateway start/exit. Keep off unless your deployment intentionally relies on Tailscale ingress.",
	"gateway.tailscale.mode": "Tailscale publish mode: \"off\", \"serve\", or \"funnel\" for private or public exposure paths. Use \"serve\" for tailnet-only access and \"funnel\" only when public internet reachability is required.",
	"gateway.tailscale.resetOnExit": "Resets Tailscale Serve/Funnel state on gateway exit to avoid stale published routes after shutdown. Keep enabled unless another controller manages publish lifecycle outside the gateway.",
	"gateway.tailscale.preserveFunnel": "When mode='serve' and an externally configured Tailscale Funnel route already covers the gateway port, skip re-applying tailscale serve on startup. Lets operators keep Funnel exposure managed outside OpenClaw without losing it across gateway restarts.",
	"gateway.remote": "Remote gateway connection settings for direct or SSH transport when this instance proxies to another runtime host. Use remote mode only when split-host operation is intentionally configured.",
	"gateway.remote.transport": "Remote connection transport: \"direct\" uses configured URL connectivity, while \"ssh\" tunnels through SSH. Use SSH when you need encrypted tunnel semantics without exposing remote ports.",
	"gateway.reload": "Live config-reload policy for how edits are applied and when full restarts are triggered. Keep hybrid behavior for safest operational updates unless debugging reload internals.",
	"gateway.tls": "TLS certificate and key settings for terminating HTTPS directly in the gateway process. Use explicit certificates in production and avoid plaintext exposure on untrusted networks.",
	"gateway.tls.enabled": "Enables TLS termination at the gateway listener so clients connect over HTTPS/WSS directly. Keep enabled for direct internet exposure or any untrusted network boundary.",
	"gateway.tls.autoGenerate": "Auto-generates a local TLS certificate/key pair when explicit files are not configured. Use only for local/dev setups and replace with real certificates for production traffic.",
	"gateway.tls.certPath": "Filesystem path to the TLS certificate file used by the gateway when TLS is enabled. Use managed certificate paths and keep renewal automation aligned with this location.",
	"gateway.tls.keyPath": "Filesystem path to the TLS private key file used by the gateway when TLS is enabled. Keep this key file permission-restricted and rotate per your security policy.",
	"gateway.tls.caPath": "Optional CA bundle path for client verification or custom trust-chain requirements at the gateway edge. Use this when private PKI or custom certificate chains are part of deployment.",
	"gateway.http": "Gateway HTTP API configuration grouping endpoint toggles and transport-facing API exposure controls. Keep only required endpoints enabled to reduce attack surface.",
	"gateway.http.endpoints": "HTTP endpoint feature toggles under the gateway API surface for compatibility routes and optional integrations. Enable endpoints intentionally and monitor access patterns after rollout.",
	"gateway.http.securityHeaders": "Optional HTTP response security headers applied by the gateway process itself. Prefer setting these at your reverse proxy when TLS terminates there.",
	"gateway.http.securityHeaders.strictTransportSecurity": "Value for the Strict-Transport-Security response header. Set only on HTTPS origins that you fully control; use false to explicitly disable.",
	"gateway.remote.url": "Remote Gateway WebSocket URL (ws:// or wss://).",
	"gateway.remote.token": "Bearer token used to authenticate this client to a remote gateway in token-auth deployments. Store via secret/env substitution and rotate alongside remote gateway auth changes.",
	"gateway.remote.password": "Password credential used for remote gateway authentication when password mode is enabled. Keep this secret managed externally and avoid plaintext values in committed config.",
	"gateway.remote.tlsFingerprint": "Expected sha256 TLS fingerprint for the remote gateway (pin to avoid MITM).",
	"gateway.remote.sshTarget": "Remote gateway over SSH (tunnels the gateway port to localhost). Format: user@host or user@host:port.",
	"gateway.remote.sshIdentity": "Optional SSH identity file path (passed to ssh -i).",
	"talk.provider": "Active Talk provider id (for example \"acme-speech\").",
	"talk.providers": "Provider-specific Talk settings keyed by provider id. During migration, prefer this over legacy talk.* keys.",
	"talk.providers.*": "Provider-owned Talk config fields for the matching provider id.",
	"talk.providers.*.apiKey": "Provider API key for Talk mode.",
	"talk.realtime": "Realtime Talk provider, model, voice, mode, transport, and brain strategy. Keep speech/TTS provider config in talk.provider and talk.providers.",
	"talk.realtime.provider": "Active realtime voice provider id, such as openai or google.",
	"talk.realtime.providers": "Provider-specific realtime voice settings keyed by provider id.",
	"talk.realtime.providers.*": "Provider-owned realtime voice config for the matching provider id.",
	"talk.realtime.providers.*.apiKey": "Provider API key for realtime Talk.",
	"talk.realtime.model": "Realtime provider model id override for browser or Gateway-owned Talk sessions.",
	"talk.realtime.voice": "Realtime provider voice id override for browser or Gateway-owned Talk sessions.",
	"talk.realtime.instructions": "Additional system instructions appended to OpenClaw's built-in realtime Talk prompt. Use this for voice style, tone, and other provider-facing realtime behavior while keeping agent-consult guidance intact.",
	"talk.realtime.mode": "Talk execution mode: realtime, stt-tts, or transcription.",
	"talk.realtime.transport": "Talk byte/session transport: webrtc, provider-websocket, gateway-relay, or managed-room.",
	"talk.realtime.brain": "Talk reasoning strategy: agent-consult for Gateway-mediated agent help, direct-tools for local tool calls, or none.",
	"talk.realtime.consultRouting": "Gateway relay fallback for final user transcripts when the realtime provider skips openclaw_agent_consult. provider-direct preserves provider replies; force-agent-consult routes through OpenClaw.",
	"talk.consultThinkingLevel": "Use this to override the thinking level for the regular agent run behind Talk realtime consults.",
	"talk.consultFastMode": "Use this to set true or false fast mode for the regular agent run behind Talk realtime consults.",
	"talk.speechLocale": "BCP 47 locale id for Talk speech recognition on device nodes, for example \"ru-RU\". Leave unset to use each device default.",
	"talk.interruptOnSpeech": "If true (default), stop assistant speech when the user starts speaking in Talk mode. Keep enabled for conversational turn-taking.",
	"talk.silenceTimeoutMs": `Milliseconds of user silence before Talk mode finalizes and sends the current transcript. Leave unset to keep the platform default pause window (${describeTalkSilenceTimeoutDefaults()}).`,
	acp: "ACP runtime controls for enabling dispatch, selecting backends, constraining allowed agent targets, and tuning streamed turn projection behavior.",
	"acp.enabled": "Global ACP feature gate. Keep disabled unless ACP runtime + policy are configured.",
	"acp.dispatch.enabled": "Independent dispatch gate for ACP session turns (default: true). Set false to keep ACP commands available while blocking ACP turn execution.",
	"acp.backend": "Default ACP runtime backend id (for example: acpx). Must match a registered ACP runtime plugin backend.",
	"acp.fallbacks": "Ordered list of fallback ACP backend ids tried when the primary backend fails with UNAVAILABLE (for example: rate-limit / quota exhausted). Each entry must match a registered ACP runtime plugin backend.",
	"acp.defaultAgent": "Fallback ACP target agent id used when ACP spawns do not specify an explicit target.",
	"acp.allowedAgents": "Allowlist of ACP target agent ids permitted for ACP runtime sessions. Empty means no additional allowlist restriction.",
	"acp.maxConcurrentSessions": "Maximum concurrently active ACP sessions across this gateway process.",
	"acp.stream": "ACP streaming projection controls for chunk sizing, metadata visibility, and deduped delivery behavior.",
	"acp.stream.coalesceIdleMs": "Coalescer idle flush window in milliseconds for ACP streamed text before block replies are emitted.",
	"acp.stream.maxChunkChars": "Maximum chunk size for ACP streamed block projection before splitting into multiple block replies.",
	"acp.stream.repeatSuppression": "When true (default), suppress repeated ACP status/tool projection lines in a turn while keeping raw ACP events unchanged.",
	"acp.stream.deliveryMode": "ACP delivery style: live streams projected output incrementally, final_only buffers all projected ACP output until terminal turn events.",
	"acp.stream.hiddenBoundarySeparator": "Separator inserted before next visible assistant text when hidden ACP tool lifecycle events occurred (none|space|newline|paragraph). Default: paragraph.",
	"acp.stream.maxOutputChars": "Maximum assistant output characters projected per ACP turn before truncation notice is emitted.",
	"acp.stream.maxSessionUpdateChars": "Maximum characters for projected ACP session/update lines (tool/status updates).",
	"acp.stream.tagVisibility": "Per-sessionUpdate visibility overrides for ACP projection (for example usage_update, available_commands_update).",
	"acp.runtime.ttlMinutes": "Idle runtime TTL in minutes for ACP session workers before eligible cleanup.",
	"acp.runtime.installCommand": "Optional operator install/setup command shown by `/acp install` and `/acp doctor` when ACP backend wiring is missing.",
	commitments: "Inferred follow-up commitment controls for automatically detecting check-ins from conversation turns and delivering them through heartbeat runs.",
	"commitments.enabled": "Enable hidden LLM extraction, storage, and heartbeat delivery for inferred follow-up commitments. Default: false.",
	"commitments.maxPerDay": "Maximum inferred follow-up commitments delivered per agent session in a rolling day. Default: 3.",
	"agents.list.*.skills": "Optional allowlist of skills for this agent. If omitted, the agent inherits agents.defaults.skills when set; otherwise skills stay unrestricted. Set [] for no skills. An explicit list fully replaces inherited defaults instead of merging with them.",
	"agents.list[].skills": "Optional allowlist of skills for this agent. If omitted, the agent inherits agents.defaults.skills when set; otherwise skills stay unrestricted. Set [] for no skills. An explicit list fully replaces inherited defaults instead of merging with them.",
	agents: "Agent runtime configuration root covering defaults and explicit agent entries used for routing and execution context. Keep this section explicit so model/tool behavior stays predictable across multi-agent workflows.",
	"agents.defaults": "Shared default settings inherited by agents unless overridden per entry in agents.list. Use defaults to enforce consistent baseline behavior and reduce duplicated per-agent configuration.",
	"agents.defaults.skills": "Optional default skill allowlist inherited by agents that omit agents.list[].skills. Omit for unrestricted skills, set [] to give inheriting agents no skills, and remember explicit agents.list[].skills replaces this default instead of merging with it.",
	"agents.defaults.subagents.delegationMode": "Prompt-only sub-agent delegation strength. \"suggest\" keeps the default guidance; \"prefer\" strongly instructs the main agent to delegate anything more involved than a direct reply via sessions_spawn.",
	"agents.list[].subagents.delegationMode": "Per-agent override for sub-agent delegation strength. Use this for coordinator agents that should stay responsive and push non-trivial work into spawned sub-agents.",
	"agents.list[].contextInjection": "Per-agent override for when workspace bootstrap files are injected into this agent's system prompt. Omit to inherit agents.defaults.contextInjection.",
	"agents.list[].bootstrapMaxChars": "Per-agent override for max characters of each workspace bootstrap file injected into this agent's system prompt. Omit to inherit agents.defaults.bootstrapMaxChars.",
	"agents.list[].bootstrapTotalMaxChars": "Per-agent override for max total characters across all workspace bootstrap files injected into this agent's system prompt. Omit to inherit agents.defaults.bootstrapTotalMaxChars.",
	"agents.list[].experimental": "Per-agent experimental flags. Omitted fields inherit agents.defaults.experimental.",
	"agents.list[].experimental.localModelLean": "Per-agent override for lean local-model mode. Enable it for one smaller local-model agent without trimming tools from every agent.",
	"agents.defaults.contextLimits": "Focused per-agent-context budget defaults for selected high-volume excerpts and injected prompt blocks. Use this to tune bounded read/injection sizes without reopening any unbounded call paths.",
	"agents.defaults.contextLimits.memoryGetMaxChars": "Default max characters returned by memory_get before truncation metadata and continuation notice are added. Increase to approximate older larger excerpts, but keep it bounded.",
	"agents.defaults.contextLimits.memoryGetDefaultLines": "Default memory_get line window used when requests omit lines. This controls how many source lines are selected before the max-char cap is applied.",
	"agents.defaults.contextLimits.toolResultMaxChars": "Default max characters kept for a single live tool result before truncation. This affects both persisted live tool-result writes and overflow-recovery truncation heuristics.",
	"agents.defaults.contextLimits.postCompactionMaxChars": "Default max characters retained from AGENTS.md during post-compaction context refresh injection. Lower this to make compaction recovery cheaper, or raise it for agents that depend on longer startup guidance.",
	"agents.list": "Explicit list of configured agents with IDs and optional overrides for model, tools, identity, and workspace. Keep IDs stable over time so bindings, approvals, and session routing remain deterministic.",
	"agents.list[].skillsLimits": "Optional per-agent overrides for skills subsystem budgets. Use this when an agent needs a different skills prompt budget without introducing a second generic context-limits path.",
	"agents.list[].skillsLimits.maxSkillsPromptChars": "Per-agent override for the skills prompt character budget. This extends the existing skills.limits.maxSkillsPromptChars path instead of routing the same budget through contextLimits.",
	"agents.list[].contextLimits": "Optional per-agent overrides for the focused context budget knobs. Omitted fields inherit agents.defaults.contextLimits.",
	"agents.list[].contextLimits.memoryGetMaxChars": "Per-agent override for the default memory_get max character budget.",
	"agents.list[].contextLimits.memoryGetDefaultLines": "Per-agent override for the default memory_get line window when lines is omitted.",
	"agents.list[].contextLimits.toolResultMaxChars": "Per-agent override for the live tool-result max character budget.",
	"agents.list[].contextLimits.postCompactionMaxChars": "Per-agent override for the post-compaction AGENTS.md excerpt budget.",
	"agents.list[].thinkingDefault": "Optional per-agent default thinking level. Overrides agents.defaults.thinkingDefault for this agent when no per-message or session override is set.",
	"agents.list[].reasoningDefault": "Optional per-agent default reasoning visibility (on|off|stream). Applies when no per-message or session reasoning override is set.",
	"agents.list[].fastModeDefault": "Optional per-agent default for fast mode. Applies when no per-message or session fast-mode override is set.",
	"agents.list[].runtime": "Optional runtime descriptor for this agent. Use embedded for default OpenClaw execution or acp for external ACP harness defaults.",
	"agents.list[].runtime.type": "Runtime type for this agent: \"embedded\" (default OpenClaw runtime) or \"acp\" (ACP harness defaults).",
	"agents.list[].runtime.acp": "ACP runtime defaults for this agent when runtime.type=acp. Binding-level ACP overrides still take precedence per conversation.",
	"agents.list[].runtime.acp.agent": "Optional ACP harness agent id to use for this OpenClaw agent (for example codex, claude, cursor, gemini, openclaw).",
	"agents.list[].runtime.acp.backend": "Optional ACP backend override for this agent's ACP sessions (falls back to global acp.backend).",
	"agents.list[].runtime.acp.mode": "Optional ACP session mode default for this agent (persistent or oneshot).",
	"agents.list[].runtime.acp.cwd": "Optional default working directory for this agent's ACP sessions.",
	"agents.list[].identity.avatar": "Avatar image path (relative to the agent workspace only) or a remote URL/data URL.",
	"agents.defaults.heartbeat.suppressToolErrorWarnings": "Suppress tool error warning payloads during heartbeat runs.",
	"agents.list[].heartbeat.suppressToolErrorWarnings": "Suppress tool error warning payloads during heartbeat runs.",
	"agents.defaults.heartbeat.timeoutSeconds": "Maximum time in seconds allowed for a heartbeat agent turn before it is aborted. Leave unset to use agents.defaults.timeoutSeconds.",
	"agents.list[].heartbeat.timeoutSeconds": "Per-agent maximum time in seconds allowed for a heartbeat agent turn before it is aborted. Leave unset to inherit the merged heartbeat/default agent timeout.",
	"agents.defaults.heartbeat.skipWhenBusy": "When true, defer heartbeat turns on this agent's extra busy lanes: its own session-keyed subagent or nested command work. Cron lanes always defer heartbeat turns.",
	"agents.list[].heartbeat.skipWhenBusy": "Per-agent override that defers heartbeat turns on that agent's extra busy lanes: its own session-keyed subagent or nested command work. Cron lanes always defer heartbeat turns.",
	browser: "Browser runtime controls for local or remote CDP attachment, profile routing, and screenshot/snapshot behavior. Keep defaults unless your automation workflow requires custom browser transport settings.",
	"browser.enabled": "Enables browser capability wiring in the gateway so browser tools and CDP-driven workflows can run. Disable when browser automation is not needed to reduce surface area and startup work.",
	"browser.cdpUrl": "Remote CDP websocket URL used to attach to an externally managed browser instance. Use this for centralized browser hosts and keep URL access restricted to trusted network paths.",
	"browser.actionTimeoutMs": "Default timeout in milliseconds for browser act requests before the client gives up waiting. Raise this when healthy waits or UI interactions exceed the default request budget.",
	"browser.localLaunchTimeoutMs": "Timeout in milliseconds for locally launched managed Chrome to expose its CDP HTTP endpoint after process start. Raise this on slow single-board computers or older hosts.",
	"browser.localCdpReadyTimeoutMs": "Timeout in milliseconds for a locally launched managed browser to finish CDP websocket readiness after the process is discovered. Raise this when Chrome starts but browser start still reports CDP not reachable.",
	"browser.color": "Default accent color used for browser profile/UI cues where colored identity hints are displayed. Use consistent colors to help operators identify active browser profile context quickly.",
	"browser.executablePath": "Explicit browser executable path when auto-discovery is insufficient for your host environment. Use an absolute stable path, or a path starting with ~ for your OS home directory, so launch behavior stays deterministic across restarts.",
	"browser.headless": "Forces browser launch in headless mode when the local launcher starts browser instances. Keep headless enabled for server environments and disable only when visible UI debugging is required.",
	"browser.noSandbox": "Disables Chromium sandbox isolation flags for environments where sandboxing fails at runtime. Keep this off whenever possible because process isolation protections are reduced.",
	"browser.attachOnly": "Restricts browser mode to attach-only behavior without starting local browser processes. Use this when all browser sessions are externally managed by a remote CDP provider.",
	"browser.cdpPortRangeStart": "Starting local CDP port used for auto-allocated browser profile ports. Increase this when host-level port defaults conflict with other local services.",
	"browser.defaultProfile": "Default browser profile name selected when callers do not explicitly choose a profile. Use a stable low-privilege profile as the default to reduce accidental cross-context state use.",
	"browser.profiles": "Named browser profile connection map used for explicit routing to CDP ports or URLs with optional metadata. Keep profile names consistent and avoid overlapping endpoint definitions.",
	"browser.profiles.*.cdpPort": "Per-profile local CDP port used when connecting to browser instances by port instead of URL. Use unique ports per profile to avoid connection collisions.",
	"browser.profiles.*.cdpUrl": "Per-profile CDP websocket URL used for explicit remote browser routing by profile name. Use this when profile connections terminate on remote hosts or tunnels.",
	"browser.profiles.*.userDataDir": "Per-profile Chromium user data directory for existing-session attachment through Chrome DevTools MCP. Use this for Brave, Edge, Chromium, or non-default Chrome profiles when the built-in auto-connect path would pick the wrong browser data directory on the selected host or browser node. Paths starting with ~ expand to the OS home directory.",
	"browser.profiles.*.mcpCommand": "Per-profile Chrome DevTools MCP command for existing-session attachment. Defaults to npx.",
	"browser.profiles.*.mcpArgs": "Extra per-profile Chrome DevTools MCP arguments for existing-session attachment, such as --no-usage-statistics. Endpoint arguments here override the built-in auto-connect or browser URL selection.",
	"browser.profiles.*.driver": "Per-profile browser driver mode. Use \"openclaw\" (or legacy \"clawd\") for CDP-based profiles, or use \"existing-session\" for Chrome DevTools MCP attachment on the selected host or browser node.",
	"browser.profiles.*.executablePath": "Per-profile browser executable path for locally launched managed browser profiles. Overrides browser.executablePath and accepts paths starting with ~ for the OS home directory.",
	"browser.profiles.*.headless": "Per-profile headless override for locally launched browser instances. Use this when one profile should stay headless without forcing browser.headless for every other profile.",
	"browser.profiles.*.attachOnly": "Per-profile attach-only override that skips local browser launch and only attaches to an existing CDP endpoint. Useful when one profile is externally managed but others are locally launched.",
	"browser.profiles.*.color": "Per-profile accent color for visual differentiation in dashboards and browser-related UI hints. Use distinct colors for high-signal operator recognition of active profiles.",
	"browser.evaluateEnabled": "Enables browser-side evaluate helpers for runtime script evaluation capabilities where supported. Keep disabled unless your workflows require evaluate semantics beyond snapshots/navigation.",
	"browser.snapshotDefaults": "Default snapshot capture configuration used when callers do not provide explicit snapshot options. Tune this for consistent capture behavior across channels and automation paths.",
	"browser.snapshotDefaults.mode": "Default snapshot extraction mode controlling how page content is transformed for agent consumption. Choose the mode that balances readability, fidelity, and token footprint for your workflows.",
	"browser.tabCleanup": "Best-effort cleanup policy for browser tabs opened by primary-agent sessions. Keep enabled to avoid stale sandbox or managed-browser tabs accumulating across long-lived gateways.",
	"browser.tabCleanup.enabled": "Enables cleanup of idle tracked browser tabs for primary-agent sessions. Disable only when external tooling owns tab lifecycle completely.",
	"browser.tabCleanup.idleMinutes": "Minutes of inactivity before a tracked primary-agent browser tab is eligible for closure. Set 0 to disable idle-time cleanup while keeping the per-session tab cap.",
	"browser.tabCleanup.maxTabsPerSession": "Maximum tracked browser tabs kept per primary-agent session. Oldest inactive tabs are closed first. Set 0 to disable the cap.",
	"browser.tabCleanup.sweepMinutes": "Minutes between browser tab cleanup sweeps. Keep this modest so idle tabs are reclaimed without adding frequent background work.",
	"browser.ssrfPolicy": "Server-side request forgery guardrail settings for browser/network fetch paths that could reach internal hosts. Keep restrictive defaults in production and open only explicitly approved targets.",
	"browser.ssrfPolicy.dangerouslyAllowPrivateNetwork": "Allows access to private-network address ranges from browser tooling. Default is disabled when unset; enable only for explicitly trusted private-network destinations.",
	"browser.ssrfPolicy.allowedHostnames": "Explicit hostname allowlist exceptions for SSRF policy checks on browser/network requests. Keep this list minimal and review entries regularly to avoid stale broad access.",
	"browser.ssrfPolicy.hostnameAllowlist": "Legacy/alternate hostname allowlist field used by SSRF policy consumers for explicit host exceptions. Use stable exact hostnames and avoid wildcard-like broad patterns.",
	"browser.remoteCdpTimeoutMs": "Timeout in milliseconds for connecting to a remote CDP endpoint before failing the browser attach attempt. Increase for high-latency tunnels, or lower for faster failure detection.",
	"browser.remoteCdpHandshakeTimeoutMs": "Timeout in milliseconds for post-connect CDP handshake readiness checks against remote browser targets. Raise this for slow-start remote browsers and lower to fail fast in automation loops.",
	"discovery.mdns.mode": "mDNS broadcast mode (\"minimal\" default, \"full\" includes cliPath/sshPort, \"off\" disables mDNS).",
	discovery: "Service discovery settings for local mDNS advertisement and optional wide-area presence signaling. Keep discovery scoped to expected networks to avoid leaking service metadata.",
	"discovery.wideArea": "Wide-area discovery configuration group for exposing discovery signals beyond local-link scopes. Enable only in deployments that intentionally aggregate gateway presence across sites.",
	"discovery.wideArea.enabled": "Enables wide-area discovery signaling when your environment needs non-local gateway discovery. Keep disabled unless cross-network discovery is operationally required.",
	"discovery.wideArea.domain": "Optional unicast DNS-SD domain for wide-area discovery, such as openclaw.internal. Use this when you intentionally publish gateway discovery beyond local mDNS scopes.",
	"discovery.mdns": "mDNS discovery configuration group for local network advertisement and discovery behavior tuning. Keep minimal mode for routine LAN discovery unless extra metadata is required.",
	tools: "Global tool access policy and capability configuration across web, exec, media, messaging, and elevated surfaces. Use this section to constrain risky capabilities before broad rollout.",
	"tools.allow": "Absolute tool allowlist that replaces profile-derived defaults for strict environments. Use this only when you intentionally run a tightly curated subset of tool capabilities.",
	"tools.deny": "Global tool denylist that blocks listed tools even when profile or provider rules would allow them. Use deny rules for emergency lockouts and long-term defense-in-depth.",
	"tools.web": "Web-tool policy grouping for search/fetch providers, limits, and fallback behavior tuning. Keep enabled settings aligned with API key availability and outbound networking policy.",
	"tools.exec": "Exec-tool policy grouping for shell execution host, security mode, approval behavior, and runtime bindings. Keep conservative defaults in production and tighten elevated execution paths.",
	"tools.exec.host": "Selects execution target strategy for shell commands. Use \"auto\" for runtime-aware behavior (sandbox when available, otherwise gateway), or pin sandbox/gateway/node explicitly when you need a fixed surface.",
	"tools.exec.security": "Execution security posture selector controlling sandbox/approval expectations for command execution. Keep strict security mode for untrusted prompts and relax only for trusted operator workflows.",
	"tools.exec.ask": "Approval strategy for when exec commands require human confirmation before running. Use stricter ask behavior in shared channels and lower-friction settings in private operator contexts.",
	"tools.exec.node": "Node binding configuration for exec tooling when command execution is delegated through connected nodes. Use explicit node binding only when multi-node routing is required.",
	"tools.agentToAgent": "Policy for allowing agent-to-agent tool calls and constraining which target agents can be reached. Keep disabled or tightly scoped unless cross-agent orchestration is intentionally enabled.",
	"tools.agentToAgent.enabled": "Enables the agent_to_agent tool surface so one agent can invoke another agent at runtime. Keep off in simple deployments and enable only when orchestration value outweighs complexity.",
	"tools.agentToAgent.allow": "Allowlist of target agent IDs permitted for agent_to_agent calls when orchestration is enabled. Use explicit allowlists to avoid uncontrolled cross-agent call graphs.",
	"tools.experimental": "Experimental built-in tool flags. Keep these off by default and enable only when you are intentionally testing a preview surface.",
	"tools.experimental.planTool": "Enable the experimental structured `update_plan` tool for non-trivial multi-step work tracking. Leave this off unless you explicitly want the tool outside strict-agentic embedded Pi runs.",
	"tools.toolSearch": "Compact large OpenClaw, MCP, and client tool catalogs behind one search/call surface. Set to true for the default code bridge or use the object form to choose the structured fallback.",
	"tools.toolSearch.enabled": "Enables Tool Search. When on, OpenClaw hides large tool catalogs behind `tool_search_code` or structured search/describe/call tools during PI runs.",
	"tools.toolSearch.mode": "Choose the model-facing surface: \"code\" exposes `tool_search_code`; \"tools\" exposes structured search/describe/call fallback tools.",
	"tools.toolSearch.codeTimeoutMs": "Maximum milliseconds for one `tool_search_code` execution. Runtime clamps values to the supported 1s..60s range.",
	"tools.toolSearch.searchDefaultLimit": "Default number of Tool Search results returned when the model omits a limit. Runtime clamps this to `maxSearchLimit`.",
	"tools.toolSearch.maxSearchLimit": "Maximum number of Tool Search results a model can request. Runtime clamps values to the supported 1..50 range.",
	"tools.codeMode": "Generic OpenClaw code mode. When enabled, agent runs expose only `exec` and `wait` to the model and hide normal tools behind a QuickJS-WASI catalog bridge.",
	"tools.codeMode.enabled": "Enables generic code mode. Default is off. When explicitly enabled, OpenClaw fails closed if the runtime is unavailable instead of exposing the full tool list.",
	"tools.codeMode.runtime": "Guest JavaScript runtime. Only \"quickjs-wasi\" is supported.",
	"tools.codeMode.mode": "Model-facing surface. Only \"only\" is supported: expose code-mode `exec` and `wait` and hide normal tools.",
	"tools.codeMode.languages": "Accepted source languages for `exec`. Supported values are \"javascript\" and \"typescript\".",
	"tools.codeMode.timeoutMs": "Maximum milliseconds for one code-mode `exec` or `wait` call.",
	"tools.codeMode.memoryLimitBytes": "QuickJS heap limit for one code-mode VM.",
	"tools.codeMode.maxOutputBytes": "Maximum serialized bytes returned through code-mode output.",
	"tools.codeMode.maxSnapshotBytes": "Maximum serialized bytes retained for one suspended QuickJS snapshot.",
	"tools.codeMode.maxPendingToolCalls": "Maximum concurrent nested tool calls a code-mode VM can start before it must resume later.",
	"tools.codeMode.snapshotTtlSeconds": "How long suspended code-mode snapshots can be resumed with `wait` before they expire.",
	"tools.codeMode.searchDefaultLimit": "Default number of hidden catalog search results returned by `tools.search` inside code mode.",
	"tools.codeMode.maxSearchLimit": "Maximum number of hidden catalog search results a code-mode program can request.",
	"tools.elevated": "Elevated tool access controls for privileged command surfaces that should only be reachable from trusted senders. Keep disabled unless operator workflows explicitly require elevated actions.",
	"tools.elevated.enabled": "Enables elevated tool execution path when sender and policy checks pass. Keep disabled in public/shared channels and enable only for trusted owner-operated contexts.",
	"tools.elevated.allowFrom": "Sender allow rules for elevated tools, usually keyed by channel/provider identity formats. Use narrow, explicit identities so elevated commands cannot be triggered by unintended users.",
	"tools.subagents": "Tool policy wrapper for spawned subagents to restrict or expand tool availability compared to parent defaults. Use this to keep delegated agent capabilities scoped to task intent.",
	"tools.subagents.tools": "Allow/deny tool policy applied to spawned subagent runtimes for per-subagent hardening. Keep this narrower than parent scope when subagents run semi-autonomous workflows.",
	"tools.sandbox": "Tool policy wrapper for sandboxed agent executions so sandbox runs can have distinct capability boundaries. Use this to enforce stronger safety in sandbox contexts.",
	"tools.sandbox.tools": "Allow/deny tool policy applied when agents run in sandboxed execution environments. Keep policies minimal so sandbox tasks cannot escalate into unnecessary external actions.",
	web: "Web channel runtime settings for heartbeat and reconnect behavior when operating web-based chat surfaces. Use reconnect values tuned to your network reliability profile and expected uptime needs.",
	"web.enabled": "Enables the web channel runtime and related websocket lifecycle behavior. Keep disabled when web chat is unused to reduce active connection management overhead.",
	"web.heartbeatSeconds": "Heartbeat interval in seconds for web channel connectivity and liveness maintenance. Use shorter intervals for faster detection, or longer intervals to reduce keepalive chatter.",
	"web.reconnect": "Reconnect backoff policy for web channel reconnect attempts after transport failure. Keep bounded retries and jitter tuned to avoid thundering-herd reconnect behavior.",
	"web.reconnect.initialMs": "Initial reconnect delay in milliseconds before the first retry after disconnection. Use modest delays to recover quickly without immediate retry storms.",
	"web.reconnect.maxMs": "Maximum reconnect backoff cap in milliseconds to bound retry delay growth over repeated failures. Use a reasonable cap so recovery remains timely after prolonged outages.",
	"web.reconnect.factor": "Exponential backoff multiplier used between reconnect attempts in web channel retry loops. Keep factor above 1 and tune with jitter for stable large-fleet reconnect behavior.",
	"web.reconnect.jitter": "Randomization factor (0-1) applied to reconnect delays to desynchronize clients after outage events. Keep non-zero jitter in multi-client deployments to reduce synchronized spikes.",
	"web.reconnect.maxAttempts": "Maximum reconnect attempts before giving up for the current failure sequence (0 means no retries). Use finite caps for controlled failure handling in automation-sensitive environments.",
	"web.whatsapp": "WhatsApp Web socket timing controls passed directly to Baileys. Tune these when network edges, proxies, or NATs are closing otherwise healthy WhatsApp Web sessions.",
	"web.whatsapp.keepAliveIntervalMs": "Baileys WhatsApp Web application ping interval in milliseconds. Lower values detect and refresh idle links sooner; keep this comfortably below your network's idle-flow timeout.",
	"web.whatsapp.connectTimeoutMs": "Maximum time in milliseconds Baileys waits for the WhatsApp WebSocket opening handshake. Use a higher value on slow or lossy networks that report opening handshake 408 timeouts.",
	"web.whatsapp.defaultQueryTimeoutMs": "Default Baileys query timeout in milliseconds for WhatsApp Web requests. Keep aligned with upstream unless a network-specific investigation shows queries need longer.",
	talk: "Talk-mode voice synthesis settings for voice identity, model selection, output format, and interruption behavior. Use this section to tune human-facing voice UX while controlling latency and cost.",
	"gateway.auth.token": "Required by default for gateway access (unless using Tailscale Serve identity); required for non-loopback binds.",
	"gateway.auth.password": "Required for Tailscale funnel.",
	"agents.defaults.sandbox.browser.network": "Docker network for sandbox browser containers (default: openclaw-sandbox-browser). Avoid bridge if you need stricter isolation.",
	"agents.list[].sandbox.browser.network": "Per-agent override for sandbox browser Docker network.",
	"agents.defaults.sandbox.docker.dangerouslyAllowContainerNamespaceJoin": "DANGEROUS break-glass override that allows sandbox Docker network mode container:<id>. This joins another container namespace and weakens sandbox isolation.",
	"agents.list[].sandbox.docker.dangerouslyAllowContainerNamespaceJoin": "Per-agent DANGEROUS override for container namespace joins in sandbox Docker network mode.",
	"agents.defaults.sandbox.docker.gpus": "Optional Docker GPU passthrough value passed to --gpus, for example \"all\" or \"device=GPU-uuid\". Requires a compatible host runtime such as NVIDIA Container Toolkit.",
	"agents.list[].sandbox.docker.gpus": "Per-agent Docker GPU passthrough override for sandbox containers.",
	"agents.defaults.sandbox.browser.cdpSourceRange": "Optional CIDR allowlist for container-edge CDP ingress (for example 172.21.0.1/32).",
	"agents.list[].sandbox.browser.cdpSourceRange": "Per-agent override for CDP source CIDR allowlist.",
	"gateway.controlUi.basePath": "Optional URL prefix where the Control UI is served (e.g. /openclaw).",
	"gateway.controlUi.root": "Optional filesystem root for Control UI assets (defaults to dist/control-ui).",
	"gateway.controlUi.embedSandbox": "Iframe sandbox policy for hosted Control UI embeds. \"strict\" disables scripts, \"scripts\" allows interactive embeds while keeping origin isolation (default), and \"trusted\" adds `allow-same-origin` for same-site documents that intentionally need stronger privileges.",
	"gateway.controlUi.allowExternalEmbedUrls": "DANGEROUS toggle that allows hosted embeds to load absolute external http(s) URLs. Keep this off unless your Control UI intentionally embeds trusted third-party pages; hosted /__openclaw__/canvas and /__openclaw__/a2ui documents do not need it.",
	"gateway.controlUi.chatMessageMaxWidth": "Optional CSS max-width for grouped Control UI chat messages, for example \"960px\", \"82%\", or \"min(1280px, 82%)\". Values are validated against a constrained width grammar before reaching the browser.",
	"gateway.controlUi.allowedOrigins": "Allowed browser origins for Control UI/WebChat websocket connections (full origins only, e.g. https://control.example.com). Required for non-loopback Control UI deployments unless dangerous Host-header fallback is explicitly enabled. Setting [\"*\"] means allow any browser origin and should be avoided outside tightly controlled local testing.",
	"gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback": "DANGEROUS toggle that enables Host-header based origin fallback for Control UI/WebChat websocket checks. This mode is supported when your deployment intentionally relies on Host-header origin policy; explicit gateway.controlUi.allowedOrigins remains the recommended hardened default.",
	"gateway.controlUi.allowInsecureAuth": "Loosens strict browser auth checks for Control UI when you must run a non-standard setup. Keep this off unless you trust your network and proxy path, because impersonation risk is higher.",
	"gateway.controlUi.dangerouslyDisableDeviceAuth": "Disables Control UI device identity checks and relies on token/password only. Use only for short-lived debugging on trusted networks, then turn it off immediately.",
	"gateway.push": "Push-delivery settings used by the gateway when it needs to wake or notify paired devices. Configure relay-backed APNs here for official iOS builds; direct APNs auth remains env-based for local/manual builds.",
	"gateway.push.apns": "APNs delivery settings for iOS devices paired to this gateway. Use relay settings for official/TestFlight builds that register through the external push relay.",
	"gateway.push.apns.relay": "External relay settings for relay-backed APNs sends. The gateway uses this relay for push.test, wake nudges, and reconnect wakes after a paired official iOS build publishes a relay-backed registration.",
	"gateway.push.apns.relay.baseUrl": "Base HTTPS URL for the external APNs relay service used by official/TestFlight iOS builds. Keep this aligned with the relay URL baked into the iOS build so registration and send traffic hit the same deployment.",
	"gateway.push.apns.relay.timeoutMs": "Timeout in milliseconds for relay send requests from the gateway to the APNs relay (default: 10000). Increase for slower relays or networks, or lower to fail wake attempts faster.",
	"gateway.http.endpoints.chatCompletions.enabled": "Enable the OpenAI-compatible `POST /v1/chat/completions` endpoint (default: false).",
	"gateway.http.endpoints.chatCompletions.maxBodyBytes": "Max request body size in bytes for `/v1/chat/completions` (default: 20MB).",
	"gateway.http.endpoints.chatCompletions.maxImageParts": "Max number of `image_url` parts accepted from the latest user message (default: 8).",
	"gateway.http.endpoints.chatCompletions.maxTotalImageBytes": "Max cumulative decoded bytes across all `image_url` parts in one request (default: 20MB).",
	"gateway.http.endpoints.chatCompletions.images": "Image fetch/validation controls for OpenAI-compatible `image_url` parts.",
	"gateway.http.endpoints.chatCompletions.images.allowUrl": "Allow server-side URL fetches for `image_url` parts (default: false; data URIs remain supported). Set this to `false` to disable URL fetching entirely.",
	"gateway.http.endpoints.chatCompletions.images.urlAllowlist": "Optional hostname allowlist for `image_url` URL fetches; supports exact hosts and `*.example.com` wildcards. Empty or omitted lists mean no hostname allowlist restriction.",
	"gateway.http.endpoints.chatCompletions.images.allowedMimes": "Allowed MIME types for `image_url` parts (case-insensitive list).",
	"gateway.http.endpoints.chatCompletions.images.maxBytes": "Max bytes per fetched/decoded `image_url` image (default: 10MB).",
	"gateway.http.endpoints.chatCompletions.images.maxRedirects": "Max HTTP redirects allowed when fetching `image_url` URLs (default: 3).",
	"gateway.http.endpoints.chatCompletions.images.timeoutMs": "Timeout in milliseconds for `image_url` URL fetches (default: 10000).",
	"gateway.reload.mode": "Controls how config edits are applied: \"off\" ignores live edits, \"restart\" always restarts, \"hot\" applies in-process, and \"hybrid\" tries hot then restarts if required. Keep \"hybrid\" for safest routine updates.",
	"gateway.reload.debounceMs": "Debounce window (ms) before applying config changes.",
	"gateway.reload.deferralTimeoutMs": "Optional maximum time (ms) to wait for in-flight operations before forcing a restart. Omit to use the default bounded wait; set 0 to wait indefinitely with periodic still-pending warnings. Lower positive values risk aborting active subagent LLM calls.",
	"gateway.nodes.browser.mode": "Node browser routing (\"auto\" = pick single connected browser node, \"manual\" = require node param, \"off\" = disable).",
	"gateway.nodes.browser.node": "Pin browser routing to a specific node id or name (optional).",
	"gateway.nodes.pairing": "Node pairing policy settings. Defaults keep CIDR auto-approval disabled; enable only with explicit trusted CIDR/IP allowlists you control.",
	"gateway.nodes.pairing.autoApproveCidrs": "Opt-in CIDR/IP allowlist for auto-approving first-time node-role device pairing with no requested scopes. Disabled when unset. Operator, browser, Control UI, and any role, scope, metadata, or public-key upgrade pairing still require manual approval.",
	"gateway.nodes.allowCommands": "Extra node.invoke commands to allow beyond the gateway defaults (array of command strings). Enabling dangerous commands here is a security-sensitive override and is flagged by `openclaw security audit`.",
	"gateway.nodes.denyCommands": "Node command names to block even if present in node claims or default allowlist (exact command-name matching only, e.g. `system.run`; does not inspect shell text inside that command).",
	"gateway.webchat.chatHistoryMaxChars": "Max characters per text field in chat.history responses before truncation (default: 12000).",
	nodeHost: "Node host controls for features exposed from this gateway node to other nodes or clients. Keep defaults unless you intentionally proxy local capabilities across your node network.",
	"nodeHost.browserProxy": "Groups browser-proxy settings for exposing local browser control through node routing. Enable only when remote node workflows need your local browser profiles.",
	"nodeHost.browserProxy.enabled": "Expose the local browser control server through node proxy routing so remote clients can use this host's browser capabilities. Keep disabled unless remote automation explicitly depends on it.",
	"nodeHost.browserProxy.allowProfiles": "Optional allowlist of browser profile names exposed through node proxy routing. Leave empty to preserve the default full profile surface, including profile create/delete routes. When set, OpenClaw enforces least-privilege profile access and blocks persistent profile create/delete through the proxy.",
	media: "Top-level media behavior shared across providers and tools that handle inbound files. Keep defaults unless you need stable filenames for external processing pipelines or longer-lived inbound media retention.",
	"media.preserveFilenames": "When enabled, uploaded media keeps its original filename instead of a generated temp-safe name. Turn this on when downstream automations depend on stable names, and leave off to reduce accidental filename leakage.",
	"media.ttlHours": "Optional retention window in hours for persisted inbound media cleanup across the full media tree. Leave unset to preserve legacy behavior, or set values like 24 (1 day) or 168 (7 days) when you want automatic cleanup.",
	audio: "Global audio ingestion settings used before higher-level tools process speech or media content. Configure this when you need deterministic transcription behavior for voice notes and clips.",
	"audio.transcription": "Command-based transcription settings for converting audio files into text before agent handling. Keep a simple, deterministic command path here so failures are easy to diagnose in logs.",
	"audio.transcription.command": "Executable + args used to transcribe audio (first token must be a safe binary/path), for example `[\"whisper-cli\", \"--model\", \"small\", \"{{MediaPath}}\"]`. Deprecated `{input}` placeholders are migrated to `{{MediaPath}}` by `openclaw doctor --fix`.",
	"audio.transcription.timeoutSeconds": "Maximum time allowed for the transcription command to finish before it is aborted. Increase this for longer recordings, and keep it tight in latency-sensitive deployments.",
	bindings: "Top-level binding rules for routing and persistent ACP conversation ownership. Use type=route for normal routing and type=acp for persistent ACP harness bindings.",
	"bindings[].type": "Binding kind. Use \"route\" (or omit for legacy route entries) for normal routing, and \"acp\" for persistent ACP conversation bindings.",
	"bindings[].agentId": "Target agent ID that receives traffic when the corresponding binding match rule is satisfied. Use valid configured agent IDs only so routing does not fail at runtime.",
	"bindings[].session": "Optional route session overrides for conversations matched by this binding. Use this when a narrow route should keep the same agent but isolate session continuity differently.",
	"bindings[].session.dmScope": "Optional DM session scope override for this route binding. For example, keep global session.dmScope=\"main\" while using \"per-account-channel-peer\" for selected direct peers.",
	"bindings[].match": "Match rule object for deciding when a binding applies, including channel and optional account/peer constraints. Keep rules narrow to avoid accidental agent takeover across contexts.",
	"bindings[].match.channel": "Channel/provider identifier this binding applies to, such as `telegram`, `discord`, or a plugin channel ID. Use the configured channel key exactly so binding evaluation works reliably.",
	"bindings[].match.accountId": "Optional account selector for multi-account channel setups so the binding applies only to one identity. Use this when account scoping is required for the route and leave unset otherwise.",
	"bindings[].match.peer": "Optional peer matcher for specific conversations including peer kind and peer id. Use this when only one direct/group/channel target should be pinned to an agent.",
	"bindings[].match.peer.kind": "Peer conversation type: \"direct\", \"group\", \"channel\", or legacy \"dm\" (deprecated alias for direct). Prefer \"direct\" for new configs and keep kind aligned with channel semantics.",
	"bindings[].match.peer.id": "Conversation identifier used with peer matching, such as a chat ID, channel ID, or group ID from the provider. Keep this exact to avoid silent non-matches.",
	"bindings[].match.guildId": "Optional Discord-style guild/server ID constraint for binding evaluation in multi-server deployments. Use this when the same peer identifiers can appear across different guilds.",
	"bindings[].match.teamId": "Optional team/workspace ID constraint used by providers that scope chats under teams. Add this when you need bindings isolated to one workspace context.",
	"bindings[].match.roles": "Optional role-based filter list used by providers that attach roles to chat context. Use this to route privileged or operational role traffic to specialized agents.",
	"bindings[].acp": "Optional per-binding ACP overrides for bindings[].type=acp. This layer overrides agents.list[].runtime.acp defaults for the matched conversation.",
	"bindings[].acp.mode": "ACP session mode override for this binding (persistent or oneshot).",
	"bindings[].acp.label": "Human-friendly label for ACP status/diagnostics in this bound conversation.",
	"bindings[].acp.cwd": "Working directory override for ACP sessions created from this binding.",
	"bindings[].acp.backend": "ACP backend override for this binding (falls back to agent runtime ACP backend, then global acp.backend).",
	broadcast: "Broadcast routing map for sending the same outbound message to multiple peer IDs per source conversation. Keep this minimal and audited because one source can fan out to many destinations.",
	"broadcast.strategy": "Delivery order for broadcast fan-out: \"parallel\" sends to all targets concurrently, while \"sequential\" sends one-by-one. Use \"parallel\" for speed and \"sequential\" for stricter ordering/backpressure control.",
	"broadcast.*": "Per-source broadcast destination list where each key is a source peer ID and the value is an array of destination peer IDs. Keep lists intentional to avoid accidental message amplification.",
	"diagnostics.flags": "Enable targeted diagnostics logs by flag (e.g. [\"telegram.http\"]). Supports wildcards like \"telegram.*\" or \"*\".",
	"diagnostics.enabled": "Master toggle for diagnostics instrumentation output in logs and telemetry wiring paths. Defaults to enabled; set false only in tightly constrained environments.",
	"diagnostics.stuckSessionWarnMs": "No-progress age threshold in milliseconds for classifying long processing sessions as long-running, stalled, or stuck. Reply, tool, status, block, and ACP progress reset the timer; repeated stuck diagnostics back off while unchanged.",
	"diagnostics.stuckSessionAbortMs": "No-progress age threshold in milliseconds before eligible stalled active work may be abort-drained for recovery. Defaults to the safer extended embedded-run recovery window.",
	"diagnostics.otel.enabled": "Enables OpenTelemetry export pipeline for traces, metrics, and logs based on configured endpoint/protocol settings. Keep disabled unless your collector endpoint and auth are fully configured.",
	"diagnostics.otel.endpoint": "Collector endpoint URL used for OpenTelemetry export transport, including scheme and port. Use a reachable, trusted collector endpoint and monitor ingestion errors after rollout.",
	"diagnostics.otel.tracesEndpoint": "Signal-specific OTLP/HTTP trace endpoint. When set, this overrides diagnostics.otel.endpoint and OTEL_EXPORTER_OTLP_ENDPOINT for trace export only.",
	"diagnostics.otel.metricsEndpoint": "Signal-specific OTLP/HTTP metrics endpoint. When set, this overrides diagnostics.otel.endpoint and OTEL_EXPORTER_OTLP_ENDPOINT for metrics export only.",
	"diagnostics.otel.logsEndpoint": "Signal-specific OTLP/HTTP logs endpoint. When set, this overrides diagnostics.otel.endpoint and OTEL_EXPORTER_OTLP_ENDPOINT for log export only.",
	"diagnostics.otel.protocol": "OTel transport protocol for telemetry export: \"http/protobuf\" or \"grpc\" depending on collector support. Use the protocol your observability backend expects to avoid dropped telemetry payloads.",
	"diagnostics.otel.headers": "Additional HTTP/gRPC metadata headers sent with OpenTelemetry export requests, often used for tenant auth or routing. Keep secrets in env-backed values and avoid unnecessary header sprawl.",
	"diagnostics.otel.serviceName": "Service name reported in telemetry resource attributes to identify this gateway instance in observability backends. Use stable names so dashboards and alerts remain consistent over deployments.",
	"diagnostics.otel.traces": "Enable trace signal export to the configured OpenTelemetry collector endpoint. Keep enabled when latency/debug tracing is needed, and disable if you only want metrics/logs.",
	"diagnostics.otel.metrics": "Enable metrics signal export to the configured OpenTelemetry collector endpoint. Keep enabled for runtime health dashboards, and disable only if metric volume must be minimized.",
	"diagnostics.otel.logs": "Enable log signal export through OpenTelemetry in addition to local logging sinks. Use this when centralized log correlation is required across services and agents.",
	"diagnostics.otel.sampleRate": "Trace sampling rate (0-1) controlling how much trace traffic is exported to observability backends. Lower rates reduce overhead/cost, while higher rates improve debugging fidelity.",
	"diagnostics.otel.flushIntervalMs": "Interval in milliseconds for periodic telemetry flush from buffers to the collector. Increase to reduce export chatter, or lower for faster visibility during active incident response.",
	"diagnostics.otel.captureContent": "Opt-in OTEL span content capture. Defaults to off; boolean true captures non-system message/tool content, while the object form lets you enable specific content classes.",
	"diagnostics.otel.captureContent.enabled": "Master switch for granular OTEL content capture fields. Keep disabled unless your collector is approved for raw prompt, response, or tool content.",
	"diagnostics.otel.captureContent.inputMessages": "Capture model input message text on OTEL spans when content capture is enabled.",
	"diagnostics.otel.captureContent.outputMessages": "Capture model output message text on OTEL spans when content capture is enabled.",
	"diagnostics.otel.captureContent.toolInputs": "Capture tool input text on OTEL spans when content capture is enabled.",
	"diagnostics.otel.captureContent.toolOutputs": "Capture tool output text on OTEL spans when content capture is enabled.",
	"diagnostics.otel.captureContent.systemPrompt": "Capture system prompt text on OTEL spans when content capture is enabled. This remains off unless explicitly enabled.",
	"diagnostics.cacheTrace.enabled": "Log cache trace snapshots for embedded agent runs (default: false).",
	"diagnostics.cacheTrace.filePath": "JSONL output path for cache trace logs (default: $OPENCLAW_STATE_DIR/logs/cache-trace.jsonl).",
	"diagnostics.cacheTrace.includeMessages": "Include full message payloads in trace output (default: true).",
	"diagnostics.cacheTrace.includePrompt": "Include prompt text in trace output (default: true).",
	"diagnostics.cacheTrace.includeSystem": "Include system prompt in trace output (default: true).",
	"tools.exec.applyPatch.enabled": "Enable or disable apply_patch for OpenAI and OpenAI Codex models when allowed by tool policy (default: true).",
	"tools.exec.applyPatch.workspaceOnly": "Restrict apply_patch paths to the workspace directory (default: true). Set false to allow writing outside the workspace (dangerous).",
	"tools.exec.applyPatch.allowModels": "Optional allowlist of model ids (e.g. \"gpt-5.4\" or \"openai/gpt-5.4\").",
	"tools.loopDetection.enabled": "Enable repetitive tool-call loop detection and backoff safety checks (default: false).",
	"tools.loopDetection.historySize": "Tool history window size for loop detection (default: 30).",
	"tools.loopDetection.warningThreshold": "Warning threshold for repetitive patterns when detector is enabled (default: 10).",
	"tools.loopDetection.unknownToolThreshold": "Block repeated calls to the same unavailable tool after this many misses (default: 10).",
	"tools.loopDetection.criticalThreshold": "Critical threshold for repetitive patterns when detector is enabled (default: 20).",
	"tools.loopDetection.globalCircuitBreakerThreshold": "Global no-progress breaker threshold (default: 30).",
	"tools.loopDetection.detectors.genericRepeat": "Enable generic repeated same-tool/same-params loop detection (default: true).",
	"tools.loopDetection.detectors.knownPollNoProgress": "Enable known poll tool no-progress loop detection (default: true).",
	"tools.loopDetection.detectors.pingPong": "Enable ping-pong loop detection (default: true).",
	"tools.loopDetection.postCompactionGuard.windowSize": "Number of post-compaction attempts during which the guard stays armed (default: 3). Lower values are stricter; higher values give the agent more attempts before abort.",
	"tools.exec.notifyOnExit": "When true (default), backgrounded exec sessions on exit and node exec lifecycle events enqueue a system event and request a heartbeat.",
	"tools.exec.notifyOnExitEmptySuccess": "When true, successful backgrounded exec exits with empty output still enqueue a completion system event (default: false).",
	"tools.exec.pathPrepend": "Directories to prepend to PATH for exec runs (gateway/sandbox).",
	"tools.exec.safeBins": "Allow stdin-only safe binaries to run without explicit allowlist entries.",
	"tools.exec.strictInlineEval": "Require explicit approval for interpreter inline-eval forms such as `python -c`, `node -e`, `ruby -e`, or `osascript -e`. Prevents silent allowlist reuse and downgrades allow-always to ask-each-time for those forms.",
	"tools.exec.commandHighlighting": "Show parser-derived command highlights in exec approval prompts (default: false). Enable this to render highlighted command text without changing exec approval policy.",
	"tools.exec.safeBinTrustedDirs": "Additional explicit directories trusted for safe-bin path checks (PATH entries are never auto-trusted).",
	"tools.exec.safeBinProfiles": "Optional per-binary safe-bin profiles (positional limits + allowed/denied flags).",
	"tools.profile": "Global tool profile name used to select a predefined tool policy baseline before applying allow/deny overrides. Use this for consistent environment posture across agents and keep profile names stable.",
	"tools.alsoAllow": "Extra tool allowlist entries merged on top of the selected tool profile and default policy. Keep this list small and explicit so audits can quickly identify intentional policy exceptions.",
	"tools.byProvider": "Per-provider tool allow/deny overrides keyed by channel/provider ID to tailor capabilities by surface. Use this when one provider needs stricter controls than global tool policy.",
	"agents.list[].tools.profile": "Per-agent override for tool profile selection when one agent needs a different capability baseline. Use this sparingly so policy differences across agents stay intentional and reviewable.",
	"agents.list[].tools.alsoAllow": "Per-agent additive allowlist for tools on top of global and profile policy. Keep narrow to avoid accidental privilege expansion on specialized agents.",
	"agents.list[].tools.codeMode": "Per-agent code mode override. Use this to test or roll out exec/wait tool-surface mode for one agent without enabling it fleet-wide.",
	"agents.list[].tools.byProvider": "Per-agent provider-specific tool policy overrides for channel-scoped capability control. Use this when a single agent needs tighter restrictions on one provider than others.",
	"agents.list[].tools.message.crossContext.allowWithinProvider": "Per-agent message guard for sending to other conversations on the same provider. Set false for current-conversation-only public agents.",
	"agents.list[].tools.message.crossContext.allowAcrossProviders": "Per-agent message guard for sending across providers. Keep false for public or sandboxed agents.",
	"agents.list[].tools.message.actions.allow": "Per-agent message action allowlist for the message tool. Set to a minimal list such as [\"send\"] for public sandbox agents so read, edit, delete, reaction, and other provider-specific message actions stay hidden and blocked.",
	"tools.exec.approvalRunningNoticeMs": "Delay in milliseconds before showing an in-progress notice after an exec approval is granted. Increase to reduce flicker for fast commands, or lower for quicker operator feedback.",
	"tools.links.enabled": "Enable automatic link understanding pre-processing so URLs can be summarized before agent reasoning. Keep enabled for richer context, and disable when strict minimal processing is required.",
	"tools.links.maxLinks": "Maximum number of links expanded per turn during link understanding. Use lower values to control latency/cost in chatty threads and higher values when multi-link context is critical.",
	"tools.links.timeoutSeconds": "Per-link understanding timeout budget in seconds before unresolved links are skipped. Keep this bounded to avoid long stalls when external sites are slow or unreachable.",
	"tools.links.models": "Preferred model list for link understanding tasks, evaluated in order as fallbacks when supported. Use lightweight models first for routine summarization and heavier models only when needed.",
	"tools.links.scope": "Controls when link understanding runs relative to conversation context and message type. Keep scope conservative to avoid unnecessary fetches on messages where links are not actionable.",
	"tools.media.models": "Shared fallback model list used by media understanding tools when modality-specific model lists are not set. Keep this aligned with available multimodal providers to avoid runtime fallback churn.",
	"tools.media.concurrency": "Maximum number of concurrent media understanding operations per turn across image, audio, and video tasks. Lower this in resource-constrained deployments to prevent CPU/network saturation.",
	"tools.media.asyncCompletion.directSend": "Deprecated compatibility flag. Async media generation completions are requester-session mediated so the agent can decide how to tell the user and use the message tool when source delivery requires it.",
	"tools.media.image.enabled": "Enable image understanding so attached or referenced images can be interpreted into textual context. Disable if you need text-only operation or want to avoid image-processing cost.",
	"tools.media.image.maxBytes": "Maximum accepted image payload size in bytes before the item is skipped or truncated by policy. Keep limits realistic for your provider caps and infrastructure bandwidth.",
	"tools.media.image.maxChars": "Maximum characters returned from image understanding output after model response normalization. Use tighter limits to reduce prompt bloat and larger limits for detail-heavy OCR tasks.",
	"tools.media.image.prompt": "Instruction template used for image understanding requests to shape extraction style and detail level. Keep prompts deterministic so outputs stay consistent across turns and channels.",
	"tools.media.image.timeoutSeconds": "Timeout in seconds for each image understanding request before it is aborted. Increase for high-resolution analysis and lower it for latency-sensitive operator workflows.",
	"tools.media.image.attachments": "Attachment handling policy for image inputs, including which message attachments qualify for image analysis. Use restrictive settings in untrusted channels to reduce unexpected processing.",
	"tools.media.image.models": "Ordered model preferences specifically for image understanding when you want to override shared media models. Put the most reliable multimodal model first to reduce fallback attempts.",
	"tools.media.image.scope": "Scope selector for when image understanding is attempted (for example only explicit requests versus broader auto-detection). Keep narrow scope in busy channels to control token and API spend.",
	...MEDIA_AUDIO_FIELD_HELP,
	"tools.media.video.enabled": "Enable video understanding so clips can be summarized into text for downstream reasoning and responses. Disable when processing video is out of policy or too expensive for your deployment.",
	"tools.media.video.maxBytes": "Maximum accepted video payload size in bytes before policy rejection or trimming occurs. Tune this to provider and infrastructure limits to avoid repeated timeout/failure loops.",
	"tools.media.video.maxChars": "Maximum characters retained from video understanding output to control prompt growth. Raise for dense scene descriptions and lower when concise summaries are preferred.",
	"tools.media.video.prompt": "Instruction template for video understanding describing desired summary granularity and focus areas. Keep this stable so output quality remains predictable across model/provider fallbacks.",
	"tools.media.video.timeoutSeconds": "Timeout in seconds for each video understanding request before cancellation. Use conservative values in interactive channels and longer values for offline or batch-heavy processing.",
	"tools.media.video.attachments": "Attachment eligibility policy for video analysis, defining which message files can trigger video processing. Keep this explicit in shared channels to prevent accidental large media workloads.",
	"tools.media.video.models": "Ordered model preferences specifically for video understanding before shared media fallback applies. Prioritize models with strong multimodal video support to minimize degraded summaries.",
	"tools.media.video.scope": "Scope selector controlling when video understanding is attempted across incoming events. Narrow scope in noisy channels, and broaden only where video interpretation is core to workflow.",
	"skills.load.extraDirs": "Additional shared skill roots to scan at lowest precedence. Use this for sibling repos or shared skill packs that should be available without copying them into the OpenClaw workspace.",
	"skills.load.allowSymlinkTargets": "Trusted real target roots that skill symlinks may resolve into when they sit outside their configured source root. Keep this narrow, such as a sibling repo skills directory.",
	"skills.load.watch": "Enable filesystem watching for skill-definition changes so updates can be applied without full process restart. Keep enabled in development workflows and disable in immutable production images.",
	"skills.load.watchDebounceMs": "Debounce window in milliseconds for coalescing rapid skill file changes before reload logic runs. Increase to reduce reload churn on frequent writes, or lower for faster edit feedback.",
	approvals: "Approval routing controls for forwarding exec and plugin approval requests to chat destinations outside the originating session. Keep these disabled unless operators need explicit out-of-band approval visibility.",
	"approvals.exec": "Groups exec-approval forwarding behavior including enablement, routing mode, filters, and explicit targets. Configure here when approval prompts must reach operational channels instead of only the origin thread.",
	"approvals.exec.enabled": "Enables forwarding of exec approval requests to configured delivery destinations (default: false). Keep disabled in low-risk setups and enable only when human approval responders need channel-visible prompts.",
	"approvals.exec.mode": "Controls where approval prompts are sent: \"session\" uses origin chat, \"targets\" uses configured targets, and \"both\" sends to both paths. Use \"session\" as baseline and expand only when operational workflow requires redundancy.",
	"approvals.exec.agentFilter": "Optional allowlist of agent IDs eligible for forwarded approvals, for example `[\"primary\", \"ops-agent\"]`. Use this to limit forwarding blast radius and avoid notifying channels for unrelated agents.",
	"approvals.exec.sessionFilter": "Optional session-key filters matched as substring or regex-style patterns, for example `[\"discord:\", \"^agent:ops:\"]`. Use narrow patterns so only intended approval contexts are forwarded to shared destinations.",
	"approvals.exec.targets": "Explicit delivery targets used when forwarding mode includes targets, each with channel and destination details. Keep target lists least-privilege and validate each destination before enabling broad forwarding.",
	"approvals.exec.targets[].channel": "Channel/provider ID used for forwarded approval delivery, such as discord, slack, or a plugin channel id. Use valid channel IDs only so approvals do not silently fail due to unknown routes.",
	"approvals.exec.targets[].to": "Destination identifier inside the target channel (channel ID, user ID, or thread root depending on provider). Verify semantics per provider because destination format differs across channel integrations.",
	"approvals.exec.targets[].accountId": "Optional account selector for multi-account channel setups when approvals must route through a specific account context. Use this only when the target channel has multiple configured identities.",
	"approvals.exec.targets[].threadId": "Optional thread/topic target for channels that support threaded delivery of forwarded approvals. Use this to keep approval traffic contained in operational threads instead of main channels.",
	"approvals.plugin": "Groups plugin-approval forwarding behavior including enablement, routing mode, filters, and explicit targets. Independent of exec approval forwarding. Configure here when plugin approval prompts must reach operational channels.",
	"approvals.plugin.enabled": "Enables forwarding of plugin approval requests to configured delivery destinations (default: false). Independent of approvals.exec.enabled.",
	"approvals.plugin.mode": "Controls where plugin approval prompts are sent: \"session\" uses origin chat, \"targets\" uses configured targets, and \"both\" sends to both paths.",
	"approvals.plugin.agentFilter": "Optional allowlist of agent IDs eligible for forwarded plugin approvals, for example `[\"primary\", \"ops-agent\"]`. Use this to limit forwarding blast radius.",
	"approvals.plugin.sessionFilter": "Optional session-key filters matched as substring or regex-style patterns, for example `[\"discord:\", \"^agent:ops:\"]`. Use narrow patterns so only intended approval contexts are forwarded.",
	"approvals.plugin.targets": "Explicit delivery targets used when plugin approval forwarding mode includes targets, each with channel and destination details.",
	"approvals.plugin.targets[].channel": "Channel/provider ID used for forwarded plugin approval delivery, such as discord, slack, or a plugin channel id.",
	"approvals.plugin.targets[].to": "Destination identifier inside the target channel (channel ID, user ID, or thread root depending on provider).",
	"approvals.plugin.targets[].accountId": "Optional account selector for multi-account channel setups when plugin approvals must route through a specific account context.",
	"approvals.plugin.targets[].threadId": "Optional thread/topic target for channels that support threaded delivery of forwarded plugin approvals.",
	"tools.fs.workspaceOnly": "Restrict filesystem tools (read/write/edit/apply_patch) to the workspace directory (default: false).",
	"tools.sessions.visibility": "Controls which sessions can be targeted by sessions_list/sessions_history/sessions_send. (\"tree\" default = current session + spawned subagent sessions; \"self\" = only current; \"agent\" = any session in the current agent id; \"all\" = any session; cross-agent still requires tools.agentToAgent).",
	"tools.message.allowCrossContextSend": "Legacy override: allow cross-context sends across all providers.",
	"tools.message.crossContext.allowWithinProvider": "Allow sends to other channels within the same provider (default: true).",
	"tools.message.crossContext.allowAcrossProviders": "Allow sends across different providers (default: false).",
	"tools.message.crossContext.marker.enabled": "Add a visible origin marker when sending cross-context (default: true).",
	"tools.message.crossContext.marker.prefix": "Text prefix for cross-context markers (supports \"{channel}\").",
	"tools.message.crossContext.marker.suffix": "Text suffix for cross-context markers (supports \"{channel}\").",
	"tools.message.broadcast.enabled": "Enable broadcast action (default: true).",
	"tools.message.actions.allow": "Global message action allowlist for the message tool. Use only when the whole runtime should expose and accept a reduced action set; prefer per-agent allowlists for public or sandboxed agents.",
	"tools.web.search.enabled": "Enable managed web_search and optional Codex-native search for eligible models.",
	"tools.web.search.provider": "Search provider id. Auto-detected from available API keys if omitted.",
	"tools.web.search.maxResults": "Number of results to return (1-10).",
	"tools.web.search.timeoutSeconds": "Timeout in seconds for web_search requests.",
	"tools.web.search.cacheTtlMinutes": "Cache TTL in minutes for web_search results.",
	"tools.web.search.openaiCodex.enabled": "Enable native Codex web search for Codex-capable models.",
	"tools.web.search.openaiCodex.mode": "Native Codex web search mode: \"cached\" (default) or \"live\".",
	"tools.web.search.openaiCodex.allowedDomains": "Optional domain allowlist passed to the native Codex web_search tool.",
	"tools.web.search.openaiCodex.contextSize": "Native Codex search context size hint: \"low\", \"medium\", or \"high\".",
	"tools.web.search.openaiCodex.userLocation.country": "Approximate country sent to native Codex web search.",
	"tools.web.search.openaiCodex.userLocation.region": "Approximate region/state sent to native Codex web search.",
	"tools.web.search.openaiCodex.userLocation.city": "Approximate city sent to native Codex web search.",
	"tools.web.search.openaiCodex.userLocation.timezone": "Approximate timezone sent to native Codex web search.",
	"tools.web.search.brave.mode": "Brave Search mode: \"web\" (URL results) or \"llm-context\" (pre-extracted page content for LLM grounding).",
	"tools.web.fetch.enabled": "Enable the web_fetch tool (lightweight HTTP fetch).",
	"tools.web.fetch.maxChars": "Max characters returned by web_fetch (truncated).",
	"tools.web.fetch.maxCharsCap": "Hard cap for web_fetch maxChars (applies to config and tool calls).",
	"tools.web.fetch.maxResponseBytes": "Max download size before truncation.",
	"tools.web.fetch.provider": "Web fetch fallback provider id.",
	"tools.web.fetch.timeoutSeconds": "Timeout in seconds for web_fetch requests.",
	"tools.web.fetch.cacheTtlMinutes": "Cache TTL in minutes for web_fetch results.",
	"tools.web.fetch.maxRedirects": "Maximum redirects allowed for web_fetch (default: 3).",
	"tools.web.fetch.userAgent": "Override User-Agent header for web_fetch requests.",
	"tools.web.fetch.readability": "Use Readability to extract main content from HTML (fallbacks to basic HTML cleanup).",
	"tools.web.fetch.useTrustedEnvProxy": "Route web_fetch through a trusted HTTP(S) env proxy and let the proxy resolve DNS. Enable only when that proxy is operator-controlled and enforces outbound policy after DNS resolution.",
	"tools.web.fetch.ssrfPolicy": "Scoped SSRF policy overrides for web_fetch. Keep this narrow and opt in only for known local-network proxy environments.",
	"tools.web.fetch.ssrfPolicy.allowRfc2544BenchmarkRange": "Allow RFC 2544 benchmark-range IPs (198.18.0.0/15) for fake-IP proxy compatibility such as Clash or Surge.",
	"tools.web.fetch.ssrfPolicy.allowIpv6UniqueLocalRange": "Allow IPv6 Unique Local Addresses (fc00::/7) for trusted fake-IP proxy compatibility such as sing-box, Clash, or Surge.",
	models: "Model catalog root for provider definitions, merge/replace behavior, and optional Bedrock discovery integration. Keep provider definitions explicit and validated before relying on production failover paths.",
	"models.mode": "Controls provider catalog behavior: \"merge\" keeps built-ins and overlays your custom providers, while \"replace\" uses only your configured providers. In \"merge\", matching provider IDs preserve non-empty agent models.json baseUrl values, while apiKey values are preserved only when the provider is not SecretRef-managed in current config/auth-profile context; SecretRef-managed providers refresh apiKey from current source markers, and matching model contextWindow/maxTokens use the higher value between explicit and implicit entries.",
	"models.providers": "Provider map keyed by provider ID containing connection/auth settings and concrete model definitions. Built-in providers may be tuned with provider-level overlays; custom providers must include baseUrl and models. Use stable provider keys so references from agents and tooling remain portable across environments.",
	"models.pricing": "Controls the optional background model-pricing bootstrap that fetches remote per-token cost catalogs.",
	"models.pricing.enabled": "Enable the background model-pricing bootstrap. Set to false to skip OpenRouter and LiteLLM catalog fetches during Gateway startup; changing this value requires a Gateway restart.",
	"models.providers.*.baseUrl": "Base URL for the provider endpoint used to serve model requests for that provider entry. Use HTTPS endpoints and keep URLs environment-specific through config templating where needed.",
	"models.providers.*.apiKey": "Provider credential used for API-key based authentication when the provider requires direct key auth. Use secret/env substitution and avoid storing real keys in committed config files.",
	"models.providers.*.auth": "Selects provider auth style: \"api-key\" for API key auth, \"token\" for bearer token auth, \"oauth\" for OAuth credentials, and \"aws-sdk\" for AWS credential resolution. Match this to your provider requirements.",
	"models.providers.*.api": "Provider API adapter selection controlling request/response compatibility handling for model calls. Use the adapter that matches your upstream provider protocol to avoid feature mismatch.",
	"models.providers.*.contextWindow": "Default native context window applied to models under this provider when a model entry does not set contextWindow. Use model-level contextWindow for per-model overrides.",
	"models.providers.*.contextTokens": "Default effective runtime context cap applied to models under this provider when a model entry does not set contextTokens. Use this when runtime should budget below the native contextWindow.",
	"models.providers.*.maxTokens": "Default maximum output token budget applied to models under this provider when a model entry does not set maxTokens.",
	"models.providers.*.timeoutSeconds": "Optional per-provider model request timeout in seconds. For built-in providers, this can be set as a standalone overlay. For custom providers, set it alongside the provider baseUrl and models. Applies to provider HTTP fetches, including connect, headers, body, and total request abort handling, and also raises the LLM idle/stream watchdog ceiling for this provider above the implicit ~120s default. Use this for slow local or self-hosted model servers, or for cloud providers that buffer reasoning tokens silently on the wire (Gemini preview, large-tool-payload Claude/Opus), instead of changing global agent timeouts.",
	"models.providers.*.injectNumCtxForOpenAICompat": "Controls whether OpenClaw injects `options.num_ctx` for Ollama providers configured with the OpenAI-compatible adapter (`openai-completions`). Default is true. Set false only if your proxy/upstream rejects unknown `options` payload fields.",
	"models.providers.*.params": "Provider-specific runtime parameters interpreted by provider plugins. Keep keys documented by the provider, and prefer explicit provider docs over ad hoc shared assumptions.",
	"models.providers.*.headers": "Static HTTP headers merged into provider requests for tenant routing, proxy auth, or custom gateway requirements. Use this sparingly and keep sensitive header values in secrets.",
	"models.providers.*.authHeader": "When true, credentials are sent via the HTTP Authorization header even if alternate auth is possible. Use this only when your provider or proxy explicitly requires Authorization forwarding.",
	"models.providers.*.agentRuntime": "Optional low-level agent runtime policy for this provider. Use provider/model runtime policy instead of agent-wide runtime pins; omitted/default lets OpenClaw choose the runtime for the selected provider.",
	"models.providers.*.agentRuntime.id": "Provider agent runtime id: \"pi\", \"auto\", a registered plugin harness id such as \"codex\", or a supported CLI backend alias such as \"claude-cli\". OpenAI on the official endpoint defaults to the Codex harness when omitted.",
	"models.providers.*.localService": "Optional on-demand local model server process for this provider. OpenClaw probes healthUrl, starts the command when needed, waits for readiness, and then sends the model request.",
	"models.providers.*.localService.command": "Absolute executable path for the local model server process. Keep this path explicit so provider startup is deterministic and does not depend on shell PATH lookup.",
	"models.providers.*.localService.args": "Argument list passed to the local model server command without shell expansion.",
	"models.providers.*.localService.cwd": "Working directory for the local model server process.",
	"models.providers.*.localService.env": "Additional environment variables for the local model server process. Values that look secret are redacted from config snapshots.",
	"models.providers.*.localService.healthUrl": "Readiness URL probed before model requests. If omitted, OpenClaw uses the provider baseUrl with /models appended.",
	"models.providers.*.localService.readyTimeoutMs": "Maximum milliseconds to wait for the local model server readiness probe after starting the process.",
	"models.providers.*.localService.idleStopMs": "Milliseconds to keep an OpenClaw-started local model server alive after the last request finishes. Set 0 to keep it alive until OpenClaw exits.",
	"models.providers.*.request": "Optional request overrides for model-provider requests, including extra headers, auth overrides, proxy routing, TLS client settings, and optional allowPrivateNetwork for trusted self-hosted endpoints. Use these only when your upstream or enterprise network path requires transport customization.",
	"models.providers.*.request.headers": "Extra headers merged into provider requests after default attribution and auth resolution.",
	"models.providers.*.request.auth": "Override provider request authentication behavior for this provider.",
	"models.providers.*.request.auth.mode": "Auth override mode: \"provider-default\", \"authorization-bearer\", or \"header\".",
	"models.providers.*.request.auth.token": "Bearer token used when auth mode is authorization-bearer.",
	"models.providers.*.request.auth.headerName": "Custom auth header name used when auth mode is header.",
	"models.providers.*.request.auth.value": "Custom auth header value used when auth mode is header.",
	"models.providers.*.request.auth.prefix": "Optional prefix prepended to request.auth.value when auth mode is header.",
	"models.providers.*.request.proxy": "Optional proxy override for model-provider requests. Use \"env-proxy\" to honor environment proxy settings or \"explicit-proxy\" to route through a specific proxy URL.",
	"models.providers.*.request.proxy.mode": "Proxy override mode for model-provider requests: \"env-proxy\" or \"explicit-proxy\".",
	"models.providers.*.request.proxy.url": "Explicit proxy URL used when request.proxy.mode is explicit-proxy. Credentials embedded in the URL are treated as sensitive and redacted from snapshots.",
	"models.providers.*.request.proxy.tls": "Optional TLS settings used when connecting to the configured proxy.",
	"models.providers.*.request.proxy.tls.ca": "Custom CA bundle used to verify the proxy TLS certificate chain.",
	"models.providers.*.request.proxy.tls.cert": "Client TLS certificate presented to the proxy when mutual TLS is required.",
	"models.providers.*.request.proxy.tls.key": "Private key paired with request.proxy.tls.cert for proxy mutual TLS.",
	"models.providers.*.request.proxy.tls.passphrase": "Optional passphrase used to decrypt request.proxy.tls.key.",
	"models.providers.*.request.proxy.tls.serverName": "Optional SNI/server-name override used when establishing TLS to the proxy.",
	"models.providers.*.request.proxy.tls.insecureSkipVerify": "Skips proxy TLS certificate verification. Use only for controlled development environments.",
	proxy: "Operator-managed forward proxy routing for OpenClaw runtime HTTP, HTTPS, WebSocket, and supported raw-egress paths. Use this when central egress control is part of the deployment boundary.",
	"proxy.enabled": "Enables operator-managed proxy routing. When enabled, OpenClaw fails startup if no managed proxy URL is configured.",
	"proxy.proxyUrl": "Managed forward proxy URL. Use http:// for a plain CONNECT proxy or https:// when the connection to the proxy endpoint itself must use TLS.",
	"proxy.tls": "TLS settings used when connecting to the managed proxy endpoint. These settings apply to proxy TLS, not destination TLS after CONNECT.",
	"proxy.tls.caFile": "Filesystem path to a custom CA bundle used to verify an HTTPS managed proxy endpoint certificate.",
	"proxy.loopbackMode": "Controls Gateway loopback control-plane routing while managed proxy mode is active: \"gateway-only\", \"proxy\", or \"block\".",
	"models.providers.*.request.tls": "Optional TLS settings used when connecting directly to the upstream model endpoint.",
	"models.providers.*.request.tls.ca": "Custom CA bundle used to verify the upstream TLS certificate chain.",
	"models.providers.*.request.tls.cert": "Client TLS certificate presented to the upstream endpoint when mutual TLS is required.",
	"models.providers.*.request.tls.key": "Private key paired with request.tls.cert for upstream mutual TLS.",
	"models.providers.*.request.tls.passphrase": "Optional passphrase used to decrypt request.tls.key.",
	"models.providers.*.request.tls.serverName": "Optional SNI/server-name override used when establishing upstream TLS.",
	"models.providers.*.request.tls.insecureSkipVerify": "Skips upstream TLS certificate verification. Use only for controlled development environments.",
	"models.providers.*.request.allowPrivateNetwork": "When true, allow model-provider HTTP requests to private, CGNAT, or similar ranges through the provider HTTP fetch guard (fetchWithSsrFGuard). Custom/local provider base URLs already trust the exact configured origin, except metadata/link-local origins; set this to false to opt out of that trust. OpenAI Responses WebSocket reuses request for headers/TLS but does not use that fetch SSRF path. Use true only for operator-controlled self-hosted endpoints that must reach private origins outside the configured baseUrl origin.",
	"models.providers.*.models": "Declared model list for a provider including identifiers, metadata, provider-specific params, and optional compatibility/cost hints. Keep IDs exact to provider catalog values so selection and fallback resolve correctly.",
	"models.providers.*.models[].agentRuntime": "Optional low-level agent runtime policy for this specific model. Model runtime policy overrides the provider runtime policy.",
	"models.providers.*.models[].agentRuntime.id": "Model agent runtime id: \"pi\", \"auto\", a registered plugin harness id such as \"codex\", or a supported CLI backend alias such as \"claude-cli\".",
	auth: "Authentication profile root used for multi-profile provider credentials and cooldown-based failover ordering. Keep profiles minimal and explicit so automatic failover behavior stays auditable.",
	"channels.googlechat.botLoopProtection": "Sliding-window guard for accepted Google Chat bot-to-bot loops. Defaults to the shared bot loop protection budget when allowBots lets bot-authored messages reach dispatch.",
	"channels.mattermost.botToken": "Bot token from Mattermost System Console -> Integrations -> Bot Accounts.",
	"channels.mattermost.baseUrl": "Base URL for your Mattermost server (e.g., https://chat.example.com).",
	"channels.mattermost.chatmode": "Reply to channel messages on mention (\"oncall\"), on trigger chars (\">\" or \"!\") (\"onchar\"), or on every message (\"onmessage\").",
	"channels.mattermost.oncharPrefixes": "Trigger prefixes for onchar mode (default: [\">\", \"!\"]).",
	"channels.mattermost.requireMention": "Require @mention in channels before responding (default: true).",
	"auth.profiles": "Named auth profiles (provider + mode + optional email).",
	"auth.order": "Ordered auth profile IDs per provider (used for automatic failover).",
	"auth.cooldowns": "Cooldown/backoff controls for temporary profile suppression after billing-related failures and retry windows. Use these to prevent rapid re-selection of profiles that are still blocked.",
	"auth.cooldowns.billingBackoffHours": "Base backoff (hours) when a profile fails due to billing/insufficient credits (default: 5).",
	"auth.cooldowns.billingBackoffHoursByProvider": "Optional per-provider overrides for billing backoff (hours).",
	"auth.cooldowns.billingMaxHours": "Cap (hours) for billing backoff (default: 24).",
	"auth.cooldowns.authPermanentBackoffMinutes": "Base backoff (minutes) for high-confidence auth_permanent failures (default: 10). Keep this shorter than billing so providers recover automatically after transient upstream auth incidents.",
	"auth.cooldowns.authPermanentMaxMinutes": "Cap (minutes) for auth_permanent backoff (default: 60).",
	"auth.cooldowns.failureWindowHours": "Failure window (hours) for backoff counters (default: 24).",
	"auth.cooldowns.overloadedProfileRotations": "Maximum same-provider auth-profile rotations allowed for overloaded errors before switching to model fallback (default: 1).",
	"auth.cooldowns.overloadedBackoffMs": "Fixed delay in milliseconds before retrying an overloaded provider/profile rotation (default: 0).",
	"auth.cooldowns.rateLimitedProfileRotations": "Maximum same-provider auth-profile rotations allowed for rate-limit errors before switching to model fallback (default: 1).",
	"agents.defaults.workspace": "Default workspace path exposed to agent runtime tools for filesystem context and repo-aware behavior. Set this explicitly when running from wrappers so path resolution stays deterministic.",
	"agents.defaults.skipOptionalBootstrapFiles": "Optional bootstrap files that should not be created in agent workspaces. Valid values: SOUL.md, USER.md, HEARTBEAT.md, IDENTITY.md.",
	"agents.defaults.contextInjection": "Controls when workspace bootstrap files are injected into the system prompt: \"always\" (default) or \"continuation-skip\" for safe continuation turns after a completed assistant response.",
	"agents.defaults.bootstrapMaxChars": "Max characters of each workspace bootstrap file injected into the system prompt before truncation (default: 12000).",
	"agents.defaults.bootstrapTotalMaxChars": "Max total characters across all injected workspace bootstrap files (default: 60000).",
	"agents.defaults.experimental": "Experimental agent-default flags. Keep these off unless you are intentionally testing a preview surface.",
	"agents.defaults.experimental.localModelLean": "Experimental local-model prompt trim. When enabled, OpenClaw drops heavyweight default tools like browser, cron, and message for weaker or smaller local-model backends.",
	"agents.defaults.bootstrapPromptTruncationWarning": "Inject agent-visible warning text when bootstrap files are truncated: \"off\", \"once\", or \"always\" (default).",
	"agents.defaults.startupContext": "Runtime-owned first-turn prelude for bare \"/new\" and \"/reset\". Use this to control whether recent daily memory files are preloaded into the first prompt instead of asking the model to decide what to read.",
	"agents.defaults.startupContext.enabled": "Enable the startup-context prelude for bare session resets (default: true). Disable this to fall back to prompt-only behavior with no runtime-loaded daily memory.",
	"agents.defaults.startupContext.applyOn": "Chooses which bare reset commands get startup context: include \"new\", \"reset\", or both (default: [\"new\",\"reset\"]).",
	"agents.defaults.startupContext.dailyMemoryDays": "Number of dated memory files to load counting backward from today in the configured user timezone (default: 2 for today + yesterday).",
	"agents.defaults.startupContext.maxFileBytes": "Maximum bytes allowed per daily memory file when building startup context (default: 16384). Files over this boundary-safe read limit are skipped.",
	"agents.defaults.startupContext.maxFileChars": "Maximum characters retained from each loaded daily memory file in the startup prelude (default: 1200).",
	"agents.defaults.startupContext.maxTotalChars": "Maximum total characters retained across all loaded daily memory files in the startup prelude (default: 2800). Additional files are truncated from the prelude once this cap is reached.",
	"agents.defaults.repoRoot": "Optional repository root shown in the system prompt runtime line (overrides auto-detect).",
	"agents.defaults.promptOverlays": "Provider-independent prompt overlays applied by model family before provider-specific prompt hooks.",
	"agents.defaults.promptOverlays.gpt5": "Shared GPT-5-family prompt overlay applied to matching model ids across providers such as OpenAI, OpenRouter, OpenCode, Codex, and compatible gateways.",
	"agents.defaults.promptOverlays.gpt5.personality": "Friendly interaction-style layer for GPT-5-family models (\"friendly\" or \"on\" enables it; \"off\" disables only that layer). The tagged behavior contract remains enabled for matching GPT-5 models.",
	"agents.defaults.envelopeTimezone": "Timezone for message envelopes (\"utc\", \"local\", \"user\", or an IANA timezone string).",
	"agents.defaults.envelopeTimestamp": "Include absolute timestamps in message envelopes (\"on\" or \"off\").",
	"agents.defaults.envelopeElapsed": "Include elapsed time in message envelopes (\"on\" or \"off\").",
	"agents.defaults.models": "Configured model catalog and allowlist (keys are full provider/model IDs or literal provider/* entries for dynamic provider catalogs).",
	"agents.defaults.models.*.agentRuntime": "Optional per-model runtime policy for the default agent. Use this for model-specific runtime exceptions instead of setting a whole-agent runtime.",
	"agents.defaults.models.*.agentRuntime.id": "Default-agent model runtime id: \"pi\", \"auto\", a registered plugin harness id such as \"codex\", or a supported CLI backend alias such as \"claude-cli\".",
	"agents.defaults.memorySearch": "Vector search over MEMORY.md and memory/*.md (per-agent overrides supported).",
	"agents.defaults.memorySearch.enabled": "Master toggle for memory search indexing and retrieval behavior on this agent profile. Keep enabled for semantic recall, and disable when you want fully stateless responses.",
	"agents.defaults.memorySearch.sources": "Chooses which sources are indexed: \"memory\" reads MEMORY.md + memory files, and \"sessions\" includes transcript history. Keep [\"memory\"] unless you need recall from prior chat transcripts.",
	"agents.defaults.memorySearch.extraPaths": "Adds extra directories or .md files to the memory index beyond default memory files. Use this when key reference docs live elsewhere in your repo; when multimodal memory is enabled, matching image/audio files under these paths are also eligible for indexing.",
	"agents.defaults.memorySearch.qmd": "Use this when one agent should query another agent's transcript collections; QMD-specific extra collections let you opt into cross-agent memory search without flattening everything into one shared namespace.",
	"agents.defaults.memorySearch.qmd.extraCollections": "Use this when you need directional transcript search across agents; add collections here to scope QMD recalls without creating a shared global transcript namespace.",
	"agents.defaults.memorySearch.qmd.extraCollections.path": "Use an absolute or workspace-relative filesystem path for the extra QMD collection; keep it pointed at the transcript directory or note folder you actually want this agent to search.",
	"agents.defaults.memorySearch.qmd.extraCollections.name": "Preserves the configured collection label only when the path points outside the agent workspace; paths inside the workspace stay agent-scoped even if a name is provided. Use this for shared cross-agent transcript roots that live outside the workspace.",
	"agents.defaults.memorySearch.qmd.extraCollections.pattern": "Use a glob pattern to restrict which files inside the collection are indexed; keep the default `**/*.md` unless you need a narrower subset.",
	"agents.defaults.memorySearch.multimodal": "Optional multimodal memory settings for indexing image and audio files from configured extra paths. Keep this off unless your embedding model explicitly supports cross-modal embeddings, and set `memorySearch.fallback` to \"none\" while it is enabled. Matching files are uploaded to the configured remote embedding provider during indexing.",
	"agents.defaults.memorySearch.multimodal.enabled": "Enables image/audio memory indexing from extraPaths. This currently requires Gemini embedding-2, keeps the default memory roots Markdown-only, disables memory-search fallback providers, and uploads matching binary content to the configured remote embedding provider.",
	"agents.defaults.memorySearch.multimodal.modalities": "Selects which multimodal file types are indexed from extraPaths: \"image\", \"audio\", or \"all\". Keep this narrow to avoid indexing large binary corpora unintentionally.",
	"agents.defaults.memorySearch.multimodal.maxFileBytes": "Sets the maximum bytes allowed per multimodal file before it is skipped during memory indexing. Use this to cap upload cost and indexing latency, or raise it for short high-quality audio clips.",
	"agents.defaults.memorySearch.experimental.sessionMemory": "Indexes session transcripts into memory search so responses can reference prior chat turns. Keep this off unless transcript recall is needed, because indexing cost and storage usage both increase.",
	"agents.defaults.memorySearch.provider": "Selects the embedding backend used to build/query memory vectors: \"openai\", \"gemini\", \"voyage\", \"mistral\", \"bedrock\", \"lmstudio\", \"ollama\", or \"local\". Keep your most reliable provider here and configure fallback for resilience.",
	"agents.defaults.memorySearch.model": "Embedding model override used by the selected memory provider when a non-default model is required. Set this only when you need explicit recall quality/cost tuning beyond provider defaults.",
	"agents.defaults.memorySearch.inputType": "Use this optional provider-specific `input_type` value only when the same label should apply to both query and document embedding requests. For asymmetric providers, prefer queryInputType and documentInputType.",
	"agents.defaults.memorySearch.queryInputType": "Optional provider-specific `input_type` value for query-time memory embeddings. Use this with OpenAI-compatible asymmetric embedding endpoints that require a query label.",
	"agents.defaults.memorySearch.documentInputType": "Optional provider-specific `input_type` value for document and indexing memory embeddings. Use this with OpenAI-compatible asymmetric embedding endpoints that require a passage or document label.",
	"agents.defaults.memorySearch.outputDimensionality": "Provider-specific output vector size override for memory embeddings. Gemini embedding-2 supports 768, 1536, or 3072; Bedrock families such as Titan V2, Cohere V4, and Nova expose their own allowed sizes. Expect a full reindex when you change it because stored vector dimensions must stay consistent.",
	"agents.defaults.memorySearch.remote.baseUrl": "Overrides the embedding API endpoint, such as an OpenAI-compatible proxy or custom Gemini base URL. Use this only when routing through your own gateway or vendor endpoint; keep provider defaults otherwise.",
	"agents.defaults.memorySearch.remote.apiKey": "Supplies a dedicated API key for remote embedding calls used by memory indexing and query-time embeddings. Use this when memory embeddings should use different credentials than global defaults or environment variables.",
	"agents.defaults.memorySearch.remote.headers": "Adds custom HTTP headers to remote embedding requests, merged with provider defaults. Use this for proxy auth and tenant routing headers, and keep values minimal to avoid leaking sensitive metadata.",
	"agents.defaults.memorySearch.remote.nonBatchConcurrency": "Controls concurrent inline embedding requests during non-batch memory indexing. Use a low value for local or small self-hosted providers such as Ollama; batch embedding concurrency is configured separately under remote.batch.",
	"agents.defaults.memorySearch.remote.batch.enabled": "Enables provider batch APIs for embedding jobs when supported (OpenAI/Gemini), improving throughput on larger index runs. Keep this enabled unless debugging provider batch failures or running very small workloads.",
	"agents.defaults.memorySearch.remote.batch.wait": "Waits for batch embedding jobs to fully finish before the indexing operation completes. Keep this enabled for deterministic indexing state; disable only if you accept delayed consistency.",
	"agents.defaults.memorySearch.remote.batch.concurrency": "Limits how many embedding batch jobs run at the same time during indexing (default: 2). Increase carefully for faster bulk indexing, but watch provider rate limits and queue errors.",
	"agents.defaults.memorySearch.remote.batch.pollIntervalMs": "Controls how often the system polls provider APIs for batch job status in milliseconds (default: 2000). Use longer intervals to reduce API chatter, or shorter intervals for faster completion detection.",
	"agents.defaults.memorySearch.remote.batch.timeoutMinutes": "Sets the maximum wait time for a full embedding batch operation in minutes (default: 60). Increase for very large corpora or slower providers, and lower it to fail fast in automation-heavy flows.",
	"agents.defaults.memorySearch.local.modelPath": "Specifies the local embedding model source for local memory search, such as a GGUF file path or `hf:` URI. Use this only when provider is `local`, and verify model compatibility before large index rebuilds.",
	"agents.defaults.memorySearch.local.contextSize": "Context window size passed to node-llama-cpp when creating the embedding context (default: 4096). 4096 safely covers typical memory-search chunks (128–512 tokens) while keeping non-weight VRAM bounded. Lower to 1024–2048 on resource-constrained hosts. Set to \"auto\" to let node-llama-cpp use the model's trained maximum — not recommended for large models (e.g. Qwen3-Embedding-8B trained on 40 960 tokens can push VRAM from ~8.8 GB to ~32 GB).",
	"agents.defaults.memorySearch.fallback": "Backup provider used when primary embeddings fail: \"openai\", \"gemini\", \"voyage\", \"mistral\", \"bedrock\", \"lmstudio\", \"ollama\", \"local\", or \"none\". Set a real fallback for production reliability; use \"none\" only if you prefer explicit failures.",
	"agents.defaults.memorySearch.store.path": "Sets where the SQLite memory index is stored on disk for each agent. Keep the default `~/.openclaw/memory/{agentId}.sqlite` unless you need custom storage placement or backup policy alignment.",
	"agents.defaults.memorySearch.store.vector.enabled": "Enables the sqlite-vec extension used for vector similarity queries in memory search (default: true). Keep this enabled for normal semantic recall; disable only for debugging or fallback-only operation.",
	"agents.defaults.memorySearch.store.vector.extensionPath": "Overrides the auto-discovered sqlite-vec extension library path (`.dylib`, `.so`, or `.dll`). Use this when your runtime cannot find sqlite-vec automatically or you pin a known-good build.",
	"agents.defaults.memorySearch.chunking.tokens": "Chunk size in tokens used when splitting memory sources before embedding/indexing. Increase for broader context per chunk, or lower to improve precision on pinpoint lookups.",
	"agents.defaults.memorySearch.chunking.overlap": "Token overlap between adjacent memory chunks to preserve context continuity near split boundaries. Use modest overlap to reduce boundary misses without inflating index size too aggressively.",
	"agents.defaults.memorySearch.query.maxResults": "Maximum number of memory hits returned from search before downstream reranking and prompt injection. Raise for broader recall, or lower for tighter prompts and faster responses.",
	"agents.defaults.memorySearch.query.minScore": "Minimum relevance score threshold for including memory results in final recall output. Increase to reduce weak/noisy matches, or lower when you need more permissive retrieval.",
	"agents.defaults.memorySearch.query.hybrid.enabled": "Combines BM25 keyword matching with vector similarity for better recall on mixed exact + semantic queries. Keep enabled unless you are isolating ranking behavior for troubleshooting.",
	"agents.defaults.memorySearch.query.hybrid.vectorWeight": "Controls how strongly semantic similarity influences hybrid ranking (0-1). Increase when paraphrase matching matters more than exact terms; decrease for stricter keyword emphasis.",
	"agents.defaults.memorySearch.query.hybrid.textWeight": "Controls how strongly BM25 keyword relevance influences hybrid ranking (0-1). Increase for exact-term matching; decrease when semantic matches should rank higher.",
	"agents.defaults.memorySearch.query.hybrid.candidateMultiplier": "Expands the candidate pool before reranking (default: 4). Raise this for better recall on noisy corpora, but expect more compute and slightly slower searches.",
	"agents.defaults.memorySearch.query.hybrid.mmr.enabled": "Adds MMR reranking to diversify results and reduce near-duplicate snippets in a single answer window. Enable when recall looks repetitive; keep off for strict score ordering.",
	"agents.defaults.memorySearch.query.hybrid.mmr.lambda": "Sets MMR relevance-vs-diversity balance (0 = most diverse, 1 = most relevant, default: 0.7). Lower values reduce repetition; higher values keep tightly relevant but may duplicate.",
	"agents.defaults.memorySearch.query.hybrid.temporalDecay.enabled": "Applies recency decay so newer memory can outrank older memory when scores are close. Enable when timeliness matters; keep off for timeless reference knowledge.",
	"agents.defaults.memorySearch.query.hybrid.temporalDecay.halfLifeDays": "Controls how fast older memory loses rank when temporal decay is enabled (half-life in days, default: 30). Lower values prioritize recent context more aggressively.",
	"agents.defaults.memorySearch.cache.enabled": "Caches computed chunk embeddings in SQLite so reindexing and incremental updates run faster (default: true). Keep this enabled unless investigating cache correctness or minimizing disk usage.",
	memory: "Memory backend configuration (global).",
	"memory.backend": "Selects the global memory engine: \"builtin\" uses OpenClaw memory internals, while \"qmd\" uses the QMD sidecar pipeline. Keep \"builtin\" unless you intentionally operate QMD.",
	"memory.citations": "Controls citation visibility in replies: \"auto\" shows citations when useful, \"on\" always shows them, and \"off\" hides them. Keep \"auto\" for a balanced signal-to-noise default.",
	"memory.qmd.command": "Sets the executable path for the `qmd` binary used by the QMD backend (default: resolved from PATH). Use an explicit absolute path when multiple qmd installs exist or PATH differs across environments.",
	"memory.qmd.mcporter": "Routes QMD work through mcporter (MCP runtime) instead of spawning `qmd` for each call. Use this when cold starts are expensive on large models; keep direct process mode for simpler local setups.",
	"memory.qmd.mcporter.enabled": "Routes QMD through an mcporter daemon instead of spawning qmd per request, reducing cold-start overhead for larger models. Keep disabled unless mcporter is installed and configured.",
	"memory.qmd.mcporter.serverName": "Names the mcporter server target used for QMD calls (default: qmd). Change only when your mcporter setup uses a custom server name for qmd mcp keep-alive.",
	"memory.qmd.mcporter.startDaemon": "Automatically starts the mcporter daemon when mcporter-backed QMD mode is enabled (default: true). Keep enabled unless process lifecycle is managed externally by your service supervisor.",
	"memory.qmd.searchMode": "Selects the QMD retrieval path: \"query\" uses standard query flow, \"search\" uses search-oriented retrieval, and \"vsearch\" emphasizes vector retrieval. Keep default unless tuning relevance quality.",
	"memory.qmd.searchTool": "Overrides the exact mcporter tool name used for QMD searches while preserving `searchMode` as the semantic retrieval mode. Use this only when your QMD MCP server exposes a custom tool such as `hybrid_search` and keep it unset for the normal built-in tool mapping.",
	"memory.qmd.includeDefaultMemory": "Automatically indexes default memory files (MEMORY.md and memory/**/*.md) into QMD collections. Keep enabled unless you want indexing controlled only through explicit custom paths.",
	"memory.qmd.paths": "Adds custom directories or files to include in QMD indexing, each with an optional name and glob pattern. Use this for project-specific knowledge locations that are outside default memory paths.",
	"memory.qmd.paths.path": "Defines the root location QMD should scan, using an absolute path or `~`-relative path. Use stable directories so collection identity does not drift across environments.",
	"memory.qmd.paths.pattern": "Filters files under each indexed root using a glob pattern, with default `**/*.md`. Use narrower patterns to reduce noise and indexing cost when directories contain mixed file types.",
	"memory.qmd.paths.name": "Sets a stable collection name for an indexed path instead of deriving it from filesystem location. Use this when paths vary across machines but you want consistent collection identity.",
	"memory.qmd.sessions.enabled": "Indexes session transcripts into QMD so recall can include prior conversation content (experimental, default: false). Enable only when transcript memory is required and you accept larger index churn.",
	"memory.qmd.sessions.exportDir": "Overrides where sanitized session exports are written before QMD indexing. Use this when default state storage is constrained or when exports must land on a managed volume.",
	"memory.qmd.sessions.retentionDays": "Defines how long exported session files are kept before automatic pruning, in days (default: unlimited). Set a finite value for storage hygiene or compliance retention policies.",
	"memory.qmd.update.interval": "Sets how often QMD refreshes indexes from source content (duration string, default: 5m). Shorter intervals improve freshness but increase background CPU and I/O.",
	"memory.qmd.update.debounceMs": "Sets the minimum delay between consecutive QMD refresh attempts in milliseconds (default: 15000). Increase this if frequent file changes cause update thrash or unnecessary background load.",
	"memory.qmd.update.onBoot": "Runs an initial QMD update when the long-lived QMD manager opens (default: true). Set false to disable manager-start updates and legacy/opt-in startup refreshes.",
	"memory.qmd.update.startup": "Controls whether Gateway startup schedules a QMD refresh before memory is first used (`off`, `idle`, or `immediate`; default: off). Keep off for fastest startup and lazy memory initialization.",
	"memory.qmd.update.startupDelayMs": "Sets the idle delay before an opt-in `memory.qmd.update.startup: \"idle\"` refresh runs (default: 120000). Increase to keep cold-start CPU available for channels and providers.",
	"memory.qmd.update.waitForBootSync": "Blocks QMD manager opening until its initial manager-start update finishes (default: false). Startup refreshes remain opt-in through `memory.qmd.update.startup`.",
	"memory.qmd.update.embedInterval": "Sets how often QMD recomputes embeddings (duration string, default: 60m; set 0 to disable periodic embeds). Lower intervals improve freshness but increase embedding workload and cost.",
	"memory.qmd.update.commandTimeoutMs": "Sets timeout for QMD maintenance commands such as collection list/add in milliseconds (default: 30000). Increase when running on slower disks or remote filesystems that delay command completion.",
	"memory.qmd.update.updateTimeoutMs": "Sets maximum runtime for each `qmd update` cycle in milliseconds (default: 120000). Raise this for larger collections; lower it when you want quicker failure detection in automation.",
	"memory.qmd.update.embedTimeoutMs": "Sets maximum runtime for each `qmd embed` cycle in milliseconds (default: 120000). Increase for heavier embedding workloads or slower hardware, and lower to fail fast under tight SLAs.",
	"memory.qmd.limits.maxResults": "Limits how many QMD hits are returned into the agent loop for each recall request (default: 6). Increase for broader recall context, or lower to keep prompts tighter and faster.",
	"memory.qmd.limits.maxSnippetChars": "Caps per-result snippet length extracted from QMD hits in characters (default: 700). Lower this when prompts bloat quickly, and raise only if answers consistently miss key details.",
	"memory.qmd.limits.maxInjectedChars": "Caps how much QMD text can be injected into one turn across all hits. Use lower values to control prompt bloat and latency; raise only when context is consistently truncated.",
	"memory.qmd.limits.timeoutMs": "Sets per-query QMD search timeout in milliseconds (default: 4000). Increase for larger indexes or slower environments, and lower to keep request latency bounded.",
	"memory.qmd.scope": "Defines which sessions/channels are eligible for QMD recall using session.sendPolicy-style rules. Keep default direct-only scope unless you intentionally want cross-chat memory sharing.",
	"agents.defaults.memorySearch.cache.maxEntries": "Sets a best-effort upper bound on cached embeddings kept in SQLite for memory search. Use this when controlling disk growth matters more than peak reindex speed.",
	"agents.defaults.memorySearch.sync.onSessionStart": "Triggers a memory index sync when a session starts so early turns see fresh memory content. Keep enabled when startup freshness matters more than initial turn latency.",
	"agents.defaults.memorySearch.sync.onSearch": "Uses lazy sync by scheduling reindex on search after content changes are detected. Keep enabled for lower idle overhead, or disable if you require pre-synced indexes before any query.",
	"agents.defaults.memorySearch.sync.watch": "Watches memory files and schedules index updates from file-change events (chokidar). Enable for near-real-time freshness; disable on very large workspaces if watch churn is too noisy.",
	"agents.defaults.memorySearch.sync.watchDebounceMs": "Debounce window in milliseconds for coalescing rapid file-watch events before reindex runs. Increase to reduce churn on frequently-written files, or lower for faster freshness.",
	"agents.defaults.memorySearch.sync.embeddingBatchTimeoutSeconds": "Overrides the timeout for inline embedding batches during memory indexing. Leave unset to use provider defaults: 600 seconds for local/self-hosted providers such as local, Ollama, and LM Studio, and 120 seconds for hosted providers.",
	"agents.defaults.memorySearch.sync.sessions.deltaBytes": "Requires at least this many newly appended bytes before session transcript changes trigger reindex (default: 100000). Increase to reduce frequent small reindexes, or lower for faster transcript freshness.",
	"agents.defaults.memorySearch.sync.sessions.deltaMessages": "Requires at least this many appended transcript messages before reindex is triggered (default: 50). Lower this for near-real-time transcript recall, or raise it to reduce indexing churn.",
	"agents.defaults.memorySearch.sync.sessions.postCompactionForce": "Forces a session memory-search reindex after compaction-triggered transcript updates (default: true). Keep enabled when compacted summaries must be immediately searchable, or disable to reduce write-time indexing pressure.",
	ui: "UI presentation settings for accenting and assistant identity shown in control surfaces. Use this for branding and readability customization without changing runtime behavior.",
	"ui.seamColor": "Primary accent color used by UI surfaces for emphasis, badges, and visual identity cues. Use high-contrast values that remain readable across light/dark themes.",
	"ui.assistant": "Assistant display identity settings for name and avatar shown in UI surfaces. Keep these values aligned with your operator-facing persona and support expectations.",
	"ui.assistant.name": "Display name shown for the assistant in UI views, chat chrome, and status contexts. Keep this stable so operators can reliably identify which assistant persona is active.",
	"ui.assistant.avatar": "Assistant avatar image source used in UI surfaces (URL, path, or data URI depending on runtime support). Use trusted assets and consistent branding dimensions for clean rendering.",
	plugins: "Plugin system controls for enabling extensions, constraining load scope, configuring entries, and tracking installs. Keep plugin policy explicit and least-privilege in production environments.",
	"plugins.enabled": "Enable or disable plugin/extension loading globally during startup and config reload (default: true). Keep enabled only when extension capabilities are required by your deployment.",
	"plugins.allow": "Optional allowlist of plugin IDs; when set, only listed plugins are eligible to load. Configured bundled chat channels can still activate their bundled plugin when the channel is explicitly enabled in config. Use this to enforce approved extension inventories in controlled environments.",
	"plugins.deny": "Optional denylist of plugin IDs that are blocked even if allowlists or paths include them. Use deny rules for emergency rollback and hard blocks on risky plugins.",
	"plugins.load": "Plugin loader configuration group for specifying filesystem paths where plugins are discovered. Keep load paths explicit and reviewed to avoid accidental untrusted extension loading.",
	"plugins.load.paths": "Additional plugin files or directories scanned by the loader beyond built-in defaults. Use dedicated extension directories and avoid broad paths with unrelated executable content.",
	"plugins.slots": "Selects which plugins own exclusive runtime slots such as memory so only one plugin provides that capability. Use explicit slot ownership to avoid overlapping providers with conflicting behavior.",
	"plugins.slots.memory": "Select the active memory plugin by id, or \"none\" to disable memory plugins.",
	"plugins.slots.contextEngine": "Selects the active context engine plugin by id so one plugin provides context orchestration behavior.",
	"plugins.bundledDiscovery": "Controls bundled plugin runtime discovery when plugins.allow is configured. \"allowlist\" (default) gates bundled provider plugins by plugins.allow like third-party plugins. \"compat\" preserves legacy behavior where bundled provider plugins can be force-loaded on every chat turn.",
	"plugins.entries": "Per-plugin settings keyed by plugin ID including enablement and plugin-specific runtime configuration payloads. Use this for scoped plugin tuning without changing global loader policy.",
	"plugins.entries.*.enabled": "Per-plugin enablement override for a specific entry, applied on top of global plugin policy (restart required). Use this to stage plugin rollout gradually across environments.",
	"plugins.entries.*.hooks": "Per-plugin typed hook policy controls for core-enforced safety gates. Use this to constrain high-impact hook categories without disabling the entire plugin.",
	"plugins.entries.*.hooks.allowPromptInjection": "Controls whether this plugin may mutate prompts through typed hooks. Set false to block `before_prompt_build` and ignore prompt-mutating fields from legacy `before_agent_start`, while preserving legacy `modelOverride` and `providerOverride` behavior.",
	"plugins.entries.*.hooks.allowConversationAccess": "Controls whether this plugin may read raw conversation content from typed hooks such as `before_agent_run`, `before_model_resolve`, `before_agent_reply`, `llm_input`, `llm_output`, `before_agent_finalize`, and `agent_end`. Non-bundled plugins must opt in explicitly.",
	"plugins.entries.*.hooks.timeoutMs": "Default timeout in milliseconds for this plugin's typed hooks, capped at 600000. Use this to bound slow plugin hooks without changing plugin code; per-hook values in hooks.timeouts take precedence.",
	"plugins.entries.*.hooks.timeouts": "Per-hook timeout overrides in milliseconds keyed by typed hook name, capped at 600000. Use narrow overrides for known slow hooks such as before_prompt_build or agent_end instead of raising every hook timeout.",
	"plugins.entries.*.subagent": "Per-plugin subagent runtime controls for model override trust and allowlists. Keep this unset unless a plugin must explicitly steer subagent model selection.",
	"plugins.entries.*.subagent.allowModelOverride": "Explicitly allows this plugin to request provider/model overrides in background subagent runs. Keep false unless the plugin is trusted to steer model selection.",
	"plugins.entries.*.subagent.allowedModels": "Allowed override targets for trusted plugin subagent runs as canonical \"provider/model\" refs. Use \"*\" only when you intentionally allow any model.",
	"plugins.entries.*.llm": "Per-plugin api.runtime.llm.complete controls for model and agent override trust. Keep this unset unless a plugin must explicitly steer host-owned completion calls.",
	"plugins.entries.*.llm.allowModelOverride": "Explicitly allows this plugin to request model overrides in api.runtime.llm.complete. Keep false unless the plugin is trusted to steer model selection.",
	"plugins.entries.*.llm.allowedModels": "Allowed override targets for trusted plugin LLM completions as canonical \"provider/model\" refs. Use \"*\" only when you intentionally allow any model.",
	"plugins.entries.*.llm.allowAgentIdOverride": "Explicitly allows this plugin to request api.runtime.llm.complete against a non-default agent id. Keep false unless the plugin is trusted for cross-agent model access.",
	"plugins.entries.*.apiKey": "Optional API key field consumed by plugins that accept direct key configuration in entry settings. Use secret/env substitution and avoid committing real credentials into config files.",
	"plugins.entries.*.env": "Per-plugin environment variable map injected for that plugin runtime context only. Use this to scope provider credentials to one plugin instead of sharing global process environment.",
	"plugins.entries.*.config": "Plugin-defined configuration payload interpreted by that plugin's own schema and validation rules. Use only documented fields from the plugin to prevent ignored or invalid settings.",
	"agents.list.*.identity.avatar": "Agent avatar (workspace-relative path, http(s) URL, or data URI).",
	"agents.defaults.model.primary": "Primary model (provider/model).",
	"agents.defaults.model.fallbacks": "Ordered fallback models (provider/model). Used when the primary model fails.",
	"agents.defaults.agentRuntime": "Legacy whole-agent runtime policy. It is ignored by runtime selection; configure runtime policy on a provider or model instead. Run openclaw doctor --fix to remove stale values.",
	"agents.defaults.agentRuntime.id": "Legacy whole-agent runtime id. It is ignored by runtime selection; configure models.providers.<provider>.agentRuntime.id or a model-specific agentRuntime.id instead.",
	"agents.defaults.embeddedHarness": "Legacy whole-agent embedded harness input. Run openclaw doctor --fix to remove it and use provider/model runtime policy where needed.",
	"agents.defaults.embeddedHarness.runtime": "Legacy whole-agent embedded harness runtime. Runtime selection ignores it; use provider/model runtime policy.",
	"agents.list.*.models": "Per-agent model catalog overrides keyed by full provider/model IDs.",
	"agents.list.*.models.*.agentRuntime": "Optional per-model runtime policy for this agent. Use this for agent-specific model exceptions instead of setting a whole-agent runtime.",
	"agents.list.*.models.*.agentRuntime.id": "Per-agent model runtime id: \"pi\", \"auto\", a registered plugin harness id such as \"codex\", or a supported CLI backend alias such as \"claude-cli\".",
	"agents.list.*.agentRuntime": "Legacy per-agent runtime policy. It is ignored by runtime selection; configure provider/model runtime policy instead. Run openclaw doctor --fix to remove stale values.",
	"agents.list.*.agentRuntime.id": "Legacy per-agent runtime id. It is ignored by runtime selection; configure a provider/model runtime id instead.",
	"agents.list.*.embeddedHarness": "Legacy per-agent embedded harness input. Run openclaw doctor --fix to remove it and use provider/model runtime policy where needed.",
	"agents.list.*.embeddedHarness.runtime": "Legacy per-agent embedded harness runtime. Runtime selection ignores it; use provider/model runtime policy.",
	"agents.defaults.imageModel.primary": "Optional image model (provider/model) used when the primary model lacks image input.",
	"agents.defaults.imageModel.fallbacks": "Ordered fallback image models (provider/model).",
	"agents.defaults.imageGenerationModel.primary": "Optional image-generation model (provider/model) used by the shared image generation capability.",
	"agents.defaults.imageGenerationModel.fallbacks": "Ordered fallback image-generation models (provider/model).",
	"agents.defaults.imageGenerationModel.timeoutMs": "Default provider request timeout in milliseconds for image_generate calls. Per-call timeoutMs overrides this.",
	"agents.defaults.videoGenerationModel.primary": "Optional video-generation model (provider/model) used by the shared video generation capability.",
	"agents.defaults.videoGenerationModel.timeoutMs": "Default provider request timeout in milliseconds for video_generate calls. Per-call timeoutMs overrides this, and this value overrides provider-authored defaults.",
	"agents.defaults.videoGenerationModel.fallbacks": "Ordered fallback video-generation models (provider/model).",
	"agents.defaults.musicGenerationModel.primary": "Optional music-generation model (provider/model) used by the shared music generation capability.",
	"agents.defaults.musicGenerationModel.fallbacks": "Ordered fallback music-generation models (provider/model).",
	"agents.defaults.mediaGenerationAutoProviderFallback": "When true (default), shared image, music, and video generation automatically appends other auth-backed provider defaults after explicit primary/fallback refs. Set false to disable implicit cross-provider fallback while keeping explicit fallbacks.",
	"agents.defaults.pdfModel.primary": "Optional PDF model (provider/model) for the PDF analysis tool. Defaults to imageModel, then session model.",
	"agents.defaults.pdfModel.fallbacks": "Ordered fallback PDF models (provider/model).",
	"agents.defaults.pdfMaxBytesMb": "Maximum PDF file size in megabytes for the PDF tool (default: 10).",
	"agents.defaults.pdfMaxPages": "Maximum number of PDF pages to process for the PDF tool (default: 20).",
	"agents.defaults.imageMaxDimensionPx": "Max image side length in pixels when sanitizing transcript/tool-result image payloads (default: 1200).",
	"agents.defaults.cliBackends": "Optional CLI backends for text-only fallback (claude-cli, etc.).",
	"agents.defaults.compaction": "Compaction tuning for when context nears token limits, including history share, reserve headroom, and pre-compaction memory flush behavior. Use this when long-running sessions need stable continuity under tight context windows.",
	"agents.defaults.compaction.mode": "Compaction strategy mode: \"default\" uses baseline behavior, while \"safeguard\" applies stricter guardrails to preserve recent context. Keep \"default\" unless you observe aggressive history loss near limit boundaries.",
	"agents.defaults.compaction.provider": "Id of a registered compaction provider plugin used for summarization. When set and the provider is registered, its summarize() method is called instead of the built-in summarizeInStages pipeline. Falls back to built-in on provider failure. Leave unset to use the default built-in summarization.",
	"agents.defaults.compaction.reserveTokens": "Token headroom reserved for reply generation and tool output after compaction runs. Use higher reserves for verbose/tool-heavy sessions, and lower reserves when maximizing retained history matters more.",
	"agents.defaults.compaction.keepRecentTokens": "Minimum token budget preserved from the most recent conversation window during compaction. Use higher values to protect immediate context continuity and lower values to keep more long-tail history.",
	"agents.defaults.compaction.reserveTokensFloor": "Minimum floor enforced for reserveTokens in Pi compaction paths (0 disables the floor guard). Use a non-zero floor to avoid over-aggressive compression under fluctuating token estimates.",
	"agents.defaults.compaction.maxHistoryShare": "Maximum fraction of total context budget allowed for retained history after compaction (range 0.1-0.9). Use lower shares for more generation headroom or higher shares for deeper historical continuity.",
	"agents.defaults.compaction.identifierPolicy": "Identifier-preservation policy for compaction summaries: \"strict\" prepends built-in opaque-identifier retention guidance (default), \"off\" disables this prefix, and \"custom\" uses identifierInstructions. Keep \"strict\" unless you have a specific compatibility need.",
	"agents.defaults.compaction.identifierInstructions": "Custom identifier-preservation instruction text used when identifierPolicy=\"custom\". Keep this explicit and safety-focused so compaction summaries do not rewrite opaque IDs, URLs, hosts, or ports.",
	"agents.defaults.compaction.recentTurnsPreserve": "Number of most recent user/assistant turns kept verbatim outside safeguard summarization (default: 3). Raise this to preserve exact recent dialogue context, or lower it to maximize compaction savings.",
	"agents.defaults.compaction.qualityGuard": "Quality-audit retry settings for safeguard compaction summaries. Safeguard mode enables this by default; set enabled: false to skip summary audits and regeneration.",
	"agents.defaults.compaction.qualityGuard.enabled": "Enables summary quality audits and regeneration retries for safeguard compaction. Default: true in safeguard mode.",
	"agents.defaults.compaction.qualityGuard.maxRetries": "Maximum number of regeneration retries after a failed safeguard summary quality audit. Use small values to bound extra latency and token cost.",
	"agents.defaults.compaction.midTurnPrecheck": "Optional Pi tool-loop precheck that detects context pressure after a tool result is appended and before the next model call. When enabled, OpenClaw reuses existing precheck recovery to truncate tool results or compact before retrying.",
	"agents.defaults.compaction.midTurnPrecheck.enabled": "Enable structured mid-turn context pressure checks for Pi tool loops. Default: false. Keep disabled unless long tool-heavy sessions hit context overflow before normal turn-end compaction can run.",
	"agents.defaults.compaction.postIndexSync": "Controls post-compaction session memory reindex mode: \"off\", \"async\", or \"await\" (default: \"async\"). Use \"await\" for strongest freshness, \"async\" for lower compaction latency, and \"off\" only when session-memory sync is handled elsewhere.",
	"agents.defaults.compaction.postCompactionSections": "AGENTS.md H2/H3 section names re-injected after compaction so the agent reruns critical startup guidance. Leave unset to use \"Session Startup\"/\"Red Lines\" with legacy fallback to \"Every Session\"/\"Safety\"; set to [] to disable reinjection entirely.",
	"agents.defaults.compaction.timeoutSeconds": "Maximum time in seconds allowed for a single compaction operation before it is aborted (default: 900). Increase this for very large sessions that need more time to summarize, or decrease it to fail faster on unresponsive models.",
	"agents.defaults.compaction.model": "Optional provider/model override used only for compaction summarization. Set this when you want compaction to run on a different model than the session default, and leave it unset to keep using the primary agent model.",
	"agents.defaults.compaction.truncateAfterCompaction": "When enabled, rotates the active session JSONL file after compaction so future turns load only the summary and unsummarized tail while the previous full transcript remains archived. Prevents unbounded active transcript growth in long-running sessions. Default: false.",
	"agents.defaults.compaction.maxActiveTranscriptBytes": "Triggers normal local compaction when the active session transcript reaches this size (bytes or strings like \"20mb\"). Requires truncateAfterCompaction so successful compaction can rotate to a smaller successor transcript; set to 0 or leave unset to disable. This never splits raw transcript bytes.",
	"agents.defaults.compaction.notifyUser": "When enabled, sends brief compaction notices to the user when compaction starts and when it completes (for example, '🧹 Compacting context...' and '🧹 Compaction complete'). Disabled by default to keep compaction silent and non-intrusive.",
	"agents.defaults.compaction.memoryFlush": "Pre-compaction memory flush settings that run an agentic memory write before heavy compaction. Keep enabled for long sessions so salient context is persisted before aggressive trimming.",
	"agents.defaults.compaction.memoryFlush.enabled": "Enables pre-compaction memory flush before the runtime performs stronger history reduction near token limits. Keep enabled unless you intentionally disable memory side effects in constrained environments.",
	"agents.defaults.compaction.memoryFlush.model": "Optional provider/model override used only for pre-compaction memory flush turns. Set this to a local model such as ollama/qwen3:8b when durable memory extraction should avoid the active session's paid model. The override is exact and does not inherit the active model fallback chain.",
	"agents.defaults.compaction.memoryFlush.softThresholdTokens": "Threshold distance to compaction (in tokens) that triggers pre-compaction memory flush execution. Use earlier thresholds for safer persistence, or tighter thresholds for lower flush frequency.",
	"agents.defaults.compaction.memoryFlush.forceFlushTranscriptBytes": "Forces pre-compaction memory flush when transcript file size reaches this threshold (bytes or strings like \"2mb\"). Use this to prevent long-session hangs even when token counters are stale; set to 0 to disable.",
	"agents.defaults.compaction.memoryFlush.prompt": "User-prompt template used for the pre-compaction memory flush turn when generating memory candidates. Use this only when you need custom extraction instructions beyond the default memory flush behavior.",
	"agents.defaults.compaction.memoryFlush.systemPrompt": "System-prompt override for the pre-compaction memory flush turn to control extraction style and safety constraints. Use carefully so custom instructions do not reduce memory quality or leak sensitive context.",
	"agents.defaults.runRetries": "Outer run loop retry iteration boundaries for the embedded Pi runner to prevent infinite execution loops during failure recovery.",
	"agents.defaults.runRetries.base": "Base number of run retry iterations for the embedded Pi runner's outer run loop (default: 24).",
	"agents.defaults.runRetries.perProfile": "Additional run retry iterations granted per fallback profile candidate (default: 8).",
	"agents.defaults.runRetries.min": "Minimum absolute limit for run retry iterations (default: 32).",
	"agents.defaults.runRetries.max": "Maximum absolute limit for run retry iterations to prevent runaway execution (default: 160).",
	"agents.list[].runRetries": "Optional per-agent override for the embedded Pi runner's outer run loop retry iteration boundaries.",
	"agents.list[].runRetries.base": "Base number of run retry iterations for this agent.",
	"agents.list[].runRetries.perProfile": "Additional run retry iterations granted per fallback profile candidate for this agent.",
	"agents.list[].runRetries.min": "Minimum absolute limit for run retry iterations for this agent.",
	"agents.list[].runRetries.max": "Maximum absolute limit for run retry iterations for this agent.",
	"agents.defaults.embeddedPi": "Embedded Pi runner hardening controls for how workspace-local Pi settings are trusted and applied in OpenClaw sessions.",
	"agents.defaults.embeddedPi.projectSettingsPolicy": "How embedded Pi handles workspace-local `.pi/config/settings.json`: \"sanitize\" (default) strips shellPath/shellCommandPrefix, \"ignore\" disables project settings entirely, and \"trusted\" applies project settings as-is.",
	"agents.defaults.embeddedPi.executionContract": "Embedded Pi execution contract: \"default\" keeps the standard runner behavior, while \"strict-agentic\" keeps OpenAI/OpenAI Codex GPT-5-family runs acting until they hit a real blocker instead of stopping at plans or filler.",
	"agents.list[].embeddedPi": "Optional per-agent embedded Pi overrides. Use this to opt specific agents into stricter GPT-5 execution behavior without changing the global default.",
	"agents.list[].embeddedPi.executionContract": "Optional per-agent embedded Pi execution contract override. Set \"strict-agentic\" to keep that agent acting through plan-only turns on OpenAI/OpenAI Codex GPT-5-family runs, or \"default\" to inherit the standard runner behavior.",
	"agents.defaults.humanDelay.mode": "Delay style for block replies (\"off\", \"natural\", \"custom\").",
	"agents.defaults.humanDelay.minMs": "Minimum delay in ms for custom humanDelay (default: 800).",
	"agents.defaults.humanDelay.maxMs": "Maximum delay in ms for custom humanDelay (default: 2500).",
	commands: "Controls chat command surfaces, owner gating, and elevated command access behavior across providers. Keep defaults unless you need stricter operator controls or broader command availability.",
	"commands.native": "Registers native slash/menu commands with channels that support command registration (Discord, Slack, Telegram). Keep enabled for discoverability unless you intentionally run text-only command workflows.",
	"commands.nativeSkills": "Registers native skill commands so users can invoke skills directly from provider command menus where supported. Keep aligned with your skill policy so exposed commands match what operators expect.",
	"commands.text": "Enables text-command parsing in chat input in addition to native command surfaces where available. Keep this enabled for compatibility across channels that do not support native command registration.",
	"commands.bash": "Allow bash chat command (`!`; `/bash` alias) to run host shell commands (default: false; requires tools.elevated).",
	"commands.bashForegroundMs": "How long bash waits before backgrounding (default: 2000; 0 backgrounds immediately).",
	"commands.config": "Allow /config chat command to read/write config on disk (default: false).",
	"commands.mcp": "Allow /mcp chat command to manage OpenClaw MCP server config under mcp.servers (default: false).",
	"commands.plugins": "Allow /plugins chat command to list discovered plugins and toggle plugin enablement in config (default: false).",
	"commands.debug": "Allow /debug chat command for runtime-only overrides (default: false).",
	"commands.restart": "Allow /restart and gateway restart tool actions (default: true).",
	"commands.useAccessGroups": "Enforce access-group allowlists/policies for commands.",
	"commands.ownerAllowFrom": "Explicit owner allowlist for owner-scoped commands. Use channel-native IDs (optionally prefixed like \"whatsapp:+15551234567\"). '*' is ignored.",
	"commands.ownerDisplay": "Controls how owner IDs are rendered in the system prompt. Allowed values: raw, hash. Default: raw.",
	"commands.ownerDisplaySecret": "Optional secret used to HMAC hash owner IDs when ownerDisplay=hash. Prefer env substitution.",
	"commands.allowFrom": "Defines elevated command allow rules by channel and sender for owner-level command surfaces. Use narrow provider-specific identities so privileged commands are not exposed to broad chat audiences.",
	mcp: "Global MCP server definitions managed by OpenClaw. Embedded Pi and other runtime adapters can consume these servers without storing them inside Pi-owned project settings.",
	"mcp.servers": "Named MCP server definitions. OpenClaw stores them in its own config and runtime adapters decide which transports are supported at execution time.",
	"mcp.servers.*.codex": "OpenClaw projection metadata for Codex app-server threads only. It does not affect ACP sessions or generic Codex harness config. Omit this block to keep the server available to every Codex app-server agent with Codex's default MCP approval behavior.",
	"mcp.servers.*.codex.agents": "Optional non-empty OpenClaw agent ids that should receive this MCP server in Codex app-server thread config. Empty, blank, or invalid lists fail closed; when omitted, the server is projected for all Codex app-server agents.",
	"mcp.servers.*.codex.defaultToolsApprovalMode": "Optional Codex MCP tool approval mode for this server: \"auto\", \"prompt\", or \"approve\". Use only for MCP servers you intentionally trust.",
	"mcp.servers.*.codex.default_tools_approval_mode": "Codex-native spelling for the same per-server MCP tool approval mode. Prefer defaultToolsApprovalMode in OpenClaw config.",
	"mcp.sessionIdleTtlMs": "Idle TTL in milliseconds for session-scoped bundled MCP runtimes. Defaults to 10 minutes; set 0 to disable idle eviction.",
	session: "Global session routing, reset, delivery policy, and maintenance controls for conversation history behavior. Keep defaults unless you need stricter isolation, retention, or delivery constraints.",
	"session.scope": "Sets base session grouping strategy: \"per-sender\" isolates by sender and \"global\" shares one session per channel context. Keep \"per-sender\" for safer multi-user behavior unless deliberate shared context is required.",
	"session.dmScope": "DM session scoping: \"main\" keeps continuity, while \"per-peer\", \"per-channel-peer\", and \"per-account-channel-peer\" increase isolation. Use isolated modes for shared inboxes or multi-account deployments.",
	"session.identityLinks": "Maps canonical identities to provider-prefixed peer IDs so equivalent users resolve to one DM thread (example: telegram:123456). Use this when the same human appears across multiple channels or accounts.",
	"session.resetTriggers": "Lists message triggers that force a session reset when matched in inbound content. Use sparingly for explicit reset phrases so context is not dropped unexpectedly during normal conversation.",
	"session.idleMinutes": "Applies a legacy idle reset window in minutes for session reuse behavior across inactivity gaps. Use this only for compatibility and prefer structured reset policies under session.reset/session.resetByType.",
	"session.reset": "Defines the default reset policy object used when no type-specific or channel-specific override applies. Set this first, then layer resetByType or resetByChannel only where behavior must differ.",
	"session.reset.mode": "Selects reset strategy: \"daily\" resets at a configured hour and \"idle\" resets after inactivity windows. Keep one clear mode per policy to avoid surprising context turnover patterns.",
	"session.reset.atHour": "Sets local-hour boundary (0-23) for daily reset mode so sessions roll over at predictable times. Use with mode=daily and align to operator timezone expectations for human-readable behavior.",
	"session.reset.idleMinutes": "Sets inactivity window before reset for idle mode and can also act as secondary guard with daily mode. Use larger values to preserve continuity or smaller values for fresher short-lived threads.",
	"session.resetByType": "Overrides reset behavior by chat type (direct, group, thread) when defaults are not sufficient. Use this when group/thread traffic needs different reset cadence than direct messages.",
	"session.resetByType.direct": "Defines reset policy for direct chats and supersedes the base session.reset configuration for that type. Use this as the canonical direct-message override instead of the legacy dm alias.",
	"session.resetByType.dm": "Deprecated alias for direct reset behavior kept for backward compatibility with older configs. Use session.resetByType.direct instead so future tooling and validation remain consistent.",
	"session.resetByType.group": "Defines reset policy for group chat sessions where continuity and noise patterns differ from DMs. Use shorter idle windows for busy groups if context drift becomes a problem.",
	"session.resetByType.thread": "Defines reset policy for thread-scoped sessions, including focused channel thread workflows. Use this when thread sessions should expire faster or slower than other chat types.",
	"session.resetByChannel": "Provides channel-specific reset overrides keyed by provider/channel id for fine-grained behavior control. Use this only when one channel needs exceptional reset behavior beyond type-level policies.",
	"session.store": "Sets the session storage file path used to persist session records across restarts. Use an explicit path only when you need custom disk layout, backup routing, or mounted-volume storage.",
	"session.typingIntervalSeconds": "Controls interval for repeated typing indicators while replies are being prepared in typing-capable channels. Increase to reduce chatty updates or decrease for more active typing feedback.",
	"session.typingMode": "Controls typing behavior timing: \"never\", \"instant\", \"thinking\", or \"message\" based emission points. Keep conservative modes in high-volume channels to avoid unnecessary typing noise.",
	"session.mainKey": "Overrides the canonical main session key used for continuity when dmScope or routing logic points to \"main\". Use a stable value only if you intentionally need custom session anchoring.",
	"session.sendPolicy": "Controls cross-session send permissions using allow/deny rules evaluated against channel, chatType, and key prefixes. Use this to fence where session tools can deliver messages in complex environments.",
	"session.sendPolicy.default": "Sets fallback action when no sendPolicy rule matches: \"allow\" or \"deny\". Keep \"allow\" for simpler setups, or choose \"deny\" when you require explicit allow rules for every destination.",
	"session.sendPolicy.rules": "Ordered allow/deny rules evaluated before the default action, for example `{ action: \"deny\", match: { channel: \"discord\" } }`. Put most specific rules first so broad rules do not shadow exceptions.",
	"session.sendPolicy.rules[].action": "Defines rule decision as \"allow\" or \"deny\" when the corresponding match criteria are satisfied. Use deny-first ordering when enforcing strict boundaries with explicit allow exceptions.",
	"session.sendPolicy.rules[].match": "Defines optional rule match conditions that can combine channel, chatType, and key-prefix constraints. Keep matches narrow so policy intent stays readable and debugging remains straightforward.",
	"session.sendPolicy.rules[].match.channel": "Matches rule application to a specific channel/provider id (for example discord, telegram, slack). Use this when one channel should permit or deny delivery independently of others.",
	"session.sendPolicy.rules[].match.chatType": "Matches rule application to chat type (direct, group, thread) so behavior varies by conversation form. Use this when DM and group destinations require different safety boundaries.",
	"session.sendPolicy.rules[].match.keyPrefix": "Matches a normalized session-key prefix after internal key normalization steps in policy consumers. Use this for general prefix controls, and prefer rawKeyPrefix when exact full-key matching is required.",
	"session.sendPolicy.rules[].match.rawKeyPrefix": "Matches the raw, unnormalized session-key prefix for exact full-key policy targeting. Use this when normalized keyPrefix is too broad and you need agent-prefixed or transport-specific precision.",
	"session.writeLock": "Groups session transcript write-lock controls. Tune only when legitimate transcript prep, cleanup, compaction, or mirror work contends longer than the default policies.",
	"session.writeLock.acquireTimeoutMs": "Milliseconds to wait while acquiring a session transcript write lock before reporting the session as busy. Default: 60000; env override: OPENCLAW_SESSION_WRITE_LOCK_ACQUIRE_TIMEOUT_MS.",
	"session.writeLock.staleMs": "Milliseconds before an existing session transcript lock can be treated as stale and reclaimed. Default: 1800000; env override: OPENCLAW_SESSION_WRITE_LOCK_STALE_MS.",
	"session.writeLock.maxHoldMs": "Milliseconds a held in-process session transcript lock may remain held before the watchdog releases it. Default: 300000; env override: OPENCLAW_SESSION_WRITE_LOCK_MAX_HOLD_MS.",
	"session.agentToAgent": "Groups controls for inter-agent session exchanges, including loop prevention limits on reply chaining. Keep defaults unless you run advanced agent-to-agent automation with strict turn caps.",
	"session.agentToAgent.maxPingPongTurns": "Max reply-back turns between requester and target agents during agent-to-agent exchanges (0-20, default 5). Use lower values to hard-limit chatter loops and preserve predictable run completion.",
	"session.threadBindings": "Shared defaults for thread-bound session routing behavior across providers that support thread focus workflows. Configure global defaults here and override per channel only when behavior differs.",
	"session.threadBindings.enabled": "Global master switch for thread-bound session routing features and focused thread delivery behavior. Keep enabled for modern thread workflows unless you need to disable thread binding globally.",
	"session.threadBindings.idleHours": "Default inactivity window in hours for thread-bound sessions across providers/channels (0 disables idle auto-unfocus). Default: 24.",
	"session.threadBindings.maxAgeHours": "Optional hard max age in hours for thread-bound sessions across providers/channels (0 disables hard cap). Default: 0.",
	"session.threadBindings.spawnSessions": "Global default gate for creating thread-bound work sessions from sessions_spawn and ACP thread spawns. Default: true when thread bindings are enabled.",
	"session.threadBindings.defaultSpawnContext": "Default native subagent context for thread-bound spawns. Use \"fork\" to start from the requester transcript or \"isolated\" for a clean child. Default: \"fork\".",
	"session.maintenance": "Automatic session-store maintenance controls for pruning age, entry caps, reset archive retention, and disk budget cleanup. Start in warn mode to observe impact, then enforce once thresholds are tuned.",
	"session.maintenance.mode": "Determines whether maintenance policies are only reported (\"warn\") or actively applied (\"enforce\"). Keep \"warn\" during rollout and switch to \"enforce\" after validating safe thresholds.",
	"session.maintenance.pruneAfter": "Removes entries older than this duration (for example `30d` or `12h`) during maintenance passes. Use this as the primary age-retention control and align it with data retention policy.",
	"session.maintenance.pruneDays": "Deprecated age-retention field kept for compatibility with legacy configs using day counts. Use session.maintenance.pruneAfter instead so duration syntax and behavior are consistent.",
	"session.maintenance.maxEntries": "Caps total session entry count retained in the store to prevent unbounded growth over time. Use lower limits for constrained environments, or higher limits when longer history is required.",
	"session.maintenance.rotateBytes": "Deprecated and ignored. Do not use for `sessions.json` growth control; OpenClaw no longer creates automatic rotation backups, and \"openclaw doctor --fix\" removes this key.",
	"session.maintenance.resetArchiveRetention": "Retention for reset transcript archives (`*.reset.<timestamp>`). Accepts a duration (for example `30d`), or `false` to disable cleanup. Defaults to pruneAfter so reset artifacts do not grow forever.",
	"session.maintenance.maxDiskBytes": "Optional per-agent sessions-directory disk budget (for example `500mb`). Use this to cap session storage per agent; when exceeded, warn mode reports pressure and enforce mode performs oldest-first cleanup.",
	"session.maintenance.highWaterBytes": "Target size after disk-budget cleanup (high-water mark). Defaults to 80% of maxDiskBytes; set explicitly for tighter reclaim behavior on constrained disks.",
	cron: "Global scheduler settings for stored cron jobs, run concurrency, delivery fallback, and run-session retention. Keep defaults unless you are scaling job volume or integrating external webhook receivers.",
	"cron.enabled": "Enables cron job execution for stored schedules managed by the gateway. Keep enabled for normal reminder/automation flows, and disable only to pause all cron execution without deleting jobs.",
	"cron.store": "Path to the cron job store file used to persist scheduled jobs across restarts. Set an explicit path only when you need custom storage layout, backups, or mounted volumes.",
	"cron.maxConcurrentRuns": "Limits how many cron jobs can execute at the same time when multiple schedules fire together, including isolated agent-turn LLM execution on the dedicated cron-nested lane. Use lower values to protect CPU/memory under heavy automation load, or raise carefully for higher throughput.",
	"cron.retry": "Overrides the default retry policy for one-shot jobs when they fail with transient errors (rate limit, overloaded, network, server_error). Omit to use defaults: maxAttempts 3, backoffMs [30000, 60000, 300000], retry all transient types.",
	"cron.retry.maxAttempts": "Max retries for one-shot jobs on transient errors before permanent disable (default: 3).",
	"cron.retry.backoffMs": "Backoff delays in ms for each retry attempt (default: [30000, 60000, 300000]). Use shorter values for faster retries.",
	"cron.retry.retryOn": "Error types to retry: rate_limit, overloaded, network, timeout, server_error. Use to restrict which errors trigger retries; omit to retry all transient types.",
	"cron.webhook": "Deprecated legacy fallback webhook URL used only for old jobs with `notify=true`. Migrate to per-job delivery using `delivery.mode=\"webhook\"` plus `delivery.to`, and avoid relying on this global field.",
	"cron.webhookToken": "Bearer token attached to cron webhook POST deliveries when webhook mode is used. Prefer secret/env substitution and rotate this token regularly if shared webhook endpoints are internet-reachable.",
	"cron.sessionRetention": "Controls how long completed cron run sessions are kept before pruning (`24h`, `7d`, `1h30m`, or `false` to disable pruning; default: `24h`). Use shorter retention to reduce storage growth on high-frequency schedules.",
	"cron.runLog": "Pruning controls for per-job cron run history files under `cron/runs/<jobId>.jsonl`, including size and line retention.",
	"cron.runLog.maxBytes": "Maximum bytes per cron run-log file before pruning rewrites to the last keepLines entries (for example `2mb`, default `2000000`).",
	"cron.runLog.keepLines": "How many trailing run-log lines to retain when a file exceeds maxBytes (default `2000`). Increase for longer forensic history or lower for smaller disks.",
	hooks: "Inbound webhook automation surface for mapping external events into wake or agent actions in OpenClaw. Keep this locked down with explicit token/session/agent controls before exposing it beyond trusted networks.",
	"hooks.enabled": "Enables the hooks endpoint and mapping execution pipeline for inbound webhook requests. Keep disabled unless you are actively routing external events into the gateway.",
	"hooks.path": "HTTP path used by the hooks endpoint (for example `/hooks`) on the gateway control server. Use a non-guessable path and combine it with token validation for defense in depth.",
	"hooks.token": "Shared bearer token checked by hooks ingress for request authentication before mappings run. Treat holders as full-trust callers for the hook ingress surface, not as a separate non-owner role. Use environment substitution and rotate regularly when webhook endpoints are internet-accessible.",
	"hooks.defaultSessionKey": "Fallback session key used for hook deliveries when a request does not provide one through allowed channels. Use a stable but scoped key to avoid mixing unrelated automation conversations.",
	"hooks.allowRequestSessionKey": "Allows callers to supply a session key in hook requests when true, enabling caller-controlled routing. Keep false unless trusted integrators explicitly need custom session threading.",
	"hooks.allowedSessionKeyPrefixes": "Allowlist of accepted session-key prefixes for inbound hook requests when caller-provided keys are enabled. Use narrow prefixes to prevent arbitrary session-key injection.",
	"hooks.allowedAgentIds": "Allowlist of agent IDs that hook mappings are allowed to target when selecting execution agents. Use this to constrain automation events to dedicated service agents and reduce blast radius if a hook token is exposed.",
	"hooks.maxBodyBytes": "Maximum accepted webhook payload size in bytes before the request is rejected. Keep this bounded to reduce abuse risk and protect memory usage under bursty integrations.",
	"hooks.presets": "Named hook preset bundles applied at load time to seed standard mappings and behavior defaults. Keep preset usage explicit so operators can audit which automations are active.",
	"hooks.transformsDir": "Base directory for hook transform modules referenced by mapping transform.module paths. Use a controlled repo directory so dynamic imports remain reviewable and predictable.",
	"hooks.mappings": "Ordered mapping rules that match inbound hook requests and choose wake or agent actions with optional delivery routing. Use specific mappings first to avoid broad pattern rules capturing everything.",
	"hooks.mappings[].id": "Optional stable identifier for a hook mapping entry used for auditing, troubleshooting, and targeted updates. Use unique IDs so logs and config diffs can reference mappings unambiguously.",
	"hooks.mappings[].match": "Grouping object for mapping match predicates such as path and source before action routing is applied. Keep match criteria specific so unrelated webhook traffic does not trigger automations.",
	"hooks.mappings[].match.path": "Path match condition for a hook mapping, usually compared against the inbound request path. Use this to split automation behavior by webhook endpoint path families.",
	"hooks.mappings[].match.source": "Source match condition for a hook mapping, typically set by trusted upstream metadata or adapter logic. Use stable source identifiers so routing remains deterministic across retries.",
	"hooks.mappings[].action": "Mapping action type: \"wake\" triggers agent wake flow, while \"agent\" sends directly to agent handling. Use \"agent\" for immediate execution and \"wake\" when heartbeat-driven processing is preferred.",
	"hooks.mappings[].wakeMode": "Wake scheduling mode: \"now\" wakes immediately, while \"next-heartbeat\" defers until the next heartbeat cycle. Use deferred mode for lower-priority automations that can tolerate slight delay.",
	"hooks.mappings[].name": "Human-readable mapping display name used in diagnostics and operator-facing config UIs. Keep names concise and descriptive so routing intent is obvious during incident review.",
	"hooks.mappings[].agentId": "Target agent ID for mapping execution when action routing should not use defaults. Use dedicated automation agents to isolate webhook behavior from interactive operator sessions.",
	"hooks.mappings[].sessionKey": "Explicit session key override for mapping-delivered messages to control thread continuity. Use stable scoped keys so repeated events correlate without leaking into unrelated conversations.",
	"hooks.mappings[].messageTemplate": "Template for synthesizing structured mapping input into the final message content sent to the target action path. Keep templates deterministic so downstream parsing and behavior remain stable.",
	"hooks.mappings[].textTemplate": "Text-only fallback template used when rich payload rendering is not desired or not supported. Use this to provide a concise, consistent summary string for chat delivery surfaces.",
	"hooks.mappings[].deliver": "Controls whether mapping execution results are delivered back to a channel destination versus being processed silently. Disable delivery for background automations that should not post user-facing output.",
	"hooks.mappings[].allowUnsafeExternalContent": "When true, mapping content may include less-sanitized external payload data in generated messages. Keep false by default and enable only for trusted sources with reviewed transform logic.",
	"hooks.mappings[].channel": "Delivery channel override for mapping outputs (for example \"last\", \"telegram\", \"discord\", \"slack\", \"signal\", \"imessage\", or \"msteams\"). Keep channel overrides explicit to avoid accidental cross-channel sends.",
	"hooks.mappings[].to": "Destination identifier inside the selected channel when mapping replies should route to a fixed target. Verify provider-specific destination formats before enabling production mappings.",
	"hooks.mappings[].model": "Optional model override for mapping-triggered runs when automation should use a different model than agent defaults. Use this sparingly so behavior remains predictable across mapping executions.",
	"hooks.mappings[].thinking": "Optional thinking-effort override for mapping-triggered runs to tune latency versus reasoning depth. Keep low or minimal for high-volume hooks unless deeper reasoning is clearly required.",
	"hooks.mappings[].timeoutSeconds": "Maximum runtime allowed for mapping action execution before timeout handling applies. Use tighter limits for high-volume webhook sources to prevent queue pileups.",
	"hooks.mappings[].transform": "Transform configuration block defining module/export preprocessing before mapping action handling. Use transforms only from reviewed code paths and keep behavior deterministic for repeatable automation.",
	"hooks.mappings[].transform.module": "Relative transform module path loaded from hooks.transformsDir to rewrite incoming payloads before delivery. Keep modules local, reviewed, and free of path traversal patterns.",
	"hooks.mappings[].transform.export": "Named export to invoke from the transform module; defaults to module default export when omitted. Set this when one file hosts multiple transform handlers.",
	"hooks.gmail": "Gmail push integration settings used for Pub/Sub notifications and optional local callback serving. Keep this scoped to dedicated Gmail automation accounts where possible.",
	"hooks.gmail.account": "Google account identifier used for Gmail watch/subscription operations in this hook integration. Use a dedicated automation mailbox account to isolate operational permissions.",
	"hooks.gmail.label": "Optional Gmail label filter limiting which labeled messages trigger hook events. Keep filters narrow to avoid flooding automations with unrelated inbox traffic.",
	"hooks.gmail.topic": "Google Pub/Sub topic name used by Gmail watch to publish change notifications for this account. Ensure the topic IAM grants Gmail publish access before enabling watches.",
	"hooks.gmail.subscription": "Pub/Sub subscription consumed by the gateway to receive Gmail change notifications from the configured topic. Keep subscription ownership clear so multiple consumers do not race unexpectedly.",
	"hooks.gmail.hookUrl": "Public callback URL Gmail or intermediaries invoke to deliver notifications into this hook pipeline. Keep this URL protected with token validation and restricted network exposure.",
	"hooks.gmail.includeBody": "When true, fetch and include email body content for downstream mapping/agent processing. Keep false unless body text is required, because this increases payload size and sensitivity.",
	"hooks.gmail.allowUnsafeExternalContent": "Allows less-sanitized external Gmail content to pass into processing when enabled. Keep disabled for safer defaults, and enable only for trusted mail streams with controlled transforms.",
	"hooks.gmail.serve": "Local callback server settings block for directly receiving Gmail notifications without a separate ingress layer. Enable only when this process should terminate webhook traffic itself.",
	"hooks.gmail.pushToken": "Shared secret token required on Gmail push hook callbacks before processing notifications. Use env substitution and rotate if callback endpoints are exposed externally.",
	"hooks.gmail.maxBytes": "Maximum Gmail payload bytes processed per event when includeBody is enabled. Keep conservative limits to reduce oversized message processing cost and risk.",
	"hooks.gmail.renewEveryMinutes": "Renewal cadence in minutes for Gmail watch subscriptions to prevent expiration. Set below provider expiration windows and monitor renew failures in logs.",
	"hooks.gmail.serve.bind": "Bind address for the local Gmail callback HTTP server used when serving hooks directly. Keep loopback-only unless external ingress is intentionally required.",
	"hooks.gmail.serve.port": "Port for the local Gmail callback HTTP server when serve mode is enabled. Use a dedicated port to avoid collisions with gateway/control interfaces.",
	"hooks.gmail.serve.path": "HTTP path on the local Gmail callback server where push notifications are accepted. Keep this consistent with subscription configuration to avoid dropped events.",
	"hooks.gmail.tailscale.mode": "Tailscale exposure mode for Gmail callbacks: \"off\", \"serve\", or \"funnel\". Use \"serve\" for private tailnet delivery and \"funnel\" only when public internet ingress is required.",
	"hooks.gmail.tailscale": "Tailscale exposure configuration block for publishing Gmail callbacks through Serve/Funnel routes. Use private tailnet modes before enabling any public ingress path.",
	"hooks.gmail.tailscale.path": "Path published by Tailscale Serve/Funnel for Gmail callback forwarding when enabled. Keep it aligned with Gmail webhook config so requests reach the expected handler.",
	"hooks.gmail.tailscale.target": "Local service target forwarded by Tailscale Serve/Funnel (for example http://127.0.0.1:8787). Use explicit loopback targets to avoid ambiguous routing.",
	"hooks.gmail.model": "Optional model override for Gmail-triggered runs when mailbox automations should use dedicated model behavior. Keep unset to inherit agent defaults unless mailbox tasks need specialization.",
	"hooks.gmail.thinking": "Thinking effort override for Gmail-driven agent runs: \"off\", \"minimal\", \"low\", \"medium\", or \"high\". Keep modest defaults for routine inbox automations to control cost and latency.",
	"hooks.internal": "Internal hook runtime settings for bundled/custom event handlers loaded from module paths. Use this for trusted in-process automations and keep handler loading tightly scoped.",
	"hooks.internal.enabled": "Enables processing for internal hooks and configured entries in the internal hook runtime. Keep disabled unless internal hooks are intentionally configured.",
	"hooks.internal.entries": "Configured internal hook entry records used to register concrete runtime handlers and metadata. Keep entries explicit and versioned so production behavior is auditable.",
	"hooks.internal.load": "Internal hook loader settings controlling where handler modules are discovered at startup. Use constrained load roots to reduce accidental module conflicts or shadowing.",
	"hooks.internal.load.extraDirs": "Additional directories searched for internal hook modules beyond default load paths. Keep this minimal and controlled to reduce accidental module shadowing.",
	"hooks.internal.installs": "Install metadata for internal hook modules, including source and resolved artifacts for repeatable deployments. Use this as operational provenance and avoid manual drift edits.",
	messages: "Message formatting, acknowledgment, queueing, debounce, and status reaction behavior for inbound/outbound chat flows. Use this section when channel responsiveness or message UX needs adjustment.",
	"messages.messagePrefix": "Prefix text prepended to inbound user messages before they are handed to the agent runtime. Use this sparingly for channel context markers and keep it stable across sessions.",
	"messages.visibleReplies": "Controls visible source replies across direct, group, and channel conversations. \"message_tool\" requires message(action=send) for visible output and keeps normal final text private. \"automatic\" posts normal replies as before.",
	"messages.responsePrefix": "Prefix text prepended to outbound assistant replies before sending to channels. Use for lightweight branding/context tags and avoid long prefixes that reduce content density.",
	"messages.groupChat": "Group-message handling controls including mention triggers and history window sizing. Keep mention patterns narrow so group channels do not trigger on every message.",
	"messages.groupChat.mentionPatterns": "Safe case-insensitive regex patterns used to detect explicit mentions/trigger phrases in group chats. Use precise patterns to reduce false positives in high-volume channels; invalid or unsafe nested-repetition patterns are ignored.",
	"messages.groupChat.historyLimit": "Maximum number of prior group messages loaded as context per turn for group sessions. Use higher values for richer continuity, or lower values for faster and cheaper responses.",
	"messages.groupChat.unmentionedInbound": "Controls how unmentioned always-on group chatter is submitted. \"user_request\" treats it as a user request; \"room_event\" submits it as quiet context where visible output requires the message tool.",
	"messages.groupChat.visibleReplies": "Overrides visible source replies for group/channel conversations. Defaults to \"automatic\" when no global visible reply policy is set. \"message_tool\" requires message(action=send) for room output and keeps normal final text private. \"automatic\" posts normal replies as before.",
	"messages.queue": "Queue strategy for inbound messages that arrive while a session run is active. Use this to tune steering, deferred followups, batching, or interruption.",
	"messages.queue.mode": "Queue mode for active runs. Use \"steer\" to inject prompts into the active run, \"followup\" to run later, \"collect\" to batch compatible messages later, or \"interrupt\" to abort the active run before starting the newest prompt.",
	"messages.queue.byChannel": "Per-channel queue mode overrides keyed by provider id (for example telegram, discord, slack). Use this when one channel's traffic pattern needs different behavior than global defaults.",
	"messages.queue.debounceMs": "Global fallback followup queue debounce window in milliseconds before draining buffered inbound messages. Default is 500ms; higher values coalesce bursts, lower values reduce latency.",
	"messages.queue.debounceMsByChannel": "Per-channel debounce overrides for queue behavior keyed by provider id. Use this to tune burst handling independently for chat surfaces with different pacing.",
	"messages.queue.cap": "Maximum number of queued inbound items retained before drop policy applies. Default is 20; keep caps bounded in noisy channels so memory usage remains predictable.",
	"messages.queue.drop": "Drop strategy when queue cap is exceeded. \"summarize\" drops oldest entries but preserves compact summaries; \"old\" drops oldest without summaries; \"new\" rejects the newest item. Use \"summarize\" for long-running chats where context matters.",
	"messages.inbound": "Direct inbound debounce settings used before queue/turn processing starts. Configure this for provider-specific rapid message bursts from the same sender.",
	"messages.inbound.byChannel": "Per-channel inbound debounce overrides keyed by provider id in milliseconds. Use this where some providers send message fragments more aggressively than others.",
	"messages.removeAckAfterReply": "Removes the acknowledgment reaction after final reply delivery when enabled. Keep enabled for cleaner UX in channels where persistent ack reactions create clutter.",
	"messages.tts": "Text-to-speech policy for reading agent replies aloud on supported voice or audio surfaces. Keep disabled unless voice playback is part of your operator/user workflow.",
	"messages.tts.persona": "Default TTS persona id. Local TTS persona preferences can override this per host.",
	"messages.tts.personas": "Named TTS personas that define stable spoken identity plus provider-specific speech bindings.",
	"messages.tts.personas.*": "One TTS persona. Use provider-specific bindings for exact voices/models and prompt templates.",
	"messages.tts.personas.*.prompt": "Provider-neutral persona prompt intent. Providers decide whether and how to map this into request instructions.",
	"messages.tts.personas.*.providers": "Provider-specific TTS persona bindings keyed by speech provider id. These merge over messages.tts.providers for the active persona.",
	"messages.tts.providers": "Provider-specific TTS settings keyed by speech provider id. Use this instead of bundled provider-specific top-level keys so speech plugins stay decoupled from core config schema.",
	"messages.tts.providers.*": "Provider-specific TTS configuration for one speech provider id. Keep fields scoped to the plugin that owns that provider.",
	"messages.tts.providers.*.apiKey": "Provider API key used by that speech provider when its plugin requires authenticated TTS access.",
	channels: "Channel provider configurations plus shared defaults that control access policies, heartbeat visibility, and per-surface behavior. Keep defaults centralized and override per provider only where required.",
	"channels.mattermost": "Mattermost channel provider configuration for bot credentials, base URL, and message trigger modes. Keep mention/trigger rules strict in high-volume team channels.",
	"channels.defaults": "Default channel behavior applied across providers when provider-specific settings are not set. Use this to enforce consistent baseline policy before per-provider tuning.",
	"channels.defaults.groupPolicy": "Default group policy across channels: \"open\", \"disabled\", or \"allowlist\". Keep \"allowlist\" for safer production setups unless broad group participation is intentional.",
	"channels.defaults.contextVisibility": "Default supplemental context visibility for fetched quote/thread/history content: \"all\" (keep all context), \"allowlist\" (only allowlisted senders), or \"allowlist_quote\" (allowlist + keep explicit quotes).",
	"channels.defaults.heartbeat": "Default heartbeat visibility settings for status messages emitted by providers/channels. Tune this globally to reduce noisy healthy-state updates while keeping alerts visible.",
	"channels.defaults.heartbeat.showOk": "Shows healthy/OK heartbeat status entries when true in channel status outputs. Keep false in noisy environments and enable only when operators need explicit healthy confirmations.",
	"channels.defaults.heartbeat.showAlerts": "Shows degraded/error heartbeat alerts when true so operator channels surface problems promptly. Keep enabled in production so broken channel states are visible.",
	"channels.defaults.heartbeat.useIndicator": "Enables concise indicator-style heartbeat rendering instead of verbose status text where supported. Use indicator mode for dense dashboards with many active channels.",
	"channels.defaults.botLoopProtection": "Default pair loop protection settings for channel providers that support bot-to-bot loop guards. Use provider-specific overrides only when one channel needs a different budget.",
	"channels.defaults.botLoopProtection.enabled": "Enables pair loop protection by default for supporting channels when bot-authored messages can reach dispatch. Providers may still disable the guard when bots are ignored.",
	"channels.defaults.botLoopProtection.maxEventsPerWindow": "Maximum events a sender/receiver pair may exchange within the configured window before suppression starts. Default for supporting channels is 20.",
	"channels.defaults.botLoopProtection.windowSeconds": "Sliding window length in seconds for pair loop budgets. Default for supporting channels is 60.",
	"channels.defaults.botLoopProtection.cooldownSeconds": "Cooldown seconds applied to a pair after it exceeds the loop budget. Default for supporting channels is 60.",
	"agents.defaults.heartbeat.includeSystemPromptSection": "Includes the default agent's ## Heartbeats system prompt section when true. Turn this off to keep heartbeat runtime behavior while omitting the heartbeat prompt instructions from the agent system prompt.",
	"agents.list.*.heartbeat.includeSystemPromptSection": "Per-agent override for whether the default agent's ## Heartbeats system prompt section is injected. Use false to keep heartbeat runtime behavior but omit the heartbeat prompt instructions from that agent's system prompt.",
	"agents.defaults.heartbeat.directPolicy": "Controls whether heartbeat delivery may target direct/DM chats: \"allow\" (default) permits DM delivery and \"block\" suppresses direct-target sends.",
	"agents.list.*.heartbeat.directPolicy": "Per-agent override for heartbeat direct/DM delivery policy; use \"block\" for agents that should only send heartbeat alerts to non-DM destinations.",
	"agents.list.*.heartbeat.skipWhenBusy": "Per-agent override that defers heartbeat turns on that agent's extra busy lanes: its own session-keyed subagent or nested command work. Cron lanes always defer heartbeat turns.",
	"channels.mattermost.configWrites": "Allow Mattermost to write config in response to channel events/commands (default: true).",
	"channels.modelByChannel": "Map provider -> channel id -> model override (values are provider/model or aliases).",
	"messages.suppressToolErrors": "When true, suppress ⚠️ tool-error warnings from being shown to the user. The agent already sees errors in context and can retry. Default: false.",
	"messages.ackReaction": "Emoji reaction used to acknowledge inbound messages (empty disables).",
	"messages.ackReactionScope": "When to send ack reactions (\"group-mentions\", \"group-all\", \"direct\", \"all\", \"off\", \"none\"). \"off\"/\"none\" disables ack reactions entirely.",
	"messages.statusReactions": "Lifecycle status reactions that update the emoji on the trigger message as the agent progresses (queued → thinking → tool → done/error).",
	"messages.statusReactions.enabled": "Enable lifecycle status reactions on supported channels. Slack and Discord treat unset as enabled when ack reactions are active; Telegram and WhatsApp require this to be true before lifecycle reactions are used.",
	"messages.statusReactions.emojis": "Override default status reaction emojis. Keys: queued, thinking, compacting, tool, coding, web, deploy, build, concierge, done, error, stallSoft, stallHard. Telegram chooses the first supported fallback when a configured emoji is not available in the chat.",
	"messages.statusReactions.timing": "Override default timing. Keys: debounceMs (700), stallSoftMs (10000), stallHardMs (30000), doneHoldMs (1500), errorHoldMs (2500).",
	"messages.inbound.debounceMs": "Debounce window (ms) for batching rapid inbound messages from the same sender (0 to disable)."
};
//#endregion
//#region src/config/schema.labels.ts
const FIELD_LABELS = {
	meta: "Metadata",
	"meta.lastTouchedVersion": "Config Last Touched Version",
	"meta.lastTouchedAt": "Config Last Touched At",
	env: "Environment",
	"env.shellEnv": "Shell Environment Import",
	"env.shellEnv.enabled": "Shell Environment Import Enabled",
	"env.shellEnv.timeoutMs": "Shell Environment Import Timeout (ms)",
	"env.vars": "Environment Variable Overrides",
	wizard: "Setup Wizard State",
	"wizard.lastRunAt": "Wizard Last Run Timestamp",
	"wizard.lastRunVersion": "Wizard Last Run Version",
	"wizard.lastRunCommit": "Wizard Last Run Commit",
	"wizard.lastRunCommand": "Wizard Last Run Command",
	"wizard.lastRunMode": "Wizard Last Run Mode",
	diagnostics: "Diagnostics",
	"diagnostics.otel": "OpenTelemetry",
	"diagnostics.cacheTrace": "Cache Trace",
	logging: "Logging",
	"logging.level": "Log Level",
	"logging.file": "Log File Path",
	"logging.consoleLevel": "Console Log Level",
	"logging.consoleStyle": "Console Log Style",
	"logging.redactSensitive": "Sensitive Data Redaction Mode",
	"logging.redactPatterns": "Custom Redaction Patterns",
	cli: "CLI",
	"cli.banner": "CLI Banner",
	"cli.banner.taglineMode": "CLI Banner Tagline Mode",
	update: "Updates",
	"update.channel": "Update Channel",
	"update.checkOnStart": "Update Check on Start",
	"update.auto.enabled": "Auto Update Enabled",
	"update.auto.stableDelayHours": "Auto Update Stable Delay (hours)",
	"update.auto.stableJitterHours": "Auto Update Stable Jitter (hours)",
	"update.auto.betaCheckIntervalHours": "Auto Update Beta Check Interval (hours)",
	commitments: "Commitments",
	"commitments.enabled": "Commitments Enabled",
	"commitments.maxPerDay": "Commitments per Day",
	"diagnostics.enabled": "Diagnostics Enabled",
	"diagnostics.flags": "Diagnostics Flags",
	"diagnostics.stuckSessionWarnMs": "Session Liveness Threshold (ms)",
	"diagnostics.stuckSessionAbortMs": "Session Abort Threshold (ms)",
	"diagnostics.memoryPressureSnapshot": "Memory Pressure Snapshot Enabled",
	"diagnostics.otel.enabled": "OpenTelemetry Enabled",
	"diagnostics.otel.endpoint": "OpenTelemetry Endpoint",
	"diagnostics.otel.tracesEndpoint": "OpenTelemetry Traces Endpoint",
	"diagnostics.otel.metricsEndpoint": "OpenTelemetry Metrics Endpoint",
	"diagnostics.otel.logsEndpoint": "OpenTelemetry Logs Endpoint",
	"diagnostics.otel.protocol": "OpenTelemetry Protocol",
	"diagnostics.otel.headers": "OpenTelemetry Headers",
	"diagnostics.otel.serviceName": "OpenTelemetry Service Name",
	"diagnostics.otel.traces": "OpenTelemetry Traces Enabled",
	"diagnostics.otel.metrics": "OpenTelemetry Metrics Enabled",
	"diagnostics.otel.logs": "OpenTelemetry Logs Enabled",
	"diagnostics.otel.sampleRate": "OpenTelemetry Trace Sample Rate",
	"diagnostics.otel.flushIntervalMs": "OpenTelemetry Flush Interval (ms)",
	"diagnostics.otel.captureContent": "OpenTelemetry Content Capture",
	"diagnostics.otel.captureContent.enabled": "OpenTelemetry Content Capture Enabled",
	"diagnostics.otel.captureContent.inputMessages": "OpenTelemetry Input Messages Capture",
	"diagnostics.otel.captureContent.outputMessages": "OpenTelemetry Output Messages Capture",
	"diagnostics.otel.captureContent.toolInputs": "OpenTelemetry Tool Inputs Capture",
	"diagnostics.otel.captureContent.toolOutputs": "OpenTelemetry Tool Outputs Capture",
	"diagnostics.otel.captureContent.systemPrompt": "OpenTelemetry System Prompt Capture",
	"diagnostics.cacheTrace.enabled": "Cache Trace Enabled",
	"diagnostics.cacheTrace.filePath": "Cache Trace File Path",
	"diagnostics.cacheTrace.includeMessages": "Cache Trace Include Messages",
	"diagnostics.cacheTrace.includePrompt": "Cache Trace Include Prompt",
	"diagnostics.cacheTrace.includeSystem": "Cache Trace Include System",
	"agents.list.*.identity.avatar": "Identity Avatar",
	"agents.list.*.skills": "Agent Skill Filter",
	"agents.list[].runtime": "Agent Runtime",
	"agents.list[].runtime.type": "Agent Runtime Type",
	"agents.list[].runtime.acp": "Agent ACP Runtime",
	"agents.list[].runtime.acp.agent": "Agent ACP Harness Agent",
	"agents.list[].runtime.acp.backend": "Agent ACP Backend",
	"agents.list[].runtime.acp.mode": "Agent ACP Mode",
	"agents.list[].runtime.acp.cwd": "Agent ACP Working Directory",
	"agents.list[].thinkingDefault": "Agent Thinking Default",
	"agents.list[].reasoningDefault": "Agent Reasoning Default",
	"agents.list[].fastModeDefault": "Agent Fast Mode Default",
	"agents.list[].contextInjection": "Agent Context Injection",
	"agents.list[].bootstrapMaxChars": "Agent Bootstrap Max Chars",
	"agents.list[].bootstrapTotalMaxChars": "Agent Bootstrap Total Max Chars",
	"agents.list[].experimental": "Agent Experimental Flags",
	"agents.list[].experimental.localModelLean": "Agent Lean Local Model Mode",
	agents: "Agents",
	"agents.defaults": "Agent Defaults",
	"agents.defaults.contextLimits": "Default Context Limits",
	"agents.defaults.contextLimits.memoryGetMaxChars": "Default memory_get Max Chars",
	"agents.defaults.contextLimits.memoryGetDefaultLines": "Default memory_get Line Window",
	"agents.defaults.contextLimits.toolResultMaxChars": "Default Tool Result Max Chars",
	"agents.defaults.contextLimits.postCompactionMaxChars": "Default Post-compaction Max Chars",
	"agents.defaults.agentRuntime": "Legacy Default Agent Runtime",
	"agents.defaults.agentRuntime.id": "Legacy Default Agent Runtime ID",
	"agents.defaults.embeddedHarness": "Default Legacy Embedded Harness Settings",
	"agents.defaults.embeddedHarness.runtime": "Default Legacy Embedded Harness Runtime",
	"agents.list": "Agent List",
	"agents.list[].skillsLimits": "Agent Skills Limits",
	"agents.list[].skillsLimits.maxSkillsPromptChars": "Agent Skills Prompt Max Chars",
	"agents.list[].contextLimits": "Agent Context Limits",
	"agents.list[].contextLimits.memoryGetMaxChars": "Agent memory_get Max Chars",
	"agents.list[].contextLimits.memoryGetDefaultLines": "Agent memory_get Line Window",
	"agents.list[].contextLimits.toolResultMaxChars": "Agent Tool Result Max Chars",
	"agents.list[].contextLimits.postCompactionMaxChars": "Agent Post-compaction Max Chars",
	"agents.list.*.models": "Agent Model Overrides",
	"agents.list.*.models.*.agentRuntime": "Agent Model Runtime",
	"agents.list.*.models.*.agentRuntime.id": "Agent Model Runtime ID",
	"agents.list.*.agentRuntime": "Legacy Agent Runtime",
	"agents.list.*.agentRuntime.id": "Legacy Agent Runtime ID",
	"agents.list.*.embeddedHarness": "Agent Legacy Embedded Harness",
	"agents.list.*.embeddedHarness.runtime": "Agent Legacy Embedded Harness Runtime",
	gateway: "Gateway",
	"gateway.port": "Gateway Port",
	"gateway.mode": "Gateway Mode",
	"gateway.bind": "Gateway Bind Mode",
	"gateway.customBindHost": "Gateway Custom Bind Host",
	"gateway.controlUi": "Control UI",
	"gateway.controlUi.enabled": "Control UI Enabled",
	"gateway.auth": "Gateway Auth",
	"gateway.auth.mode": "Gateway Auth Mode",
	"gateway.auth.allowTailscale": "Gateway Auth Allow Tailscale Identity",
	"gateway.auth.rateLimit": "Gateway Auth Rate Limit",
	"gateway.auth.trustedProxy": "Gateway Trusted Proxy Auth",
	"gateway.trustedProxies": "Gateway Trusted Proxy CIDRs",
	"gateway.allowRealIpFallback": "Gateway Allow x-real-ip Fallback",
	"gateway.tools": "Gateway Tool Exposure Policy",
	"gateway.tools.allow": "Gateway Tool Allowlist",
	"gateway.tools.deny": "Gateway Tool Denylist",
	"gateway.handshakeTimeoutMs": "Gateway Handshake Timeout",
	"gateway.channelHealthCheckMinutes": "Gateway Channel Health Check Interval (min)",
	"gateway.channelStaleEventThresholdMinutes": "Gateway Channel Stale Event Threshold (min)",
	"gateway.channelMaxRestartsPerHour": "Gateway Channel Max Restarts Per Hour",
	"gateway.tailscale": "Gateway Tailscale",
	"gateway.tailscale.mode": "Gateway Tailscale Mode",
	"gateway.tailscale.resetOnExit": "Gateway Tailscale Reset on Exit",
	"gateway.tailscale.preserveFunnel": "Gateway Tailscale Preserve External Funnel",
	"gateway.remote": "Remote Gateway",
	"gateway.remote.transport": "Remote Gateway Transport",
	"gateway.reload": "Config Reload",
	"gateway.tls": "Gateway TLS",
	"gateway.tls.enabled": "Gateway TLS Enabled",
	"gateway.tls.autoGenerate": "Gateway TLS Auto-Generate Cert",
	"gateway.tls.certPath": "Gateway TLS Certificate Path",
	"gateway.tls.keyPath": "Gateway TLS Key Path",
	"gateway.tls.caPath": "Gateway TLS CA Path",
	"gateway.http": "Gateway HTTP API",
	"gateway.http.endpoints": "Gateway HTTP Endpoints",
	"gateway.http.securityHeaders": "Gateway HTTP Security Headers",
	"gateway.http.securityHeaders.strictTransportSecurity": "Strict Transport Security Header",
	"gateway.remote.url": "Remote Gateway URL",
	"gateway.remote.sshTarget": "Remote Gateway SSH Target",
	"gateway.remote.sshIdentity": "Remote Gateway SSH Identity",
	"gateway.remote.token": "Remote Gateway Token",
	"gateway.remote.password": "Remote Gateway Password",
	"gateway.remote.tlsFingerprint": "Remote Gateway TLS Fingerprint",
	"gateway.auth.token": "Gateway Token",
	"gateway.auth.password": "Gateway Password",
	browser: "Browser",
	"browser.enabled": "Browser Enabled",
	"browser.cdpUrl": "Browser CDP URL",
	"browser.actionTimeoutMs": "Browser Action Timeout (ms)",
	"browser.localLaunchTimeoutMs": "Browser Local Launch Timeout (ms)",
	"browser.localCdpReadyTimeoutMs": "Browser Local CDP Ready Timeout (ms)",
	"browser.color": "Browser Accent Color",
	"browser.executablePath": "Browser Executable Path",
	"browser.headless": "Browser Headless Mode",
	"browser.noSandbox": "Browser No-Sandbox Mode",
	"browser.attachOnly": "Browser Attach-only Mode",
	"browser.cdpPortRangeStart": "Browser CDP Port Range Start",
	"browser.defaultProfile": "Browser Default Profile",
	"browser.profiles": "Browser Profiles",
	"browser.profiles.*.cdpPort": "Browser Profile CDP Port",
	"browser.profiles.*.cdpUrl": "Browser Profile CDP URL",
	"browser.profiles.*.userDataDir": "Browser Profile User Data Dir",
	"browser.profiles.*.mcpCommand": "Browser Profile Chrome MCP Command",
	"browser.profiles.*.mcpArgs": "Browser Profile Chrome MCP Args",
	"browser.profiles.*.driver": "Browser Profile Driver",
	"browser.profiles.*.executablePath": "Browser Profile Executable Path",
	"browser.profiles.*.headless": "Browser Profile Headless Mode",
	"browser.profiles.*.attachOnly": "Browser Profile Attach-only Mode",
	"browser.profiles.*.color": "Browser Profile Accent Color",
	tools: "Tools",
	"tools.allow": "Tool Allowlist",
	"tools.deny": "Tool Denylist",
	"tools.web": "Web Tools",
	"tools.exec": "Exec Tool",
	"tools.media.image.enabled": "Enable Image Understanding",
	"tools.media.image.maxBytes": "Image Understanding Max Bytes",
	"tools.media.image.maxChars": "Image Understanding Max Chars",
	"tools.media.image.prompt": "Image Understanding Prompt",
	"tools.media.image.timeoutSeconds": "Image Understanding Timeout (sec)",
	"tools.media.image.attachments": "Image Understanding Attachment Policy",
	"tools.media.image.models": "Image Understanding Models",
	"tools.media.image.scope": "Image Understanding Scope",
	"tools.media.models": "Media Understanding Shared Models",
	"tools.media.concurrency": "Media Understanding Concurrency",
	"tools.media.asyncCompletion.directSend": "Async Media Completion Direct Send",
	...MEDIA_AUDIO_FIELD_LABELS,
	"tools.media.video.enabled": "Enable Video Understanding",
	"tools.media.video.maxBytes": "Video Understanding Max Bytes",
	"tools.media.video.maxChars": "Video Understanding Max Chars",
	"tools.media.video.prompt": "Video Understanding Prompt",
	"tools.media.video.timeoutSeconds": "Video Understanding Timeout (sec)",
	"tools.media.video.attachments": "Video Understanding Attachment Policy",
	"tools.media.video.models": "Video Understanding Models",
	"tools.media.video.scope": "Video Understanding Scope",
	"tools.links.enabled": "Enable Link Understanding",
	"tools.links.maxLinks": "Link Understanding Max Links",
	"tools.links.timeoutSeconds": "Link Understanding Timeout (sec)",
	"tools.links.models": "Link Understanding Models",
	"tools.links.scope": "Link Understanding Scope",
	"tools.profile": "Tool Profile",
	"tools.alsoAllow": "Tool Allowlist Additions",
	"agents.list[].tools.profile": "Agent Tool Profile",
	"agents.list[].tools.alsoAllow": "Agent Tool Allowlist Additions",
	"agents.list[].tools.codeMode": "Agent Code Mode",
	"tools.byProvider": "Tool Policy by Provider",
	"agents.list[].tools.byProvider": "Agent Tool Policy by Provider",
	"agents.list[].tools.message.crossContext.allowWithinProvider": "Agent Cross-Context Messaging (Same Provider)",
	"agents.list[].tools.message.crossContext.allowAcrossProviders": "Agent Cross-Context Messaging (Across Providers)",
	"agents.list[].tools.message.actions.allow": "Agent Message Action Allowlist",
	"tools.exec.applyPatch.enabled": "Enable apply_patch",
	"tools.exec.applyPatch.workspaceOnly": "apply_patch Workspace-Only",
	"tools.exec.applyPatch.allowModels": "apply_patch Model Allowlist",
	"tools.loopDetection.enabled": "Tool-loop Detection",
	"tools.loopDetection.historySize": "Tool-loop History Size",
	"tools.loopDetection.warningThreshold": "Tool-loop Warning Threshold",
	"tools.loopDetection.unknownToolThreshold": "Unknown-tool Loop Threshold",
	"tools.loopDetection.criticalThreshold": "Tool-loop Critical Threshold",
	"tools.loopDetection.globalCircuitBreakerThreshold": "Tool-loop Global Circuit Breaker Threshold",
	"tools.loopDetection.postCompactionGuard.windowSize": "Post-compaction Loop Guard Window Size",
	"tools.loopDetection.detectors.genericRepeat": "Tool-loop Generic Repeat Detection",
	"tools.loopDetection.detectors.knownPollNoProgress": "Tool-loop Poll No-Progress Detection",
	"tools.loopDetection.detectors.pingPong": "Tool-loop Ping-Pong Detection",
	"tools.fs.workspaceOnly": "Workspace-only FS tools",
	"tools.sessions.visibility": "Session Tools Visibility",
	"tools.exec.notifyOnExit": "Exec Notify On Exit",
	"tools.exec.notifyOnExitEmptySuccess": "Exec Notify On Empty Success",
	"tools.exec.approvalRunningNoticeMs": "Exec Approval Running Notice (ms)",
	"tools.exec.host": "Exec Target",
	"tools.exec.security": "Exec Security",
	"tools.exec.ask": "Exec Ask",
	"tools.exec.node": "Exec Node Binding",
	"tools.agentToAgent": "Agent-to-Agent Tool Access",
	"tools.agentToAgent.enabled": "Enable Agent-to-Agent Tool",
	"tools.agentToAgent.allow": "Agent-to-Agent Target Allowlist",
	"tools.experimental": "Experimental Tools",
	"tools.experimental.planTool": "Enable Structured Plan Tool",
	"tools.toolSearch": "Tool Search",
	"tools.toolSearch.enabled": "Enable Tool Search",
	"tools.toolSearch.mode": "Tool Search Surface",
	"tools.toolSearch.codeTimeoutMs": "Tool Search Code Timeout",
	"tools.toolSearch.searchDefaultLimit": "Tool Search Default Results",
	"tools.toolSearch.maxSearchLimit": "Tool Search Max Results",
	"tools.codeMode": "Code Mode",
	"tools.codeMode.enabled": "Enable Code Mode",
	"tools.codeMode.runtime": "Code Mode Runtime",
	"tools.codeMode.mode": "Code Mode Surface",
	"tools.codeMode.languages": "Code Mode Languages",
	"tools.codeMode.timeoutMs": "Code Mode Timeout",
	"tools.codeMode.memoryLimitBytes": "Code Mode Memory Limit",
	"tools.codeMode.maxOutputBytes": "Code Mode Output Limit",
	"tools.codeMode.maxSnapshotBytes": "Code Mode Snapshot Limit",
	"tools.codeMode.maxPendingToolCalls": "Code Mode Pending Tool Limit",
	"tools.codeMode.snapshotTtlSeconds": "Code Mode Snapshot TTL",
	"tools.codeMode.searchDefaultLimit": "Code Mode Default Search Results",
	"tools.codeMode.maxSearchLimit": "Code Mode Max Search Results",
	"tools.elevated": "Elevated Tool Access",
	"tools.elevated.enabled": "Enable Elevated Tool Access",
	"tools.elevated.allowFrom": "Elevated Tool Allow Rules",
	"tools.subagents": "Subagent Tool Policy",
	"tools.subagents.tools": "Subagent Tool Allow/Deny Policy",
	"tools.sandbox": "Sandbox Tool Policy",
	"tools.sandbox.tools": "Sandbox Tool Allow/Deny Policy",
	"tools.exec.pathPrepend": "Exec PATH Prepend",
	"tools.exec.safeBins": "Exec Safe Bins",
	"tools.exec.strictInlineEval": "Require Inline-Eval Approval",
	"tools.exec.commandHighlighting": "Exec Command Highlighting",
	"tools.exec.safeBinTrustedDirs": "Exec Safe Bin Trusted Dirs",
	"tools.exec.safeBinProfiles": "Exec Safe Bin Profiles",
	approvals: "Approvals",
	"approvals.exec": "Exec Approval Forwarding",
	"approvals.exec.enabled": "Forward Exec Approvals",
	"approvals.exec.mode": "Approval Forwarding Mode",
	"approvals.exec.agentFilter": "Approval Agent Filter",
	"approvals.exec.sessionFilter": "Approval Session Filter",
	"approvals.exec.targets": "Approval Forwarding Targets",
	"approvals.exec.targets[].channel": "Approval Target Channel",
	"approvals.exec.targets[].to": "Approval Target Destination",
	"approvals.exec.targets[].accountId": "Approval Target Account ID",
	"approvals.exec.targets[].threadId": "Approval Target Thread ID",
	"approvals.plugin": "Plugin Approval Forwarding",
	"approvals.plugin.enabled": "Forward Plugin Approvals",
	"approvals.plugin.mode": "Plugin Approval Forwarding Mode",
	"approvals.plugin.agentFilter": "Plugin Approval Agent Filter",
	"approvals.plugin.sessionFilter": "Plugin Approval Session Filter",
	"approvals.plugin.targets": "Plugin Approval Forwarding Targets",
	"approvals.plugin.targets[].channel": "Plugin Approval Target Channel",
	"approvals.plugin.targets[].to": "Plugin Approval Target Destination",
	"approvals.plugin.targets[].accountId": "Plugin Approval Target Account ID",
	"approvals.plugin.targets[].threadId": "Plugin Approval Target Thread ID",
	"tools.message.allowCrossContextSend": "Allow Cross-Context Messaging",
	"tools.message.crossContext.allowWithinProvider": "Allow Cross-Context (Same Provider)",
	"tools.message.crossContext.allowAcrossProviders": "Allow Cross-Context (Across Providers)",
	"tools.message.crossContext.marker.enabled": "Cross-Context Marker",
	"tools.message.crossContext.marker.prefix": "Cross-Context Marker Prefix",
	"tools.message.crossContext.marker.suffix": "Cross-Context Marker Suffix",
	"tools.message.broadcast.enabled": "Enable Message Broadcast",
	"tools.message.actions.allow": "Message Action Allowlist",
	"tools.web.search.enabled": "Enable Web Search Tool",
	"tools.web.search.provider": "Web Search Provider",
	"tools.web.search.maxResults": "Web Search Max Results",
	"tools.web.search.timeoutSeconds": "Web Search Timeout (sec)",
	"tools.web.search.cacheTtlMinutes": "Web Search Cache TTL (min)",
	"tools.web.search.openaiCodex.enabled": "Enable Native Codex Web Search",
	"tools.web.search.openaiCodex.mode": "Codex Web Search Mode",
	"tools.web.search.openaiCodex.allowedDomains": "Codex Allowed Domains",
	"tools.web.search.openaiCodex.contextSize": "Codex Search Context Size",
	"tools.web.search.openaiCodex.userLocation.country": "Codex User Country",
	"tools.web.search.openaiCodex.userLocation.region": "Codex User Region",
	"tools.web.search.openaiCodex.userLocation.city": "Codex User City",
	"tools.web.search.openaiCodex.userLocation.timezone": "Codex User Timezone",
	"tools.web.search.brave.mode": "Brave Search Mode",
	"tools.web.fetch.enabled": "Enable Web Fetch Tool",
	"tools.web.fetch.maxChars": "Web Fetch Max Chars",
	"tools.web.fetch.maxCharsCap": "Web Fetch Hard Max Chars",
	"tools.web.fetch.maxResponseBytes": "Web Fetch Max Download Size (bytes)",
	"tools.web.fetch.provider": "Web Fetch Provider",
	"tools.web.fetch.timeoutSeconds": "Web Fetch Timeout (sec)",
	"tools.web.fetch.cacheTtlMinutes": "Web Fetch Cache TTL (min)",
	"tools.web.fetch.maxRedirects": "Web Fetch Max Redirects",
	"tools.web.fetch.userAgent": "Web Fetch User-Agent",
	"tools.web.fetch.readability": "Web Fetch Readability Extraction",
	"tools.web.fetch.useTrustedEnvProxy": "Web Fetch Trusted Env Proxy",
	"tools.web.fetch.ssrfPolicy": "Web Fetch SSRF Policy",
	"tools.web.fetch.ssrfPolicy.allowRfc2544BenchmarkRange": "Web Fetch Allow RFC 2544 Benchmark Range",
	"tools.web.fetch.ssrfPolicy.allowIpv6UniqueLocalRange": "Web Fetch Allow IPv6 Unique Local Range",
	"gateway.controlUi.basePath": "Control UI Base Path",
	"gateway.controlUi.root": "Control UI Assets Root",
	"gateway.controlUi.embedSandbox": "Control UI Embed Sandbox Mode",
	"gateway.controlUi.allowExternalEmbedUrls": "Allow External Control UI Embed URLs",
	"gateway.controlUi.chatMessageMaxWidth": "Control UI Chat Message Max Width",
	"gateway.controlUi.allowedOrigins": "Control UI Allowed Origins",
	"gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback": "Dangerously Allow Host-Header Origin Fallback",
	"gateway.controlUi.allowInsecureAuth": "Insecure Control UI Auth Toggle",
	"gateway.controlUi.dangerouslyDisableDeviceAuth": "Dangerously Disable Control UI Device Auth",
	"gateway.push": "Gateway Push Delivery",
	"gateway.push.apns": "Gateway APNs Delivery",
	"gateway.push.apns.relay": "Gateway APNs Relay",
	"gateway.push.apns.relay.baseUrl": "Gateway APNs Relay Base URL",
	"gateway.push.apns.relay.timeoutMs": "Gateway APNs Relay Timeout (ms)",
	"gateway.http.endpoints.chatCompletions.enabled": "OpenAI Chat Completions Endpoint",
	"gateway.http.endpoints.chatCompletions.maxBodyBytes": "OpenAI Chat Completions Max Body Bytes",
	"gateway.http.endpoints.chatCompletions.maxImageParts": "OpenAI Chat Completions Max Image Parts",
	"gateway.http.endpoints.chatCompletions.maxTotalImageBytes": "OpenAI Chat Completions Max Total Image Bytes",
	"gateway.http.endpoints.chatCompletions.images": "OpenAI Chat Completions Image Limits",
	"gateway.http.endpoints.chatCompletions.images.allowUrl": "OpenAI Chat Completions Allow Image URLs",
	"gateway.http.endpoints.chatCompletions.images.urlAllowlist": "OpenAI Chat Completions Image URL Allowlist",
	"gateway.http.endpoints.chatCompletions.images.allowedMimes": "OpenAI Chat Completions Image MIME Allowlist",
	"gateway.http.endpoints.chatCompletions.images.maxBytes": "OpenAI Chat Completions Image Max Bytes",
	"gateway.http.endpoints.chatCompletions.images.maxRedirects": "OpenAI Chat Completions Image Max Redirects",
	"gateway.http.endpoints.chatCompletions.images.timeoutMs": "OpenAI Chat Completions Image Timeout (ms)",
	"gateway.reload.mode": "Config Reload Mode",
	"gateway.reload.debounceMs": "Config Reload Debounce (ms)",
	"gateway.reload.deferralTimeoutMs": "Restart Deferral Timeout (ms)",
	"gateway.nodes.browser.mode": "Gateway Node Browser Mode",
	"gateway.nodes.browser.node": "Gateway Node Browser Pin",
	"gateway.nodes.pairing": "Gateway Node Pairing",
	"gateway.nodes.pairing.autoApproveCidrs": "Gateway Node Pairing Auto-Approve CIDRs",
	"gateway.nodes.allowCommands": "Gateway Node Allowlist (Extra Commands)",
	"gateway.nodes.denyCommands": "Gateway Node Denylist",
	"gateway.webchat.chatHistoryMaxChars": "WebChat History Max Chars",
	nodeHost: "Node Host",
	"nodeHost.browserProxy": "Node Browser Proxy",
	"nodeHost.browserProxy.enabled": "Node Browser Proxy Enabled",
	"nodeHost.browserProxy.allowProfiles": "Node Browser Proxy Allowed Profiles",
	media: "Media",
	"media.preserveFilenames": "Preserve Media Filenames",
	"media.ttlHours": "Media Retention TTL (hours)",
	audio: "Audio",
	"audio.transcription": "Audio Transcription",
	"audio.transcription.command": "Audio Transcription Command",
	"audio.transcription.timeoutSeconds": "Audio Transcription Timeout (sec)",
	bindings: "Bindings",
	"bindings[].type": "Binding Type",
	"bindings[].agentId": "Binding Agent ID",
	"bindings[].session": "Binding Session",
	"bindings[].session.dmScope": "Binding Session DM Scope",
	"bindings[].match": "Binding Match Rule",
	"bindings[].match.channel": "Binding Channel",
	"bindings[].match.accountId": "Binding Account ID",
	"bindings[].match.peer": "Binding Peer Match",
	"bindings[].match.peer.kind": "Binding Peer Kind",
	"bindings[].match.peer.id": "Binding Peer ID",
	"bindings[].match.guildId": "Binding Guild ID",
	"bindings[].match.teamId": "Binding Team ID",
	"bindings[].match.roles": "Binding Roles",
	"bindings[].acp": "ACP Binding Overrides",
	"bindings[].acp.mode": "ACP Binding Mode",
	"bindings[].acp.label": "ACP Binding Label",
	"bindings[].acp.cwd": "ACP Binding Working Directory",
	"bindings[].acp.backend": "ACP Binding Backend",
	broadcast: "Broadcast",
	"broadcast.strategy": "Broadcast Strategy",
	"broadcast.*": "Broadcast Destination List",
	"skills.load.extraDirs": "Extra Skill Directories",
	"skills.load.allowSymlinkTargets": "Allowed Skill Symlink Targets",
	"skills.load.watch": "Watch Skills",
	"skills.load.watchDebounceMs": "Skills Watch Debounce (ms)",
	"agents.defaults.skills": "Skills",
	"agents.defaults.subagents.delegationMode": "Sub-agent Delegation Mode",
	"agents.list[].subagents.delegationMode": "Sub-agent Delegation Mode",
	"agents.defaults.workspace": "Workspace",
	"agents.defaults.repoRoot": "Repo Root",
	"agents.defaults.promptOverlays": "Prompt Overlays",
	"agents.defaults.promptOverlays.gpt5": "GPT-5 Prompt Overlay",
	"agents.defaults.promptOverlays.gpt5.personality": "GPT-5 Personality Overlay",
	"agents.defaults.skipOptionalBootstrapFiles": "Skipped Optional Bootstrap Files",
	"agents.defaults.contextInjection": "Context Injection",
	"agents.defaults.bootstrapMaxChars": "Bootstrap Max Chars",
	"agents.defaults.bootstrapTotalMaxChars": "Bootstrap Total Max Chars",
	"agents.defaults.experimental": "Experimental Agent Flags",
	"agents.defaults.experimental.localModelLean": "Enable Lean Local Model Mode (Experimental)",
	"agents.defaults.bootstrapPromptTruncationWarning": "Bootstrap Prompt Truncation Warning",
	"agents.defaults.startupContext": "Startup Context",
	"agents.defaults.startupContext.enabled": "Enable Startup Context",
	"agents.defaults.startupContext.applyOn": "Startup Context Apply On",
	"agents.defaults.startupContext.dailyMemoryDays": "Startup Context Daily Memory Days",
	"agents.defaults.startupContext.maxFileBytes": "Startup Context Max File Bytes",
	"agents.defaults.startupContext.maxFileChars": "Startup Context Max File Chars",
	"agents.defaults.startupContext.maxTotalChars": "Startup Context Max Total Chars",
	"agents.defaults.envelopeTimezone": "Envelope Timezone",
	"agents.defaults.envelopeTimestamp": "Envelope Timestamp",
	"agents.defaults.envelopeElapsed": "Envelope Elapsed",
	"agents.defaults.memorySearch": "Memory Search",
	"agents.defaults.memorySearch.enabled": "Enable Memory Search",
	"agents.defaults.memorySearch.sources": "Memory Search Sources",
	"agents.defaults.memorySearch.extraPaths": "Extra Memory Paths",
	"agents.defaults.memorySearch.qmd": "Memory Search QMD Collections",
	"agents.defaults.memorySearch.qmd.extraCollections": "QMD Extra Collections",
	"agents.defaults.memorySearch.qmd.extraCollections.path": "QMD Extra Collection Path",
	"agents.defaults.memorySearch.qmd.extraCollections.name": "QMD Extra Collection Name",
	"agents.defaults.memorySearch.qmd.extraCollections.pattern": "QMD Extra Collection Pattern",
	"agents.defaults.memorySearch.multimodal": "Memory Search Multimodal",
	"agents.defaults.memorySearch.multimodal.enabled": "Enable Memory Search Multimodal",
	"agents.defaults.memorySearch.multimodal.modalities": "Memory Search Multimodal Modalities",
	"agents.defaults.memorySearch.multimodal.maxFileBytes": "Memory Search Multimodal Max File Bytes",
	"agents.defaults.memorySearch.experimental.sessionMemory": "Memory Search Session Index (Experimental)",
	"agents.defaults.memorySearch.provider": "Memory Search Provider",
	"agents.defaults.memorySearch.remote.baseUrl": "Remote Embedding Base URL",
	"agents.defaults.memorySearch.remote.apiKey": "Remote Embedding API Key",
	"agents.defaults.memorySearch.remote.headers": "Remote Embedding Headers",
	"agents.defaults.memorySearch.remote.nonBatchConcurrency": "Remote Non-Batch Embedding Concurrency",
	"agents.defaults.memorySearch.remote.batch.enabled": "Remote Batch Embedding Enabled",
	"agents.defaults.memorySearch.remote.batch.wait": "Remote Batch Wait for Completion",
	"agents.defaults.memorySearch.remote.batch.concurrency": "Remote Batch Concurrency",
	"agents.defaults.memorySearch.remote.batch.pollIntervalMs": "Remote Batch Poll Interval (ms)",
	"agents.defaults.memorySearch.remote.batch.timeoutMinutes": "Remote Batch Timeout (min)",
	"agents.defaults.memorySearch.model": "Memory Search Model",
	"agents.defaults.memorySearch.inputType": "Memory Search Input Type",
	"agents.defaults.memorySearch.queryInputType": "Memory Search Query Input Type",
	"agents.defaults.memorySearch.documentInputType": "Memory Search Document Input Type",
	"agents.defaults.memorySearch.outputDimensionality": "Memory Search Output Dimensionality",
	"agents.defaults.memorySearch.fallback": "Memory Search Fallback",
	"agents.defaults.memorySearch.local.modelPath": "Local Embedding Model Path",
	"agents.defaults.memorySearch.local.contextSize": "Local Embedding Context Size",
	"agents.defaults.memorySearch.store.path": "Memory Search Index Path",
	"agents.defaults.memorySearch.store.vector.enabled": "Memory Search Vector Index",
	"agents.defaults.memorySearch.store.vector.extensionPath": "Memory Search Vector Extension Path",
	"agents.defaults.memorySearch.chunking.tokens": "Memory Chunk Tokens",
	"agents.defaults.memorySearch.chunking.overlap": "Memory Chunk Overlap Tokens",
	"agents.defaults.memorySearch.sync.onSessionStart": "Index on Session Start",
	"agents.defaults.memorySearch.sync.onSearch": "Index on Search (Lazy)",
	"agents.defaults.memorySearch.sync.watch": "Watch Memory Files",
	"agents.defaults.memorySearch.sync.watchDebounceMs": "Memory Watch Debounce (ms)",
	"agents.defaults.memorySearch.sync.embeddingBatchTimeoutSeconds": "Embedding Batch Timeout (s)",
	"agents.defaults.memorySearch.sync.sessions.deltaBytes": "Session Delta Bytes",
	"agents.defaults.memorySearch.sync.sessions.deltaMessages": "Session Delta Messages",
	"agents.defaults.memorySearch.sync.sessions.postCompactionForce": "Force Reindex After Compaction",
	"agents.defaults.memorySearch.query.maxResults": "Memory Search Max Results",
	"agents.defaults.memorySearch.query.minScore": "Memory Search Min Score",
	"agents.defaults.memorySearch.query.hybrid.enabled": "Memory Search Hybrid",
	"agents.defaults.memorySearch.query.hybrid.vectorWeight": "Memory Search Vector Weight",
	"agents.defaults.memorySearch.query.hybrid.textWeight": "Memory Search Text Weight",
	"agents.defaults.memorySearch.query.hybrid.candidateMultiplier": "Memory Search Hybrid Candidate Multiplier",
	"agents.defaults.memorySearch.query.hybrid.mmr.enabled": "Memory Search MMR Re-ranking",
	"agents.defaults.memorySearch.query.hybrid.mmr.lambda": "Memory Search MMR Lambda",
	"agents.defaults.memorySearch.query.hybrid.temporalDecay.enabled": "Memory Search Temporal Decay",
	"agents.defaults.memorySearch.query.hybrid.temporalDecay.halfLifeDays": "Memory Search Temporal Decay Half-life (Days)",
	"agents.defaults.memorySearch.cache.enabled": "Memory Search Embedding Cache",
	"agents.defaults.memorySearch.cache.maxEntries": "Memory Search Embedding Cache Max Entries",
	memory: "Memory",
	"memory.backend": "Memory Backend",
	"memory.citations": "Memory Citations Mode",
	"memory.qmd.command": "QMD Binary",
	"memory.qmd.mcporter": "QMD MCPorter",
	"memory.qmd.mcporter.enabled": "QMD MCPorter Enabled",
	"memory.qmd.mcporter.serverName": "QMD MCPorter Server Name",
	"memory.qmd.mcporter.startDaemon": "QMD MCPorter Start Daemon",
	"memory.qmd.searchMode": "QMD Search Mode",
	"memory.qmd.searchTool": "QMD Search Tool Override",
	"memory.qmd.includeDefaultMemory": "QMD Include Default Memory",
	"memory.qmd.paths": "QMD Extra Paths",
	"memory.qmd.paths.path": "QMD Path",
	"memory.qmd.paths.pattern": "QMD Path Pattern",
	"memory.qmd.paths.name": "QMD Path Name",
	"memory.qmd.sessions.enabled": "QMD Session Indexing",
	"memory.qmd.sessions.exportDir": "QMD Session Export Directory",
	"memory.qmd.sessions.retentionDays": "QMD Session Retention (days)",
	"memory.qmd.update.interval": "QMD Update Interval",
	"memory.qmd.update.debounceMs": "QMD Update Debounce (ms)",
	"memory.qmd.update.onBoot": "QMD Update on Manager Start",
	"memory.qmd.update.startup": "QMD Gateway Startup Refresh",
	"memory.qmd.update.startupDelayMs": "QMD Gateway Startup Delay (ms)",
	"memory.qmd.update.waitForBootSync": "QMD Wait for Manager-Start Sync",
	"memory.qmd.update.embedInterval": "QMD Embed Interval",
	"memory.qmd.update.commandTimeoutMs": "QMD Command Timeout (ms)",
	"memory.qmd.update.updateTimeoutMs": "QMD Update Timeout (ms)",
	"memory.qmd.update.embedTimeoutMs": "QMD Embed Timeout (ms)",
	"memory.qmd.limits.maxResults": "QMD Max Results",
	"memory.qmd.limits.maxSnippetChars": "QMD Max Snippet Chars",
	"memory.qmd.limits.maxInjectedChars": "QMD Max Injected Chars",
	"memory.qmd.limits.timeoutMs": "QMD Search Timeout (ms)",
	"memory.qmd.scope": "QMD Surface Scope",
	auth: "Auth",
	"auth.profiles": "Auth Profiles",
	"auth.order": "Auth Profile Order",
	"auth.cooldowns": "Auth Cooldowns",
	acp: "ACP",
	"acp.enabled": "ACP Enabled",
	"acp.dispatch.enabled": "ACP Dispatch Enabled",
	"acp.backend": "ACP Backend",
	"acp.fallbacks": "ACP Fallback Backends",
	"acp.defaultAgent": "ACP Default Agent",
	"acp.allowedAgents": "ACP Allowed Agents",
	"acp.maxConcurrentSessions": "ACP Max Concurrent Sessions",
	"acp.stream": "ACP Stream",
	"acp.stream.coalesceIdleMs": "ACP Stream Coalesce Idle (ms)",
	"acp.stream.maxChunkChars": "ACP Stream Max Chunk Chars",
	"acp.stream.repeatSuppression": "ACP Stream Repeat Suppression",
	"acp.stream.deliveryMode": "ACP Stream Delivery Mode",
	"acp.stream.hiddenBoundarySeparator": "ACP Stream Hidden Boundary Separator",
	"acp.stream.maxOutputChars": "ACP Stream Max Output Chars",
	"acp.stream.maxSessionUpdateChars": "ACP Stream Max Session Update Chars",
	"acp.stream.tagVisibility": "ACP Stream Tag Visibility",
	"acp.runtime.ttlMinutes": "ACP Runtime TTL (minutes)",
	"acp.runtime.installCommand": "ACP Runtime Install Command",
	models: "Models",
	"models.mode": "Model Catalog Mode",
	"models.pricing": "Model Pricing",
	"models.pricing.enabled": "Model Pricing Enabled",
	"models.providers": "Model Providers",
	"models.providers.*.baseUrl": "Model Provider Base URL",
	"models.providers.*.apiKey": "Model Provider API Key",
	"models.providers.*.auth": "Model Provider Auth Mode",
	"models.providers.*.api": "Model Provider API Adapter",
	"models.providers.*.contextWindow": "Model Provider Context Window",
	"models.providers.*.contextTokens": "Model Provider Context Tokens",
	"models.providers.*.maxTokens": "Model Provider Max Tokens",
	"models.providers.*.timeoutSeconds": "Model Provider Request Timeout",
	"models.providers.*.injectNumCtxForOpenAICompat": "Model Provider Inject num_ctx (OpenAI Compat)",
	"models.providers.*.params": "Model Provider Runtime Parameters",
	"models.providers.*.headers": "Model Provider Headers",
	"models.providers.*.authHeader": "Model Provider Authorization Header",
	"models.providers.*.agentRuntime": "Model Provider Runtime",
	"models.providers.*.agentRuntime.id": "Model Provider Runtime ID",
	"models.providers.*.localService": "Model Provider Local Service",
	"models.providers.*.localService.command": "Model Provider Local Service Command",
	"models.providers.*.localService.args": "Model Provider Local Service Arguments",
	"models.providers.*.localService.cwd": "Model Provider Local Service Working Directory",
	"models.providers.*.localService.env": "Model Provider Local Service Environment",
	"models.providers.*.localService.healthUrl": "Model Provider Local Service Health URL",
	"models.providers.*.localService.readyTimeoutMs": "Model Provider Local Service Ready Timeout",
	"models.providers.*.localService.idleStopMs": "Model Provider Local Service Idle Stop",
	"models.providers.*.request": "Model Provider Request Overrides",
	"models.providers.*.request.headers": "Model Provider Request Headers",
	"models.providers.*.request.auth": "Model Provider Request Auth Override",
	"models.providers.*.request.auth.mode": "Model Provider Request Auth Mode",
	"models.providers.*.request.auth.token": "Model Provider Request Bearer Token",
	"models.providers.*.request.auth.headerName": "Model Provider Request Auth Header Name",
	"models.providers.*.request.auth.value": "Model Provider Request Auth Header Value",
	"models.providers.*.request.auth.prefix": "Model Provider Request Auth Header Prefix",
	"models.providers.*.request.proxy": "Model Provider Request Proxy",
	"models.providers.*.request.proxy.mode": "Model Provider Request Proxy Mode",
	"models.providers.*.request.proxy.url": "Model Provider Request Proxy URL",
	"models.providers.*.request.proxy.tls": "Model Provider Request Proxy TLS",
	"models.providers.*.request.proxy.tls.ca": "Model Provider Request Proxy TLS CA",
	"models.providers.*.request.proxy.tls.cert": "Model Provider Request Proxy TLS Cert",
	"models.providers.*.request.proxy.tls.key": "Model Provider Request Proxy TLS Key",
	"models.providers.*.request.proxy.tls.passphrase": "Model Provider Request Proxy TLS Passphrase",
	"models.providers.*.request.proxy.tls.serverName": "Model Provider Request Proxy TLS Server Name",
	"models.providers.*.request.proxy.tls.insecureSkipVerify": "Model Provider Request Proxy TLS Skip Verify",
	proxy: "Managed Proxy",
	"proxy.enabled": "Managed Proxy Enabled",
	"proxy.proxyUrl": "Managed Proxy URL",
	"proxy.tls": "Managed Proxy TLS",
	"proxy.tls.caFile": "Managed Proxy TLS CA File",
	"proxy.loopbackMode": "Managed Proxy Loopback Mode",
	"models.providers.*.request.tls": "Model Provider Request TLS",
	"models.providers.*.request.tls.ca": "Model Provider Request TLS CA",
	"models.providers.*.request.tls.cert": "Model Provider Request TLS Cert",
	"models.providers.*.request.tls.key": "Model Provider Request TLS Key",
	"models.providers.*.request.tls.passphrase": "Model Provider Request TLS Passphrase",
	"models.providers.*.request.tls.serverName": "Model Provider Request TLS Server Name",
	"models.providers.*.request.tls.insecureSkipVerify": "Model Provider Request TLS Skip Verify",
	"models.providers.*.request.allowPrivateNetwork": "Model Provider Request Allow Private Network",
	"models.providers.*.models": "Model Provider Model List",
	"models.providers.*.models[].agentRuntime": "Model Runtime",
	"models.providers.*.models[].agentRuntime.id": "Model Runtime ID",
	"auth.cooldowns.billingBackoffHours": "Billing Backoff (hours)",
	"auth.cooldowns.billingBackoffHoursByProvider": "Billing Backoff Overrides",
	"auth.cooldowns.billingMaxHours": "Billing Backoff Cap (hours)",
	"auth.cooldowns.authPermanentBackoffMinutes": "Auth-Permanent Backoff (minutes)",
	"auth.cooldowns.authPermanentMaxMinutes": "Auth-Permanent Backoff Cap (minutes)",
	"auth.cooldowns.failureWindowHours": "Failover Window (hours)",
	"auth.cooldowns.overloadedProfileRotations": "Overloaded Profile Rotations",
	"auth.cooldowns.overloadedBackoffMs": "Overloaded Backoff (ms)",
	"auth.cooldowns.rateLimitedProfileRotations": "Rate-Limited Profile Rotations",
	"agents.defaults.models": "Models",
	"agents.defaults.models.*.agentRuntime": "Default Agent Model Runtime",
	"agents.defaults.models.*.agentRuntime.id": "Default Agent Model Runtime ID",
	"agents.defaults.model.primary": "Primary Model",
	"agents.defaults.model.fallbacks": "Model Fallbacks",
	"agents.defaults.imageModel.primary": "Image Model",
	"agents.defaults.imageModel.fallbacks": "Image Model Fallbacks",
	"agents.defaults.imageGenerationModel.primary": "Image Generation Model",
	"agents.defaults.imageGenerationModel.fallbacks": "Image Generation Model Fallbacks",
	"agents.defaults.imageGenerationModel.timeoutMs": "Image Generation Timeout (ms)",
	"agents.defaults.videoGenerationModel.primary": "Video Generation Model",
	"agents.defaults.videoGenerationModel.fallbacks": "Video Generation Model Fallbacks",
	"agents.defaults.videoGenerationModel.timeoutMs": "Video Generation Timeout (ms)",
	"agents.defaults.musicGenerationModel.primary": "Music Generation Model",
	"agents.defaults.musicGenerationModel.fallbacks": "Music Generation Model Fallbacks",
	"agents.defaults.mediaGenerationAutoProviderFallback": "Media Generation Auto Provider Fallback",
	"agents.defaults.pdfModel.primary": "PDF Model",
	"agents.defaults.pdfModel.fallbacks": "PDF Model Fallbacks",
	"agents.defaults.pdfMaxBytesMb": "PDF Max Size (MB)",
	"agents.defaults.pdfMaxPages": "PDF Max Pages",
	"agents.defaults.imageMaxDimensionPx": "Image Max Dimension (px)",
	"agents.defaults.humanDelay.mode": "Human Delay Mode",
	"agents.defaults.humanDelay.minMs": "Human Delay Min (ms)",
	"agents.defaults.humanDelay.maxMs": "Human Delay Max (ms)",
	"agents.defaults.cliBackends": "CLI Backends",
	"agents.defaults.compaction": "Compaction",
	"agents.defaults.compaction.mode": "Compaction Mode",
	"agents.defaults.compaction.provider": "Compaction Provider",
	"agents.defaults.compaction.reserveTokens": "Compaction Reserve Tokens",
	"agents.defaults.compaction.keepRecentTokens": "Compaction Keep Recent Tokens",
	"agents.defaults.compaction.reserveTokensFloor": "Compaction Reserve Token Floor",
	"agents.defaults.compaction.maxHistoryShare": "Compaction Max History Share",
	"agents.defaults.compaction.identifierPolicy": "Compaction Identifier Policy",
	"agents.defaults.compaction.identifierInstructions": "Compaction Identifier Instructions",
	"agents.defaults.compaction.recentTurnsPreserve": "Compaction Preserve Recent Turns",
	"agents.defaults.compaction.qualityGuard": "Compaction Quality Guard",
	"agents.defaults.compaction.qualityGuard.enabled": "Compaction Quality Guard Enabled",
	"agents.defaults.compaction.qualityGuard.maxRetries": "Compaction Quality Guard Max Retries",
	"agents.defaults.compaction.midTurnPrecheck": "Compaction Mid-turn Precheck",
	"agents.defaults.compaction.midTurnPrecheck.enabled": "Compaction Mid-turn Precheck Enabled",
	"agents.defaults.compaction.postIndexSync": "Compaction Post-Index Sync",
	"agents.defaults.compaction.postCompactionSections": "Post-Compaction Context Sections",
	"agents.defaults.compaction.timeoutSeconds": "Compaction Timeout (Seconds)",
	"agents.defaults.compaction.model": "Compaction Model Override",
	"agents.defaults.compaction.truncateAfterCompaction": "Rotate Transcript After Compaction",
	"agents.defaults.compaction.maxActiveTranscriptBytes": "Compaction Active Transcript Size Threshold",
	"agents.defaults.compaction.notifyUser": "Compaction Notify User",
	"agents.defaults.compaction.memoryFlush": "Compaction Memory Flush",
	"agents.defaults.compaction.memoryFlush.enabled": "Compaction Memory Flush Enabled",
	"agents.defaults.compaction.memoryFlush.model": "Compaction Memory Flush Model Override",
	"agents.defaults.compaction.memoryFlush.softThresholdTokens": "Compaction Memory Flush Soft Threshold",
	"agents.defaults.compaction.memoryFlush.forceFlushTranscriptBytes": "Compaction Memory Flush Transcript Size Threshold",
	"agents.defaults.compaction.memoryFlush.prompt": "Compaction Memory Flush Prompt",
	"agents.defaults.compaction.memoryFlush.systemPrompt": "Compaction Memory Flush System Prompt",
	"agents.defaults.runRetries": "Run Retries",
	"agents.defaults.runRetries.base": "Run Retries Base",
	"agents.defaults.runRetries.perProfile": "Run Retries Per Profile",
	"agents.defaults.runRetries.min": "Run Retries Minimum",
	"agents.defaults.runRetries.max": "Run Retries Maximum",
	"agents.list[].runRetries": "Agent Run Retries",
	"agents.list[].runRetries.base": "Agent Run Retries Base",
	"agents.list[].runRetries.perProfile": "Agent Run Retries Per Profile",
	"agents.list[].runRetries.min": "Agent Run Retries Minimum",
	"agents.list[].runRetries.max": "Agent Run Retries Maximum",
	"agents.defaults.embeddedPi": "Embedded Pi",
	"agents.defaults.embeddedPi.projectSettingsPolicy": "Embedded Pi Project Settings Policy",
	"agents.defaults.embeddedPi.executionContract": "Embedded Pi Execution Contract",
	"agents.defaults.heartbeat.includeSystemPromptSection": "Heartbeat Include System Prompt Section",
	"agents.list.*.heartbeat.includeSystemPromptSection": "Heartbeat Include System Prompt Section",
	"agents.list[].embeddedPi": "Agent Embedded Pi",
	"agents.list[].embeddedPi.executionContract": "Agent Embedded Pi Execution Contract",
	"agents.defaults.heartbeat.directPolicy": "Heartbeat Direct Policy",
	"agents.list.*.heartbeat.directPolicy": "Heartbeat Direct Policy",
	"agents.defaults.heartbeat.suppressToolErrorWarnings": "Heartbeat Suppress Tool Error Warnings",
	"agents.list.*.heartbeat.suppressToolErrorWarnings": "Heartbeat Suppress Tool Error Warnings",
	"agents.defaults.heartbeat.timeoutSeconds": "Heartbeat Timeout (Seconds)",
	"agents.list.*.heartbeat.timeoutSeconds": "Heartbeat Timeout (Seconds)",
	"agents.defaults.heartbeat.skipWhenBusy": "Heartbeat Skip When Busy",
	"agents.list.*.heartbeat.skipWhenBusy": "Heartbeat Skip When Busy",
	"agents.defaults.sandbox.browser.network": "Sandbox Browser Network",
	"agents.defaults.sandbox.browser.cdpSourceRange": "Sandbox Browser CDP Source Port Range",
	"agents.defaults.sandbox.docker.dangerouslyAllowContainerNamespaceJoin": "Sandbox Docker Allow Container Namespace Join",
	"agents.defaults.sandbox.docker.gpus": "Sandbox Docker GPUs",
	commands: "Commands",
	"commands.native": "Native Commands",
	"commands.nativeSkills": "Native Skill Commands",
	"commands.text": "Text Commands",
	"commands.bash": "Allow Bash Chat Command",
	"commands.bashForegroundMs": "Bash Foreground Window (ms)",
	"commands.config": "Allow /config",
	"commands.mcp": "Allow /mcp",
	"commands.plugins": "Allow /plugins",
	"commands.debug": "Allow /debug",
	"commands.restart": "Allow Restart",
	"commands.useAccessGroups": "Use Access Groups",
	"commands.ownerAllowFrom": "Command Owners",
	"commands.ownerDisplay": "Owner ID Display",
	"commands.ownerDisplaySecret": "Owner ID Hash Secret",
	"commands.allowFrom": "Command Elevated Access Rules",
	mcp: "MCP",
	"mcp.servers": "MCP Servers",
	"mcp.servers.*.codex": "Codex MCP Projection",
	"mcp.servers.*.codex.agents": "Codex MCP Agents",
	"mcp.servers.*.codex.defaultToolsApprovalMode": "Codex MCP Tool Approval",
	"mcp.servers.*.codex.default_tools_approval_mode": "Codex MCP Tool Approval",
	"mcp.sessionIdleTtlMs": "MCP Runtime Idle TTL",
	ui: "UI",
	"ui.seamColor": "Accent Color",
	"ui.assistant": "Assistant Appearance",
	"ui.assistant.name": "Assistant Name",
	"ui.assistant.avatar": "Assistant Avatar",
	"browser.evaluateEnabled": "Browser Evaluate Enabled",
	"browser.snapshotDefaults": "Browser Snapshot Defaults",
	"browser.snapshotDefaults.mode": "Browser Snapshot Mode",
	"browser.tabCleanup": "Browser Tab Cleanup",
	"browser.tabCleanup.enabled": "Browser Tab Cleanup Enabled",
	"browser.tabCleanup.idleMinutes": "Browser Tab Cleanup Idle Minutes",
	"browser.tabCleanup.maxTabsPerSession": "Browser Tab Cleanup Max Tabs Per Session",
	"browser.tabCleanup.sweepMinutes": "Browser Tab Cleanup Sweep Minutes",
	"browser.ssrfPolicy": "Browser SSRF Policy",
	"browser.ssrfPolicy.dangerouslyAllowPrivateNetwork": "Browser Dangerously Allow Private Network",
	"browser.ssrfPolicy.allowedHostnames": "Browser Allowed Hostnames",
	"browser.ssrfPolicy.hostnameAllowlist": "Browser Hostname Allowlist",
	"browser.remoteCdpTimeoutMs": "Remote CDP Timeout (ms)",
	"browser.remoteCdpHandshakeTimeoutMs": "Remote CDP Handshake Timeout (ms)",
	session: "Session",
	"session.scope": "Session Scope",
	"session.dmScope": "DM Session Scope",
	"session.identityLinks": "Session Identity Links",
	"session.resetTriggers": "Session Reset Triggers",
	"session.idleMinutes": "Session Idle Minutes",
	"session.reset": "Session Reset Policy",
	"session.reset.mode": "Session Reset Mode",
	"session.reset.atHour": "Session Daily Reset Hour",
	"session.reset.idleMinutes": "Session Reset Idle Minutes",
	"session.resetByType": "Session Reset by Chat Type",
	"session.resetByType.direct": "Session Reset (Direct)",
	"session.resetByType.dm": "Session Reset (DM Deprecated Alias)",
	"session.resetByType.group": "Session Reset (Group)",
	"session.resetByType.thread": "Session Reset (Thread)",
	"session.resetByChannel": "Session Reset by Channel",
	"session.store": "Session Store Path",
	"session.typingIntervalSeconds": "Session Typing Interval (seconds)",
	"session.typingMode": "Session Typing Mode",
	"session.mainKey": "Session Main Key",
	"session.sendPolicy": "Session Send Policy",
	"session.sendPolicy.default": "Session Send Policy Default Action",
	"session.sendPolicy.rules": "Session Send Policy Rules",
	"session.sendPolicy.rules[].action": "Session Send Rule Action",
	"session.sendPolicy.rules[].match": "Session Send Rule Match",
	"session.sendPolicy.rules[].match.channel": "Session Send Rule Channel",
	"session.sendPolicy.rules[].match.chatType": "Session Send Rule Chat Type",
	"session.sendPolicy.rules[].match.keyPrefix": "Session Send Rule Key Prefix",
	"session.sendPolicy.rules[].match.rawKeyPrefix": "Session Send Rule Raw Key Prefix",
	"session.writeLock": "Session Write Lock",
	"session.writeLock.acquireTimeoutMs": "Session Write Lock Acquire Timeout",
	"session.writeLock.staleMs": "Session Write Lock Stale Timeout",
	"session.writeLock.maxHoldMs": "Session Write Lock Max Hold",
	"session.agentToAgent": "Session Agent-to-Agent",
	"session.agentToAgent.maxPingPongTurns": "Agent-to-Agent Ping-Pong Turns",
	"session.threadBindings": "Session Thread Bindings",
	"session.threadBindings.enabled": "Thread Binding Enabled",
	"session.threadBindings.idleHours": "Thread Binding Idle Timeout (hours)",
	"session.threadBindings.maxAgeHours": "Thread Binding Max Age (hours)",
	"session.threadBindings.spawnSessions": "Thread-Bound Session Spawns",
	"session.threadBindings.defaultSpawnContext": "Thread Spawn Context",
	"session.maintenance": "Session Maintenance",
	"session.maintenance.mode": "Session Maintenance Mode",
	"session.maintenance.pruneAfter": "Session Prune After",
	"session.maintenance.pruneDays": "Session Prune Days (Deprecated)",
	"session.maintenance.maxEntries": "Session Max Entries",
	"session.maintenance.rotateBytes": "Deprecated Session Rotate Size",
	"session.maintenance.resetArchiveRetention": "Session Reset Archive Retention",
	"session.maintenance.maxDiskBytes": "Session Max Disk Budget",
	"session.maintenance.highWaterBytes": "Session Disk High-water Target",
	cron: "Cron",
	"cron.enabled": "Cron Enabled",
	"cron.store": "Cron Store Path",
	"cron.maxConcurrentRuns": "Cron Max Concurrent Runs",
	"cron.retry": "Cron Retry Policy",
	"cron.retry.maxAttempts": "Cron Retry Max Attempts",
	"cron.retry.backoffMs": "Cron Retry Backoff (ms)",
	"cron.retry.retryOn": "Cron Retry Error Types",
	"cron.webhook": "Cron Legacy Webhook (Deprecated)",
	"cron.webhookToken": "Cron Webhook Bearer Token",
	"cron.sessionRetention": "Cron Session Retention",
	"cron.runLog": "Cron Run Log Pruning",
	"cron.runLog.maxBytes": "Cron Run Log Max Bytes",
	"cron.runLog.keepLines": "Cron Run Log Keep Lines",
	hooks: "Hooks",
	"hooks.enabled": "Hooks Enabled",
	"hooks.path": "Hooks Endpoint Path",
	"hooks.token": "Hooks Auth Token",
	"hooks.defaultSessionKey": "Hooks Default Session Key",
	"hooks.allowRequestSessionKey": "Hooks Allow Request Session Key",
	"hooks.allowedSessionKeyPrefixes": "Hooks Allowed Session Key Prefixes",
	"hooks.allowedAgentIds": "Hooks Allowed Agent IDs",
	"hooks.maxBodyBytes": "Hooks Max Body Bytes",
	"hooks.presets": "Hooks Presets",
	"hooks.transformsDir": "Hooks Transforms Directory",
	"hooks.mappings": "Hook Mappings",
	"hooks.mappings[].id": "Hook Mapping ID",
	"hooks.mappings[].match": "Hook Mapping Match",
	"hooks.mappings[].match.path": "Hook Mapping Match Path",
	"hooks.mappings[].match.source": "Hook Mapping Match Source",
	"hooks.mappings[].action": "Hook Mapping Action",
	"hooks.mappings[].wakeMode": "Hook Mapping Wake Mode",
	"hooks.mappings[].name": "Hook Mapping Name",
	"hooks.mappings[].agentId": "Hook Mapping Agent ID",
	"hooks.mappings[].sessionKey": "Hook Mapping Session Key",
	"hooks.mappings[].messageTemplate": "Hook Mapping Message Template",
	"hooks.mappings[].textTemplate": "Hook Mapping Text Template",
	"hooks.mappings[].deliver": "Hook Mapping Deliver Reply",
	"hooks.mappings[].allowUnsafeExternalContent": "Hook Mapping Allow Unsafe External Content",
	"hooks.mappings[].channel": "Hook Mapping Delivery Channel",
	"hooks.mappings[].to": "Hook Mapping Delivery Destination",
	"hooks.mappings[].model": "Hook Mapping Model Override",
	"hooks.mappings[].thinking": "Hook Mapping Thinking Override",
	"hooks.mappings[].timeoutSeconds": "Hook Mapping Timeout (sec)",
	"hooks.mappings[].transform": "Hook Mapping Transform",
	"hooks.mappings[].transform.module": "Hook Transform Module",
	"hooks.mappings[].transform.export": "Hook Transform Export",
	"hooks.gmail": "Gmail Hook",
	"hooks.gmail.account": "Gmail Hook Account",
	"hooks.gmail.label": "Gmail Hook Label",
	"hooks.gmail.topic": "Gmail Hook Pub/Sub Topic",
	"hooks.gmail.subscription": "Gmail Hook Subscription",
	"hooks.gmail.pushToken": "Gmail Hook Push Token",
	"hooks.gmail.hookUrl": "Gmail Hook Callback URL",
	"hooks.gmail.includeBody": "Gmail Hook Include Body",
	"hooks.gmail.maxBytes": "Gmail Hook Max Body Bytes",
	"hooks.gmail.renewEveryMinutes": "Gmail Hook Renew Interval (min)",
	"hooks.gmail.allowUnsafeExternalContent": "Gmail Hook Allow Unsafe External Content",
	"hooks.gmail.serve": "Gmail Hook Local Server",
	"hooks.gmail.serve.bind": "Gmail Hook Server Bind Address",
	"hooks.gmail.serve.port": "Gmail Hook Server Port",
	"hooks.gmail.serve.path": "Gmail Hook Server Path",
	"hooks.gmail.tailscale": "Gmail Hook Tailscale",
	"hooks.gmail.tailscale.mode": "Gmail Hook Tailscale Mode",
	"hooks.gmail.tailscale.path": "Gmail Hook Tailscale Path",
	"hooks.gmail.tailscale.target": "Gmail Hook Tailscale Target",
	"hooks.gmail.model": "Gmail Hook Model Override",
	"hooks.gmail.thinking": "Gmail Hook Thinking Override",
	"hooks.internal": "Internal Hooks",
	"hooks.internal.enabled": "Internal Hooks Enabled",
	"hooks.internal.entries": "Internal Hook Entries",
	"hooks.internal.load": "Internal Hook Loader",
	"hooks.internal.load.extraDirs": "Internal Hook Extra Directories",
	"hooks.internal.installs": "Internal Hook Install Records",
	web: "Web Channel",
	"web.enabled": "Web Channel Enabled",
	"web.heartbeatSeconds": "Web Channel Heartbeat Interval (sec)",
	"web.reconnect": "Web Channel Reconnect Policy",
	"web.reconnect.initialMs": "Web Reconnect Initial Delay (ms)",
	"web.reconnect.maxMs": "Web Reconnect Max Delay (ms)",
	"web.reconnect.factor": "Web Reconnect Backoff Factor",
	"web.reconnect.jitter": "Web Reconnect Jitter",
	"web.reconnect.maxAttempts": "Web Reconnect Max Attempts",
	"web.whatsapp": "WhatsApp Web Socket Timing",
	"web.whatsapp.keepAliveIntervalMs": "WhatsApp Web Keepalive Interval (ms)",
	"web.whatsapp.connectTimeoutMs": "WhatsApp Web Connect Timeout (ms)",
	"web.whatsapp.defaultQueryTimeoutMs": "WhatsApp Web Query Timeout (ms)",
	discovery: "Discovery",
	"discovery.wideArea": "Wide-area Discovery",
	"discovery.wideArea.enabled": "Wide-area Discovery Enabled",
	"discovery.wideArea.domain": "Wide-area Discovery Domain",
	"discovery.mdns": "mDNS Discovery",
	talk: "Talk",
	"talk.speechLocale": "Talk Speech Locale",
	"talk.interruptOnSpeech": "Talk Interrupt on Speech",
	"talk.silenceTimeoutMs": "Talk Silence Timeout (ms)",
	"talk.consultThinkingLevel": "Talk Consult Thinking Level",
	"talk.consultFastMode": "Talk Consult Fast Mode",
	messages: "Messages",
	"messages.messagePrefix": "Inbound Message Prefix",
	"messages.visibleReplies": "Visible Replies",
	"messages.responsePrefix": "Outbound Response Prefix",
	"messages.groupChat": "Group Chat Rules",
	"messages.groupChat.mentionPatterns": "Group Mention Patterns",
	"messages.groupChat.historyLimit": "Group History Limit",
	"messages.groupChat.unmentionedInbound": "Group Unmentioned Inbound",
	"messages.groupChat.visibleReplies": "Group Visible Replies",
	"messages.queue": "Inbound Queue",
	"messages.queue.mode": "Queue Mode",
	"messages.queue.byChannel": "Queue Mode by Channel",
	"messages.queue.debounceMs": "Queue Fallback Debounce (ms)",
	"messages.queue.debounceMsByChannel": "Queue Fallback Debounce by Channel (ms)",
	"messages.queue.cap": "Queue Capacity",
	"messages.queue.drop": "Queue Drop Strategy",
	"messages.inbound": "Inbound Debounce",
	"messages.suppressToolErrors": "Suppress Tool Error Warnings",
	"messages.ackReaction": "Ack Reaction Emoji",
	"messages.ackReactionScope": "Ack Reaction Scope",
	"messages.removeAckAfterReply": "Remove Ack Reaction After Reply",
	"messages.statusReactions": "Status Reactions",
	"messages.statusReactions.enabled": "Enable Status Reactions",
	"messages.statusReactions.emojis": "Status Reaction Emojis",
	"messages.statusReactions.timing": "Status Reaction Timing",
	"messages.inbound.debounceMs": "Inbound Message Debounce (ms)",
	"messages.inbound.byChannel": "Inbound Debounce by Channel (ms)",
	"messages.tts": "Message Text-to-Speech",
	"messages.tts.persona": "TTS Persona",
	"messages.tts.personas": "TTS Personas",
	"messages.tts.personas.*": "TTS Persona",
	"messages.tts.personas.*.prompt": "TTS Persona Prompt",
	"messages.tts.personas.*.providers": "TTS Persona Provider Bindings",
	"messages.tts.providers": "TTS Provider Settings",
	"messages.tts.providers.*": "TTS Provider Config",
	"messages.tts.providers.*.apiKey": "TTS Provider API Key",
	"talk.provider": "Talk Active Provider",
	"talk.providers": "Talk Provider Settings",
	"talk.providers.*": "Talk Provider Config",
	"talk.providers.*.apiKey": "Talk Provider API Key",
	"talk.realtime": "Talk Realtime",
	"talk.realtime.provider": "Talk Realtime Provider",
	"talk.realtime.providers": "Talk Realtime Provider Settings",
	"talk.realtime.providers.*": "Talk Realtime Provider Config",
	"talk.realtime.providers.*.apiKey": "Talk Realtime Provider API Key",
	"talk.realtime.model": "Talk Realtime Model",
	"talk.realtime.voice": "Talk Realtime Voice",
	"talk.realtime.instructions": "Talk Realtime Instructions",
	"talk.realtime.mode": "Talk Realtime Mode",
	"talk.realtime.transport": "Talk Realtime Transport",
	"talk.realtime.brain": "Talk Realtime Brain",
	"talk.realtime.consultRouting": "Talk Realtime Consult Routing",
	channels: "Channels",
	"channels.defaults": "Channel Defaults",
	"channels.defaults.groupPolicy": "Default Group Policy",
	"channels.defaults.contextVisibility": "Default Context Visibility",
	"channels.defaults.heartbeat": "Default Heartbeat Visibility",
	"channels.defaults.heartbeat.showOk": "Heartbeat Show OK",
	"channels.defaults.heartbeat.showAlerts": "Heartbeat Show Alerts",
	"channels.defaults.heartbeat.useIndicator": "Heartbeat Use Indicator",
	"channels.defaults.botLoopProtection": "Default Bot Loop Protection",
	"channels.defaults.botLoopProtection.enabled": "Default Bot Loop Protection Enabled",
	"channels.defaults.botLoopProtection.maxEventsPerWindow": "Default Bot Loop Events per Window",
	"channels.defaults.botLoopProtection.windowSeconds": "Default Bot Loop Window Seconds",
	"channels.defaults.botLoopProtection.cooldownSeconds": "Default Bot Loop Cooldown Seconds",
	"channels.mattermost": "Mattermost",
	"channels.modelByChannel": "Channel Model Overrides",
	"channels.googlechat.botLoopProtection": "Google Chat Bot Loop Protection",
	"channels.mattermost.botToken": "Mattermost Bot Token",
	"channels.mattermost.baseUrl": "Mattermost Base URL",
	"channels.mattermost.configWrites": "Mattermost Config Writes",
	"channels.mattermost.chatmode": "Mattermost Chat Mode",
	"channels.mattermost.oncharPrefixes": "Mattermost Onchar Prefixes",
	"channels.mattermost.requireMention": "Mattermost Require Mention",
	"agents.list[].skills": "Agent Skill Filter",
	"agents.list[].identity.avatar": "Agent Avatar",
	"agents.list[].heartbeat.suppressToolErrorWarnings": "Agent Heartbeat Suppress Tool Error Warnings",
	"agents.list[].heartbeat.timeoutSeconds": "Agent Heartbeat Timeout (Seconds)",
	"agents.list[].heartbeat.skipWhenBusy": "Agent Heartbeat Skip When Busy",
	"agents.list[].sandbox.browser.network": "Agent Sandbox Browser Network",
	"agents.list[].sandbox.browser.cdpSourceRange": "Agent Sandbox Browser CDP Source Port Range",
	"agents.list[].sandbox.docker.dangerouslyAllowContainerNamespaceJoin": "Agent Sandbox Docker Allow Container Namespace Join",
	"agents.list[].sandbox.docker.gpus": "Agent Sandbox Docker GPUs",
	"discovery.mdns.mode": "mDNS Discovery Mode",
	plugins: "Plugins",
	"plugins.enabled": "Enable Plugins",
	"plugins.allow": "Plugin Allowlist",
	"plugins.bundledDiscovery": "Bundled Plugin Discovery",
	"plugins.deny": "Plugin Denylist",
	"plugins.load": "Plugin Loader",
	"plugins.load.paths": "Plugin Load Paths",
	"plugins.slots": "Plugin Slots",
	"plugins.slots.memory": "Memory Plugin",
	"plugins.slots.contextEngine": "Context Engine Plugin",
	"plugins.entries": "Plugin Entries",
	"plugins.entries.*.enabled": "Plugin Enabled",
	"plugins.entries.*.hooks": "Plugin Hook Policy",
	"plugins.entries.*.hooks.allowConversationAccess": "Allow Conversation Access Hooks",
	"plugins.entries.*.hooks.allowPromptInjection": "Allow Prompt Injection Hooks",
	"plugins.entries.*.hooks.timeoutMs": "Plugin Hook Timeout (ms)",
	"plugins.entries.*.hooks.timeouts": "Plugin Hook Timeout Overrides",
	"plugins.entries.*.subagent": "Plugin Subagent Policy",
	"plugins.entries.*.subagent.allowModelOverride": "Allow Plugin Subagent Model Override",
	"plugins.entries.*.subagent.allowedModels": "Plugin Subagent Allowed Models",
	"plugins.entries.*.llm": "Plugin LLM Policy",
	"plugins.entries.*.llm.allowModelOverride": "Allow Plugin LLM Model Override",
	"plugins.entries.*.llm.allowedModels": "Plugin LLM Allowed Models",
	"plugins.entries.*.llm.allowAgentIdOverride": "Allow Plugin LLM Agent Override",
	"plugins.entries.*.apiKey": "Plugin API Key",
	"plugins.entries.*.env": "Plugin Environment Variables",
	"plugins.entries.*.config": "Plugin Config"
};
//#endregion
//#region src/config/schema.tags.ts
const CONFIG_TAGS = [
	"security",
	"auth",
	"network",
	"access",
	"privacy",
	"observability",
	"performance",
	"reliability",
	"storage",
	"models",
	"media",
	"automation",
	"channels",
	"tools",
	"advanced"
];
const TAG_PRIORITY = {
	security: 0,
	auth: 1,
	access: 2,
	network: 3,
	privacy: 4,
	observability: 5,
	reliability: 6,
	performance: 7,
	storage: 8,
	models: 9,
	media: 10,
	automation: 11,
	channels: 12,
	tools: 13,
	advanced: 14
};
const TAG_OVERRIDES = {
	"gateway.auth.token": [
		"security",
		"auth",
		"access",
		"network"
	],
	"gateway.auth.password": [
		"security",
		"auth",
		"access",
		"network"
	],
	"gateway.push.apns.relay.baseUrl": ["network", "advanced"],
	"gateway.controlUi.embedSandbox": [
		"security",
		"access",
		"advanced"
	],
	"gateway.controlUi.allowExternalEmbedUrls": [
		"security",
		"access",
		"network",
		"advanced"
	],
	"gateway.controlUi.chatMessageMaxWidth": ["advanced"],
	"gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback": [
		"security",
		"access",
		"network",
		"advanced"
	],
	"gateway.controlUi.dangerouslyDisableDeviceAuth": [
		"security",
		"access",
		"network",
		"advanced"
	],
	"gateway.controlUi.allowInsecureAuth": [
		"security",
		"access",
		"network",
		"advanced"
	],
	"gateway.nodes.pairing.autoApproveCidrs": [
		"security",
		"access",
		"network",
		"advanced"
	],
	"proxy.tls.caFile": [
		"security",
		"network",
		"storage",
		"advanced"
	],
	"tools.exec.applyPatch.workspaceOnly": [
		"tools",
		"security",
		"access",
		"advanced"
	]
};
const PREFIX_RULES = [
	{
		prefix: "channels.",
		tags: ["channels", "network"]
	},
	{
		prefix: "tools.",
		tags: ["tools"]
	},
	{
		prefix: "gateway.",
		tags: ["network"]
	},
	{
		prefix: "nodehost.",
		tags: ["network"]
	},
	{
		prefix: "discovery.",
		tags: ["network"]
	},
	{
		prefix: "auth.",
		tags: ["auth", "access"]
	},
	{
		prefix: "memory.",
		tags: ["storage"]
	},
	{
		prefix: "models.",
		tags: ["models"]
	},
	{
		prefix: "diagnostics.",
		tags: ["observability"]
	},
	{
		prefix: "logging.",
		tags: ["observability"]
	},
	{
		prefix: "cron.",
		tags: ["automation"]
	},
	{
		prefix: "talk.",
		tags: ["media"]
	},
	{
		prefix: "audio.",
		tags: ["media"]
	}
];
const KEYWORD_RULES = [
	{
		pattern: /(token|password|secret|api[_.-]?key|tlsfingerprint)/i,
		tags: ["security", "auth"]
	},
	{
		pattern: /(allow|deny|owner|permission|policy|access)/i,
		tags: ["access"]
	},
	{
		pattern: /(timeout|debounce|interval|concurrency|max|limit|cachettl)/i,
		tags: ["performance"]
	},
	{
		pattern: /(retry|backoff|fallback|circuit|health|reload|probe)/i,
		tags: ["reliability"]
	},
	{
		pattern: /(path|dir|file|store|db|session|cache)/i,
		tags: ["storage"]
	},
	{
		pattern: /(telemetry|trace|metrics|logs|diagnostic)/i,
		tags: ["observability"]
	},
	{
		pattern: /(experimental|dangerously|insecure)/i,
		tags: ["advanced", "security"]
	},
	{
		pattern: /(privacy|redact|sanitize|anonym|pseudonym)/i,
		tags: ["privacy"]
	}
];
const MODEL_PATH_PATTERN = /(^|\.)(model|models|modelid|imagemodel)(\.|$)/i;
const MEDIA_PATH_PATTERN = /(tools\.media\.|^audio\.|^talk\.|image|video|stt|tts)/i;
const AUTOMATION_PATH_PATTERN = /(cron|heartbeat|schedule|onstart|watchdebounce)/i;
const AUTH_KEYWORD_PATTERN = /(token|password|secret|api[_.-]?key|credential|oauth)/i;
function normalizeTag(tag) {
	const normalized = normalizeLowercaseStringOrEmpty(tag);
	return CONFIG_TAGS.includes(normalized) ? normalized : null;
}
function normalizeTags(tags) {
	const out = /* @__PURE__ */ new Set();
	for (const tag of tags) {
		const normalized = normalizeTag(tag);
		if (normalized) out.add(normalized);
	}
	return [...out].toSorted((a, b) => TAG_PRIORITY[a] - TAG_PRIORITY[b]);
}
function collectUnknownTags(tags) {
	const out = /* @__PURE__ */ new Set();
	for (const tag of tags) {
		const normalized = normalizeLowercaseStringOrEmpty(tag);
		if (!normalized || normalizeTag(normalized)) continue;
		out.add(normalized);
	}
	return [...out];
}
function patternToRegExp(pattern) {
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^.]+");
	return new RegExp(`^${escaped}$`, "i");
}
function resolveOverride(path) {
	const direct = TAG_OVERRIDES[path];
	if (direct) return direct;
	for (const [pattern, tags] of Object.entries(TAG_OVERRIDES)) {
		if (!pattern.includes("*")) continue;
		if (patternToRegExp(pattern).test(path)) return tags;
	}
}
function addTags(set, tags) {
	for (const tag of tags) set.add(tag);
}
function deriveTagsForPath(path, hint) {
	const lowerPath = normalizeLowercaseStringOrEmpty(path);
	const override = resolveOverride(path);
	if (override) return normalizeTags(override);
	const tags = /* @__PURE__ */ new Set();
	for (const rule of PREFIX_RULES) if (lowerPath.startsWith(rule.prefix)) addTags(tags, rule.tags);
	for (const rule of KEYWORD_RULES) if (rule.pattern.test(path)) addTags(tags, rule.tags);
	if (MODEL_PATH_PATTERN.test(path)) tags.add("models");
	if (MEDIA_PATH_PATTERN.test(path)) tags.add("media");
	if (AUTOMATION_PATH_PATTERN.test(path)) tags.add("automation");
	if (hint?.sensitive) {
		tags.add("security");
		if (AUTH_KEYWORD_PATTERN.test(path)) tags.add("auth");
	}
	if (hint?.advanced) tags.add("advanced");
	if (tags.size === 0) tags.add("advanced");
	return normalizeTags([...tags]);
}
function applyDerivedTags(hints) {
	const next = {};
	for (const [path, hint] of Object.entries(hints)) {
		const existingTags = Array.isArray(hint?.tags) ? hint.tags : [];
		const tags = [...normalizeTags([...deriveTagsForPath(path, hint), ...existingTags]), ...collectUnknownTags(existingTags)];
		next[path] = {
			...hint,
			tags
		};
	}
	return next;
}
//#endregion
//#region src/config/schema.hints.ts
let log = null;
function getLog() {
	if (!log) log = createSubsystemLogger("config/schema");
	return log;
}
const GROUP_LABELS = {
	wizard: "Wizard",
	update: "Update",
	cli: "CLI",
	diagnostics: "Diagnostics",
	logging: "Logging",
	gateway: "Gateway",
	nodeHost: "Node Host",
	agents: "Agents",
	tools: "Tools",
	bindings: "Bindings",
	audio: "Audio",
	models: "Models",
	messages: "Messages",
	commands: "Commands",
	session: "Session",
	cron: "Cron",
	hooks: "Hooks",
	ui: "UI",
	browser: "Browser",
	talk: "Talk",
	channels: "Messaging Channels",
	skills: "Skills",
	plugins: "Plugins",
	discovery: "Discovery",
	presence: "Presence",
	voicewake: "Voice Wake"
};
const GROUP_ORDER = {
	wizard: 20,
	update: 25,
	cli: 26,
	diagnostics: 27,
	gateway: 30,
	nodeHost: 35,
	agents: 40,
	tools: 50,
	bindings: 55,
	audio: 60,
	models: 70,
	messages: 80,
	commands: 85,
	session: 90,
	cron: 100,
	hooks: 110,
	ui: 120,
	browser: 130,
	talk: 140,
	channels: 150,
	skills: 200,
	plugins: 205,
	discovery: 210,
	presence: 220,
	voicewake: 230,
	logging: 900
};
const FIELD_PLACEHOLDERS = {
	"gateway.remote.url": "ws://host:18789",
	"gateway.remote.tlsFingerprint": "sha256:ab12cd34…",
	"gateway.remote.sshTarget": "user@host",
	"gateway.controlUi.basePath": "/openclaw",
	"gateway.controlUi.root": "dist/control-ui",
	"gateway.controlUi.allowedOrigins": "https://control.example.com",
	"gateway.push.apns.relay.baseUrl": "https://relay.example.com",
	"channels.mattermost.baseUrl": "https://chat.example.com",
	"agents.list[].identity.avatar": "avatars/openclaw.png"
};
const CHANNEL_NAMESPACE_PREFIX = "channels.";
const CHANNEL_KERNEL_HINT_PREFIXES = ["channels.defaults", "channels.modelByChannel"];
function isKernelOwnedChannelHintPath(path) {
	if (path === "channels") return true;
	return CHANNEL_KERNEL_HINT_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}.`));
}
function isPluginOwnedChannelHintPath(path) {
	if (!path.startsWith(CHANNEL_NAMESPACE_PREFIX)) return false;
	return !isKernelOwnedChannelHintPath(path);
}
function buildBaseHints() {
	const hints = {};
	for (const [group, label] of Object.entries(GROUP_LABELS)) hints[group] = {
		label,
		group: label,
		order: GROUP_ORDER[group]
	};
	for (const [path, label] of Object.entries(FIELD_LABELS)) {
		if (isPluginOwnedChannelHintPath(path)) continue;
		const current = hints[path];
		hints[path] = current ? {
			...current,
			label
		} : { label };
	}
	for (const [path, help] of Object.entries(FIELD_HELP)) {
		if (isPluginOwnedChannelHintPath(path)) continue;
		const current = hints[path];
		hints[path] = current ? {
			...current,
			help
		} : { help };
	}
	for (const [path, placeholder] of Object.entries(FIELD_PLACEHOLDERS)) {
		if (isPluginOwnedChannelHintPath(path)) continue;
		const current = hints[path];
		hints[path] = current ? {
			...current,
			placeholder
		} : { placeholder };
	}
	return applyDerivedTags(hints);
}
function applySensitiveHints(hints, allowedKeys) {
	const next = { ...hints };
	const keys = allowedKeys ? [...allowedKeys] : Object.keys(next);
	for (const key of keys) {
		const current = next[key];
		if (current?.sensitive !== void 0) continue;
		if (isSensitiveConfigPath(key)) next[key] = {
			...current,
			sensitive: true
		};
	}
	return next;
}
function applySensitiveUrlHints(hints, allowedKeys) {
	const next = { ...hints };
	const keys = allowedKeys ? [...allowedKeys] : Object.keys(next);
	for (const key of keys) {
		if (!isSensitiveUrlConfigPath(key)) continue;
		const current = next[key];
		const tags = new Set(current?.tags ?? []);
		tags.add(SENSITIVE_URL_HINT_TAG);
		next[key] = {
			...current,
			tags: [...tags]
		};
	}
	return next;
}
function collectMatchingSchemaPaths(schema, path, matchesPath, paths = /* @__PURE__ */ new Set()) {
	let currentSchema = schema;
	while (isUnwrappable(currentSchema)) currentSchema = currentSchema.unwrap();
	if (path && matchesPath(path)) paths.add(path);
	if (currentSchema instanceof ZodObject) {
		const shape = currentSchema.shape;
		for (const key in shape) {
			const nextPath = path ? `${path}.${key}` : key;
			collectMatchingSchemaPaths(shape[key], nextPath, matchesPath, paths);
		}
		const catchallSchema = currentSchema["_def"].catchall;
		if (catchallSchema && !(catchallSchema instanceof ZodNever)) collectMatchingSchemaPaths(catchallSchema, path ? `${path}.*` : "*", matchesPath, paths);
	} else if (currentSchema instanceof ZodArray) {
		const nextPath = path ? `${path}[]` : "[]";
		collectMatchingSchemaPaths(currentSchema.element, nextPath, matchesPath, paths);
	} else if (currentSchema instanceof ZodRecord) {
		const nextPath = path ? `${path}.*` : "*";
		collectMatchingSchemaPaths(currentSchema["_def"].valueType, nextPath, matchesPath, paths);
	} else if (currentSchema instanceof ZodUnion || currentSchema instanceof ZodDiscriminatedUnion) for (const option of currentSchema.options) collectMatchingSchemaPaths(option, path, matchesPath, paths);
	else if (currentSchema instanceof ZodIntersection) {
		collectMatchingSchemaPaths(currentSchema["_def"].left, path, matchesPath, paths);
		collectMatchingSchemaPaths(currentSchema["_def"].right, path, matchesPath, paths);
	}
	return paths;
}
function isUnwrappable(object) {
	return !!object && typeof object === "object" && "unwrap" in object && typeof object.unwrap === "function" && !(object instanceof ZodArray);
}
function mapSensitivePaths(schema, path, hints) {
	let next = { ...hints };
	let currentSchema = schema;
	let isSensitive = sensitive.has(currentSchema);
	while (isUnwrappable(currentSchema)) {
		currentSchema = currentSchema.unwrap();
		isSensitive ||= sensitive.has(currentSchema);
	}
	if (isSensitive) next[path] = {
		...next[path],
		sensitive: true
	};
	else if (isSensitiveConfigPath(path) && !next[path]?.sensitive) getLog().debug(`possibly sensitive key found: (${path})`);
	if (currentSchema instanceof ZodObject) {
		const shape = currentSchema.shape;
		for (const key in shape) {
			const nextPath = path ? `${path}.${key}` : key;
			next = mapSensitivePaths(shape[key], nextPath, next);
		}
		const catchallSchema = currentSchema["_def"].catchall;
		if (catchallSchema && !(catchallSchema instanceof ZodNever)) next = mapSensitivePaths(catchallSchema, path ? `${path}.*` : "*", next);
	} else if (currentSchema instanceof ZodArray) {
		const nextPath = path ? `${path}[]` : "[]";
		next = mapSensitivePaths(currentSchema.element, nextPath, next);
	} else if (currentSchema instanceof ZodRecord) {
		const nextPath = path ? `${path}.*` : "*";
		next = mapSensitivePaths(currentSchema["_def"].valueType, nextPath, next);
	} else if (currentSchema instanceof ZodUnion || currentSchema instanceof ZodDiscriminatedUnion) for (const option of currentSchema.options) next = mapSensitivePaths(option, path, next);
	else if (currentSchema instanceof ZodIntersection) {
		next = mapSensitivePaths(currentSchema["_def"].left, path, next);
		next = mapSensitivePaths(currentSchema["_def"].right, path, next);
	}
	return next;
}
//#endregion
//#region src/config/schema.shared.ts
function cloneSchema(value) {
	return structuredClone(value);
}
function asSchemaObject(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value;
}
function schemaHasChildren(schema) {
	if (schema.properties && Object.keys(schema.properties).length > 0) return true;
	if (schema.additionalProperties && typeof schema.additionalProperties === "object") return true;
	if (Array.isArray(schema.items)) return schema.items.some((entry) => typeof entry === "object" && entry !== null);
	for (const branch of [
		schema.oneOf,
		schema.anyOf,
		schema.allOf
	]) if (branch?.some((entry) => entry && typeof entry === "object" && schemaHasChildren(entry))) return true;
	return Boolean(schema.items && typeof schema.items === "object");
}
function findWildcardHintMatch(params) {
	const targetParts = params.splitPath(params.path);
	let bestMatch;
	for (const [hintPath, hint] of Object.entries(params.uiHints)) {
		const hintParts = params.splitPath(hintPath);
		if (hintParts.length !== targetParts.length) continue;
		let wildcardCount = 0;
		let matches = true;
		for (let index = 0; index < hintParts.length; index += 1) {
			const hintPart = hintParts[index];
			if (hintPart === targetParts[index]) continue;
			if (hintPart === "*") {
				wildcardCount += 1;
				continue;
			}
			matches = false;
			break;
		}
		if (!matches) continue;
		if (!bestMatch || wildcardCount < bestMatch.wildcardCount) bestMatch = {
			path: hintPath,
			hint,
			wildcardCount
		};
	}
	return bestMatch ? {
		path: bestMatch.path,
		hint: bestMatch.hint
	} : null;
}
//#endregion
//#region src/config/schema-base.ts
const LEGACY_HIDDEN_PUBLIC_PATHS = ["canvasHost", "hooks.internal.handlers"];
const asJsonSchemaObject$1 = (value) => asSchemaObject(value);
function buildFieldDocumentation() {
	const titles = {};
	for (const [key, value] of Object.entries(FIELD_LABELS)) if (value) titles[key] = value;
	const descriptions = {};
	for (const [key, value] of Object.entries(FIELD_HELP)) if (value) descriptions[key] = value;
	return {
		titles,
		descriptions
	};
}
/**
* Recursively walk a JSON Schema object and apply field docs using dot-path
* matching. Existing titles/descriptions (for example from Zod metadata) are
* preserved.
*/
function applyFieldDocumentation(node, documentation, prefixes = [""]) {
	const props = node.properties;
	if (props) for (const [key, child] of Object.entries(props)) {
		const childObj = asJsonSchemaObject$1(child);
		if (!childObj) continue;
		const childPrefixes = prefixes.map((prefix) => prefix ? `${prefix}.${key}` : key);
		applyNodeDocumentation(childObj, documentation, childPrefixes);
		applyFieldDocumentation(childObj, documentation, childPrefixes);
	}
	if (node.additionalProperties && typeof node.additionalProperties === "object") {
		const addObj = asJsonSchemaObject$1(node.additionalProperties);
		if (addObj) {
			const wildcardPrefixes = prefixes.map((prefix) => prefix ? `${prefix}.*` : "*");
			applyNodeDocumentation(addObj, documentation, wildcardPrefixes);
			applyFieldDocumentation(addObj, documentation, wildcardPrefixes);
		}
	}
	if (node.items) {
		const itemsObj = asJsonSchemaObject$1(node.items);
		if (itemsObj) {
			const itemPrefixes = Array.from(new Set(prefixes.flatMap((prefix) => {
				const arrayPath = prefix ? `${prefix}[]` : "[]";
				const wildcardAlias = prefix ? `${prefix}.*` : "*";
				return wildcardAlias === arrayPath ? [arrayPath] : [wildcardAlias, arrayPath];
			})));
			applyNodeDocumentation(itemsObj, documentation, itemPrefixes);
			applyFieldDocumentation(itemsObj, documentation, itemPrefixes);
		}
	}
	for (const keyword of [
		"anyOf",
		"oneOf",
		"allOf"
	]) {
		const branches = node[keyword];
		if (Array.isArray(branches)) for (const branch of branches) {
			const branchObj = asJsonSchemaObject$1(branch);
			if (branchObj) applyFieldDocumentation(branchObj, documentation, prefixes);
		}
	}
}
function applyNodeDocumentation(node, documentation, pathCandidates) {
	if (!node.title) for (const path of pathCandidates) {
		const title = documentation.titles[path];
		if (title) {
			node.title = title;
			break;
		}
	}
	if (!node.description) for (const path of pathCandidates) {
		const description = documentation.descriptions[path];
		if (description) {
			node.description = description;
			break;
		}
	}
}
function stripChannelSchema(schema) {
	const next = cloneSchema(schema);
	const root = asJsonSchemaObject$1(next);
	if (!root || !root.properties) return next;
	delete root.properties.$schema;
	if (Array.isArray(root.required)) root.required = root.required.filter((key) => key !== "$schema");
	const channelsNode = asJsonSchemaObject$1(root.properties.channels);
	if (channelsNode) {
		channelsNode.properties = {};
		channelsNode.required = [];
		channelsNode.additionalProperties = true;
	}
	return next;
}
function stripObjectPropertyPath(schema, path) {
	const root = asJsonSchemaObject$1(schema);
	if (!root || path.length === 0) return;
	let current = root;
	for (const segment of path.slice(0, -1)) {
		current = asJsonSchemaObject$1(current?.properties?.[segment]);
		if (!current) return;
	}
	const key = path[path.length - 1];
	if (!current?.properties || !key) return;
	delete current.properties[key];
	if (Array.isArray(current.required)) current.required = current.required.filter((entry) => entry !== key);
}
function stripLegacyCompatSchemaPaths(schema) {
	const next = cloneSchema(schema);
	for (const path of LEGACY_HIDDEN_PUBLIC_PATHS) stripObjectPropertyPath(next, path.split("."));
	return next;
}
function stripLegacyCompatHints(hints) {
	const next = { ...hints };
	for (const path of LEGACY_HIDDEN_PUBLIC_PATHS) for (const key of Object.keys(next)) if (key === path || key.startsWith(`${path}.`) || key.startsWith(`${path}[`)) delete next[key];
	return next;
}
let baseConfigSchemaStablePayload = null;
function computeBaseConfigSchemaStablePayload() {
	if (baseConfigSchemaStablePayload) return {
		schema: cloneSchema(baseConfigSchemaStablePayload.schema),
		uiHints: cloneSchema(baseConfigSchemaStablePayload.uiHints),
		version: baseConfigSchemaStablePayload.version
	};
	const schema = OpenClawSchema.toJSONSchema({
		target: "draft-07",
		unrepresentable: "any"
	});
	schema.title = "OpenClawConfig";
	const schemaRoot = asJsonSchemaObject$1(schema);
	if (schemaRoot) applyFieldDocumentation(schemaRoot, buildFieldDocumentation());
	const baseHints = mapSensitivePaths(OpenClawSchema, "", buildBaseHints());
	const sensitiveUrlPaths = collectMatchingSchemaPaths(OpenClawSchema, "", isSensitiveUrlConfigPath);
	const stablePayload = {
		schema: stripLegacyCompatSchemaPaths(stripChannelSchema(schema)),
		uiHints: stripLegacyCompatHints(applyDerivedTags(applySensitiveUrlHints(baseHints, sensitiveUrlPaths))),
		version: VERSION
	};
	baseConfigSchemaStablePayload = stablePayload;
	return {
		schema: cloneSchema(stablePayload.schema),
		uiHints: cloneSchema(stablePayload.uiHints),
		version: stablePayload.version
	};
}
function computeBaseConfigSchemaResponse(params) {
	const stablePayload = computeBaseConfigSchemaStablePayload();
	return {
		schema: stablePayload.schema,
		uiHints: stablePayload.uiHints,
		version: stablePayload.version,
		generatedAt: params?.generatedAt ?? (/* @__PURE__ */ new Date()).toISOString()
	};
}
//#endregion
//#region src/config/schema.ts
const asJsonSchemaObject = (value) => asSchemaObject(value);
const FORBIDDEN_LOOKUP_SEGMENTS = new Set([
	"__proto__",
	"prototype",
	"constructor"
]);
const LOOKUP_SCHEMA_STRING_KEYS = new Set([
	"$id",
	"$schema",
	"title",
	"description",
	"format",
	"pattern",
	"contentEncoding",
	"contentMediaType"
]);
const LOOKUP_SCHEMA_NUMBER_KEYS = new Set([
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"minLength",
	"maxLength",
	"minItems",
	"maxItems",
	"minProperties",
	"maxProperties"
]);
const LOOKUP_SCHEMA_BOOLEAN_KEYS = new Set([
	"additionalProperties",
	"uniqueItems",
	"deprecated",
	"readOnly",
	"writeOnly"
]);
const MAX_LOOKUP_PATH_SEGMENTS = 32;
const LOOKUP_SCHEMA_COMPOSITION_KEYS = [
	"anyOf",
	"oneOf",
	"allOf"
];
const LOOKUP_SCHEMA_NESTED_FORM_DEPTH = 4;
function isObjectSchema(schema) {
	const type = schema.type;
	if (type === "object") return true;
	if (Array.isArray(type) && type.includes("object")) return true;
	return Boolean(schema.properties || schema.additionalProperties);
}
function mergeObjectSchema(base, extension) {
	const mergedRequired = new Set([...base.required ?? [], ...extension.required ?? []]);
	const merged = {
		...base,
		...extension,
		properties: {
			...base.properties,
			...extension.properties
		}
	};
	if (mergedRequired.size > 0) merged.required = Array.from(mergedRequired);
	const additional = extension.additionalProperties ?? base.additionalProperties;
	if (additional !== void 0) merged.additionalProperties = additional;
	return merged;
}
const EXTENSION_SCHEMA_MAX_BYTES = 256 * 1024;
const EXTENSION_SCHEMA_TOTAL_MAX_BYTES = 2 * 1024 * 1024;
const EXTENSION_SCHEMA_MAX_ITEMS = 256;
function schemaJsonBytes(schema) {
	try {
		return Buffer.byteLength(JSON.stringify(schema), "utf-8");
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}
function buildOmittedExtensionConfigSchema(kind, id) {
	return {
		type: "object",
		additionalProperties: true,
		description: `${kind} config schema for ${id} was omitted from the full config.schema response because installed extension schemas exceeded the Gateway response budget.`
	};
}
function limitExtensionSchemas(params) {
	let totalBytes = 0;
	let includedItems = 0;
	const keepSchema = (schema) => {
		const bytes = schemaJsonBytes(schema);
		if (!Number.isFinite(bytes) || bytes > EXTENSION_SCHEMA_MAX_BYTES || totalBytes + bytes > EXTENSION_SCHEMA_TOTAL_MAX_BYTES || includedItems >= EXTENSION_SCHEMA_MAX_ITEMS) return false;
		totalBytes += bytes;
		includedItems += 1;
		return true;
	};
	return {
		plugins: params.plugins.map((plugin) => {
			if (!plugin.configSchema || keepSchema(plugin.configSchema)) return plugin;
			return {
				...plugin,
				configSchema: buildOmittedExtensionConfigSchema("plugin", plugin.id)
			};
		}),
		channels: params.channels.map((channel) => {
			if (!channel.configSchema || keepSchema(channel.configSchema)) return channel;
			return {
				...channel,
				configSchema: buildOmittedExtensionConfigSchema("channel", channel.id)
			};
		})
	};
}
function collectExtensionHintKeys(hints, plugins, channels) {
	const keys = /* @__PURE__ */ new Set();
	const collectPrefixedHintKeys = (prefix) => {
		for (const key of Object.keys(hints)) if (key === prefix || key.startsWith(`${prefix}.`)) keys.add(key);
	};
	const collectSchemaKeys = (schema, basePath) => {
		const node = asJsonSchemaObject(schema);
		if (!node) return;
		keys.add(basePath);
		for (const [propertyKey, propertySchema] of Object.entries(node.properties ?? {})) collectSchemaKeys(propertySchema, `${basePath}.${propertyKey}`);
		if (node.additionalProperties && typeof node.additionalProperties === "object") collectSchemaKeys(node.additionalProperties, `${basePath}.*`);
		if (Array.isArray(node.items)) {
			for (const item of node.items) if (item && typeof item === "object") collectSchemaKeys(item, `${basePath}[]`);
			return;
		}
		if (node.items && typeof node.items === "object") collectSchemaKeys(node.items, `${basePath}[]`);
	};
	for (const plugin of plugins) {
		const id = plugin.id.trim();
		if (!id) continue;
		const prefix = `plugins.entries.${id}`;
		collectPrefixedHintKeys(prefix);
		collectSchemaKeys(plugin.configSchema, `${prefix}.config`);
	}
	for (const channel of channels) {
		const id = channel.id.trim();
		if (!id) continue;
		const prefix = `channels.${id}`;
		collectPrefixedHintKeys(prefix);
		collectSchemaKeys(channel.configSchema, prefix);
	}
	return keys;
}
function applyPluginHints(hints, plugins) {
	const next = { ...hints };
	for (const plugin of plugins) {
		const id = plugin.id.trim();
		if (!id) continue;
		const name = (plugin.name ?? id).trim() || id;
		const basePath = `plugins.entries.${id}`;
		next[basePath] = {
			...next[basePath],
			label: name,
			help: plugin.description ? `${plugin.description} (plugin: ${id})` : `Plugin entry for ${id}.`
		};
		next[`${basePath}.enabled`] = {
			...next[`${basePath}.enabled`],
			label: `Enable ${name}`
		};
		next[`${basePath}.config`] = {
			...next[`${basePath}.config`],
			label: `${name} Config`,
			help: `Plugin-defined config payload for ${id}.`
		};
		const uiHints = plugin.configUiHints ?? {};
		for (const [relPathRaw, hint] of Object.entries(uiHints)) {
			const relPath = relPathRaw.trim().replace(/^\./, "");
			if (!relPath) continue;
			const key = `${basePath}.config.${relPath}`;
			next[key] = {
				...next[key],
				...hint
			};
		}
	}
	return next;
}
function applyChannelHints(hints, channels) {
	const next = { ...hints };
	for (const channel of channels) {
		const id = channel.id.trim();
		if (!id) continue;
		const basePath = `channels.${id}`;
		const current = next[basePath] ?? {};
		const label = channel.label?.trim();
		const help = channel.description?.trim();
		next[basePath] = {
			...current,
			...label ? { label } : {},
			...help ? { help } : {}
		};
		const uiHints = channel.configUiHints ?? {};
		for (const [relPathRaw, hint] of Object.entries(uiHints)) {
			const relPath = relPathRaw.trim().replace(/^\./, "");
			if (!relPath) continue;
			const key = `${basePath}.${relPath}`;
			next[key] = {
				...next[key],
				...hint
			};
		}
	}
	return next;
}
function listHeartbeatTargetChannels(channels) {
	const seen = /* @__PURE__ */ new Set();
	const ordered = [];
	for (const channel of channels) {
		const normalized = normalizeLowercaseStringOrEmpty(channel.id);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		ordered.push(normalized);
	}
	return ordered;
}
function applyHeartbeatTargetHints(hints, channels) {
	const next = { ...hints };
	const channelList = listHeartbeatTargetChannels(channels);
	const help = `Delivery target ("last", "none", or a channel id).${channelList.length ? ` Known channels: ${channelList.join(", ")}.` : ""}`;
	for (const path of ["agents.defaults.heartbeat.target", "agents.list.*.heartbeat.target"]) {
		const current = next[path] ?? {};
		next[path] = {
			...current,
			help: current.help ?? help,
			placeholder: current.placeholder ?? "last"
		};
	}
	return next;
}
function applyPluginSchemas(schema, plugins) {
	const next = cloneSchema(schema);
	const entriesNode = asJsonSchemaObject(asJsonSchemaObject(asJsonSchemaObject(next)?.properties?.plugins)?.properties?.entries);
	if (!entriesNode) return next;
	const entryBase = asJsonSchemaObject(entriesNode.additionalProperties);
	const entryProperties = entriesNode.properties ?? {};
	entriesNode.properties = entryProperties;
	for (const plugin of plugins) {
		if (!plugin.configSchema) continue;
		const entryObject = asJsonSchemaObject(entryBase ? cloneSchema(entryBase) : { type: "object" }) ?? { type: "object" };
		const baseConfigSchema = asJsonSchemaObject(entryObject.properties?.config);
		const pluginSchema = asJsonSchemaObject(plugin.configSchema);
		const nextConfigSchema = baseConfigSchema && pluginSchema && isObjectSchema(baseConfigSchema) && isObjectSchema(pluginSchema) ? mergeObjectSchema(baseConfigSchema, pluginSchema) : cloneSchema(plugin.configSchema);
		entryObject.properties = {
			...entryObject.properties,
			config: nextConfigSchema
		};
		entryProperties[plugin.id] = entryObject;
	}
	return next;
}
function applyChannelSchemas(schema, channels) {
	const next = cloneSchema(schema);
	const channelsNode = asJsonSchemaObject(asJsonSchemaObject(next)?.properties?.channels);
	if (!channelsNode) return next;
	const channelProps = channelsNode.properties ?? {};
	channelsNode.properties = channelProps;
	for (const channel of channels) {
		if (!channel.configSchema) continue;
		const existing = asJsonSchemaObject(channelProps[channel.id]);
		const incoming = asJsonSchemaObject(channel.configSchema);
		if (existing && incoming && isObjectSchema(existing) && isObjectSchema(incoming)) channelProps[channel.id] = mergeObjectSchema(existing, incoming);
		else channelProps[channel.id] = cloneSchema(channel.configSchema);
	}
	return next;
}
let cachedBase = null;
const mergedSchemaCache = /* @__PURE__ */ new Map();
const MERGED_SCHEMA_CACHE_MAX = 64;
function buildMergedSchemaCacheKey(params) {
	const plugins = params.plugins.map((plugin) => ({
		id: plugin.id,
		name: plugin.name,
		description: plugin.description,
		configSchema: plugin.configSchema ?? null,
		configUiHints: plugin.configUiHints ?? null
	})).toSorted((a, b) => a.id.localeCompare(b.id));
	const channels = params.channels.map((channel) => ({
		id: channel.id,
		label: channel.label,
		description: channel.description,
		configSchema: channel.configSchema ?? null,
		configUiHints: channel.configUiHints ?? null
	})).toSorted((a, b) => a.id.localeCompare(b.id));
	const hash = crypto.createHash("sha256");
	hash.update("{\"plugins\":[");
	plugins.forEach((plugin, index) => {
		if (index > 0) hash.update(",");
		hash.update(JSON.stringify(plugin));
	});
	hash.update("],\"channels\":[");
	channels.forEach((channel, index) => {
		if (index > 0) hash.update(",");
		hash.update(JSON.stringify(channel));
	});
	hash.update("]}");
	return hash.digest("hex");
}
function setMergedSchemaCache(key, value) {
	if (mergedSchemaCache.size >= MERGED_SCHEMA_CACHE_MAX) {
		const oldest = mergedSchemaCache.keys().next();
		if (!oldest.done) mergedSchemaCache.delete(oldest.value);
	}
	mergedSchemaCache.set(key, value);
}
function getBundledChannelSchemaMetadata() {
	return GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.map((entry) => {
		const metadata = Object.assign({ id: entry.channelId }, entry.label ? { label: entry.label } : {}, entry.description ? { description: entry.description } : {}, { configSchema: entry.schema });
		if ("uiHints" in entry) metadata.configUiHints = entry.uiHints;
		return metadata;
	});
}
function buildBaseConfigSchema() {
	if (cachedBase) return cachedBase;
	const generated = computeBaseConfigSchemaResponse();
	const bundledChannels = getBundledChannelSchemaMetadata();
	const mergedWithoutSensitiveHints = applyHeartbeatTargetHints(applyChannelHints(generated.uiHints, bundledChannels), bundledChannels);
	const mergedHints = applyDerivedTags(applySensitiveHints(mergedWithoutSensitiveHints, collectExtensionHintKeys(mergedWithoutSensitiveHints, [], bundledChannels)));
	const next = {
		...generated,
		schema: applyChannelSchemas(generated.schema, bundledChannels),
		uiHints: mergedHints
	};
	cachedBase = next;
	return next;
}
function buildConfigSchema(params) {
	const base = buildBaseConfigSchema();
	const { plugins, channels } = limitExtensionSchemas({
		plugins: params?.plugins ?? [],
		channels: params?.channels ?? []
	});
	if (plugins.length === 0 && channels.length === 0) return base;
	const cacheKey = params?.cache !== false ? buildMergedSchemaCacheKey({
		plugins,
		channels
	}) : null;
	if (cacheKey) {
		const cached = mergedSchemaCache.get(cacheKey);
		if (cached) return cached;
	}
	const mergedWithoutSensitiveHints = applyHeartbeatTargetHints(applyChannelHints(applyPluginHints(base.uiHints, plugins), channels), channels);
	const extensionHintKeys = collectExtensionHintKeys(mergedWithoutSensitiveHints, plugins, channels);
	const mergedHints = applyDerivedTags(applySensitiveUrlHints(applySensitiveHints(mergedWithoutSensitiveHints, extensionHintKeys), extensionHintKeys));
	const mergedSchema = applyChannelSchemas(applyPluginSchemas(base.schema, plugins), channels);
	const merged = {
		...base,
		schema: mergedSchema,
		uiHints: mergedHints
	};
	if (cacheKey) setMergedSchemaCache(cacheKey, merged);
	return merged;
}
function normalizeLookupPath(path) {
	return path.trim().replace(/\[(\*|\d*)\]/g, (_match, segment) => `.${segment || "*"}`).replace(/^\.+|\.+$/g, "").replace(/\.+/g, ".");
}
function splitLookupPath(path) {
	const normalized = normalizeLookupPath(path);
	return normalized ? normalized.split(".").filter(Boolean) : [];
}
function resolveUiHintMatch(uiHints, path) {
	return findWildcardHintMatch({
		uiHints,
		path,
		splitPath: splitLookupPath
	});
}
function resolveItemsSchema(schema, index) {
	if (Array.isArray(schema.items)) {
		const entry = index === void 0 ? schema.items.find((candidate) => typeof candidate === "object" && candidate !== null) : schema.items[index];
		return entry && typeof entry === "object" ? entry : null;
	}
	return schema.items && typeof schema.items === "object" ? schema.items : null;
}
function resolveLookupChildSchema(schema, segment) {
	if (FORBIDDEN_LOOKUP_SEGMENTS.has(segment)) return null;
	const properties = schema.properties;
	if (properties && Object.hasOwn(properties, segment)) return asJsonSchemaObject(properties[segment]);
	const itemIndex = /^\d+$/.test(segment) ? Number.parseInt(segment, 10) : void 0;
	const items = resolveItemsSchema(schema, itemIndex);
	if ((segment === "*" || itemIndex !== void 0) && items) return items;
	if (schema.additionalProperties && typeof schema.additionalProperties === "object") return schema.additionalProperties;
	return null;
}
function stripSchemaForLookup(schema, nestedFormDepth = 0) {
	const next = {};
	for (const [key, value] of Object.entries(schema)) {
		if (LOOKUP_SCHEMA_STRING_KEYS.has(key) && typeof value === "string") {
			next[key] = value;
			continue;
		}
		if (LOOKUP_SCHEMA_NUMBER_KEYS.has(key) && typeof value === "number") {
			next[key] = value;
			continue;
		}
		if (LOOKUP_SCHEMA_BOOLEAN_KEYS.has(key) && typeof value === "boolean") {
			next[key] = value;
			continue;
		}
		if (key === "type") {
			if (typeof value === "string") next[key] = value;
			else if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) next[key] = [...value];
			continue;
		}
		if (key === "enum" && Array.isArray(value)) {
			const entries = value.filter((entry) => entry === null || typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean");
			if (entries.length === value.length) next[key] = [...entries];
			continue;
		}
		if (key === "const" && (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")) next[key] = value;
	}
	if (schema.properties && (nestedFormDepth > 0 && nestedFormDepth <= LOOKUP_SCHEMA_NESTED_FORM_DEPTH || schema.additionalProperties && typeof schema.additionalProperties === "object")) next.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, child]) => [key, stripSchemaForLookup(child, nestedFormDepth + 1)]));
	if (schema.additionalProperties && typeof schema.additionalProperties === "object") next.additionalProperties = stripSchemaForLookup(schema.additionalProperties, nestedFormDepth + 1);
	if (Array.isArray(schema.items)) next.items = schema.items.map((item) => stripSchemaForLookup(item, nestedFormDepth + 1));
	else if (schema.items && typeof schema.items === "object") next.items = stripSchemaForLookup(schema.items, nestedFormDepth + 1);
	if (nestedFormDepth <= LOOKUP_SCHEMA_NESTED_FORM_DEPTH) for (const key of LOOKUP_SCHEMA_COMPOSITION_KEYS) {
		const variants = schema[key];
		if (!Array.isArray(variants)) continue;
		next[key] = variants.filter((variant) => variant && typeof variant === "object").map((variant) => stripSchemaForLookup(variant, nestedFormDepth + 1));
	}
	return next;
}
function buildLookupChildren(schema, path, uiHints, resolveReloadMetadata) {
	const children = [];
	const required = new Set(schema.required ?? []);
	const pushChild = (key, childSchema, isRequired) => {
		const childPath = path ? `${path}.${key}` : key;
		const resolvedHint = resolveUiHintMatch(uiHints, childPath);
		const reloadMetadata = resolveReloadMetadata?.(childPath);
		children.push({
			key,
			path: childPath,
			type: childSchema.type,
			required: isRequired,
			hasChildren: schemaHasChildren(childSchema),
			reloadKind: reloadMetadata?.kind,
			hint: resolvedHint?.hint,
			hintPath: resolvedHint?.path
		});
	};
	for (const [key, childSchema] of Object.entries(schema.properties ?? {})) pushChild(key, childSchema, required.has(key));
	const wildcardSchema = (schema.additionalProperties && typeof schema.additionalProperties === "object" && !Array.isArray(schema.additionalProperties) ? schema.additionalProperties : null) ?? resolveItemsSchema(schema);
	if (wildcardSchema) pushChild("*", wildcardSchema, false);
	return children;
}
function lookupConfigSchema(response, path, resolveReloadMetadata) {
	const wantsRoot = path.trim() === ".";
	const normalizedPath = normalizeLookupPath(path);
	if (!normalizedPath && !wantsRoot) return null;
	const parts = splitLookupPath(normalizedPath);
	if (!wantsRoot && parts.length === 0 || parts.length > MAX_LOOKUP_PATH_SEGMENTS) return null;
	let current = asJsonSchemaObject(response.schema);
	if (!current) return null;
	for (const segment of parts) {
		const next = resolveLookupChildSchema(current, segment);
		if (!next) return null;
		current = next;
	}
	const resolvedHint = resolveUiHintMatch(response.uiHints, normalizedPath);
	const reloadMetadata = resolveReloadMetadata?.(normalizedPath);
	return {
		path: wantsRoot ? "." : normalizedPath,
		schema: stripSchemaForLookup(current),
		reloadKind: reloadMetadata?.kind,
		hint: resolvedHint?.hint,
		hintPath: resolvedHint?.path,
		children: buildLookupChildren(current, wantsRoot ? "" : normalizedPath, response.uiHints, resolveReloadMetadata)
	};
}
//#endregion
//#region src/config/runtime-schema.ts
function loadManifestRegistry(config, env) {
	const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
	const currentSnapshot = getCurrentPluginMetadataSnapshot({
		config,
		env,
		workspaceDir
	});
	if (currentSnapshot) return currentSnapshot.manifestRegistry;
	return loadPluginMetadataSnapshot({
		config,
		env: env ?? process.env,
		workspaceDir
	}).manifestRegistry;
}
function loadGatewayRuntimeConfigSchema() {
	const registry = loadManifestRegistry(getRuntimeConfig());
	return buildConfigSchema({
		plugins: collectPluginSchemaMetadata(registry),
		channels: collectChannelSchemaMetadata(registry)
	});
}
async function readBestEffortRuntimeConfigSchema() {
	const snapshot = await readConfigFileSnapshot();
	const registry = loadManifestRegistry(snapshot.valid ? snapshot.config : { plugins: { enabled: true } });
	return buildConfigSchema({
		plugins: snapshot.valid ? collectPluginSchemaMetadata(registry) : [],
		channels: collectChannelSchemaMetadata(registry)
	});
}
//#endregion
export { readBestEffortRuntimeConfigSchema as n, lookupConfigSchema as r, loadGatewayRuntimeConfigSchema as t };
