# @openclaw/tokenomics

Local-first LLM spend accounting for OpenClaw.

**Requires Node.js ≥ 20** (the plugin uses `import` attributes and stable ESM
that ships with the OpenClaw Gateway). No external runtime dependencies.

This plugin does not maintain its own price list. It **consumes OpenClaw's own
per-call cost** (the `costUsd` on `model.usage` diagnostics, which OpenClaw
computes from its provider/model catalog) and adds the layer OpenClaw does not
have: a durable spend **ledger** plus a **report** — period and by-model
rollups, a free-vs-paid split, and an avoided-spend / counterfactual headline.

It is host-neutral and offline: nothing leaves the machine, and no pricing feed
is fetched at runtime. Cost precedence is: the host-reported `costUsd` is
authoritative; otherwise a free classification yields `$0`; otherwise an
optional local override catalog estimates it (unknown models stay `$0`, so cost
is never invented). The avoided-spend baseline is derived from observed spend by
default (the highest effective `$/Mtok` among paid models actually used), so no
separate price catalog is required.

## Install

```bash
openclaw plugins install @openclaw/tokenomics
```

Restart the Gateway after installing or updating the plugin.

## Enable

```bash
openclaw plugins enable tokenomics
```

## How it works

- A startup service subscribes to internal `model.usage` diagnostics and appends
  a row (`ts_utc`, `provider`, `model`, `tokens_in`, `tokens_out`, `cost_usd`) to
  `<stateDir>/tokenomics/ledger.jsonl`.
- Cost precedence: an explicit per-call `costUsd` from the host wins; otherwise a
  free classification yields `$0`; otherwise the optional pricing catalog
  (`<stateDir>/tokenomics/pricing.json`) estimates it. Unknown models stay `$0`
  so cost is never invented.

## Capturing streaming usage

This plugin can only record what `model.usage` reports. For **streaming**
responses, OpenClaw only asks the provider for a final usage chunk
(`stream_options: { include_usage: true }`) when the provider's
`compat.supportsUsageInStreaming` is true. OpenClaw auto-detects this as `false`
for some OpenAI-compatible providers at a **non-standard base URL** (for example
a self-hosted or custom enterprise provider). Such providers then return no token
usage on streamed calls, so `model.usage` carries no tokens and no cost — and the
call is **not** recorded.

If a provider's streamed calls are missing from the ledger, set that provider's
`compat.supportsUsageInStreaming: true` in your model config so OpenClaw requests
usage. The plugin logs a throttled warning when it sees `model.usage` events that
carry neither tokens nor cost, naming the affected `provider/model`, so this gap
is visible instead of silent. (Non-streaming calls always include usage and are
unaffected.)

## Configuration

The plugin requires no configuration keys. Once enabled, the service starts at
Gateway startup and begins recording spend. Behavior is shaped by two optional
inputs:

- the report query parameters (below), and
- an optional pricing catalog file (below).

There is nothing to set under `plugins.entries.tokenomics.config`.

## Spend report

A read-only report is exposed on the Gateway:

```
GET /api/diagnostics/tokenomics            # JSON report (last 30 days)
GET /api/diagnostics/tokenomics?format=text
GET /api/diagnostics/tokenomics?since=2026-06-01&until=2026-06-30&gran=day
```

Query parameters:

| Parameter | Values                         | Default                |
| --------- | ------------------------------ | ---------------------- |
| `since`   | RFC3339 or `YYYY-MM-DD`        | 30 days before `until` |
| `until`   | RFC3339 or `YYYY-MM-DD`        | now                    |
| `gran`    | `hour`, `day`, `week`, `month` | `day`                  |
| `format`  | `json`, `text`                 | `json`                 |
| `period`  | free-text label                | (empty)                |

A date-only `until` (for example `until=2026-06-30`) is treated as the inclusive
end of that UTC day. Unparseable `since`/`until` values, or a `since` that is
later than `until`, return `400 Bad Request`.

