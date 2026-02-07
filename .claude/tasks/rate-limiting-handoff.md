# Handoff: Gateway Auth Rate Limiting → hayun

## 작업
src/gateway/auth.ts에 인증 실패 rate limiting 구현 + 테스트

## 조사 완료 (minseo)
- 현재 auth.ts에 rate limiting 없음 — 실패 시 즉시 연결 종료만 수행
- 기존 패턴 2개 확인:
  1. Auth Profile Cooldown (`src/agents/auth-profiles/usage.ts:70-76`) — 지수 백오프
  2. Circuit Breaker (`src/agents/circuit-breaker.ts`) — 3회 실패 → open

## 구현 범위
1. **IP별 실패 카운터** — Map<string, { count, lastFailure }> + TTL
2. **지수 백오프 지연** — 기존 `calculateAuthProfileCooldownMs` 패턴 참고
3. **차단 로직** — 임계값 초과 시 WebSocket 차단 + HTTP 429
4. **테스트** — auth.test.ts에 rate limiting 케이스 추가

## 수정 대상 파일
| 파일 | 변경 |
|------|------|
| `src/gateway/auth.ts` | rate limiter 클래스/함수 추가 |
| `src/gateway/auth.test.ts` | rate limiting 테스트 추가 |
| `src/gateway/server/ws-connection/message-handler.ts` | 인증 전 rate limit 체크 호출 |
| `src/gateway/http-common.ts` | 429 응답 헬퍼 추가 (선택) |

## 참고 코드
- `src/agents/auth-profiles/usage.ts:70-76` (백오프 수식)
- `src/agents/circuit-breaker.ts` (상태 전이 패턴)
- `src/gateway/server/ws-connection/message-handler.ts:569-624` (현재 실패 처리)

## 완료 후
- yerin에게 리뷰 요청
- sujin에게 보고
