---
summary: "OpenClaw의 고급 설정 및 개발 워크플로우"
read_when:
  - 새 기기 설정
  - 개인 설정을 해치지 않으면서 '최신+최고'를 원할 때
title: "설정"
---

# 설정

<Note>
처음 설정 중이라면 [시작하기](/ko-KR/start/getting-started)부터 시작하십시오. 마법사에 대한 자세한 내용은 [온보딩 마법사](/ko-KR/start/wizard)를 참조하세요.
</Note>

Last updated: 2026-01-01

## TL;DR

- **레포 외부에서의 맞춤화:** `~/.openclaw/workspace` (작업공간) + `~/.openclaw/openclaw.json` (설정).
- **안정적인 워크플로우:** macOS 앱을 설치하고 번들된 게이트웨이를 실행합니다.
- **최신 워크플로우:** `pnpm gateway:watch` 명령어를 통해 직접 게이트웨이를 실행하고, 로컬 모드에서 macOS 앱이 연결되도록 합니다.

## Prereqs (from source)

- Node `>=22`
- `pnpm`
- Docker (옵션; 컨테이너화된 설정/e2e 전용 — [Docker](/ko-KR/install/docker) 참조)

## 맞춤화 전략 (업데이트로 인한 영향 최소화)

"100% 나에게 맞춤화"되고 손쉬운 업데이트를 원한다면 다음 위치에 맞춤화를 보관하세요:

- **설정:** `~/.openclaw/openclaw.json` (JSON/JSON5-유형)
- **작업공간:** `~/.openclaw/workspace` (스킬, 프롬프트, 메모리; 이를 개인 git 저장소로 만드세요)

한 번 설정:

```bash
openclaw setup
```

이 레포 내부에서 지역 CLI 항목을 사용하세요:

```bash
openclaw setup
```

전역 설치가 없는 경우 `pnpm openclaw setup`을 통해 실행하세요.

## 이 레포에서 게이트웨이 실행

`pnpm build` 후, 패키지된 CLI를 직접 실행할 수 있습니다:

```bash
node openclaw.mjs gateway --port 18789 --verbose
```

## 안정적인 워크플로우 (macOS 앱 우선)

1. **OpenClaw.app** 설치 및 실행 (메뉴바).
2. 온보딩/권한 체크리스트 완료 (TCC 프롬프트).
3. 게이트웨이가 **로컬**로 실행되고 있는지 확인 (앱이 관리함).
4. 표면 연결 (예: WhatsApp):

```bash
openclaw channels login
```

5. 무결성 검사:

```bash
openclaw health
```

온보딩이 빌드에 포함되지 않은 경우:

- `openclaw setup`을 실행하고, `openclaw channels login`을 실행한 후 게이트웨이를 수동으로 시작합니다(`openclaw gateway`).

## 최신 워크플로우 (터미널에서의 게이트웨이)

목표: TypeScript 게이트웨이 작업, 핫 리로드, macOS 앱 UI 연결 유지.

### 0) (선택 사항) macOS 앱도 소스에서 실행

최신 임계의 macOS 앱도 원한다면:

```bash
./scripts/restart-mac.sh
```

### 1) 개발용 게이트웨이 시작

```bash
pnpm install
pnpm gateway:watch
```

`gateway:watch`는 게이트웨이를 워치 모드로 실행하고 TypeScript 변경 시 재로드합니다.

### 2) 실행 중인 게이트웨이에 macOS 앱 포인트 지정

**OpenClaw.app**에서:

- 연결 모드: **로컬**
  앱은 구성된 포트에서 실행 중인 게이트웨이에 연결됩니다.

### 3) 검증

- 인앱 게이트웨이 상태는 **“기존 게이트웨이 사용 중…”**으로 표시되어야 합니다.
- 또는 CLI 사용:

```bash
openclaw health
```

### 일반적인 실수들

- **잘못된 포트:** 게이트웨이 WS 기본값은 `ws://127.0.0.1:18789`이며, 앱 + CLI가 동일한 포트를 사용해야 합니다.
- **상태 저장 위치:**
  - 자격 증명: `~/.openclaw/credentials/`
  - 세션: `~/.openclaw/agents/<agentId>/sessions/`
  - 로그: `/tmp/openclaw/`

## 자격 증명 저장 맵

인증 문제 해결 또는 백업 항목 결정 시 사용하세요:

- **WhatsApp**: `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **Telegram 봇 토큰**: 설정/환경 변수 또는 `channels.telegram.tokenFile`
- **Discord 봇 토큰**: 설정/환경 변수 (토큰 파일은 아직 지원되지 않음)
- **Slack 토큰들**: 설정/환경 변수 (`channels.slack.*`)
- **페어링 허용 목록**: `~/.openclaw/credentials/<channel>-allowFrom.json`
- **모델 인증 프로필**: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- **레거시 OAuth 가져오기**: `~/.openclaw/credentials/oauth.json`
  더 상세한 내용: [보안](/ko-KR/gateway/security#credential-storage-map).

## 설정 업데이트 (설정을 망치지 않고)

- `~/.openclaw/workspace` 및 `~/.openclaw/`을 "당신의 항목"으로 보관하세요; 개인 프롬프트/설정을 `openclaw` 레포에 두지 마십시오.
- 소스 업데이트: `git pull` + `pnpm install` (lockfile이 변경된 경우) + 계속해서 `pnpm gateway:watch` 사용.

## Linux (systemd 사용자 서비스)

Linux 설치는 systemd **사용자** 서비스를 사용합니다. 기본적으로 systemd는 로그아웃/유휴 상태에서 사용자 서비스를 중지시켜 게이트웨이를 종료합니다. 온보딩은 지속성을 활성화하려고 시도합니다 (sudo가 필요할 수 있음). 아직 꺼져 있다면, 다음을 실행하세요:

```bash
sudo loginctl enable-linger $USER
```

항상 켜져 있거나 다중 사용자 서버의 경우, 사용자 서비스 대신 **시스템** 서비스를 고려하십시오 (지속성 필요 없음). systemd 참고사항은 [게이트웨이 런북](/ko-KR/gateway)을 참조하십시오.

## 관련 문서

- [게이트웨이 런북](/ko-KR/gateway) (플래그, 감독, 포트)
- [게이트웨이 설정](/ko-KR/gateway/configuration) (설정 스키마 + 예제)
- [Discord](/ko-KR/channels/discord) 및 [Telegram](/ko-KR/channels/telegram) (응답 태그 + replyToMode 설정)
- [OpenClaw 어시스턴트 설정](/ko-KR/start/openclaw)
- [macOS 앱](/ko-KR/platforms/macos) (게이트웨이 수명주기)
