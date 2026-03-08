# OpenClaw Migration Guide

이 문서는 버전별 BREAKING 변경사항과 마이그레이션 방법을 정리합니다.

---

## 빠른 마이그레이션 체크리스트

```bash
# 1. 설정 자동 수정
openclaw doctor --fix

# 2. 플러그인 업데이트
openclaw plugins update

# 3. 문제 진단
openclaw doctor

# 4. (Teams 사용 시) 플러그인 설치
openclaw plugins install @openclaw/msteams

# 5. (Zalo 사용 시) 세션 갱신
openclaw channels login --channel zalouser
```

> 대부분의 설정 변경은 `openclaw doctor --fix`로 자동 마이그레이션됩니다.

---

## v2026.3.2 (Latest)

### 1. `tools.profile` 기본값 `messaging`으로 변경

- **영향**: 신규 설치 (기존 설치는 영향 없음)
- **내용**: 신규 로컬 설치 시 코딩/시스템 도구가 기본 비활성화
- **조치**: 코딩/시스템 도구가 필요하면 프로필을 수동으로 설정

### 2. ACP dispatch 기본 활성화

- **영향**: 모든 사용자
- **내용**: ACP 턴 라우팅이 기본 활성화됨
- **조치**: 비활성화 필요 시 `acp.dispatch.enabled=false` 설정
- **문서**: https://docs.openclaw.ai/tools/acp-agents

### 3. Plugin SDK `registerHttpHandler` 제거

- **영향**: 플러그인 개발자
- **내용**: `api.registerHttpHandler(...)` API가 제거됨
- **조치**: `api.registerHttpRoute({ path, auth, match, handler })`로 변경. 동적 웹훅은 `registerPluginHttpRoute(...)` 사용

### 4. Zalo Personal 외부 CLI 의존성 제거

- **영향**: Zalo 사용자
- **내용**: `zca`-호환 CLI 바이너리(`openzca`, `zca-cli`) 의존성 제거, JS 네이티브 방식으로 전환
- **조치**: 업그레이드 후 `openclaw channels login --channel zalouser`로 세션 갱신

---

## v2026.3.1

### 5. Node exec 승인에 `systemRunPlan` 필수

- **영향**: 커스텀 통합, 테스트
- **내용**: `host=node` 승인 요청에 `systemRunPlan`이 없으면 거부됨
- **조치**: 승인 페이로드에 `systemRunPlan` 포함

### 6. `system.run` 실행 시 canonical path 고정

- **영향**: 통합 테스트
- **내용**: 경로 토큰 명령어가 `realpath`로 고정됨 (예: `tr` → `/usr/bin/tr`)
- **조치**: 테스트에서 전체 경로 사용하도록 변경

---

## v2026.2.25

### 7. Heartbeat DM 전송 기본값 `allow`로 복구

- **영향**: DM 차단 설정을 사용하던 사용자
- **내용**: v2026.2.24에서 기본 차단이었던 것이 다시 `allow`로 변경
- **조치**: DM 차단을 유지하려면 `agents.defaults.heartbeat.directPolicy: "block"` 설정

---

## v2026.2.24

### 8. Heartbeat DM 전송 기본 차단

- **영향**: 모든 사용자
- **내용**: DM(direct chat) 대상에 대한 Heartbeat 전송이 기본 차단됨
- **조치**: DM 전송이 필요하면 명시적으로 허용 설정 (v2026.2.25에서 다시 allow로 복구됨)

### 9. Docker `network: "container:<id>"` 기본 차단

- **영향**: Docker sandbox 사용자
- **내용**: 컨테이너 네임스페이스 조인이 보안상 기본 차단됨
- **조치**: 필요 시 `agents.defaults.sandbox.docker.dangerouslyAllowContainerNamespaceJoin: true` 설정

---

## v2026.2.23

### 10. 브라우저 SSRF 정책 기본값 변경

- **영향**: 브라우저 도구 사용자
- **내용**: `browser.ssrfPolicy.allowPrivateNetwork` → `browser.ssrfPolicy.dangerouslyAllowPrivateNetwork`으로 키 변경. 기본값은 trusted-network 모드
- **조치**: `openclaw doctor --fix`로 자동 마이그레이션

---

## v2026.2.22

### 11. Google Antigravity 프로바이더 제거

- **영향**: Google Antigravity를 사용하던 사용자
- **내용**: `google-antigravity/*` 모델/프로필 설정이 더 이상 동작하지 않음
- **조치**: `google-gemini-cli` 또는 지원 프로바이더로 마이그레이션

### 12. 도구 실패 시 상세 에러 숨김

- **영향**: 디버깅 워크플로
- **내용**: 도구 실패 시 요약만 표시, 상세 에러(프로바이더 메시지, 로컬 경로 등)는 기본 숨김
- **조치**: `/verbose on` 또는 `/verbose full`로 상세 에러 확인

### 13. `session.dmScope` 기본값 `per-channel-peer`

- **영향**: DM 세션 관리
- **내용**: CLI 로컬 온보딩 시 DM 스코프가 채널별 피어 단위로 기본 설정
- **조치**: 공유 DM 연속성이 필요하면 `session.dmScope: "main"` 설정

