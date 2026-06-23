# SEMI-AUTO-RUN-003 — Workspace Inventory Reconcile

**Date:** 2026-06-23 13:06 KST  
**Status:** ✅ COMPLETE  
**Grade:** 🟢 Auto (read-only inventory reconcile)

---

## 1. 정확한 git status 기준 카운트

```
git status --short 기준:
  modified (M):    21 lines = 21개 파일 (실제 파일 수와 동일)
  untracked (??):  22 lines = 42개 실제 파일 (디렉토리 단위 집계)
  Total:           43 lines
```

### modified 21건 — 정확한 목록

|  #  | 파일                                                    | 영역            |            수정량 |
| :-: | ------------------------------------------------------- | :-------------- | ----------------: |
|  1  | `.gitignore`                                            | housekeeping    | +5 (✅ 우리 작업) |
|  2  | `ext/telegram/src/bot-message-dispatch.ts`              | Telegram Plugin |            +63/-5 |
|  3  | `ext/telegram/src/bot-message.test.ts`                  | Telegram Plugin |           +188/-2 |
|  4  | `ext/telegram/src/bot-message.ts`                       | Telegram Plugin |           +107/-0 |
|  5  | `ext/telegram/src/polling-session.test.ts`              | Telegram Plugin |             +5/-2 |
|  6  | `ext/telegram/src/polling-session.ts`                   | Telegram Plugin |             +8/-0 |
|  7  | `ext/telegram/src/telegram-ingress-worker.runtime.ts`   | Telegram Plugin |             +1/-0 |
|  8  | `ext/telegram/src/telegram-ingress-worker.ts`           | Telegram Plugin |             +1/-0 |
|  9  | `src/agents/agent-bundle-mcp-materialize.ts`            | MCP Catalog     |            +33/-1 |
| 10  | `src/agents/agent-bundle-mcp-runtime.test.ts`           | MCP Catalog     |          +352/-12 |
| 11  | `src/agents/agent-bundle-mcp-runtime.ts`                | MCP Catalog     |           +87/-36 |
| 12  | `src/agents/agent-bundle-mcp-tools.materialize.test.ts` | MCP Catalog     |            +39/-0 |
| 13  | `src/agents/agent-bundle-mcp-types.ts`                  | MCP Catalog     |             +7/-1 |
| 14  | `src/agents/codex-mcp-config.test.ts`                   | Codex Config    |            +27/-0 |
| 15  | `src/agents/codex-mcp-config.ts`                        | Codex Config    |             +3/-1 |
| 16  | `src/agents/codex-mcp-config.types.ts`                  | Codex Config    |             +2/-0 |
| 17  | `src/agents/embedded-agent-runner/run.ts`               | Memory Bridge   |             +4/-4 |
| 18  | `src/agents/embedded-agent-runner/run/attempt.ts`       | Memory Bridge   |            +14/-0 |
| 19  | `src/agents/embedded-agent-runner/run/params.ts`        | Memory Bridge   |             +3/-0 |
| 20  | `src/auto-reply/get-reply-options.types.ts`             | Auto-reply      |             +3/-0 |
| 21  | `src/auto-reply/reply/agent-runner-execution.ts`        | Auto-reply      |             +1/-0 |

### untracked 22건 — 디렉토리/파일 정확한 목록

|   #   | git line                      |  실제 파일 수  | 구성                                                                                          |
| :---: | ----------------------------- | :------------: | :-------------------------------------------------------------------------------------------- |
|   1   | `docs/audits/`                |  **21개 .md**  | 금일 audit 보고서 전부                                                                        |
|  2~3  | `scripts/jinhee-memory-*.mjs` |    **2개**     | bridge-preview, memory-promotion                                                              |
| 4~13  | `src/agents/jinhee-*`         | **10개** (5쌍) | conversation-log-writer, db-write-guard, memory-bridge, candidate-extractor, memory-promotion |
| 14~20 | `src/plugins/plugin-*`        |    **7개**     | adapter, capability-policy, manifest-schema, runtime-guard                                    |
| 21~22 | `ext/telegram/plugin-*`       |    **2개**     | plugin-status-message                                                                         |

---

## 2. SEMI-AUTO-RUN-002 불일치 원인

| 문제             | SEMI-AUTO-RUN-002        |         실제          | 원인                                              |
| :--------------- | ------------------------ | :-------------------: | :------------------------------------------------ |
| modified 집계    | "21건" + 별도 .gitignore | 21건 (gitignore 포함) | .gitignore 이중 집계                              |
| untracked "건수" | "22건"                   |  22 lines = 42 files  | git line 수 vs 파일 수 혼동                       |
| 표의 번호 범위   | 1~42                     |       22 lines        | audit 파일을 개별 집계했지만 git line 수와 불일치 |

---

## 3. 후보 분류

### Modified 21건 — stage-safe / hold