The `period` parameter supplies a human-readable window label (e.g.
`Q2 2026`, `this month`, `YTD 2026`) that appears in both JSON and text report
output.

Example `?format=text` output:

```
Tokenomics
2026-06-01 → 2026-06-30 (30d)

spent          $12.40  (5,200 calls, 8.10M tok)
avoided        $48.60  free tokens valued at baseline
counterfactual $61.00  all tokens @ frontier (... /Mtok)

free share     ████████████████░░░░░░░░ 67% free

model            calls     tokens        cost  tag
frontier           420       2.7M      $12.40  paid
local-8b          4780       5.4M       $0.00  free
```

## Optional override catalog

You normally need nothing here — cost comes from OpenClaw's own `costUsd` and the
baseline is derived from observed spend. For the rare case where the host does
not report a cost, or you want to pin an explicit baseline, drop a `pricing.json`
in `<stateDir>/tokenomics/`. Rates are `$ / 1M tokens`. The file is read at
startup and per report; it is never fetched or written by this plugin.

```json
{
  "baseline_model": "frontier",
  "baseline_usd_per_mtok": 15.0,
  "models": {
    "frontier": { "input_usd_per_mtok": 3.0, "output_usd_per_mtok": 15.0 },
    "local-8b": { "input_usd_per_mtok": 0.0, "output_usd_per_mtok": 0.0 }
  }
}
```

`baseline_usd_per_mtok` (when set) overrides the derived baseline. Model lookup
tolerates id vs display-name drift (exact, case-insensitive, then `host/leaf`
suffix match). Models absent from the catalog are charged `$0`, so cost is never
invented.

Because `pricing.json` can change the avoided-spend and counterfactual headline
figures, treat it as trusted input: store it under the Gateway state directory
with the same file permissions as the rest of that directory, and do not accept
it from untrusted sources.

**File permission requirements:** The plugin enforces that `pricing.json` must
not be group-writable or world-writable. On macOS/Linux the file must also be
owned by the same uid as the Gateway process. A file that fails these checks is
rejected (treated as absent, so cost is never invented) and a warning is logged.
The safe permission is `0o600` (owner read+write) or `0o400` (owner read-only).

Mode-bit and ownership checks are **POSIX-only** (macOS / Linux). On Windows
`stat.mode` does not reflect POSIX permissions; the plugin skips the mode
validation and relies on the OS-level ACL and the Gateway's own state-directory
protections.

## Design notes

- **Single-user, local-first storage.** The ledger is a per-machine append-only
  JSONL file and reads are synchronous. This keeps the plugin dependency-free and
  crash-tolerant for the single-operator workloads it targets. A SQLite-backed
  store with windowed reads is the intended path if a deployment outgrows it.
- **Tolerant reads.** A half-written or corrupt ledger line (for example from an
  interrupted append) is skipped rather than aborting the report; the count of
  skipped lines is logged as a warning.
- **Storage location.** The ledger lives at `<stateDir>/tokenomics/ledger.jsonl`
  inside the Gateway state directory. On a default install this is
  `~/.openclaw/state/tokenomics/ledger.jsonl`. The optional pricing catalog is
  `pricing.json` in the same directory.
- **Operational considerations.** The ledger grows unbounded — one JSON line per
  model call. At typical operator workloads this remains well under 50 MB/month.
  If the file grows large, you can truncate it (rename/remove the file while the
  Gateway is stopped); the plugin will start a new ledger on next startup. No
  built-in rotation is provided yet. Treat the ledger as a local audit log, not
  as a system of record — back it up if your workflow requires long-term
  retention.

## Roadmap

A subscription/plan layer (flat-rate and quota-based plans, with subscription
ROI vs metered-equivalent cost) is planned, to account for billing models that
per-token pricing cannot express.

## Package

- Plugin id: `tokenomics`
