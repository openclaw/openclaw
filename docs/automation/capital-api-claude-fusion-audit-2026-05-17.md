# Capital API Claude Fusion Audit 2026-05-17

## Core Result

Status: partial_fusion

Claude 的文件目標是完整的 `capital-api-agent` 架構；目前 `D:\OpenClaw` 實際落地的是 `capital-quotes` read-only 報價防錯層與 `paper-hft` 模擬交易層。兩者已有部分融合，但尚未完成同一個完整 agent 閉環。

## Evidence

OpenClaw root check:

- `pwd`: `D:\OpenClaw`
- `git rev-parse --show-toplevel`: `D:/OpenClaw`
- `package.json`: exists
- `pnpm-workspace.yaml`: exists
- `pnpm-lock.yaml`: exists

Claude source files checked:

- `C:\Users\user\Desktop\新增資料夾\codex-openclaw-capital-api-FINAL-v2.md`
- `C:\Users\user\Desktop\新增資料夾\codex-openclaw-capital-api-agent-tasks.md`

## Current OpenClaw Surfaces Found

Implemented:

- `skills/capital-quotes/SKILL.md`
- `skills/auto-trading-assistant/SKILL.md`
- `.agents/skills/capital-api-agent/SKILL.md`
- `.agents/skills/capital-api-agent/agents/openai.yaml`
- `scripts/openclaw-capital-quote-reader.mjs`
- `scripts/openclaw-capital-quote-status.mjs`
- `scripts/openclaw-capital-quote-pump.mjs`
- `scripts/openclaw-capital-quote-runtime-event.mjs`
- `scripts/openclaw-capital-quote-architecture.mjs`
- `scripts/validate-capital-quote-state.mjs`
- `scripts/openclaw-capital-paper-trading-simulator.mjs`
- `scripts/openclaw-capital-paper-hft-readiness.mjs`
- `scripts/openclaw-capital-paper-hft-burst.mjs`
- `config/capital-paper-hft-risk-controls.json`
- `config/capital-paper-microstructure-strategy.json`

Missing or not yet fused:

- `skills/capital-api-agent/SKILL.md`
- `agents/capital-api-agent/IDENTITY.md`
- `config/capital-api-agent.manifest.json`
- `config/capital-holiday-calendar.json`
- `config/capital-product-session-registry.json`
- `config/capital-overseas-session-templates.json`
- `scripts/check-capital-api-agent.mjs`
- `scripts/check-capital-manifest-safety-flags.mjs`
- `scripts/check-capital-holiday-calendar.mjs`
- `scripts/check-capital-txf-session-isolation.mjs`
- `brokerdesk:quote:now`
- `brokerdesk:quote:now:check`
- `brokerdesk:capital-api:agent:check`
- `brokerdesk:capital-api:product-sessions:check`
- `brokerdesk:capital-api:txf-session-isolation:check`
- `brokerdesk:capital-api:holiday-calendar:check`

## Difference Matrix

| Area                  | Claude Target                                                             | Current OpenClaw                                          | Status    |
| --------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------- | --------- |
| Agent identity        | `agents/capital-api-agent/IDENTITY.md` with manifest consistency check    | missing                                                   | not_fused |
| Skill source          | `skills/capital-api-agent/SKILL.md` and `.agents/.../SKILL.md` must match | only `.agents/.../SKILL.md` exists; `skills/...` missing  | not_fused |
| Agent YAML            | complete OpenAI agent definition                                          | `.agents/.../openai.yaml` exists but is only 379 bytes    | partial   |
| Manifest              | `config/capital-api-agent.manifest.json` with safety flags                | missing                                                   | not_fused |
| Quote read gate       | stale/fresh/session guard                                                 | implemented in `capital-quotes` quote reader/status/pump  | fused     |
| Broker event time     | use broker event time, not callback receive time only                     | implemented in quote reader                               | fused     |
| Stale quote block     | reject stale callbacks and closed-session snapshots                       | implemented                                               | fused     |
| Login/order safety    | no OpenClaw-owned login or real order writes                              | present in `.agents` skill and `capital-quotes` rules     | fused     |
| `quote:now`           | one-command fresh quote answer per symbol                                 | missing                                                   | not_fused |
| TX00 day/night split  | TX00AM/TX00PM isolation and 13:45-15:00 inter-session behavior            | partial hardcoded session logic; no registry/check script | partial   |
| Holiday calendar      | TAIFEX/CME/SGX calendar with check                                        | missing                                                   | not_fused |
| Overseas sessions     | CME/SGX templates, OJO05 A50 exact hours                                  | missing                                                   | not_fused |
| Product registry      | all quote symbols mapped with source/session/freshness rules              | missing                                                   | not_fused |
| Paper HFT             | read-only quote driven paper simulation                                   | implemented                                               | fused     |
| Paper unblock cascade | blocked state cascade and unblock flow                                    | partially present, not matched to Claude target           | partial   |
| Dual-bundle live scan | reference Python bundle scan with execution blocked                       | missing in current package scripts                        | not_fused |

