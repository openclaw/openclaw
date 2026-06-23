# SEMI-AUTO-RUN-008 — Source/Test Validation Plan

**Date:** 2026-06-23 18:51 KST  
**Status:** ✅ COMPLETE  
**Grade:** 🟢 Auto (focused test execution)

---

## 1. Source 9건 목록 (🟢 stage-candidate)

|  #  | 파일                                               | 기능/티켓                        |
| :-: | :------------------------------------------------- | -------------------------------- |
|  1  | `docs/audits/SEMI-AUTO-RUN-005.md`                 | Audit 보고서                     |
|  2  | `src/agents/jinhee-conversation-log-writer.ts`     | 대화 로그 writer (`node:sqlite`) |
|  3  | `src/agents/jinhee-memory-candidate-extractor.ts`  | 기억 후보 추출기 (`node:sqlite`) |
|  4  | `src/agents/jinhee-memory-promotion.ts`            | 기억 승격 (`sqlite3` CLI)        |
|  5  | `src/plugins/plugin-adapter.types.ts`              | Plugin 타입 정의                 |
|  6  | `src/plugins/plugin-capability-policy.ts`          | Plugin 권한 정책                 |
|  7  | `src/plugins/plugin-manifest.schema.ts`            | Plugin 매니페스트 스키마         |
|  8  | `src/plugins/plugin-runtime-guard.ts`              | Plugin 런타임 가드               |
|  9  | `extensions/telegram/src/plugin-status-message.ts` | Telegram Plugin 상태 메시지      |

---

## 2. Test-needed 6건 목록 (🟡 test-needed)

|  #  | 파일                                                    | vitest config                       |
| :-: | ------------------------------------------------------- | ----------------------------------- |
|  1  | `src/agents/jinhee-conversation-log-writer.test.ts`     | vitest.agents.config.ts             |
|  2  | `src/agents/jinhee-memory-candidate-extractor.test.ts`  | vitest.agents.config.ts             |
|  3  | `src/plugins/plugin-adapter.test.ts`                    | vitest.plugins.config.ts            |
|  4  | `src/plugins/plugin-capability-policy.test.ts`          | vitest.plugins.config.ts            |
|  5  | `src/plugins/plugin-runtime-guard.test.ts`              | vitest.plugins.config.ts            |
|  6  | `extensions/telegram/src/plugin-status-message.test.ts` | vitest.extension-telegram.config.ts |

---

## 3. 티켓/기능 매핑

| 기능 그룹                         |            Source | Test |        Test 결과         |
| :-------------------------------- | ----------------: | :--: | :----------------------: |
| 📝 **Conversation Log Writer**    |               1건 | 1건  |      ✅ 12/12 PASS       |
| 🧠 **Memory Candidate Extractor** |               1건 | 1건  |      ⚠️ 25/27 PASS       |
| 🚀 **Memory Promotion**           | 1건 (source only) |  —   | 🔴 hold (better-sqlite3) |
| 🔌 **Plugin Adapter**             |       1건 (types) | 1건  |       ✅ 6/6 PASS        |
| 🛡️ **Plugin Capability Policy**   |               1건 | 1건  |      ✅ 12/12 PASS       |
| 🚧 **Plugin Runtime Guard**       |               1건 | 1건  |     ✅ 134/134 PASS      |
| 🧾 **Plugin Manifest Schema**     | 1건 (schema only) |  —   |        (no test)         |
| 📡 **Telegram Plugin Status**     |               1건 | 1건  |      ✅ 22/22 PASS       |
| 📊 **SEMI-AUTO-RUN-005 Report**   |        1건 (docs) |  —   |         (report)         |

---

## 4. Focused Tests 실행 결과

| Test                                        | Total   |  Pass   | Fail  | Config   |
| :------------------------------------------ | ------- | :-----: | :---: | :------- |
| `jinhee-conversation-log-writer.test.ts`    | 12      |   12    |   0   | agents   |
| `jinhee-memory-candidate-extractor.test.ts` | 27      |   25    | 🐛 2  | agents   |
| `plugin-adapter.test.ts`                    | 6       |    6    |   0   | plugins  |
| `plugin-capability-policy.test.ts`          | 12      |   12    |   0   | plugins  |
| `plugin-runtime-guard.test.ts`              | 134     |   134   |   0   | plugins  |
| `plugin-status-message.test.ts`             | 22      |   22    |   0   | telegram |
| **Total**                                   | **190** | **186** | **2** |          |

