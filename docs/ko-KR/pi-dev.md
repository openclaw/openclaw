---
title: "Pi 개발 워크플로우"
---

# Pi 개발 워크플로우

이 가이드는 OpenClaw의 pi 통합 작업을 위한 적절한 워크플로우를 요약한 것입니다.

## 타입 체크 및 린트

- 타입 체크 및 빌드: `pnpm build`
- 린트: `pnpm lint`
- 포맷 체크: `pnpm format`
- 푸시 전 전체 게이트: `pnpm lint && pnpm build && pnpm test`

## Pi 테스트 실행

Pi 통합 테스트 세트를 위한 전용 스크립트를 사용하세요:

```bash
scripts/pi/run-tests.sh
```

실제 프로바이더 동작을 테스트하는 라이브 테스트를 포함하려면:

```bash
scripts/pi/run-tests.sh --live
```

이 스크립트는 다음의 글로브 패턴을 사용하여 Pi 관련 유닛 테스트를 모두 실행합니다:

- `src/agents/pi-*.test.ts`
- `src/agents/pi-embedded-*.test.ts`
- `src/agents/pi-tools*.test.ts`
- `src/agents/pi-settings.test.ts`
- `src/agents/pi-tool-definition-adapter.test.ts`
- `src/agents/pi-extensions/*.test.ts`

## 수동 테스트

권장 흐름:

- 개발 모드로 게이트웨이 실행:
  - `pnpm gateway:dev`
- 에이전트를 직접 트리거:
  - `pnpm openclaw agent --message "Hello" --thinking low`
- 대화형 디버깅을 위한 TUI 사용:
  - `pnpm tui`

도구 호출 동작에 대해서는 `read` 또는 `exec` 액션을 프롬프트하여 도구 스트리밍과 페이로드 처리를 볼 수 있습니다.

## 클린 슬레이트 리셋

상태는 OpenClaw 상태 디렉터리 아래 저장됩니다. 기본값은 `~/.openclaw`입니다. `OPENCLAW_STATE_DIR`이 설정된 경우, 해당 디렉터리를 대신 사용합니다.

모든 것을 리셋하려면:

- 설정은 `openclaw.json`
- 인증 프로필 및 토큰은 `credentials/`
- 에이전트 세션 기록은 `agents/<agentId>/sessions/`
- 세션 인덱스는 `agents/<agentId>/sessions.json`
- 레거시 경로가 존재할 경우 `sessions/`
- 빈 작업 공간을 원한다면 `workspace/`

세션만 리셋하고 싶다면 해당 에이전트의 `agents/<agentId>/sessions/`와 `agents/<agentId>/sessions.json`을 삭제하십시오. 인증을 다시 하고 싶지 않다면 `credentials/`를 유지하십시오.

## 참고 자료

- [https://docs.openclaw.ai/testing](https://docs.openclaw.ai/testing)
- [https://docs.openclaw.ai/start/getting-started](https://docs.openclaw.ai/start/getting-started)
