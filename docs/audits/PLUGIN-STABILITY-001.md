# PLUGIN-STABILITY-001: Telegram Ingress Offset Persist 안정화

**Status:** ✅ 완료 (2026-06-22 20:15 KST)

## 목적

Telegram isolated ingress poller 쪽에서 `update_id` offset persist가 불완전하여 standalone slash command가 poller downtime/restart 시 유실될 가능성을 해결한다.

## 문제 분석

Worker (`telegram-ingress-worker.runtime.ts`)가 `getUpdates`를 호출한 후 각 update를 spool하고 `spooled` 메시지를 main process로 전송한다.

- `spooled` 메시지는 `updateId`를 포함 → main process에서 `persistUpdateId()` 호출 ✅
- `poll-success` 메시지는 `offset`만 포함, `updateId`가 없음 → **persist되지 않음** ❌

격차: worker가 50개의 update를 poll한 후 `poll-success`를 보내지만 모든 `spooled` 메시지가 main process에 도달하기 전에 crash/restart가 발생하면 마지막 `spooled`들의 offset이 persist되지 않음. worker는 restart 후 `update_id`보다 높은 offset부터 다시 poll 시작하므로 일부 update가 유실될 수 있음.

## 변경 사항

### 1. `telegram-ingress-worker.ts` — 메시지 타입 확장

- `poll-success` 타입에 `updateId: number | null` 필드 추가
- 기존 `offset`(getUpdates 요청용)과 별도로 실제 highest update_id 전달

### 2. `telegram-ingress-worker.runtime.ts` — highest updateId 전송

```typescript
post({
  type: "poll-success",
  offset,
  updateId: lastUpdateId, // ← 이번 poll batch의 가장 높은 update_id
  count: result.length,
  finishedAt: Date.now(),
});
```

### 3. `polling-session.ts` — poll-success 핸들러에 persist 추가

```typescript
if (typeof message.updateId === "number") {
  this.opts.persistUpdateId(message.updateId).catch((err) => {
    this.opts.log(`[telegram][diag] persist update offset from poll-success failed: ...`);
  });
}
```

### 4. `polling-session.test.ts` — mock 타입/메시지 업데이트

- 3곳의 mock `poll-success` 호출에 `updateId: null` 추가
- WorkerPollSuccessListener 타입에 `updateId` 필드 추가

## 검증

| 항목                                                               |        결과         |
| ------------------------------------------------------------------ | :-----------------: |
| unit-fast tests (memory-bridge)                                    |      27/27 ✅       |
| agents tests (conversation-log-writer)                             |      12/12 ✅       |
| extension-telegram (polling-session + bot-message + plugin-status) |     104/104 ✅      |
| **Total**                                                          | **131/131 PASS** ✅ |
| Build (`pnpm run build`)                                           |     ✅ (142.8s)     |
| Gateway restart                                                    |         ✅          |
| dist 코드 확인 (`monitor-polling.runtime-*.js`)                    |         ✅          |
| dist 코드 확인 (`telegram-ingress-worker.runtime.js`)              |         ✅          |
| 금지 파일 변경 없음 (package.json, lock, config, secrets, DB)      |         ✅          |

## 안전성

- `persistUpdateId` 내부에서 이미 ordering guard 존재: `lastUpdateId`보다 작거나 같은 값은 skip
- `catch`로 persist 실패 시 graceful handling
- 기존 `spooled` 핸들러의 persist와 병렬로 동작하여 중복 persist는 monitor에서 자동 무시
- worker가 message를 순차적으로 전송하므로 경합 조건 없음

## 보호 규칙 준수

- [x] `package.json` / `pnpm-lock.yaml` — 변경 없음
- [x] `TOOLS.md` — 변경 없음
- [x] `openclaw.json` — 변경 없음
- [x] model_selection / secrets / DB — 변경 없음
- [x] Schema migration 없음
- [x] 기존 동작 변경 없음 (spooled handler 유지 + poll-success에만 추가)

## 보너스 — ticket 요구사항 외 검증

- standalone slash command (`/mcp_status`, `/plugins`) → early return 확인
- `spooled` handler의 persist → 기존 유지, 변경 없음
- `monitor.ts`의 `persistUpdateId` ordering guard — 검증 완료 (이미 있음)
