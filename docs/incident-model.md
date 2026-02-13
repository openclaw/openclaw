# Gateway incident model

This document specifies the on-disk incident log used by the OpenClaw gateway.

## Files

- **Incident log (append-only):** `~/.openclaw/state/gateway-incidents.jsonl`
- **Incident summary state:** `~/.openclaw/state/gateway-incidents-state.json`

`OPENCLAW_STATE_DIR` overrides the base directory.

## JSONL entry schema

Each line in `gateway-incidents.jsonl` is a JSON object:

```ts
type GatewayIncidentKind = "start" | "signal" | "crash" | "recover";

type GatewayIncidentEntry = {
  ts: number; // epoch millis
  kind: GatewayIncidentKind;
  pid?: number;
  restartCount?: number;

  // kind=signal
  signal?: string;

  // kind=crash
  exitCode?: number | null;
  errorName?: string;
  errorMessage?: string;
  errorStack?: string;
  errorCode?: string;

  // kind=recover
  status?: "ok" | "error";
  detail?: string;
};
```

Notes:

- `errorMessage` / `errorStack` are tailed (size-limited) to reduce log bloat.
- The log is pruned opportunistically (size/line limits) to avoid unbounded growth.

## Summary state schema

`gateway-incidents-state.json` is a small JSON document used to quickly surface:

- last crash time
- last signal
- restartCount

```ts
type GatewayIncidentState = {
  version: 1;
  restartCount: number;
  lastStartAtMs?: number;
  lastSignalAtMs?: number;
  lastSignal?: string;
  lastCrashAtMs?: number;
  lastCrashSummary?: string;
  lastRecoverAttemptAtMs?: number;
};
```

## Design constraints

- **Best-effort:** incident writes must never throw in a way that crashes the gateway.
- **Low overhead:** append-only JSONL with small prune routine.
- **Automation-friendly:** CLI exposes `--json` output and stable fields.
