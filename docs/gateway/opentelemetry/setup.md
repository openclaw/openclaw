---
summary: "Install and enable diagnostics-otel, see which processes export, check exporter health, and turn export off"
title: "Set up OpenTelemetry export"
sidebarTitle: "Setup"
read_when:
  - You want to send OpenClaw model usage, message flow, or session metrics to an OpenTelemetry collector
  - You need to know whether a Gateway run, a one-shot local run, or `openclaw agent exec` exports telemetry
  - You are checking exporter health, or turning the export pipeline off
---

## Quick start

```bash
openclaw plugins install clawhub:@openclaw/diagnostics-otel
```

```json5
{
  plugins: {
    allow: ["diagnostics-otel"],
    entries: {
      "diagnostics-otel": { enabled: true },
    },
  },
  diagnostics: {
    enabled: true,
    otel: {
      enabled: true,
      endpoint: "http://otel-collector:4318",
      protocol: "http/protobuf",
      serviceName: "openclaw-gateway",
      traces: true,
      metrics: true,
      logs: true,
      sampleRate: 0.2,
      flushIntervalMs: 60000,
    },
  },
}
```

Or enable the plugin from the CLI: `openclaw plugins enable diagnostics-otel`.

With the plugin loaded, changes to `diagnostics.otel` hot-reload only its exporter
service. The previous generation unsubscribes and flushes before the replacement
starts with the new endpoint, headers, sampling, and signal settings. Other plugin
services, channels, and Gateway connections stay running. A cleanup or startup
failure requests Gateway recovery instead of leaving a partially replaced exporter.

`diagnostics.enabled` also hot-applies to the shared dispatcher and its heartbeat.
The Gateway owns that process-wide heartbeat; stopping a channel leaves it running.
Standalone hosts using the plugin SDK own `startDiagnosticHeartbeat` and
`stopDiagnosticHeartbeat` for their process, rather than each channel owning them.
Disabling it stops diagnostic sampling and recovery listeners; enabling it starts
them again. Preloaded OpenTelemetry SDKs keep ownership of their providers and
transport: these changes do not shut down or reconfigure the host SDK.

<Note>
`diagnostics.otel.protocol` accepts only `http/protobuf`. If a persisted config,
including a value supplied through `${VAR}` interpolation, still resolves this
field to the retired `grpc` value, run
[`openclaw doctor --fix`](/cli/doctor). Doctor repairs directly authored values
and the deepest internal single-file include that solely owns the changed
`diagnostics.otel` keys, including an unambiguous nested include chain. For root
includes, actual array-entry includes, include arrays, sibling overrides,
same-path or ancestor merges, changes spanning ownership boundaries, external
include targets, an owning file that still authors a nested `$include`
directive, or another ambiguous source, Doctor leaves the files unchanged and
lists the candidate source file or files to edit manually. When the same run
also needs a root-owned repair, such as a legacy agent roster, Doctor refuses
that write; the refused write leaves every file unchanged (earlier writes in the
same run stay saved), and Doctor names the boundary to repair by hand before
rerunning, plus the included file or files when the root file authors that
boundary's `$include` (an agent-roster boundary is named without its file).

When `diagnostics.otel.protocol` is unset, each plugin-owned OTLP signal first
checks its nonblank `OTEL_EXPORTER_OTLP_*_PROTOCOL` value, then
`OTEL_EXPORTER_OTLP_PROTOCOL`, then defaults to `http/protobuf`. Doctor does not
rewrite process environment variables. An unsupported value disables only that
plugin-owned OTLP signal; supported sibling signals continue, as does the stdout
branch of `logsExporter: "both"`. Preloaded trace and metric SDKs own their own
transport selection and are not rejected by this plugin.
</Note>

## Which processes export

- **Gateway** starts the exporter at startup and exports from the Gateway
  process for every run it executes, including `openclaw agent` turns
  dispatched to it.
- **One-shot local runs** (`openclaw agent --local`) execute in the CLI
  process. When OTel export is configured and
  the plugin is enabled, that same CLI process starts one exporter instance for
  the run and flushes buffered spans, metrics, and logs before the process exits.
  The CLI waits at most 5 seconds for the diagnostic-event queue to drain and 10
  more for the flush, so an unreachable collector cannot hold the command open.
  A collector that accepts the connection but never answers can still delay exit
  until the exporter's own request timeout (`OTEL_EXPORTER_OTLP_TIMEOUT`).
  Plugin registration resources remain open until exporter cleanup finishes,
  even when either wait times out.
  In JSON output mode, these one-shot runs suppress only the stdout JSONL log
  sink so command stdout stays reserved for the JSON response; OTLP traces,
  metrics, and logs continue when configured.
- `openclaw agent exec` also runs the agent embedded in the CLI process, but
  does not yet start this exporter, so its runs export no telemetry. Dispatch
  through the Gateway, or use `openclaw agent --local`, when you need traces
  from a headless run.

## Exporter health

`openclaw doctor` and `openclaw status --all` show a bounded, redacted snapshot
of the running Gateway's latest trusted exporter state for each signal and
transport. For `diagnostics-otel`, the snapshot distinguishes:

- OTLP/HTTP protobuf with an endpoint supplied by config or an `OTEL_*`
  environment fallback.
- OTLP/HTTP protobuf using the exporter dependency's default endpoint because
  no endpoint was supplied.
- Stdout log export.
- Trace or metric export owned by an externally preloaded OpenTelemetry SDK.

OTLP export failure and recovery transitions are recorded from the exporter's
final result callback, after dependency-owned retries finish. A retryable
response that later succeeds is therefore not reported as a failure. Startup,
log preparation or emit, export, and shutdown failures use fixed reason
categories rather than raw errors.

The snapshot never includes endpoint values, headers, certificates, payloads,
or raw error messages. Transport is retained only in this local health
projection. It is not added to the existing
`openclaw.telemetry.exporter.events` metric attributes, and existing Prometheus
label sets are unchanged.

## Without an exporter

Keep diagnostics events available to plugins or custom sinks without running
`diagnostics-otel`:

```json5
{
  diagnostics: { enabled: true },
}
```

For targeted debug output without raising `logging.level`, use diagnostics
flags. Flags are case-insensitive and support wildcards (`telegram.*` or
`*`):

```json5
{
  diagnostics: { flags: ["telegram.http"] },
}
```

Or as a one-off env override:

```bash
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload openclaw gateway
```

Flag output goes to the standard log file (`logging.file`) and is still
redacted by the always-on log redaction policy. Full guide:
[Diagnostics flags](/diagnostics/flags).

## Disable

```json5
{
  diagnostics: { otel: { enabled: false } },
}
```

Or leave `diagnostics-otel` out of `plugins.allow`, or run
`openclaw plugins disable diagnostics-otel`.

When the plugin would otherwise own NodeSDK, keep propagation available while
disabling every plugin-owned exporter, listener, health route, and stdout sink:

```bash
OTEL_SDK_DISABLED=true openclaw gateway
```
