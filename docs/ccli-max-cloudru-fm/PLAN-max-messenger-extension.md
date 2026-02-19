# Plan: MAX Messenger Extension for OpenClaw

> **Date:** 2026-02-16
> **Branch:** `claude/review-openclaw-messenger-docs-Rwr8i`
> **Prerequisite:** Research doc `research/max-messenger-integration.md` (complete)

---

## Goal

Создать полноценное расширение `extensions/max/` для интеграции мессенджера MAX (VK Group) с платформой OpenClaw. Расширение должно следовать паттерну существующих каналов (telegram, discord, signal) и пройти полный цикл качества.

---

## Scope

### In Scope

- Extension `@openclaw/max` в `extensions/max/`
- ChannelPlugin адаптер для MAX Bot API (`platform-api.max.ru`)
- Webhook + Long Polling поддержка
- Inline-клавиатуры, форматирование (markdown/html)
- Webhook signature verification
- Rate limiting (30 rps MAX API)
- Интеграция с существующей платформой (IMessengerPort, Event Bus)

### Out of Scope (future)

- Mini App интеграция (Phase 2)
- VK Pay платежи (Phase 3)
- Cloud.ru AI Agents A2A интеграция (отдельный ADR)

---

## Quality Cycle — 9 Steps

### Step 1: Create ADR-006 using DDD

**Deliverable:** `docs/ccli-max-cloudru-fm/adr/ADR-006-max-messenger-extension.md`

**Content:**

- **Context:** MAX — российский мессенджер, предустановлен на смартфонах с Sep 2025, Bot API на `platform-api.max.ru`, TypeScript SDK `@maxhub/max-bot-api`
- **Bounded Context:** Messenger (existing) — расширение через `IMessengerPort`
- **Decision:**
  - Новый extension `extensions/max/` по паттерну telegram
  - 5 файлов: `package.json`, `openclaw.plugin.json`, `index.ts`, `src/runtime.ts`, `src/channel.ts`
  - Webhook verification: HMAC signature (уточнить формат из MAX API docs)
  - Long Polling для разработки, Webhook для продакшена
  - Rate limit: 30 rps (Token Bucket, уже предусмотрен в платформе как `max: 20 rps`)
  - Message format: markdown (приоритет) + html fallback
  - Inline keyboards: callback, link, open_app типы кнопок
- **Consequences:** +1 extension, +1 devDep (`@maxhub/max-bot-api`), новый канал в wizard
- **DDD Aggregates:**
  - `MaxAccount` — конфигурация бот-аккаунта (token, webhook URL)
  - `MaxMessage` — входящее/исходящее сообщение
  - `MaxWebhookEvent` — событие от платформы MAX

**Key Design Decisions:**

1. SDK vs Raw API — использовать `@maxhub/max-bot-api` (85+ stars, MIT, official)
2. Webhook secret — хранить в `channels.max.webhookSecret`, verify через HMAC
3. Bot token — хранить в `channels.max.accounts[id].token`
4. Message chunking — markdown-aware, лимит 4096 символов (как Telegram)
5. Gateway pattern — `startAccount` запускает Long Polling или Webhook listener

---

### Step 2: Shift-Left Testing on ADR

