# SEMI-AUTO-RUN-007 — Remaining Untracked Triage

**Date:** 2026-06-23 18:49 KST  
**Status:** ✅ COMPLETE  
**Grade:** 🟢 Auto (read-only)

---

## 1. Untracked 16개 파일 목록

```
docs/audits/SEMI-AUTO-RUN-005.md
extensions/telegram/src/plugin-status-message.ts
extensions/telegram/src/plugin-status-message.test.ts
src/agents/jinhee-conversation-log-writer.ts
src/agents/jinhee-conversation-log-writer.test.ts
src/agents/jinhee-memory-candidate-extractor.ts
src/agents/jinhee-memory-candidate-extractor.test.ts
src/agents/jinhee-memory-promotion.ts
src/agents/jinhee-memory-promotion.test.ts
src/plugins/plugin-adapter.test.ts
src/plugins/plugin-adapter.types.ts
src/plugins/plugin-capability-policy.test.ts
src/plugins/plugin-capability-policy.ts
src/plugins/plugin-manifest.schema.ts
src/plugins/plugin-runtime-guard.test.ts
src/plugins/plugin-runtime-guard.ts
```

---

## 2. 파일별 분류 (상세)

### ✅ 🟢 Stage-candidate — 10건 (source files + audit)

| 파일                                               |                                       사유 |
| :------------------------------------------------- | -----------------------------------------: |
| `docs/audits/SEMI-AUTO-RUN-005.md`                 |            audit 보고서 (다른 24건과 동일) |
| `src/agents/jinhee-conversation-log-writer.ts`     |        `node:sqlite` 사용 (내장, dep 없음) |
| `src/agents/jinhee-memory-candidate-extractor.ts`  |        `node:sqlite` 사용 (내장, dep 없음) |
| `src/agents/jinhee-memory-promotion.ts`            | `sqlite3` CLI 사용 (OS 도구, npm dep 아님) |
| `src/plugins/plugin-adapter.types.ts`              |           타입 정의 전용 (런타임 dep 없음) |
| `src/plugins/plugin-capability-policy.ts`          |               순수 정책 로직 (DB dep 없음) |
| `src/plugins/plugin-manifest.schema.ts`            |                  스키마 검증 (DB dep 없음) |
| `src/plugins/plugin-runtime-guard.ts`              |               순수 가드 로직 (DB dep 없음) |
| `extensions/telegram/src/plugin-status-message.ts` |             순수 메시지 생성 (DB dep 없음) |

### ⚠️ 🟡 Test-needed — 6건 (test files)

| 파일                                           | 분석                              | test 가능? |
| :--------------------------------------------- | --------------------------------- | :--------: |
| `jinhee-conversation-log-writer.test.ts`       | `node:sqlite` (내장) ✅           | ✅ 예상됨  |
| `jinhee-memory-candidate-extractor.test.ts`    | 순수 단위 테스트 27개, DB mock ✅ | ✅ 예상됨  |
| `src/plugins/plugin-adapter.test.ts`           | 순수 단위 테스트 ✅               | ✅ 예상됨  |
| `src/plugins/plugin-capability-policy.test.ts` | 순수 단위 테스트 ✅               | ✅ 예상됨  |
| `src/plugins/plugin-runtime-guard.test.ts`     | 순수 단위 테스트 ✅               | ✅ 예상됨  |
| `telegram/plugin-status-message.test.ts`       | 순수 단위 테스트 ✅               | ✅ 예상됨  |

### ⛔ 🔴 Hold — 1건

| 파일                                         |                                                   사유 |
| :------------------------------------------- | -----------------------------------------------------: |
| `src/agents/jinhee-memory-promotion.test.ts` | `import Database from "better-sqlite3"` → npm pkg 필요 |

---

## 3. DB 의존성 분석 결과

| 파일                                        | 사용 DB                   |     Dep 필요?      |    상태    |
| :------------------------------------------ | ------------------------- | :----------------: | :--------: |
| `jinhee-memory-promotion.ts`                | `sqlite3` CLI (execSync)  | ❌ CLI만 있으면 OK |     ✅     |
| `jinhee-memory-promotion.test.ts`           | `better-sqlite3` npm      |      ✅ 필요       | ❌ Blocked |
| `jinhee-memory-candidate-extractor.ts`      | `node:sqlite` (Node 내장) |      ❌ 없음       |     ✅     |
| `jinhee-memory-candidate-extractor.test.ts` | mock만 사용               |      ❌ 없음       |     ✅     |
| `jinhee-conversation-log-writer.ts`         | `node:sqlite` (Node 내장) |      ❌ 없음       |     ✅     |
| `jinhee-conversation-log-writer.test.ts`    | `node:sqlite` (Node 내장) |      ❌ 없음       |     ✅     |
| `plugin-*.ts` (5개)                         | 없음                      |      ❌ 없음       |     ✅     |
| `plugin-*.test.ts` (3개)                    | 없음                      |      ❌ 없음       |     ✅     |
| `telegram/plugin-status-message.*`          | 없음                      |      ❌ 없음       |     ✅     |

---

## 4. 권장 stage 순서

| 우선순위 | 그룹                                       | 파일 수 | 조건                         |
| :------: | :----------------------------------------- | ------: | :--------------------------- |
|    1️⃣    | `docs/audits/SEMI-AUTO-RUN-005.md`         |     1건 | 즉시 stage 가능              |
|    2️⃣    | Source 파일 (9건)                          |     9건 | 코드 리뷰 후 stage 가능      |
|    3️⃣    | Test 파일 중 `better-sqlite3` 불필요 (6건) |     6건 | `pnpm test` 확인 후          |
|    4️⃣    | `jinhee-memory-promotion.test.ts`          |     1건 | `pnpm add better-sqlite3` 후 |

---

## 5. 검증

| 항목                    |                      결과 |
| :---------------------- | ------------------------: |
| forbidden 변경          |                   없음 ✅ |
| DB write                |   없음 ✅ (canonical: 30) |
| stage-candidate 제안 수 | 10건 (audit 1 + source 9) |
| test-needed 수          |                       6건 |
| hold 수                 |   1건 (promotion.test.ts) |
| 폐기/삭제 후보          |                      없음 |
