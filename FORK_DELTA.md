# FORK_DELTA.md — OpenFinClaw vs Upstream OpenClaw

**Last updated**: 2026-03-07
**Upstream merged**: 2026.2.25 (395 commits)

This document catalogs every OpenFinClaw-specific customization that diverges from upstream. Use it as a checklist when merging upstream changes.

---

## 1. Brand Customizations

| File                             | Our Value                               | Upstream Value                 |
| -------------------------------- | --------------------------------------- | ------------------------------ |
| `package.json` → name            | `openfinclaw`                           | `openclaw`                     |
| `package.json` → description     | AI-powered financial assistant gateway… | Multi-channel AI gateway…      |
| `package.json` → homepage        | `github.com/cryptoSUN2049/openFinclaw`  | `github.com/openclaw/openclaw` |
| `package.json` → keywords        | ai, ccxt, crypto, finance, gateway…     | `[]`                           |
| `package.json` → bin             | `openfinclaw: openfinclaw.mjs`          | `openclaw: openclaw.mjs`       |
| `package.json` → bugs/repository | cryptoSUN2049/openFinclaw               | openclaw/openclaw              |
| `openfinclaw.mjs`                | Custom CLI entry point                  | N/A (ours only)                |
| `README.md`                      | OpenFinClaw brand, features, roadmap    | OpenClaw docs                  |

## 2. Financial Extensions (5 active + 1 shared types)

All in `extensions/`, each with `devDependencies: { "openfinclaw": "workspace:*" }`.

| Extension                | Purpose                                                                                           | AI Tools | Status |
| ------------------------ | ------------------------------------------------------------------------------------------------- | -------- | ------ |
| `findoo-trader-plugin`   | Unified trading: exchange registry, risk control, paper trading, strategy engine, fund management | 23       | Active |
| `findoo-datahub-plugin`  | Market data provider: OHLCV, ticker, indicators, regime detection                                 | 40+      | Active |
| `findoo-backtest-plugin` | Remote backtesting via datahub                                                                    | 2        | Active |
| `fin-evolution-engine`   | GEP gene evolution, LLM mutation, RDAVD fitness                                                   | 2        | Active |
| `fin-shared-types`       | Cross-extension shared types (OHLCV, StrategyDefinition, etc.)                                    | 0        | Stable |

**Total AI tools**: 67+

### Retired Extensions (merged into findoo-trader-plugin)

The following extensions were consolidated into `findoo-trader-plugin` and no longer exist as separate directories:
`fin-core`, `fin-trading`, `fin-portfolio`, `fin-market-data`, `fin-paper-trading`, `fin-strategy-engine`, `fin-fund-manager`, `fin-expert-sdk`, `fin-info-feed`, `fin-monitoring`, `fin-data-bus`, `fin-data-hub`, `fin-openbb-data`, `fin-strategy-memory`.

## 3. Financial Skills

### Extension-bundled Skills (current architecture)

Skills are bundled with their extensions under `extensions/*/skills/`:

| Extension                | Skills | Examples                                        |
| ------------------------ | ------ | ----------------------------------------------- |
| `findoo-datahub-plugin`  | 27     | crypto, a-share, us-equity, macro, derivatives… |
| `findoo-backtest-plugin` | 1      | remote-backtest                                 |

### Community Skills (commons/skills/fin-\*)

20 community skills in `commons/skills/fin-*/SKILL.md` — these reference generic tool names and work with the current extension architecture.

## 4. Financial Configuration

| File                                  | Purpose                                                           |
| ------------------------------------- | ----------------------------------------------------------------- |
| `src/config/types.financial.ts`       | `FinancialConfig`, `ExchangeAccountConfig`, `TradingConfig` types |
| `src/config/zod-schema.financial.ts`  | Zod validation with sensitive field masking                       |
| `src/commands/configure.financial.ts` | Interactive exchange + trading risk config wizard                 |

## 5. Core Integration Points

| File                   | Change                                                            |
| ---------------------- | ----------------------------------------------------------------- |
| `src/config/types.ts`  | `export * from "./types.financial.js"` — financial types exported |
| `tsconfig.json` paths  | Dual aliases: `openfinclaw/plugin-sdk` + `openclaw/plugin-sdk`    |
| `package.json` exports | `./plugin-sdk`, `./plugin-sdk/account-id`, `./cli-entry`          |

