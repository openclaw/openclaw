# SEMI-AUTO-RUN-004 — Stage-Safe Artifact Plan

**Date:** 2026-06-23 18:37 KST  
**Status:** ✅ COMPLETE  
**Grade:** 🟢 Auto (read-only file list 확정)

---

## 전체 untracked 현황

`git ls-files --others --exclude-standard | wc -l` → **44 files**

| 분류                 |  파일 수 | 상세                                       |                       조건 |
| :------------------- | -------: | :----------------------------------------- | -------------------------: |
| 🟢 **stage-safe**    | **29건** | audits 23 + scripts 2 + bridge 2 + guard 2 |          즉시 git add 가능 |
| 🟡 **test-required** | **11건** | conv-log 2 + plugins 7 + telegram plugin 2 |         테스트 확인 후 add |
| 🔴 **hold**          |  **4건** | promotion 2 + candidate 2                  | better-sqlite3 설치 후 add |

---

## 1. 🟢 Stage-safe 29건 — 바로 git add 가능

### 1-1. docs/audits/ — 23건 (read-only audit reports)

```
docs/audits/AUDIT-DOCS-SUMMARY.md
docs/audits/AUTO-BACKLOG-SCAN-012.md
docs/audits/CODEX-DELEGATION-RULE-011.md
docs/audits/GITIGNORE-APPLY-018.md
docs/audits/GITIGNORE-CANDIDATE-SCAN-017.md
docs/audits/ISOLATED-DELIVERY-SMOKE-016.md
docs/audits/ISOLATED-EXECUTION-PATTERN-015.md
docs/audits/ISOLATED-TIMEOUT-REVIEW.md
docs/audits/MARKETTWIN-CRON-CONSISTENCY-013.md
docs/audits/MEM-PERSIST-FOUNDATION-001.md
docs/audits/MEMORY-BRIDGE-THRESHOLD-009.md
docs/audits/MEMORY-BRIDGE-THRESHOLD-010.md
docs/audits/MEMORY-CANDIDATE-003.md
docs/audits/MEMORY-OPERATING-RULE-007.md
docs/audits/MEMORY-OPERATING-RULE-ROUNDTRIP-008.md
docs/audits/MEMORY-PROMOTION-004-BATCH-APPROVED.md
docs/audits/MEMORY-PROMOTION-004-BATCH.md
docs/audits/MEMORY-ROUNDTRIP-005.md
docs/audits/PLUGIN-RUNTIME-BLOCK-003.md
docs/audits/PLUGIN-STABILITY-001.md
docs/audits/SEMI-AUTO-RUN-002.md
docs/audits/SEMI-AUTO-RUN-003.md
docs/audits/WORKSPACE-DIFF-CLASSIFY-016.md
```

### 1-2. scripts/ — 2건 (read-only CLI scripts)

```
scripts/jinhee-memory-bridge-preview.mjs    — bridge preview (read-only)
scripts/jinhee-memory-promotion.mjs          — promotion CLI
```

### 1-3. jinhee-memory-bridge — 2건 (14/14 ✅ 테스트 통과)

```
src/agents/jinhee-memory-bridge.ts
src/agents/jinhee-memory-bridge.test.ts
```

### 1-4. jinhee-db-write-guard — 2건 (13/13 ✅ 테스트 통과)

```
src/agents/jinhee-db-write-guard.ts
src/agents/jinhee-db-write-guard.test.ts
```

---

## 2. 🟡 Test-required 11건 — 테스트 확인 후 add

### 2-1. jinhee-conversation-log-writer — 2건 (테스트 미확인)

```
src/agents/jinhee-conversation-log-writer.ts
src/agents/jinhee-conversation-log-writer.test.ts
```

### 2-2. Plugin Safety System — 7건 (테스트 미확인)

```
src/plugins/plugin-adapter.test.ts
src/plugins/plugin-adapter.types.ts
src/plugins/plugin-capability-policy.test.ts
src/plugins/plugin-capability-policy.ts
src/plugins/plugin-manifest.schema.ts
src/plugins/plugin-runtime-guard.test.ts
src/plugins/plugin-runtime-guard.ts
```

### 2-3. Telegram Plugin Status — 2건 (테스트 미확인)

```
extensions/telegram/src/plugin-status-message.ts
extensions/telegram/src/plugin-status-message.test.ts
```

---

## 3. 🔴 Hold 4건 — better-sqlite3 필요

### 3-1. jinhee-memory-promotion — 2건 (better-sqlite3 의존)

```
src/agents/jinhee-memory-promotion.ts         ❌ Cannot find package 'better-sqlite3'
src/agents/jinhee-memory-promotion.test.ts    ❌ Cannot find package 'better-sqlite3'
```

### 3-2. jinhee-memory-candidate-extractor — 2건 (better-sqlite3 의존)

```
src/agents/jinhee-memory-candidate-extractor.ts
src/agents/jinhee-memory-candidate-extractor.test.ts
```

---

## 4. git add 커맨드 (형 승인 시)

```bash
# 🟢 Stage-safe 29건
git add docs/audits/*.md
git add scripts/jinhee-memory-*.mjs
git add src/agents/jinhee-memory-bridge.ts src/agents/jinhee-memory-bridge.test.ts
git add src/agents/jinhee-db-write-guard.ts src/agents/jinhee-db-write-guard.test.ts

# 🟡 Test-required (테스트 후)
git add src/agents/jinhee-conversation-log-writer.ts src/agents/jinhee-conversation-log-writer.test.ts
git add src/plugins/plugin-*.ts src/plugins/plugin-*.test.ts
git add extensions/telegram/src/plugin-status-message.ts extensions/telegram/src/plugin-status-message.test.ts

# 🔴 Hold (better-sqlite3 설치 후)
git add src/agents/jinhee-memory-promotion.ts src/agents/jinhee-memory-promotion.test.ts
git add src/agents/jinhee-memory-candidate-extractor.ts src/agents/jinhee-memory-candidate-extractor.test.ts
```

---

## 5. 검증

| 항목                   |                                                              결과 |
| :--------------------- | ----------------------------------------------------------------: |
| forbidden 변경         |                                                           없음 ✅ |
| DB write               |                              없음 ✅ (canonical:30, memories:214) |
| git add/commit/push    |                                                           없음 ✅ |
| 실제 untracked 파일 수 | 44개 (23 audits + 2 scripts + 10 agents + 7 plugins + 2 telegram) |
| `.bak.*` 파일 ignore   |                              ✅ (gitignore 적용됨, 0개 untracked) |
| report 위치            |                                `docs/audits/SEMI-AUTO-RUN-004.md` |
