---
summary: Discord 기본 폴백을 전용 봇으로 분리하는 지연 배포 계획
read_when:
  - 폴백/기본 Discord 정체성을 에이전트 바인딩 정체성으로부터 분리할 때
title: "보류: 전용 Discord 폴백 봇"
---

# 보류: 전용 Discord 폴백 봇

상태: 보류 (아직 미적용)

## 배경

현재 런타임 폴백은 `channels.discord.accounts.default`를 사용하며, 안정성을 위해 의도적으로 ruda와 동일하게 맞춰져 있다. 이로써 계정 해석이 default로 폴백될 때 `Discord bot token missing for account default` 오류를 방지한다.

## 향후 분리 이유

- 폴백/시스템 트래픽과 ruda 에이전트 정체성 간의 결합도를 낮춘다.
- 운영 메시지 vs 에이전트 작성 메시지의 감사 명확성을 높인다.
- 향후 토큰 로테이션을 더 안전하고 영향 없이 수행할 수 있다.

## 목표 상태

- 기존 에이전트별 바인딩(agentId → accountId)은 변경 없이 유지.
- `accounts.default` 전용 Discord 봇 정체성을 새로 생성.
- 폴백/시스템/사용자 직접 요청 등 바인딩되지 않은 흐름을 해당 전용 default 계정으로 이동.

## 배포 절차 (향후)

1. 전용 Discord 봇 및 토큰 생성.
2. `channels.discord.accounts.default`를 전용 토큰/설정으로 변경.
3. `channels.discord.accounts.ruda`는 변경 없이 유지.
4. `ai.openclaw.gateway` 재시작.
5. 폴백 토큰 오류 없음 확인 + 아웃바운드 메시지에서 예상 봇 정체성 확인.

## 롤백

- `channels.discord.accounts.default`를 이전 정상값(현재 ruda와 동일)으로 복원.
- Gateway 재시작 후 로그 재확인.

## 검증 체크리스트

- `Discord bot token missing for account default` 로그 엔트리가 새로 발생하지 않음.
- 에이전트별 매핑 메시지는 여전히 각 에이전트 바인딩 봇 정체성 사용.
- 폴백/비바인딩 흐름이 전용 default 정체성으로 정상 해석됨.
