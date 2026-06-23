# SEMI-AUTO-RUN-009: Candidate Extractor Test Fix

> **등급:** 🟡 Light
> **수행:** 2026-06-23 21:50+09:00 KST | **소요:** ~3분
> **상태:** ✅ COMPLETE

---

## 목적

`jinhee-memory-candidate-extractor.test.ts`의 2개 pre-existing test bug를 수정하고
PASS한 모든 stage-candidate 파일을 stage 가능으로 확정한다.

---

## 발견된 2개 테스트 버그 (SEMI-AUTO-RUN-008 계승)

|  #  | 테스트                                               | 원인                                                                                                                                                                      | 수정                                                                                                             |
| :-: | :--------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :--------------------------------------------------------------------------------------------------------------- |
|  1  | `report has correct sections order`                  | Test의 `sectionOrder` 배열에 `"Summary"`, `"Stats"` (숫자 없음) → Source는 `"## 1. Summary"`, `"## 2. Stats"` (숫자 접두어 포함)                                          | `sectionOrder` 배열에 순번 추가                                                                                  |
|  2  | `report contains no INSERT/UPDATE/DELETE references` | Test가 `expect(report).not.toMatch(/INSERT/i)`로 검증 → Source는 Safety 섹션에서 `"**INSERT/UPDATE/DELETE executed:** No (read-only)"` 로 read-only임을 명시적으로 문서화 | 검증 로직을 `INSERT INTO`/`UPDATE.*SET.*WHERE`/`DELETE FROM`/`executed promotion` 으로 변경 (SQL 실행 주장 감지) |

---

## Test 실행 결과

```
Test Files  2 passed (2)  ← agents-core + agents-support (동일 파일, workspace 이중 포함)
Tests       54 passed (54)
Duration    6.08s
```

✅ **54/54 ALL PASS** — 기존 PASS 52건 유지, 2건 FAIL→PASS 전환

---

## Stage 가능 현황

### ✅ Stage 가능 (candidate-extractor)

| 파일                                                   |     상태      | 비고                               |
| :----------------------------------------------------- | :-----------: | :--------------------------------- |
| `src/agents/jinhee-memory-candidate-extractor.ts`      | ✅ **source** | 기존 PASS, 변경 없음               |
| `src/agents/jinhee-memory-candidate-extractor.test.ts` |  ✅ **test**  | **2개 assertion 수정, 54/54 PASS** |

### ✅ 기존 Stage 가능 12건 유지 (SEMI-AUTO-RUN-008 기준)

|  #  | 파일                                                    | 비고                |
| :-: | :------------------------------------------------------ | :------------------ |
|  1  | `src/agents/jinhee-conversation-log-writer.ts`          | source PASS         |
|  2  | `src/agents/jinhee-conversation-log-writer.test.ts`     | test PASS (12/12)   |
|  3  | `src/plugins/plugin-adapter.types.ts`                   | source PASS         |
|  4  | `src/plugins/plugin-adapter.test.ts`                    | test PASS (6/6)     |
|  5  | `src/plugins/plugin-capability-policy.ts`               | source PASS         |
|  6  | `src/plugins/plugin-capability-policy.test.ts`          | test PASS (12/12)   |
|  7  | `src/plugins/plugin-manifest.schema.ts`                 | source PASS         |
|  8  | `src/plugins/plugin-runtime-guard.ts`                   | source PASS         |
|  9  | `src/plugins/plugin-runtime-guard.test.ts`              | test PASS (134/134) |
| 10  | `extensions/telegram/src/plugin-status-message.test.ts` | test PASS (22/22)   |
| 11  | `docs/audits/SEMI-AUTO-RUN-005.md`                      | audit report        |
| 12  | `docs/audits/SEMI-AUTO-RUN-008.md`                      | audit report        |

### ❌ Hold 유지 (1건)

| 파일                                         | 사유                                   |
| :------------------------------------------- | :------------------------------------- |
| `src/agents/jinhee-memory-promotion.test.ts` | 🔴 `better-sqlite3` 미설치로 실행 불가 |

---

## 검증 결과

| 항목                                     |                                                           상태                                                           |
| :--------------------------------------- | :----------------------------------------------------------------------------------------------------------------------: |
| ✅ candidate-extractor focused test PASS |                                                      **54/54 PASS**                                                      |
| ✅ 기존 PASS test 영향 없음              | conversation-log-writer, plugin-adapter, plugin-capability-policy, plugin-runtime-guard, plugin-status-message 모두 유지 |
| ✅ Forbidden diff clean                  |                              package.json/pnpm-lock.yaml/MEMORY.md/openclaw.json 변경 없음                               |
| ✅ DB canonical count 유지               |                                                            30                                                            |
| ✅ DB write 없음                         |                                                    sqlite3 CLI 미사용                                                    |
| ✅ README/settings/Telegram 변경 없음    |                                                            —                                                             |

---

## Stage 권장 명령어

```bash
# candidate-extractor 수정 test
git add src/agents/jinhee-memory-candidate-extractor.test.ts

# 전체 stage-safe 파일 (기존 12건 + 수정된 test 1건 = 13건)
git add src/agents/jinhee-memory-candidate-extractor.test.ts \
       src/agents/jinhee-memory-candidate-extractor.ts \
       src/agents/jinhee-conversation-log-writer.ts \
       src/agents/jinhee-conversation-log-writer.test.ts \
       src/plugins/plugin-adapter.types.ts \
       src/plugins/plugin-adapter.test.ts \
       src/plugins/plugin-capability-policy.ts \
       src/plugins/plugin-capability-policy.test.ts \
       src/plugins/plugin-manifest.schema.ts \
       src/plugins/plugin-runtime-guard.ts \
       src/plugins/plugin-runtime-guard.test.ts \
       extensions/telegram/src/plugin-status-message.test.ts \
       docs/audits/SEMI-AUTO-RUN-005.md \
       docs/audits/SEMI-AUTO-RUN-008.md
```

---

## 다음 단계

1. 형이 stage/commit/push 결정
2. 남은 modified 21건 (Telegram/MCP+Codex/Memory/Auto-reply) — keep/revert/discard 정책 필요
3. `better-sqlite3` 설치 결정 (promotion.test.ts 해제)
