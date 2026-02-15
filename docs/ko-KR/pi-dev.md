---
title: "Pi Development Workflow"
x-i18n:
  source_hash: b6c44672306d8867a3b09332c393981223b21a28d3b432bd281fdb8032bc9fd0
---

# Pi 개발 워크플로

이 가이드는 OpenClaw에서 pi 통합 작업을 위한 정상적인 작업 흐름을 요약합니다.

## 유형 검사 및 Linting

- 유형 확인 및 빌드: `pnpm build`
- 린트: `pnpm lint`
- 형식 확인: `pnpm format`
- 푸시 전 풀 게이트: `pnpm lint && pnpm build && pnpm test`

## Pi 테스트 실행

pi 통합 테스트 세트에 대한 전용 스크립트를 사용하십시오.

```bash
scripts/pi/run-tests.sh
```

실제 공급자 동작을 실행하는 실시간 테스트를 포함하려면 다음을 수행하세요.

```bash
scripts/pi/run-tests.sh --live
```

스크립트는 다음 글로브를 통해 모든 pi 관련 단위 테스트를 실행합니다.

- `src/agents/pi-*.test.ts`
- `src/agents/pi-embedded-*.test.ts`
- `src/agents/pi-tools*.test.ts`
- `src/agents/pi-settings.test.ts`
- `src/agents/pi-tool-definition-adapter.test.ts`
- `src/agents/pi-extensions/*.test.ts`

## 수동 테스트

권장되는 흐름:

- 개발 모드에서 게이트웨이를 실행합니다.
  - `pnpm gateway:dev`
- 에이전트를 직접 트리거합니다.
  - `pnpm openclaw agent --message "Hello" --thinking low`
- 대화형 디버깅을 위해 TUI를 사용합니다.
  - `pnpm tui`

도구 호출 동작의 경우 `read` 또는 `exec` 작업을 요청하여 도구 스트리밍 및 페이로드 처리를 볼 수 있습니다.

## 클린 슬레이트 재설정

상태는 OpenClaw 상태 디렉토리에 있습니다. 기본값은 `~/.openclaw`입니다. `OPENCLAW_STATE_DIR`가 설정된 경우 해당 디렉터리를 대신 사용하세요.

모든 것을 재설정하려면:

- `openclaw.json` 구성용
- 인증 프로필 및 토큰의 경우 `credentials/`
- `agents/<agentId>/sessions/` 에이전트 세션 기록
- 세션 인덱스의 경우 `agents/<agentId>/sessions.json`
- `sessions/` 레거시 경로가 존재하는 경우
- `workspace/` 빈 작업 공간을 원하는 경우

세션만 재설정하려면 해당 에이전트의 `agents/<agentId>/sessions/` 및 `agents/<agentId>/sessions.json`를 삭제하세요. 재인증을 원하지 않으면 `credentials/`를 유지하세요.

## 참고자료

- [https://docs.openclaw.ai/testing](https://docs.openclaw.ai/testing)
- [https://docs.openclaw.ai/start/getting-started](https://docs.openclaw.ai/start/getting-started)
