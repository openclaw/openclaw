---
summary: "CLI reference for `openclaw lint` (read-only diagnostic checks)"
read_when:
  - You need a read-only validation gate for config or workspace health
  - You want JSON diagnostics without running guided doctor repairs
title: "Lint"
---

# `openclaw lint`

Run read-only diagnostic checks for config and workspace health.

`openclaw lint` uses the same structured diagnostic checks that modern doctor
repairs use for detection, but it never prompts, repairs, or rewrites
config/state. Use it in CI, preflight scripts, policy checks, and review
workflows when you want stable findings instead of guided repair prompts.

## Examples

```bash
openclaw lint
openclaw lint --severity-min warning
openclaw lint --json
openclaw lint --only core/lint/gateway-config --json
openclaw lint --skip core/lint/skills-readiness
```

## Options

- `--json`: emit JSON findings instead of human output
- `--severity-min <level>`: drop findings below `info`, `warning`, or `error`
- `--skip <id>`: skip a check id; repeat to skip more than one
- `--only <id>`: run only a check id; repeat to run a small selected set

## Output

Human output is compact:

```text
openclaw lint: ran 5 check(s), 1 finding(s)
  [warning] core/lint/gateway-config gateway.mode - gateway.mode is unset; gateway start will be blocked.
    fix: Run `openclaw configure` and set Gateway mode (local/remote), or `openclaw config set gateway.mode local`.
```

JSON output is stable enough for scripts:

```json
{
  "ok": false,
  "checksRun": 5,
  "checksSkipped": 0,
  "findings": [
    {
      "checkId": "core/lint/gateway-config",
      "severity": "warning",
      "message": "gateway.mode is unset; gateway start will be blocked.",
      "path": "gateway.mode",
      "fixHint": "Run `openclaw configure` and set Gateway mode (local/remote), or `openclaw config set gateway.mode local`."
    }
  ]
}
```

Exit behavior:

- `0`: no findings at or above the selected severity threshold
- `1`: at least one finding meets the selected threshold
- `2`: command/runtime failure before lint findings can be produced

`--severity-min` controls both visible findings and the exit threshold. For
example, `openclaw lint --severity-min error` can print no findings and exit `0`
even when lower-severity `info` or `warning` findings exist.

## Diagnostic Checks

Modern diagnostic checks use a small contract:

```ts
detect(ctx) -> DiagnosticFinding[]
```

`detect()` powers `openclaw lint`. Repairs remain part of `openclaw doctor`, not
the lint command.

A finding includes a stable `checkId`, `severity`, human-readable `message`, and
optional source fields such as `path`, `line`, `column`, `ocPath`, and `fixHint`.
Use check ids with `--only` and `--skip` when a workflow wants a focused gate.
