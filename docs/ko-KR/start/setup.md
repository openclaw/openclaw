---
summary: "Advanced setup and development workflows for OpenClaw"
read_when:
  - Setting up a new machine
  - You want “latest + greatest” without breaking your personal setup
title: "Setup"
x-i18n:
  source_hash: 6620daddff099dc00a8af069ae578e90e67309d48c12fe671f4935bee3a8f901
---

# 설정

<Note>
처음 설정하는 경우 [시작하기](/start/getting-started)부터 시작하세요.
마법사에 대한 자세한 내용은 [온보딩 마법사](/start/wizard)를 참조하세요.
</Note>

최종 업데이트 날짜: 2026-01-01

## 요약;DR

- **저장소 외부의 조정 작업:** `~/.openclaw/workspace` (작업 공간) + `~/.openclaw/openclaw.json` (config).
- **안정적인 작업 흐름:** macOS 앱을 설치합니다. 번들 게이트웨이를 실행하도록 하세요.
- **최첨단 워크플로:** `pnpm gateway:watch`를 통해 게이트웨이를 직접 실행한 다음 macOS 앱을 로컬 모드로 연결하도록 합니다.

## 전제조건(소스에서)

- 노드 `>=22`
- `pnpm`
- Docker(선택 사항, 컨테이너화된 설정/e2e에만 해당 - [Docker](/install/docker) 참조)

## 전략 조정(업데이트가 손상되지 않도록)

"100% 나에게 맞춤" _및_ 쉬운 업데이트를 원한다면 다음에서 사용자 정의를 유지하세요.

- **구성:** `~/.openclaw/openclaw.json` (JSON/JSON5-ish)
- **작업 공간:** `~/.openclaw/workspace` (기술, 프롬프트, 추억; 비공개 git 저장소로 만들기)

부트스트랩 한 번:

```bash
openclaw setup
```

이 리포지토리 내부에서 로컬 CLI 항목을 사용합니다.

```bash
openclaw setup
```

아직 전역 설치가 없다면 `pnpm openclaw setup`를 통해 실행하세요.

## 이 저장소에서 게이트웨이 실행

`pnpm build` 이후 패키지된 CLI를 직접 실행할 수 있습니다.

```bash
node openclaw.mjs gateway --port 18789 --verbose
```

## 안정적인 작업 흐름(macOS 앱 우선)

1. **OpenClaw.app**(메뉴 표시줄)을 설치하고 실행합니다.
2. 온보딩/권한 체크리스트를 완료합니다(TCC 프롬프트).
3. 게이트웨이가 **로컬**이고 실행 중인지 확인하세요(앱에서 관리함).
4. 링크 표면(예: WhatsApp):

```bash
openclaw channels login
```

5. 건전성 검사:

```bash
openclaw health
```

빌드에서 온보딩을 사용할 수 없는 경우:

- `openclaw setup`를 실행한 다음 `openclaw channels login`를 실행하고 게이트웨이를 수동으로 시작합니다(`openclaw gateway`).

## Bleeding Edge Workflow(단말기의 게이트웨이)

목표: TypeScript 게이트웨이 작업, 핫 리로드, macOS 앱 UI 연결 유지.

### 0) (선택 사항) 소스에서도 macOS 앱 실행

최첨단 macOS 앱도 원한다면:

```bash
./scripts/restart-mac.sh
```

### 1) 개발 게이트웨이를 시작합니다.

```bash
pnpm install
pnpm gateway:watch
```

`gateway:watch`는 감시 모드에서 게이트웨이를 실행하고 TypeScript 변경 사항을 다시 로드합니다.

### 2) 실행 중인 게이트웨이에서 macOS 앱을 가리킵니다.

**OpenClaw.app**에서:

- 연결 모드: **로컬**
  앱은 구성된 포트에서 실행 중인 게이트웨이에 연결됩니다.

### 3) 확인

- 인앱 게이트웨이 상태는 **"기존 게이트웨이 사용 중..."**이어야 합니다.
- 또는 CLI를 통해:

```bash
openclaw health
```

### 일반 풋건

- **잘못된 포트:** Gateway WS의 기본값은 `ws://127.0.0.1:18789`입니다. 앱 + CLI를 동일한 포트에 유지하세요.
- **주 거주지:**
  - 자격 증명: `~/.openclaw/credentials/`
  - 세션: `~/.openclaw/agents/<agentId>/sessions/`
  - 로그: `/tmp/openclaw/`

## 자격 증명 저장소 맵

인증을 디버깅하거나 백업할 항목을 결정할 때 다음을 사용하세요.

- **WhatsApp**: `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **텔레그램 봇 토큰**: config/env 또는 `channels.telegram.tokenFile`
- **Discord 봇 토큰**: config/env (토큰 파일은 아직 지원되지 않음)
- **Slack 토큰**: config/env (`channels.slack.*`)
- **페어링 허용 목록**: `~/.openclaw/credentials/<channel>-allowFrom.json`
- **모델 인증 프로필**: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- **레거시 OAuth 가져오기**: `~/.openclaw/credentials/oauth.json`
  자세한 내용: [보안](/gateway/security#credential-storage-map).

## 업데이트 중(설정을 망치지 않고)

- `~/.openclaw/workspace` 및 `~/.openclaw/`를 "당신의 것"으로 유지하십시오. `openclaw` 저장소에 개인 프롬프트/구성을 넣지 마세요.
- 업데이트 소스: `git pull` + `pnpm install` (잠금 파일이 변경된 경우) + `pnpm gateway:watch`를 계속 사용합니다.

## Linux(시스템 사용자 서비스)

Linux 설치에서는 systemd **user** 서비스를 사용합니다. 기본적으로 systemd는 사용자를 중지합니다.
로그아웃/유휴 시 서비스로 인해 게이트웨이가 종료됩니다. 활성화하려는 온보딩 시도
당신을 기다리고 있습니다 (sudo를 요구할 수도 있습니다). 아직 꺼져 있으면 다음을 실행하세요.

```bash
sudo loginctl enable-linger $USER
```

상시 가동 또는 다중 사용자 서버의 경우에는 **시스템** 서비스를 고려하세요.
사용자 서비스(지체 필요 없음). 시스템 노트는 [게이트웨이 런북](/gateway)을 참조하세요.

## 관련 문서

- [Gateway Runbook](/gateway) (플래그, 감독, 포트)
- [게이트웨이 구성](/gateway/configuration) (구성 스키마 + 예시)
- [Discord](/channels/discord) 및 [텔레그램](/channels/telegram) (답글 태그 + replyToMode 설정)
- [OpenClaw 보조 설정](/start/openclaw)
- [macOS 앱](/platforms/macos) (게이트웨이 수명주기)