**Tool:** [shift-left-testing skill](https://github.com/proffesor-for-testing/agentic-qe/tree/main/v3/assets/skills/shift-left-testing)

**What to validate:**

- Requirements completeness — все ли API-endpoints MAX покрыты?
- Testability — можно ли замокать MAX Bot API для unit-тестов?
- Security — webhook verification, token storage, rate limiting
- Risk analysis — зависимость от внешнего SDK, API stability

**Expected output:** `quality/shift-left-testing-report-ADR-006.md`

---

### Step 3: QCSD Ideation Swarm on refined ADR

**Tool:** [qcsd-ideation-swarm skill](https://github.com/proffesor-for-testing/agentic-qe/tree/main/v3/assets/skills/qcsd-ideation-swarm)

**What to analyze:**

- Quality criteria matrix (functionality, reliability, security, performance)
- Edge cases: network failures, MAX API outages, rate limit bursts
- Security threat model: token leakage, webhook spoofing, message injection
- Middleware quality: webhook validation, error handling, retry logic

**Expected output:** `quality/qcsd-ideation-ADR-006.md`

---

### Step 4: Code Goal Planner — Implementation Plan

**Tool:** [code-goal-planner agent](https://github.com/proffesor-for-testing/agentic-qe/blob/main/.claude/agents/goal/code-goal-planner.md)

**Expected milestones:**

| #   | Milestone                   | Files                                                                | Tests |
| --- | --------------------------- | -------------------------------------------------------------------- | ----- |
| M1  | Scaffold extension          | `package.json`, `openclaw.plugin.json`, `index.ts`, `src/runtime.ts` | 0     |
| M2  | Channel plugin skeleton     | `src/channel.ts` с заглушками для всех секций                        | 5     |
| M3  | Outbound messaging          | `outbound.sendText`, `outbound.sendMedia`, chunker                   | 15    |
| M4  | Gateway (webhook + polling) | `gateway.startAccount`, webhook handler                              | 20    |
| M5  | Inline keyboards            | Callback handling, keyboard builder                                  | 10    |
| M6  | Config & Setup              | Wizard integration, account management                               | 10    |
| M7  | Status & Probing            | `status.probeAccount`, health checks                                 | 5     |
| M8  | Integration tests           | End-to-end с mock MAX API                                            | 15    |

**Expected output:** `planning/milestones-ADR-006.md`

---

### Step 5: Requirements Validator — Gap Analysis

**Tool:** Requirements validator skill

**Loop:** Validate implementation plan -> find gaps -> mitigate -> repeat until clean.

**Likely gaps to check:**

- [ ] Webhook signature format (MAX uses what algorithm? HMAC-SHA256?)
- [ ] GROUP chat support (bot mentions, thread replies)
- [ ] Media upload flow (photo, video, document via `POST /uploads`)
- [ ] Error handling for all MAX API error codes (400, 401, 429, 503)
- [ ] Graceful shutdown (stop webhook/polling on account logout)
- [ ] Config migration (what if MAX changes API version?)

**Expected output:** `quality/requirements-validation-ADR-006.md`

---

### Step 6: Implementation Swarm

**Actual coding.** Create all files in `extensions/max/`:

```
extensions/max/
  package.json              # @openclaw/max
  openclaw.plugin.json      # id: "max", channels: ["max"]
  index.ts                  # register(api) entry point
  src/
    runtime.ts              # setMaxRuntime / getMaxRuntime singleton
    channel.ts              # ChannelPlugin<ResolvedMaxAccount, MaxProbe>
```

**Key implementation details:**

1. **`channel.ts` sections** (following telegram pattern):
   - `meta` — getChatChannelMeta("max")
   - `capabilities` — chatTypes: ["direct", "group"], reactions: false, threads: false, media: true, nativeCommands: true
   - `outbound.sendText` — POST /messages via runtime
   - `outbound.sendMedia` — POST /uploads + POST /messages with attachment
   - `outbound.chunker` — markdown-aware, limit 4096
   - `gateway.startAccount` — start webhook/polling listener
   - `status.probeAccount` — GET /me to verify bot token
   - `config.*` — account CRUD in openclaw.json
   - `setup.*` — wizard flow for bot token input
   - `security.*` — DM policy, webhook verification

2. **Dependencies:** Add `@maxhub/max-bot-api` to devDependencies (or use raw HTTP via runtime)

3. **Platform integration:**
   - Platform already has `max` in MessengerPlatform type
   - Rate limits already configured: `max: 20 rps, burstSize: 20`
   - Streaming config already set: `max: maxMessageLength 4096`

---

### Step 7: Brutal Honesty Review

**Tool:** [brutal-honesty-review skill](https://github.com/proffesor-for-testing/agentic-qe/tree/main/v3/assets/skills)

**What to evaluate:**

- Does the extension follow the telegram pattern exactly?
- Are all ChannelPlugin sections implemented (not just stubs)?
- Is webhook verification cryptographically correct?
- Is error handling comprehensive (all MAX API error codes)?
- Does the wizard integration work end-to-end?
- Are tests meaningful (not just happy path)?

**Loop:** Find gaps -> fix -> re-review until clean.

**Expected output:** `BRUTAL-HONESTY-REVIEW-ADR-006.md`

---

### Step 8: Final Gap Check

**Question:** Did we miss something?

**Checklist:**

- [ ] Extension loads via `openclaw.plugin.json`
- [ ] Bot token storage is secure (not in git)
- [ ] Webhook endpoint is documented
- [ ] Rate limiting works (30 rps MAX, 20 rps OpenClaw)
- [ ] Message formatting (markdown) renders correctly in MAX
- [ ] Inline keyboards work for callback and link types
- [ ] Group chat support (bot_added, bot_removed events)
- [ ] Error messages are user-friendly (Russian locale)
- [ ] Long Polling works for development
- [ ] Webhook works for production
- [ ] Account probe (GET /me) validates token
- [ ] Graceful shutdown stops listener

If gaps found -> formulate what's missing -> repeat from Step 1 (new ADR or ADR amendment).

---

### Step 9: QE Queen Assessment

**Tool:** QE Queen organized QE fleet

**Full quality assessment:**

- Unit test coverage >= 85%
- Integration tests with mock MAX API
- Security audit (webhook verification, token handling)
- Performance testing (rate limit compliance)
- Documentation completeness (README, setup guide)

---

## Dependencies & Risks

| Risk                                             | Probability | Impact | Mitigation                                            |
| ------------------------------------------------ | ----------- | ------ | ----------------------------------------------------- |
| MAX Bot API undocumented behavior                | Medium      | High   | Use official SDK, test against staging                |
| SDK `@maxhub/max-bot-api` instability            | Low         | Medium | Pin version, fallback to raw HTTP                     |
| Webhook signature format unknown                 | High        | High   | Research in Step 1, test in Step 2                    |
| MAX platform rate limit changes                  | Low         | Low    | Configurable in `channels.max.rateLimit`              |
| Russian business entity required for publication | High        | Low    | Document as prerequisite, not blocker for development |

---

## Estimated Effort per Step

| Step                      | Effort       | Parallelizable                         |
| ------------------------- | ------------ | -------------------------------------- |
| 1. ADR                    | 1 session    | No                                     |
| 2. Shift-Left             | 1 session    | No (needs ADR)                         |
| 3. QCSD Ideation          | 1 session    | No (needs refined ADR)                 |
| 4. Code Goal Planner      | 1 session    | No (needs validated ADR)               |
| 5. Requirements Validator | 1-2 sessions | No (needs plan)                        |
| 6. Implementation         | 2-3 sessions | Partially (M1-M3 independent of M4-M7) |
| 7. Brutal Honesty         | 1 session    | No (needs implementation)              |
| 8. Gap Check              | 0.5 session  | No                                     |
| 9. QE Queen               | 1 session    | No                                     |

**Total: ~9-11 sessions**

---

## Next Action

Start **Step 1**: Write ADR-006-max-messenger-extension.md using DDD analysis.