### 14. 채널 스트리밍 설정 통합

- **영향**: 채널 설정 관리자
- **내용**: 스트리밍 설정이 `channels.<channel>.streaming` (off | partial | block | progress)로 통합. Slack 네이티브 스트림은 `channels.slack.nativeStreaming`으로 분리
- **조치**: `openclaw doctor --fix`로 레거시 키 자동 마이그레이션

### 15. Gateway device-auth v1 서명 제거

- **영향**: 디바이스 인증 클라이언트
- **내용**: v1 서명 방식이 제거됨. v2 페이로드 서명 + `connect.challenge` nonce 필수
- **조치**: 디바이스 인증 클라이언트를 v2 서명 방식으로 업데이트

---

## v2026.2.15

### 16. Gateway auth "none" 모드 제거

- **영향**: 모든 사용자 (중요)
- **내용**: 인증 없이 Gateway를 실행할 수 없음
- **조치**: 반드시 token 또는 password 설정 (Tailscale Serve identity는 허용)

```bash
# 토큰 생성 예시
openclaw gateway --generate-token
```

---

## v2026.2.12

### 17. Control UI HTTP 인증 거부 (기본)

- **영향**: 웹 UI 사용자
- **내용**: HTTP(비보안)에서 디바이스 ID 없이 접근 시 거부
- **조치**: HTTPS(Tailscale Serve) 사용 또는 `gateway.controlUi.allowInsecureAuth: true` 설정
- **문서**: https://docs.openclaw.ai/web/control-ui#insecure-http

### 18. 타임스탬프 기본값 UTC → 로컬 시간

- **영향**: 에이전트 개발자
- **내용**: 엔벨로프 및 시스템 이벤트 타임스탬프가 호스트 로컬 시간으로 기본 변경
- **조치**: UTC 변환 로직이 있었다면 제거 가능

---

## v2026.2.10

### 19. 잘못된 설정 항목 시 Gateway 시작 거부

- **영향**: 모든 사용자
- **내용**: 유효하지 않거나 알 수 없는 설정 항목이 있으면 Gateway가 시작을 거부
- **조치**: `openclaw doctor --fix` 실행 후 `openclaw plugins update`

---

## v2026.2.6

### 20. `openclaw message`에 `target` 필수

- **영향**: CLI 사용자, 스크립트
- **내용**: `to`/`channelId` 파라미터가 `target`으로 통합
- **조치**: 기존 스크립트에서 `to`/`channelId` → `target`으로 변경

### 21. 채널 인증: config 우선, env 폴백

- **영향**: Discord/Telegram/Matrix 채널 설정
- **내용**: 환경변수보다 config 파일 설정이 우선 적용됨
- **조치**: 설정을 config 파일로 이동 권장 (환경변수는 폴백으로 계속 동작)

### 22. `chatType: "room"` 제거

- **영향**: 채팅 타입 설정
- **내용**: 레거시 `chatType: "room"` 미지원
- **조치**: `chatType: "channel"` 사용

### 23. `openclaw hooks` → `openclaw webhooks`

- **영향**: CLI 사용자
- **내용**: 웹훅 명령어가 `hooks` → `webhooks`로 변경. `hooks`는 다른 기능으로 사용
- **조치**: 스크립트에서 명령어 변경

### 24. `openclaw plugins install` 동작 변경

- **영향**: 플러그인 관리
- **내용**: 로컬 경로 설치 시 `~/.openclaw/extensions`에 복사됨
- **조치**: 기존 경로 기반 로딩을 유지하려면 `--link` 플래그 사용

---

## v2026.2.3

### 25. iOS 최소 버전 18.0

- **영향**: iOS 사용자
- **내용**: Textual 마크다운 렌더링을 위해 iOS 18.0 이상 필수
- **조치**: iOS 18 미만 기기는 미지원

### 26. MS Teams 플러그인 분리

- **영향**: Microsoft Teams 사용자
- **내용**: Teams가 코어에서 분리되어 별도 플러그인으로 변경
- **조치**: `openclaw plugins install @openclaw/msteams`

---

## v2026.1.x (초기 릴리스)

### 27. "providers" → "channels" 전체 리네이밍

- **영향**: 모든 사용자
- **내용**: CLI/RPC/config 전반에서 "providers" → "channels"로 용어 변경
- **조치**: config 자동 마이그레이션됨 (`channels.*`로 저장)

---

## 수동 조치가 필요한 핵심 항목

| 항목 | 설명 |
|------|------|
| **#3 Plugin SDK API 변경** | `registerHttpHandler` → `registerHttpRoute`로 코드 수정 필요 |
| **#16 Gateway 인증 필수화** | token 또는 password 설정 필수 |
| **#25 iOS 18.0 요구** | iOS 18 미만 기기 미지원 |
| **#11 Google Antigravity 제거** | 다른 프로바이더로 마이그레이션 필요 |
| **#15 Device-auth v2 필수** | 디바이스 인증 클라이언트 업데이트 필요 |
| **#20 message target 필수** | CLI 스크립트 수정 필요 |

나머지 항목은 `openclaw doctor --fix`로 자동 마이그레이션되거나, config 설정 한 줄로 해결됩니다.