| 후보              | 파일                      |        판단        | 사유                                                 |
| :---------------- | ------------------------- | :----------------: | :--------------------------------------------------- |
| 🟢 **stage-safe** | `.gitignore`              | ✅ **commit 가능** | bak/backup 패턴 3줄, 검증 완료                       |
| 🔴 **hold #1**    | Telegram Plugin (7건)     |        보류        | 6/5~11 작업 중단. Telegram MCP 통합 일괄 결정 필요   |
| 🔴 **hold #2**    | MCP Catalog + Codex (8건) |        보류        | 6/5~11 작업 중단. MCP 선택적 로딩 기능. 형 결정 필요 |
| 🔴 **hold #3**    | Memory Bridge (3건)       |        보류        | 6/22 최근 작업. attempt.ts + run.ts — 형 결정 필요   |
| 🔴 **hold #4**    | Auto-reply (2건)          |        보류        | 6/22 최근 작업. 형 결정 필요                         |

### Untracked 22 entries (42 files) — stage-safe / test-required / hold

| 후보                 | 파일                                 |        판단         | 사유                                  |
| :------------------- | ------------------------------------ | :-----------------: | :------------------------------------ |
| 🟢 **stage-safe A**  | `docs/audits/` (21건)                | ✅ **git add 가능** | 모두 금일 세션 read-only 산출물       |
| 🟢 **stage-safe B**  | `scripts/jinhee-*` (2건)             | ✅ **git add 가능** | preview+promotion 스크립트, read-only |
| 🟢 **stage-safe C**  | `jinhee-memory-bridge.*` (2건)       | ✅ **git add 가능** | 14/14 테스트 통과, 금일 정착 완료     |
| 🟢 **stage-safe D**  | `jinhee-db-write-guard.*` (2건)      | ✅ **git add 가능** | 13/13 테스트 통과                     |
| 🟡 **test-required** | `conversation-log-writer.*` (2건)    |    테스트 후 add    | 테스트 결과 미확인                    |
| 🟡 **test-required** | `plugin-runtime-guard.*` (2건)       |    테스트 후 add    | 테스트 결과 미확인                    |
| 🟡 **test-required** | `plugin-adapter.*` (2건)             |    테스트 후 add    | 테스트 필요                           |
| 🟡 **test-required** | `plugin-capability-policy.*` (2건)   |    테스트 후 add    | 테스트 필요                           |
| 🟡 **test-required** | `plugin-manifest.schema.ts` (1건)    |    테스트 후 add    | 테스트 필요                           |
| 🟡 **test-required** | `plugin-status-message.*` (2건)      |    테스트 후 add    | 테스트 필요                           |
| 🔴 **hold**          | `jinhee-memory-promotion.*` (2건)    |        보류         | better-sqlite3 없음                   |
| 🔴 **hold**          | `jinhee-candidate-extractor.*` (2건) |        보류         | better-sqlite3 없음                   |

---

## 4. 요약

| 구분                                    |             건수 | 처리                                                                                       |
| :-------------------------------------- | ---------------: | :----------------------------------------------------------------------------------------- |
| **Modified: 🟢 commit 가능**            | 1건 (.gitignore) | 즉시 가능                                                                                  |
| **Modified: 🔴 hold**                   |             20건 | 형 결정 필요 — commit or discard                                                           |
| **Untracked: 🟢 stage-safe**            |             27건 | 즉시 git add 가능 (audit 21 + scripts 2 + bridge 2 + guard 2)                              |
| **Untracked: 🟡 test-required**         |             11건 | 테스트 후 git add (conv-log 2 + adapter 2 + cap-pol 2 + guard 2 + schema 1 + status-msg 2) |
| **Untracked: 🔴 hold (better-sqlite3)** |              4건 | promotion 2 + candidate 2                                                                  |

**실제 파일 총계: 27 + 11 + 4 = 42 files ✅**

| 🟢 **stage-safe** | 27건 | 즉시 git add 가능 |
| 🟡 **test-required** | 11건 | 테스트 후 git add |
| 🔴 **hold** | 4건 | better-sqlite3 설치 후 add |

---

## 5. 형 승인 필요 항목

```
A. modified 20건 (Telegram+MCP+Memory+Auto-reply)
   → commit? discard? 보류? (일괄 결정)

B. untracked 27건 (stage-safe)
   → git add 진행? (내용상 문제 없음)

C. untracked 11건 (test-required)
   → 테스트 먼저? 아니면 add 후 테스트?

D. untracked 4건 (better-sqlite3)
   → pnpm install better-sqlite3?

E. 전체 commit/push
   → 한 번에 push? 아니면 선별?
```

## 6. 검증

| 항목                |                                                 결과 |
| :------------------ | ---------------------------------------------------: |
| forbidden 변경      |                                              없음 ✅ |
| DB write            |                 없음 ✅ (canonical:30, memories:214) |
| git add/commit/push |                                              없음 ✅ |
| 숫자 불일치 해소    | ✅ (원인: git line vs file 수, .gitignore 이중 집계) |
| report 위치         |                   `docs/audits/SEMI-AUTO-RUN-003.md` |

## 최종 판정

```
SEMI-AUTO-RUN-003: ✅ COMPLETE

inventory reconciled.
  modified: 21 files (1 stage-safe + 20 hold)
  untracked: 22 lines = 42 files (27 stage-safe + 11 test-required + 4 hold)
  불일치 원인: git line 수 vs 실제 파일 수 차이 + .gitignore 이중 집계
  forbidden: clean ✅

형 결정 대기: A~E 5건
```
