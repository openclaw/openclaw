---
read_when:
    - 새 기계 설정
    - 개인 설정을 손상시키지 않고 "최신 + 최고"를 원합니다.
summary: OpenClaw를 위한 고급 설정 및 개발 워크플로
title: 설정
x-i18n:
    generated_at: "2026-02-08T16:04:47Z"
    model: gtx
    provider: google-translate
    source_hash: 6620daddff099dc00a8af069ae578e90e67309d48c12fe671f4935bee3a8f901
    source_path: start/setup.md
    workflow: 15
---

# 설정

<Note>
처음 설정하는 경우 [시작하기](/start/getting-started)부터 시작하세요.
마법사에 대한 자세한 내용은 [온보딩 마법사](/start/wizard)를 참조하세요.
</Note>

최종 업데이트 날짜: 2026-01-01

## TL;DR

- **저장소 외부의 삶을 조정합니다:** `~/.openclaw/workspace` (작업 공간) + `~/.openclaw/openclaw.json` (구성).
- **안정적인 작업 흐름:** macOS 앱을 설치합니다. 번들 게이트웨이를 실행하도록 하세요.
- **최첨단 워크플로우:** 다음을 통해 게이트웨이를 직접 실행하세요. `pnpm gateway:watch`을 누른 다음 macOS 앱이 로컬 모드로 연결되도록 하세요.

## 전제조건(소스에서)

- 마디 `>=22`
- `pnpm`
- Docker(선택 사항, 컨테이너화된 설정/e2e에만 해당 - 참조) [도커](/install/docker))

## 전략 조정(업데이트가 손상되지 않도록)

100% 나에게 꼭 맞는 맞춤을 ​​원하신다면 _그리고_ 간편한 업데이트, 사용자 정의 유지:

- **구성:** `~/.openclaw/openclaw.json` (JSON/JSON5-ish)
- **작업 공간:** `~/.openclaw/workspace` (기술, 프롬프트, 추억; 비공개 Git 저장소로 만드세요)

부트스트랩 한 번:

```bash
openclaw setup
```

이 리포지토리 내부에서 로컬 CLI 항목을 사용합니다.

```bash
openclaw setup
```

아직 전역 설치가 없다면 다음을 통해 실행하세요. `pnpm openclaw setup`.

## 이 저장소에서 게이트웨이 실행

후에 `pnpm build`, 패키지된 CLI를 직접 실행할 수 있습니다.

```bash
node openclaw.mjs gateway --port 18789 --verbose
```

## 안정적인 작업 흐름(macOS 앱 우선)

1. 설치 + 실행 **OpenClaw.app** (메뉴 모음).
2. 온보딩/권한 체크리스트(TCC 프롬프트)를 완료하세요.
3. 게이트웨이가 다음과 같은지 확인하세요. **현지의** 실행 중입니다(앱이 관리함).
4. 링크 표면(예: WhatsApp):

```bash
openclaw channels login
```

5. 건전성 검사:

```bash
openclaw health
```

빌드에서 온보딩을 사용할 수 없는 경우:

- 달리다 `openclaw setup`, 그 다음에 `openclaw channels login`, 게이트웨이를 수동으로 시작합니다(`openclaw gateway`).

## 최첨단 워크플로우(터미널의 게이트웨이)

목표: TypeScript 게이트웨이 작업, 핫 리로드, macOS 앱 UI 연결 유지.

### 0) (선택 사항) 소스에서도 macOS 앱을 실행합니다.

최첨단 macOS 앱도 원한다면:

```bash
./scripts/restart-mac.sh
```

### 1) 개발 게이트웨이 시작

```bash
pnpm install
pnpm gateway:watch
```

`gateway:watch` 감시 모드에서 게이트웨이를 실행하고 TypeScript 변경 사항을 다시 로드합니다.

### 2) 실행 중인 게이트웨이에서 macOS 앱을 가리킵니다.

~ 안에 **OpenClaw.app**:

- 연결 모드: **현지의**
  앱은 구성된 포트에서 실행 중인 게이트웨이에 연결됩니다.

### 3) 확인

- 인앱 게이트웨이 상태를 읽어야 합니다. **“기존 게이트웨이를 이용해서…”**
- 또는 CLI를 통해:

```bash
openclaw health
```

### 일반적인 풋건

- **잘못된 포트:** 게이트웨이 WS의 기본값은 다음과 같습니다. `ws://127.0.0.1:18789`; 앱 + CLI를 동일한 포트에 유지하세요.
- **주정부가 거주하는 곳:**
  - 신임장: `~/.openclaw/credentials/`
  - 세션: `~/.openclaw/agents/<agentId>/sessions/`
  - 로그: `/tmp/openclaw/`

## 자격 증명 저장소 지도

인증을 디버깅하거나 백업할 항목을 결정할 때 다음을 사용하세요.

- **왓츠앱**:`~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **텔레그램 봇 토큰**: 구성/환경 또는 `channels.telegram.tokenFile`
- **디스코드 봇 토큰**: config/env (토큰 파일은 아직 지원되지 않음)
- **슬랙 토큰**: 구성/환경(`channels.slack.*`)
- **페어링 허용 목록**:`~/.openclaw/credentials/<channel>-allowFrom.json`
- **모델 인증 프로필**:`~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- **기존 OAuth 가져오기**:`~/.openclaw/credentials/oauth.json`
  더 자세한 내용: [보안](/gateway/security#credential-storage-map).

## 업데이트 중(설정을 망치지 않고)

- 유지하다 `~/.openclaw/workspace`그리고`~/.openclaw/` "당신의 물건"으로; 개인 프롬프트/구성을 `openclaw` 레포.
- 소스 업데이트 중: `git pull` + `pnpm install` (잠금 파일이 변경된 경우) + 계속 사용 `pnpm gateway:watch`.

## Linux(시스템 사용자 서비스)

Linux 설치에서는 systemd를 사용합니다. **사용자** 서비스. 기본적으로 systemd는 사용자를 중지합니다.
로그아웃/유휴 시 서비스로 인해 게이트웨이가 종료됩니다. 활성화하려는 온보딩 시도
당신을 기다리고 있습니다 (sudo를 요구할 수도 있습니다). 아직 꺼져 있으면 다음을 실행하세요.

```bash
sudo loginctl enable-linger $USER
```

상시 가동 또는 다중 사용자 서버의 경우 다음을 고려하십시오. **체계** 대신에 서비스
사용자 서비스(지체 필요 없음). 보다 [게이트웨이 런북](/gateway) 시스템 노트의 경우.

## 관련 문서

- [게이트웨이 런북](/gateway) (플래그, 감독, 포트)
- [게이트웨이 구성](/gateway/configuration) (구성 스키마 + 예)
- [불화](/channels/discord)그리고[전보](/channels/telegram) (답장 태그 + replyToMode 설정)
- [OpenClaw 어시스턴트 설정](/start/openclaw)
- [macOS 앱](/platforms/macos) (게이트웨이 수명주기)
