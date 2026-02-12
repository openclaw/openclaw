# Implementation Plan: Heimdall SYSTEM Tier

## Summary

Добавление SYSTEM tier для agent-initiated calls (cron, heartbeat, internal operations) в Heimdall security layer. Текущая реализация использует OWNER override, что нарушает principle of least privilege. SYSTEM tier обеспечит минимальные привилегии для внутренних операций с полной аудитируемостью.

## Deep Analysis Insights

**Из thinkdeep анализа:**

- Главный риск: confused deputy attacks через subagent inheritance
- Критично: provenance hardening для isTrustedInternal
- Текущий workaround (OWNER override в pi-tools.ts:379-382) должен быть удален
- Необходим non-delegation by default для SYSTEM tier

**Из consensus (confidence 8/10, 7/10):**

- SYSTEM tier - правильная абстракция, industry-aligned
- Smart defaults должны быть консервативными (read-only приоритет)
- Audit logging критичен для трассировки internal calls

## Phases

### Phase 1: Core SYSTEM Tier Implementation

**Objective:** Добавить SYSTEM tier в type system и resolution logic

**Tasks:**

1.1. **Update types.ts**

- Добавить `SYSTEM = "system"` в SenderTier enum
- Добавить `isTrustedInternal?: boolean` в SecurityContext interface
- File: `src/security/heimdall/types.ts`

  1.2. **Update sender-tier.ts**

- Модифицировать `resolveSenderTier()` для проверки `isTrustedInternal` ПЕРВЫМ (before fail-closed)
- Logic: `if (context.isTrustedInternal) return SenderTier.SYSTEM;`
- Ensure fail-closed: `if (!context.senderId && !context.senderUsername && !context.isTrustedInternal) return GUEST;`
- File: `src/security/heimdall/sender-tier.ts:44-76`

  1.3. **Update tool-acl.ts**

- Добавить SYSTEM tier matching в `isToolAllowed()`
- SYSTEM bypasses dangerous patterns check (но не OWNER bypass)
- SYSTEM проверяется через `config.systemAcl` (если задан) или defaults
- File: `src/security/heimdall/tool-acl.ts:113-156`

**Success Criteria:**

- [ ] SYSTEM enum value существует
- [ ] resolveSenderTier() возвращает SYSTEM для isTrustedInternal=true
- [ ] isToolAllowed() корректно обрабатывает SYSTEM tier
- [ ] Unit tests покрывают SYSTEM tier resolution

---

### Phase 2: Integration Points

**Objective:** Inject isTrustedInternal в правильных точках pipeline

**Tasks:**

2.1. **Audit senderIsOwner usage**

- Find ALL locations where `senderIsOwner` устанавливается:
  - `src/cron/isolated-agent/run.ts` (cron jobs)
  - `src/auto-reply/reply/agent-runner.ts` (heartbeat?)
  - CLI invocations
- Document каждое место и его purpose
- Files: results from grep

  2.2. **Replace senderIsOwner with isTrustedInternal**

- Update pi-tools options interface: `internal?: boolean` (вместо senderIsOwner)
- Update call sites из 2.1 для передачи `internal: true`
- File: `src/agents/pi-tools.ts:168`, call sites из 2.1

  2.3. **REMOVE EXISTING WORKAROUND**

- **CRITICAL:** Удалить override на OWNER в pi-tools.ts:379-382
- Code to remove:
  ```typescript
  if (senderIsOwner && senderTier !== "owner") {
    senderTier = "owner" as SenderTier;
  }
  ```
- После удаления internal calls будут использовать SYSTEM tier
- File: `src/agents/pi-tools.ts:379-382`

  2.4. **Map internal flag to isTrustedInternal**

- В pi-tools.ts при создании SecurityContext:
  - Если `options?.internal === true`, set `isTrustedInternal: true`
  - Передать SecurityContext в `wrapToolWithBeforeToolCallHook`
- File: `src/agents/pi-tools.ts:366-383`

  2.5. **Audit subagent context propagation**

- Find где создаются subagent tools
- Verify что `internal` flag НЕ НАСЛЕДУЕТСЯ автоматически
- Enforce: subagent calls должны использовать parent sender tier (NOT SYSTEM unless explicitly re-attested)
- Add safeguard: log warning if subagent attempts to inherit SYSTEM
- Files: grep for subagent creation, tool delegation

  2.6. **Enhance audit logging**

- Update `audit.ts` для включения:
  - `tier: "system"` в audit logs
  - `internal_reason: "cron" | "heartbeat" | "maintenance"` (optional field)
  - `correlation_id` для трассировки internal operations
- File: `src/security/heimdall/audit.ts`

