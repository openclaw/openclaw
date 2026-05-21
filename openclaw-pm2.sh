#!/bin/bash
# luna-memory plugin agent_end hook 이 /internal/dump-user-md 호출 시 쓰는 내부 토큰.
# luna-memory-service/.env 의 LUNA_INTERNAL_TOKEN 과 동일 값이어야 함.
export LUNA_INTERNAL_TOKEN=MTgXLfJB05pM030r3GAUOsy7rPtyxAqN

# P2.12 도구 호출 반복 폭주 차단 활성화 (2026-05-19, gemma-memory follow-up).
# tool-loop-detection.ts 가 기본 enabled:false 라 명시 활성화 필요.
# WINDOW=4 → 5회 연속 동일 (toolName, args) 시 critical 차단 + synthetic blocked tool_result 주입.
export OPENCLAW_TOOL_LOOP_GUARD_ENABLED=1
export OPENCLAW_TOOL_LOOP_GUARD_WINDOW=4

# P2.14 환각 가드 활성화 (2026-05-20, gemma-memory follow-up).
# 5/20 ClaudeU TDLib 검증 결과 황선아·정유진 케이스 환각 재발 → 코드 가드 도입.
# 조건 AND 4건 (gemma + 인명 패턴 + tool_use 0 + 거짓 도구 보고 키워드) 만족 시
# memory.sh by-person 재실행 + 텔레그램 정정 메시지 발송.
# CHAT_ID 는 @lisyoen_gemma_bot DM (8324629902). 미설정 시 정정 메시지 미발송.
export OPENCLAW_HALLUCINATION_GUARD_ENABLED=1
export OPENCLAW_HALLUCINATION_GUARD_AGENTS=gemma
export OPENCLAW_HALLUCINATION_GUARD_TIMEOUT_MS=15000
export OPENCLAW_HALLUCINATION_GUARD_MEMORY_SH=/home/lisyoen/.openclaw/agents/gemma/workspace/scripts/memory.sh
export OPENCLAW_HALLUCINATION_GUARD_CHAT_ID=8324629902
export OPENCLAW_HALLUCINATION_GUARD_API=http://127.0.0.1:9087/api/send
export OPENCLAW_HALLUCINATION_GUARD_LOG_LEVEL=info

# P2.18 (2026-05-21): tool_call arguments sanitize guard + false-negative
# retry-promise watcher. 13:45 KST 사고 (gemma assistantText 채널의
# 마크업 토큰 "<<|...|>" / "</code>" 가 tool_call args 채널까지
# 전파되어 shell syntax error 박제 실패) 대응.
export OPENCLAW_TOOL_ARG_SANITIZE_GUARD_ENABLED=1
export OPENCLAW_TOOL_ARG_SANITIZE_REMOVE_SENTINEL=1
export OPENCLAW_TOOL_ARG_SANITIZE_REMOVE_HTML_TAGS=1
export OPENCLAW_TOOL_ARG_SANITIZE_BALANCE_QUOTE=1
export OPENCLAW_FALSE_NEGATIVE_GUARD_ENABLED=1
export OPENCLAW_FALSE_NEGATIVE_GUARD_MODE=warn
export OPENCLAW_FALSE_NEGATIVE_GUARD_WINDOW_MS=10000

# P6-3a 옵션 B (2026-05-18): SIGUSR1 가 in-process restart 로 전환되어
# plugins.allow 등 plugins.* 변경 시 게이트웨이 PID 유지 (세션 단절 회피).
# 근거: src/infra/process-respawn.ts:29, src/entry.ts:84
export OPENCLAW_NO_RESPAWN=1

exec /home/lisyoen/.nvm/versions/node/v22.22.0/bin/node \
  /home/lisyoen/projects/openclaw/openclaw.mjs \
  gateway --port 9086 --allow-unconfigured
