---
summary: "디버깅 도구, 개발 프로필, 로그, 진단 방법"
read_when:
  - 문제를 진단하고 디버깅하고 싶을 때
  - 개발 환경을 설정하고 싶을 때
title: "디버깅"
---

# 디버깅

OpenClaw의 문제를 진단하고 해결하기 위한 도구와 워크플로우입니다.

## 런타임 디버그 오버라이드

채팅에서 `/debug` 명령어로 런타임 설정을 임시 변경할 수 있습니다:

```
/debug show              # 현재 오버라이드 표시
/debug set key value     # 오버라이드 설정
/debug unset key         # 오버라이드 제거
/debug reset             # 모든 오버라이드 초기화
```

활성화 필요:

```json5
{
  commands: {
    debug: true,
  },
}
```

## 개발 프로필 (Dev Profile)

프로덕션과 격리된 개발 환경:

```bash
# 개발 Gateway 시작
pnpm gateway:dev

# 개발 TUI 연결
OPENCLAW_PROFILE=dev openclaw tui
```

- 상태 디렉토리: `~/.openclaw-dev/` (프로덕션과 격리)
- 자동 기본 설정 생성
- `BOOTSTRAP.md` 건너뛰기
- 초기화: `pnpm gateway:dev:reset`

## Gateway Watch 모드

코드 변경 시 자동 재시작:

```bash
pnpm gateway:watch --force
```

## 로그 확인

### 로그 파일 위치

```
# macOS/Linux
/tmp/openclaw/openclaw-*.log

# Windows
%TEMP%\openclaw\openclaw-*.log
```

### CLI로 로그 확인

```bash
openclaw logs
openclaw logs --filter gateway
openclaw logs --filter agent
openclaw logs --filter hooks
```

### 로그 레벨

```json5
{
  logging: {
    level: "debug",     // trace, debug, info, warn, error
    redact: true,       // 민감 정보 마스킹
  },
}
```

## 로우 스트림 로깅

```bash
# 어시스턴트 스트림 (필터링 전)
openclaw agent --message "테스트" --raw-stream

# OpenAI 호환 청크
PI_RAW_STREAM=1 openclaw agent --message "테스트"
```

**주의**: 민감한 데이터가 포함될 수 있습니다. 로컬에서만 사용하세요.

## Doctor 명령어

```bash
openclaw doctor              # 대화형 진단
openclaw doctor --repair     # 자동 수리
openclaw doctor --yes        # 기본값 수락
```

검사 항목: 설정 유효성, 레거시 마이그레이션, 상태 무결성, 인증 프로필, 서비스 설정, 보안 경고

## 상태 진단

```bash
openclaw status              # 기본 상태
openclaw status --all        # 전체 진단
openclaw status --deep       # 실행 중 Gateway 프로브
openclaw health --json       # JSON 형식
```

## 채팅에서 진단

```
/status          # 상태 요약
/context list    # 컨텍스트 구성
/usage tokens    # 토큰 사용량
```

## 일반적인 디버깅 시나리오

### 에이전트가 응답하지 않음

1. `openclaw status --deep`로 상태 확인
2. `openclaw logs --filter agent`로 오류 검색
3. `openclaw models auth list`로 인증 확인
4. `/reset`으로 세션 리셋

### 채널 연결 끊김

1. `openclaw channels status <channel>` 확인
2. `openclaw channels login <channel>` 재연결
3. Gateway 재시작

### 도구 실행 실패

1. `/debug show`로 설정 확인
2. 보안 모드 확인
3. `openclaw doctor`로 샌드박스 확인
4. `openclaw logs --filter tools`로 로그 확인

### 느린 응답

1. `/usage tokens`로 컨텍스트 크기 확인
2. `/compact`로 컨텍스트 줄이기
3. 경량 모델로 전환
4. `/think low`로 사고 레벨 낮추기

## 개발자를 위한 소스 코드 가이드

| 영역              | 경로                                    |
| ----------------- | --------------------------------------- |
| Gateway 서버      | `src/gateway/server.ts`                 |
| 에이전트 루프     | `src/agents/pi-embedded-runner/run/`    |
| 채널 어댑터       | `extensions/<channel>/src/`             |
| 플러그인 SDK      | `src/plugin-sdk/`                       |
| 설정 스키마       | `src/config/zod-schema.ts`              |
| CLI 명령어        | `src/commands/`                         |

### 테스트 실행

```bash
pnpm test                        # 전체 테스트
pnpm test:watch                  # 감시 모드
pnpm test:coverage               # 커버리지
pnpm test -- --filter "파일명"   # 특정 테스트
```

## 다음 단계

- [문제 해결](/ko-KR/help/troubleshooting) - 일반적인 문제와 수정
- [FAQ](/ko-KR/help/faq) - 자주 묻는 질문
- [개발 가이드](/ko-KR/reference/contributing) - 기여 방법