## 6. Deploy Configuration

| Path                              | Purpose                         |
| --------------------------------- | ------------------------------- |
| `deploy/Dockerfile.gateway`       | Multi-stage gateway build       |
| `deploy/docker-compose.local.yml` | Local dev (gateway + Redis)     |
| `deploy/docker-compose.test.yml`  | Test environment                |
| `deploy/docker-compose.prd.yml`   | Production                      |
| `deploy/config/finclaw.*.json`    | Gateway configs per environment |
| `deploy/scripts/`                 | Deployment scripts              |
| `deploy/.env.example`             | Environment variable reference  |

## 7. FinClaw Commons

| Path                                 | Purpose                    |
| ------------------------------------ | -------------------------- |
| `commons/index.json`                 | Central registry           |
| `commons/skills/fin-*/`              | 20 community skills        |
| `commons/templates/finclaw-starter/` | Starter workspace template |
| `commons/dashboard/`                 | HTML dashboard generator   |
| `commons/fcs/`                       | FinClaw Score system       |
| `commons/site/`                      | Static browsing site       |

## 8. UI Extensions

| Path                                            | Purpose                               |
| ----------------------------------------------- | ------------------------------------- |
| `ui/src/ui/views/exchanges.ts`                  | Exchanges management view (337 lines) |
| `ui/src/ui/controllers/exchanges.ts`            | Controller bridging to config RPC     |
| `ui/src/ui/app-render.ts`                       | Exchanges tab rendering               |
| `ui/src/ui/navigation.ts`                       | Exchanges tab in nav                  |
| `ui/src/i18n/locales/{en,zh-CN,zh-TW,pt-BR}.ts` | i18n strings                          |

## 9. Extension devDeps Pattern

All `extensions/*/package.json` (upstream + ours) include:

```json
{
  "devDependencies": {
    "openfinclaw": "workspace:*"
  }
}
```

This enables local development with our package name. Must be restored after every upstream merge.

## 10. Merge Checklist

When merging upstream, restore these after conflict resolution:

- [ ] `package.json` — name, description, homepage, keywords, bin, bugs, repository
- [ ] `README.md` — OpenFinClaw brand sections (keep upstream doc links if useful)
- [ ] `openfinclaw.mjs` — must not be deleted
- [ ] All `extensions/*/package.json` — re-add `"openfinclaw": "workspace:*"` devDep
- [ ] `pnpm-lock.yaml` — delete conflicted version, run `pnpm install`
- [ ] `tsconfig.json` paths — verify dual `openfinclaw/` + `openclaw/` aliases
- [ ] `src/config/types.ts` — verify `export * from "./types.financial.js"` present
- [ ] Fix any upstream API changes in `extensions/findoo-*` (check `pnpm tsgo`)
- [ ] Run `pnpm format:fix` then `pnpm check` to verify

## 11. Environment Variables

- Primary: `OPENFINCLAW_*`
- Fallback: `OPENCLAW_*`
- Financial: `FINANCE_ENABLED`, exchange API keys in config

## 12. Runtime Services Registry

| Service ID              | Extension      | Purpose                  |
| ----------------------- | -------------- | ------------------------ |
| `fin-data-provider`     | findoo-datahub | OHLCV/Ticker/market data |
| `fin-regime-detector`   | findoo-datahub | Market regime detection  |
| `fin-strategy-registry` | findoo-trader  | Strategy management      |
| `fin-backtest-engine`   | findoo-trader  | Backtest engine          |
| `fin-paper-engine`      | findoo-trader  | Paper trading            |
| `fin-exchange-registry` | findoo-trader  | Exchange management      |
| `fin-risk-controller`   | findoo-trader  | Risk control             |
| `fin-fund-manager`      | findoo-trader  | Fund management          |
| `fin-live-executor`     | findoo-trader  | Live trading execution   |
| `fin-event-store`       | findoo-trader  | Event sourcing           |
| `fin-alert-engine`      | findoo-trader  | Alert management         |

---

**File count**: ~150+ OpenFinClaw-specific files across 5 extensions (67+ AI tools), 20+ skills, config, UI, commons, and deploy.
