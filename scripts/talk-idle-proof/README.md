# Talk idle-timeout live proof scripts

Interactive helpers for the three PR evidence scenarios on `feat/talk-idle-timeout`.

## Prerequisites

- Branch built: `pnpm build` and `dist/OpenClaw.app` packaged
- Test config: `~/.openclaw/openclaw.talk-idle-test.json` with `talk.idleTimeoutS: 30`
- Mac app running: `open -n dist/OpenClaw.app --args --attach-only`
- Microphone + Speech Recognition granted for OpenClaw
- Use branch CLI (not Homebrew `openclaw`)

## Run

All three in order:

```bash
bash scripts/talk-idle-proof/run-all.sh
```

Or one scenario at a time:

```bash
bash scripts/talk-idle-proof/scenario1-native-silent.sh
bash scripts/talk-idle-proof/scenario2-thinking-pending.sh
bash scripts/talk-idle-proof/scenario3-gateway-relay.sh
```

## Output

Artifacts land under `/tmp/talk-idle-proof/run-<timestamp>/`:

- `scenarioN/talk.runtime.log` — captured logs
- `scenarioN/talk.runtime.filtered.txt` — key idle-timeout lines
- `scenarioN/talk.config.json` — gateway talk.config snapshot
- `PR-EVIDENCE.md` — paste into PR (redact secrets first)

## Environment overrides

| Variable        | Default                                    |
| --------------- | ------------------------------------------ |
| `REPO`          | `$HOME/git/openclaw`                       |
| `TEST_CONFIG`   | `~/.openclaw/openclaw.talk-idle-test.json` |
| `IDLE_WAIT_SEC` | `60` (30s timeout + buffer)                |
| `LOG_LOOKBACK`  | `10m`                                      |
| `GATEWAY_PORT`  | `18789`                                    |
| `EVIDENCE_DIR`  | `/tmp/talk-idle-proof/run-<timestamp>`     |

If `clawlog.sh` needs sudo, enter your password when prompted for full log lines.
