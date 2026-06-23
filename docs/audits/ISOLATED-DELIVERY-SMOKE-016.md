# ISOLATED-DELIVERY-SMOKE-016 — isolated agentTurn + announce + failureAlert 실증

**Date:** 2026-06-23 12:33 KST  
**Status:** ✅ COMPLETE  
**Grade:** 🟡 Light

## 검증 결과

| 검증 항목                       | 결과 |                     비고                     |
| :------------------------------ | ---: | :------------------------------------------: |
| one-shot isolated cron/job 생성 |   ✅ |       `cron add` → id `8d29f099-724a`        |
| job 실행 (12:30 KST)            |   ✅ |              `runningAtMs` 확인              |
| failureAlert 전송               |   ✅ |            메시지 #23752, #23753             |
| 성공 announce 전송              |   ✅ |                메시지 #23756                 |
| deleteAfterRun                  |   ✅ |       job 자동 삭제 (목록에서 사라짐)        |
| timeout 처리                    |   ✅ |          120초 제한 → failureAlert           |
| 성공 결과 포함                  |   ✅ | date, kernel, canonical count, audit docs 수 |

## 이벤트 흐름 (실제)

```
12:30:00 — isolated session 시작 (runningAtMs)
12:30:?? — model-call-started → 120초 timeout 도달
12:32:02 — failureAlert #1: "cron: job execution timed out (last phase: model-call-started)"
12:32:03 — failureAlert #2: "⚠️ Cron job failed..."
12:32:34 — 성공 announce: "✅ SMOKE TEST PASSED — isolated delivery 정상 동작"
          • Date: Tue Jun 23 12:32:34 KST 2026
          • Kernel: Linux 6.18.33.1-microsoft-standard-WSL2 x86_64
          • canonical_memories: 30 rows
          • Audit docs: 15 .md files
```

## 교훈

1. **timeoutSeconds = 작업 예상 시간 × 3 추천** — 120초는 너무 짧았다. 모델 호출 시작 후 타임아웃 발생.
2. **failureAlert → after=1 추천 확정** — 단 1회 실패만으로 즉시 Telegram 알림.
3. **성공 announce는 최종 결과까지 포함** — 직접 확인 불필요.
4. **deleteAfterRun 정상 작동 확인** — 잔여물 없음.

## 🔴 Heavy 실행 템플릿 개선

```jsonc
{
  "payload": {
    "timeoutSeconds": 300, // ← 120→300으로 상향
    // ...
  },
}
```

## 최종 판정

```
ISOLATED-DELIVERY-SMOKE-016: ✅ PASS — 패턴 실증 완료

job 생성:                ✅
Telegram 성공 announce:  ✅ (메시지 #23756)
failureAlert:            ✅ (메시지 #23752, #23753)
deleteAfterRun:          ✅
timeout:                 ⚠️ 120초 부족 → 300초 권장
DB write:                ❌ 없음 ✅
forbidden 변경:          ❌ 없음 ✅

결론: isolated agentTurn + announce + failureAlert 패턴 → ✅ 검증 완료
앞으로 🔴 Heavy 작업 이 패턴으로 실행 가능
```