**Success Criteria:**

- [ ] All senderIsOwner usages mapped and replaced
- [ ] OWNER override удален из pi-tools.ts
- [ ] internal flag корректно мапится в isTrustedInternal
- [ ] Subagent inheritance проверен и защищен
- [ ] Audit logs содержат SYSTEM tier events
- [ ] Integration tests: cron/heartbeat работают через SYSTEM tier

---

### Phase 3: Smart Defaults & Configuration

**Objective:** Provide safe, conservative defaults для SYSTEM tier ACL

**Tasks:**

3.1. **Analyze actual tool surface**

- List ALL tools matching `kg_*` pattern
- Categorize: read-only vs write operations
- Repeat for `http_*`, `bash_safe`, `channel_*`
- Document findings для informed defaults
- Files: pi-tools.ts, grep for tool definitions

  3.2. **Define conservative systemAcl defaults**

- Based on 3.1 analysis, create minimal allowlist:
  ```typescript
  systemAcl: z.array(z.string()).default([
    // Read-only operations
    'kg_query',           // NOT kg_* (too broad)
    'kg_search',
    'channel_status',     // NOT channel_* (avoid channel_delete)
    'domain_resolve',     // DNS resolution
    'http_get',           // NOT http_* (avoid POST/DELETE)
    'http_head',
    'telegram_send_message',  // Notification delivery
    // Targeted write operations
    'session_heartbeat',  // Heartbeat updates
  ]),
  ```
- Rationale: prefer explicit allow over wildcard patterns
- File: `src/security/heimdall/config-schema.ts`

  3.3. **Update config schema**

- Add `systemAcl` field to HeimdallConfig schema
- Add JSDoc explaining SYSTEM tier usage
- Provide migration notes for existing users
- File: `src/security/heimdall/config-schema.ts`

  3.4. **Documentation**

- Create `docs/heimdall/SYSTEM_TIER.md`:
  - Explain OWNER vs SYSTEM vs MEMBER vs GUEST
  - When to use each tier
  - How to customize systemAcl
  - Security considerations (non-delegation, provenance)
- Update main Heimdall README with SYSTEM tier section
- Files: docs/heimdall/, src/security/heimdall/README.md

**Success Criteria:**

- [ ] systemAcl defaults are minimal and safe
- [ ] Configuration schema supports systemAcl customization
- [ ] Documentation explains tier hierarchy clearly
- [ ] Migration guide provided for existing users

---

## Approach Decision

**Chosen approach:** SYSTEM tier with dedicated ACL

**Rationale:**

- Preserves principle of least privilege (SYSTEM < OWNER)
- Maintains audit trail (vs skipping Heimdall)
- Industry-aligned (k8s service accounts, AWS service-linked roles)
- Scales to future internal operations

**Alternatives considered:**

- OWNER + internal flag → Rejected (privilege escalation risk, audit confusion)
- Pattern whitelists → Rejected (brittle, maintenance burden)
- Skip Heimdall for internal calls → Rejected (no audit trail, shadow execution)

---

## Critical Decisions

**Decision 1: SYSTEM tier is non-delegable by default**

- Rationale: Prevent confused deputy attacks via subagents
- Tradeoff: Subagents must explicitly re-attest if SYSTEM tier needed (rare)
- Implementation: Log warning if subagent inherits SYSTEM, downgrade to parent sender tier

**Decision 2: Conservative systemAcl defaults (read-only priority)**

- Rationale: 80% of cron/heartbeat use cases are read-only or narrow writes
- Tradeoff: Users may need to extend systemAcl for specific deployments
- Implementation: Explicit tool names instead of wildcard patterns

**Decision 3: Remove existing OWNER override**

- Rationale: Current workaround violates least privilege, creates audit confusion
- Tradeoff: Breaking change if users rely on override behavior (unlikely)
- Implementation: Delete pi-tools.ts:379-382 after SYSTEM tier is functional

---

## Risks & Mitigations

**Risk 1: Async context loss at queue boundaries**

- Description: isTrustedInternal flag lost when calls go through async queues/callbacks
- Mitigation: Thread `internal` flag through options explicitly, avoid implicit propagation
- Test: Integration test with queue-based cron job

**Risk 2: Confused deputy via subagent inheritance**

- Description: Subagent tools automatically inherit SYSTEM tier, escalate privileges
- Mitigation: Explicit non-delegation check in subagent tool creation, log warnings
- Test: Security test attempting to create subagent with SYSTEM tier

**Risk 3: systemAcl too permissive (wildcard patterns)**

- Description: Defaults like `kg_*` include destructive operations (kg_delete, kg_truncate)
- Mitigation: Use explicit tool names instead of wildcards, prioritize read-only
- Test: Manual review of defaults against actual tool surface (task 3.1)