## Conclusion

兩個沒有完整融合。

目前正確融合的部分是：

- read-only 報價狀態讀取
- stale quote 防錯
- broker event time 判斷
- 休市不把歷史 callback 當即時報價
- OpenClaw 不登入、不下單
- paper-only 模擬交易入口

尚未融合的核心缺口是：

- Claude 定義的 `capital-api-agent` 正式 agent 身分、manifest、canonical skill surface 沒有完整存在。
- 商品/交易時段/假日/海外期貨 session registry 沒有落地。
- `brokerdesk:quote:now` 尚未建立，所以使用者問「目前報價」時還沒有單一正確入口可自動跑完整 gate。
- OJO05 / SGX A50、TX00AM / TX00PM isolation、TX00 inter-session、holiday calendar 仍未形成可驗證命令。

## Next Safe Task

新增低侵入 `brokerdesk:capital-api:agent:check`，只做檔案與 safety surface 檢查，不登入、不連券商、不下單。先把「Claude 目標 vs OpenClaw 實際缺口」變成可重跑的 gate，避免之後再口頭判斷是否融合。

## 2026-05-20 Angry Bohr Worktree Follow-up

Status: integration_incomplete

This follow-up compares the current `D:\OpenClaw` main worktree with `D:\OpenClaw\.claude\worktrees\angry-bohr-619b69`.

Verified facts:

- `D:\OpenClaw` is the active OpenClaw root.
- `claude/angry-bohr-619b69` exists at `D:\OpenClaw\.claude\worktrees\angry-bohr-619b69`.
- `main` head checked during this audit: `4280fa797e`.
- `angry-bohr` head checked during this audit: `6178fbdcf3`.
- `angry-bohr` is not fully merged into `main`.
- `angry-bohr` is ahead by the Capital HFT sequence:
  - `49048a10ed feat: add CapitalHftService OpenClaw integration (HFT quote + order pipeline)`
  - `0c2de078b4 feat: add overseas futures (SKOSQuoteLib) and stock support to HFT service`
  - `a3222b968b feat: fix HFT quote subscriptions and add stock list support`
  - `6178fbdcf3 feat: add full real-time risk monitor and trading data pipeline`
- The branch diff from `main...claude/angry-bohr-619b69` contains about 100 paths.
- The important `angry-bohr` paths missing from `main` are mostly the full HFT/strategy stack: `scripts/openclaw-capital-hft-*.mjs`, `scripts/strategy-engine/**`, and `config/live-risk-positions.json`.
- `angry-bohr` itself is not a clean source snapshot: it has tracked changes and untracked runtime/cache/helper files.

Current runtime blockers:

- `reports/hermes-agent/state/openclaw-capital-service-status-latest.json` reports `status: blocked_or_degraded` and `ready: false`.
- The service snapshot is stale and the recorded PID is dead: `pidAlive: false`, `livenessStatus: dead_pid`.
- The service remains `paper-only`; `liveTradingEnabled` and `writeTradingEnabled` are false.
- `reports/hermes-agent/state/openclaw-capital-quote-telegram-reply-latest.json` reports Telegram owner ready, but quote matching is not complete: `freshMatched: false`.
- Legacy `BrokerDesk/state/*.json` files are stale and still show `missing-background-status`, `quoteUniverseCount: 0`, and `quoteProofStatus: not_confirmed`.
- A running Claude process references the wrong path `D:\OpenClaw\.claire\worktrees\angry-bohr-619b69`, while the valid path is `D:\OpenClaw\.claude\worktrees\angry-bohr-619b69`.

Still unfinished:

- Merge map: decide which `angry-bohr` HFT/strategy files should be absorbed into the current OpenClaw main worktree.
- Safe quote runtime: restart or repair the Capital service until the state snapshot is fresh and `ready` is true.
- Fresh quote answer: make Telegram quote replies require `freshMatched: true` and report blockers instead of stale prices.
- Product/session registry: finish domestic/overseas product mapping, TX00 AM/PM separation, inter-session behavior, and holiday handling.
- Overseas futures: validate SKOSQuoteLib callback flow and product/session mapping for the actual subscribed products.
- Strategy integration: move the useful `scripts/strategy-engine/**` pieces into the current OpenClaw architecture without wholesale overwrite.
- Order integration: keep real order execution disabled until quote, account, position, and order-report gates are all verified.

Recommended next safe task:

Create a read-only `angry-bohr` merge-map gate that classifies each missing file as one of:

- `absorb_now`
- `already_replaced`
- `requires_adapter`
- `blocked_runtime`
- `do_not_merge`

The first safe merge target should be read-only quote/status and strategy-interface code only. Do not merge real order sending or live trading enablement until the runtime gates are green.