## 5. 실패 분석

### ❌ `jinhee-memory-candidate-extractor.test.ts` — 2 failures (pre-existing)

1. **`report has correct sections order`** — `expected -1 to be greater than -1`
   - **원인:** Test의 `sectionOrder` 배열에 `"Summary"`, `"Stats"` 등이 있으나 source 코드는 `"## 1. Summary"`, `"## 2. Stats"` 등 숫자 접두어 포함
   - **조치:** Test 수정 필요 (`"Summary"` → `"1. Summary"` 등), **기존 소스 코드 버그 아님, test-src mismatch**

2. **`report contains no INSERT/UPDATE/DELETE references`** — `expected '…' not to match /INSERT/i`
   - **원인:** Report 생성 함수가 포함하는 설명 텍스트 내에 "INSERT" 키워드 존재 (read-only 지침 문구 등)
   - **조치:** Test regex 정밀화 필요 (negative lookahead), **기존 소스 코드 문제 아님**

> **판정:** 두 실패 모두 **pre-existing test bugs**. Source 코드는 정상 작동. Test 기대치가 source와 정확히 일치하지 않음.

---

## 6. Stage 가능 후보

| 순위 | 그룹                                   | 파일                                                                                                                               |       Test?       |                   상태                   |
| :--: | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | :---------------: | :--------------------------------------: |
|  1️⃣  | **source + test 모두 PASS**            | `jinhee-conversation-log-writer` (2 files) + `plugin-*` (5 source + 3 test) + `telegram plugin-status-message` (1 source + 1 test) |      ✅ PASS      |          ✅ **즉시 stage 가능**          |
|  2️⃣  | **source PASS, test 실패 (기존 버그)** | `jinhee-memory-candidate-extractor` (1 source + 1 test)                                                                            |  ⚠️ pre-existing  | ✅ **source stage 가능, test는 수정 후** |
|  3️⃣  | **source만, test 없음**                | `jinhee-memory-promotion.ts`                                                                                                       |         —         |         ✅ **source stage 가능**         |
|  4️⃣  | **test만 hold**                        | `jinhee-memory-promotion.test.ts`                                                                                                  | 🔴 better-sqlite3 |                 ❌ hold                  |
|  5️⃣  | **audit 보고서**                       | `SEMI-AUTO-RUN-005.md`                                                                                                             |         —         |          ✅ **즉시 stage 가능**          |

### 권장 stage 명령어

```bash
# Group 1: source files (9건)
git add docs/audits/SEMI-AUTO-RUN-005.md
git add src/agents/jinhee-conversation-log-writer.ts
git add src/agents/jinhee-memory-candidate-extractor.ts
git add src/agents/jinhee-memory-promotion.ts
git add src/plugins/plugin-adapter.types.ts
git add src/plugins/plugin-capability-policy.ts
git add src/plugins/plugin-manifest.schema.ts
git add src/plugins/plugin-runtime-guard.ts
git add extensions/telegram/src/plugin-status-message.ts

# Group 2: test files — PASS confirmed (5건, candidate-extractor 제외)
git add src/agents/jinhee-conversation-log-writer.test.ts
git add src/plugins/plugin-adapter.test.ts
git add src/plugins/plugin-capability-policy.test.ts
git add src/plugins/plugin-runtime-guard.test.ts
git add extensions/telegram/src/plugin-status-message.test.ts

# Hold: test file need better-sqlite3 (1건)
# src/agents/jinhee-memory-promotion.test.ts

# Hold: test file with pre-existing bugs — 수정 후 add 권장 (1건)
# src/agents/jinhee-memory-candidate-extractor.test.ts — test 수정 필요
```

---

## 7. 검증

| 항목                     |                                          결과 |
| :----------------------- | --------------------------------------------: |
| forbidden 변경           |                                       없음 ✅ |
| DB write                 |                       없음 ✅ (canonical: 30) |
| test 실행 그룹           |                                 6/6 실행 완료 |
| PASS 그룹                |   5/6 (conversation-log, plugins 3, telegram) |
| FAIL (pre-existing bugs) | 1/6 (candidate-extractor — test-src mismatch) |
| hold (better-sqlite3)    |                       1건 (promotion.test.ts) |
| stage 가능 후보 total    |             **14건** (source 9 + test 5 PASS) |