**Risk 4: External spoofing of isTrustedInternal**

- Description: User request sets `internal: true` to escalate to SYSTEM tier
- Mitigation: isTrustedInternal ONLY set in trusted code paths (agent-runner, cron), never from external input
- Test: Unit test attempting to spoof isTrustedInternal from external call

---

## Files to Modify

### Core Implementation (Phase 1)

- `src/security/heimdall/types.ts` — Add SYSTEM enum, isTrustedInternal field
- `src/security/heimdall/sender-tier.ts` — Update resolveSenderTier() logic
- `src/security/heimdall/tool-acl.ts` — Add SYSTEM tier ACL matching

### Integration (Phase 2)

- `src/auto-reply/reply/agent-runner.ts` — Set internal flag for heartbeat
- `src/cron/isolated-agent/run.ts` — Set internal flag for cron jobs
- `src/agents/pi-tools.ts` — Map internal → isTrustedInternal, REMOVE override (379-382)
- `src/security/heimdall/audit.ts` — Enhance logging with tier/reason/correlation

### Configuration (Phase 3)

- `src/security/heimdall/config-schema.ts` — Add systemAcl defaults
- `docs/heimdall/SYSTEM_TIER.md` — Documentation (NEW FILE)
- `src/security/heimdall/README.md` — Update with SYSTEM tier section

---

## Testing Strategy

### Unit Tests

**File:** `src/security/heimdall/sender-tier.test.ts`

- Test: `resolveSenderTier()` with `isTrustedInternal=true` returns SYSTEM
- Test: `resolveSenderTier()` with `isTrustedInternal=false` falls through to normal logic
- Test: `resolveSenderTier()` with `isTrustedInternal=undefined` treated as false

**File:** `src/security/heimdall/tool-acl.test.ts`

- Test: SYSTEM tier allows tools in systemAcl defaults
- Test: SYSTEM tier denies tools NOT in systemAcl
- Test: SYSTEM tier respects custom systemAcl config
- Test: OWNER bypass still works (OWNER always allowed)

**File:** `src/agents/pi-tools.test.ts`

- Test: `internal: true` maps to `isTrustedInternal: true` in SecurityContext
- Test: `internal: false` maps to `isTrustedInternal: false`
- Test: `internal: undefined` defaults to `isTrustedInternal: undefined`

### Integration Tests

**File:** `src/cron/isolated-agent/run.test.ts` (or new integration test file)

- Test: Cron job with SYSTEM tier can execute kg_query, telegram_send_message
- Test: Cron job with SYSTEM tier CANNOT execute destructive tools (exec, write)
- Test: Heartbeat operation works through SYSTEM tier
- Test: External user call does NOT receive SYSTEM tier (receives GUEST/MEMBER/OWNER based on config)

**Migration Test:**

- Test: Existing cron jobs (previously using OWNER override) continue working with SYSTEM tier
- Test: No regression in functionality after removing override

### Security Tests

**File:** `src/security/heimdall/security.test.ts` (or new test file)

- Test: External request attempting to set `internal: true` → isTrustedInternal remains false
- Test: Subagent call does NOT inherit SYSTEM tier from parent (downgrade to parent sender tier)
- Test: Spoofing attempt via request headers/params → SYSTEM tier NOT granted
- Test: SYSTEM tier cannot access tools outside systemAcl (e.g., exec, apply_patch)

---

## Success Criteria

- [ ] SYSTEM tier enum added to types
- [ ] resolveSenderTier() checks isTrustedInternal first
- [ ] isToolAllowed() handles SYSTEM tier with ACL
- [ ] All unit tests passing (sender-tier, tool-acl, pi-tools)
- [ ] Integration tests passing (cron e2e, heartbeat e2e)
- [ ] Security tests passing (spoofing, inheritance, ACL boundaries)
- [ ] OWNER override removed from pi-tools.ts:379-382
- [ ] Audit logs include SYSTEM tier events
- [ ] Documentation complete (SYSTEM_TIER.md, README updates)
- [ ] Migration guide provided
- [ ] 80%+ test coverage for new code

---

## Plan Validation

**Critique result:** REVISE → All findings addressed in this revision

**Key findings resolved:**

1. ✅ Corrected file paths (agent-runner.ts)
2. ✅ Explicitly included OWNER override removal
3. ✅ Added subagent context propagation audit
4. ✅ Refined smart defaults (explicit tools, no wildcards)
5. ✅ Added audit logging enhancements
6. ✅ Included migration test in testing strategy
7. ✅ Documented non-delegation safeguards
