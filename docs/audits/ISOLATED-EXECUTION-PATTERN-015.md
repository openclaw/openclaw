# ISOLATED-EXECUTION-PATTERN-015 — 🔴 Heavy 장기 작업 실행 패턴

**Date:** 2026-06-23 12:28 KST  
**Status:** ✅ COMPLETE  
**Grade:** 🟡 Light (운영 규칙 문서화, DB write 없음)

## 배경

🔴 Heavy 작업을 메인 세션에서 직접 실행하면 아래 문제가 발생한다:

| 문제            |                           원인 |             결과             |
| :-------------- | -----------------------------: | :--------------------------: |
| 툴콜 실패       | read-only 모드 누락, 체인 끊김 | Telegram 응답 없이 turn 종료 |
| session timeout |      작업이 예상보다 오래 걸림 |    강제 종료, 결과 미전달    |
| 중간 오류       |   DB write 실패, 네트워크 오류 |    형이 무슨 일인지 모름     |

**해결책:** 🔴 Heavy + 5분 초과 예상 작업은 **isolated agentTurn**으로 격리 실행.  
성공/실패 모두 Telegram으로 자동 전달.

---

## 실행 규칙

### 대상 작업

- 🔴 Heavy: DB write, canonical 변경, config 변경, gateway restart 등
- 5분 초과 예상 작업
- 외부 API 호출 (비용 발생 가능)

### 실행 흐름

```
형 → TASK (Telegram)
  ↓
진희 → isolated agentTurn cron job 생성
  ↓
OpenClaw Gateway → isolated session에서 안전하게 실행
  ↓
성공 → announce delivery로 Telegram 전송
실패 → failureAlert로 Telegram 전송
  ↓
형 → 결과 확인 → 다음 작업 결정
```

### 템플릿

#### payload 구성

```jsonc
{
  "payload": {
    "kind": "agentTurn",
    "message": "TASK: <티켓명>\n등급: 🔴 Heavy\n\n<상세 작업 내용>",
    "timeoutSeconds": 300, // 작업 예상 시간 * 3 (검증: ISOLATED-DELIVERY-SMOKE-016)
    "model": "opencode-go/deepseek-v4-pro", // 필요 시 모델 지정
    "lightContext": false, // false = 전체 컨텍스트 로드
    "fallbacks": [], // fallback 금지 (J-005A)
    "toolsAllow": ["exec", "read", "write", "edit", "sqlite__*"], // 필요한 툴만
  },
}
```

#### sessionTarget + delivery 구성

```jsonc
{
  "sessionTarget": "isolated",
  "delivery": {
    "mode": "announce",
    "channel": "telegram",
    "to": "8180190219", // 형 Telegram ID
  },
  "failureAlert": {
    "after": 1, // 1회 실패 시 알림
    "channel": "telegram",
    "to": "8180190219",
  },
}
```

---

## 실제 적용 예시

### 예시 1: canonical UPDATE (MEMORY-BRIDGE-THRESHOLD-010)

```jsonc
{
  "name": "heavy-id103-update",
  "schedule": { "kind": "at", "at": "2026-06-23T12:00:00+09:00" },
  "deleteAfterRun": true,
  "sessionTarget": "isolated",
  "payload": {
    "kind": "agentTurn",
    "message": "TASK: MEMORY-BRIDGE-THRESHOLD-010\n등급: 🔴 Heavy\n\nID 103 truth_confidence를 1000에서 950으로 UPDATE.\n\n허용:\n- sqlite3 /home/savit/ai/jinhee_data/jinhee.db 'UPDATE canonical_memories SET truth_confidence=950 WHERE id=103;'\n- 전후 확인 (SELECT)\n\n금지:\n- 다른 row 수정 금지\n- INSERT/DELETE 금지\n- MEMORY.md/config 변경 금지\n\n검증 후 보고",
    "timeoutSeconds": 60,
    "toolsAllow": ["exec", "read", "write"],
  },
  "delivery": {
    "mode": "announce",
    "channel": "telegram",
    "to": "8180190219",
  },
  "failureAlert": {
    "after": 1,
    "channel": "telegram",
    "to": "8180190219",
  },
}
```

### 예시 2: DB INSERT (MEMORY-OPERATING-RULE-007)

```jsonc
{
  "name": "heavy-id107-insert",
  "schedule": { "kind": "at", "at": "2026-06-23T11:48:00+09:00" },
  "deleteAfterRun": true,
  "sessionTarget": "isolated",
  "payload": {
    "kind": "agentTurn",
    "message": "TASK: MEMORY-OPERATING-RULE-007\n등급: 🔴 Heavy\n\ncanonical_memories에 위험도 등급제 운영 규칙 INSERT.\n\nINSERT INTO canonical_memories (content, truth_confidence, source_count, category, auto_type, created_at)\nVALUES ('작업 운영은 위험도 등급제로 나눈다...', 950, 1, 'operational_rule', 'operational_rule', datetime('now'));\n\n검증: INSERT 후 SELECT COUNT(*) = 30",
    "timeoutSeconds": 60,
    "toolsAllow": ["exec", "read"],
  },
  "delivery": {
    "mode": "announce",
    "channel": "telegram",
    "to": "8180190219",
  },
  "failureAlert": {
    "after": 1,
    "channel": "telegram",
    "to": "8180190219",
  },
}
```

---

## 간편 실행 함수

진희가 직접 cron job 생성할 때는 아래 패턴으로 실행:

```
cron add:
  name: "heavy-<티켓명>"
  schedule: at (즉시 실행, <ISO>)
  deleteAfterRun: true
  sessionTarget: isolated
  payload.kind: agentTurn
  payload.message: <TASK 내용>
  payload.timeoutSeconds: <작업 예상 시간 * 3> (최소 300, smoke-016 검증)
  payload.toolsAllow: [<필요한 툴>]
  delivery.mode: announce
  delivery.channel: telegram
  delivery.to: 8180190219
  failureAlert.after: 1
  failureAlert.channel: telegram
  failureAlert.to: 8180190219
```

### toolsAllow 권장값

| 작업 유형     |                          toolsAllow |
| :------------ | ----------------------------------: |
| DB write      |         `["exec", "read", "write"]` |
| preview/smoke |                  `["exec", "read"]` |
| 코드 패치     | `["exec", "read", "write", "edit"]` |
| config 변경   | `["exec", "read", "write", "edit"]` |

---

## 주의사항

- `sessionTarget = "isolated"` 필수. `"main"` 쓰면 메인 세션과 충돌.
- `deleteAfterRun = true` → 1회 실행 후 job 자동 삭제 (잔여물 방지).
- `failureAlert.after = 1` → **단 1회 실패만으로 Telegram 알림.**
- `failureAlert`은 cron job 레벨에서만 동작. payload 내 try/catch와 중복 아님.
- `schedule.kind = "at"` + `deleteAfterRun = true` = **1회성 즉시 실행.**
- `timeoutSeconds`는 작업 예상 시간 × 3 이상 설정. 실제 smoke 검증(ISOLATED-DELIVERY-SMOKE-016)에서 120초로는 간단한 read-only 작업도 타임아웃 발생. 최소 300초 권장.

---

## 참조

- [CODEX-DELEGATION-RULE-011](./CODEX-DELEGATION-RULE-011.md) — 반자동 개발 위임 규칙
- [J-005A](../MEMORY.md) — Model Routing Policy (fallback 금지)
