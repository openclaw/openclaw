---
title: "설정"
summary: "OpenClaw 의 고급 설정 및 개발 워크플로"
read_when:
  - 새 머신을 설정할 때
  - 개인 설정을 망가뜨리지 않고 "최신 및 최고"를 원할 때
x-i18n:
  source_path: docs/start/setup.md
---

# 설정

<Note>
처음 설정하는 경우 [시작하기](/start/getting-started)부터 시작하세요.
온보딩 상세 정보는 [온보딩 (CLI)](/start/wizard)를 참조하세요.
</Note>

## 요약

- **커스터마이징은 레포 외부에 있습니다:** `~/.openclaw/workspace` (워크스페이스) + `~/.openclaw/openclaw.json` (설정).
- **안정적인 워크플로:** macOS 앱을 설치하고 번들된 Gateway 를 실행합니다.
- **최신 워크플로:** `pnpm gateway:watch` 로 Gateway 를 직접 실행한 후, macOS 앱을 로컬 모드로 연결합니다.

## 사전 요구 사항 (소스에서)

- Node 24 권장 (Node 22 LTS, 현재 `22.16+`, 여전히 지원)
- `pnpm`
- Docker (선택 사항; 컨테이너화된 설정/e2e 전용 — [Docker](/install/docker) 참조)

## 커스터마이징 전략 (업데이트가 피해를 주지 않도록)

"100% 나에게 맞춤" _이면서_ 쉬운 업데이트를 원한다면, 커스터마이징을 다음에 유지하세요:

- **설정:** `~/.openclaw/openclaw.json` (JSON/JSON5 형식)
- **워크스페이스:** `~/.openclaw/workspace` (Skills, 프롬프트, 메모리; 프라이빗 git 레포로 만드세요)

한 번 부트스트랩:

```bash
openclaw setup
```

이 레포 내에서 로컬 CLI 항목을 사용하세요:

```bash
openclaw setup
```

아직 글로벌 설치가 없다면 `pnpm openclaw setup` 으로 실행하세요.

## 이 레포에서 Gateway 실행

`pnpm build` 후, 패키지된 CLI 를 직접 실행할 수 있습니다:

```bash
node openclaw.mjs gateway --port 18789 --verbose
```

## 안정적인 워크플로 (macOS 앱 우선)

1. **OpenClaw.app** (메뉴 바)을 설치하고 실행합니다.
2. 온보딩/권한 체크리스트를 완료합니다(TCC 프롬프트).
3. Gateway 가 **로컬**이고 실행 중인지 확인합니다(앱이 관리).
4. 서피스를 연결합니다(예: WhatsApp):

```bash
openclaw channels login
```

5. 정상 작동 확인:

```bash
openclaw health
```

빌드에 온보딩이 없는 경우:

- `openclaw setup` 을 실행한 후, `openclaw channels login`, 그리고 Gateway 를 수동으로 시작합니다(`openclaw gateway`).

## 최신 워크플로 (터미널에서 Gateway)

목표: TypeScript Gateway 작업, 핫 리로드, macOS 앱 UI 연결 유지.

### 0) (선택 사항) 소스에서 macOS 앱도 실행

macOS 앱도 최신으로 유지하고 싶다면:

```bash
./scripts/restart-mac.sh
```

### 1) 개발 Gateway 시작

```bash
pnpm install
pnpm gateway:watch
```

`gateway:watch` 는 watch 모드로 Gateway 를 실행하며 관련 소스, 설정, 번들된 플러그인 메타데이터 변경 시 리로드합니다.

### 2) 실행 중인 Gateway 에 macOS 앱 연결

**OpenClaw.app** 에서:

- 연결 모드: **로컬**
  앱이 구성된 포트에서 실행 중인 Gateway 에 연결합니다.

### 3) 확인

- 앱 내 Gateway 상태가 **"Using existing gateway ..."** 으로 표시되어야 합니다
- 또는 CLI 를 통해:

```bash
openclaw health
```

### 일반적인 함정

- **잘못된 포트:** Gateway WS 기본값은 `ws://127.0.0.1:18789`; 앱 + CLI 를 동일한 포트로 유지하세요.
- **상태가 저장되는 위치:**
  - 자격 증명: `~/.openclaw/credentials/`
  - 세션: `~/.openclaw/agents/<agentId>/sessions/`
  - 로그: `/tmp/openclaw/`

## 자격 증명 저장 맵

인증 디버깅이나 백업할 항목을 결정할 때 사용하세요:

- **WhatsApp**: `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **Telegram 봇 토큰**: 설정/환경 변수 또는 `channels.telegram.tokenFile` (일반 파일만; 심볼릭 링크 거부)
- **Discord 봇 토큰**: 설정/환경 변수 또는 SecretRef (env/file/exec 프로바이더)
- **Slack 토큰**: 설정/환경 변수 (`channels.slack.*`)
- **페어링 허용 목록**:
  - `~/.openclaw/credentials/<channel>-allowFrom.json` (기본 계정)
  - `~/.openclaw/credentials/<channel>-<accountId>-allowFrom.json` (기본이 아닌 계정)
- **모델 인증 프로필**: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- **파일 기반 시크릿 페이로드 (선택 사항)**: `~/.openclaw/secrets.json`
- **레거시 OAuth 가져오기**: `~/.openclaw/credentials/oauth.json`
  자세한 내용: [보안](/gateway/security#credential-storage-map).

## 업데이트 (설정을 망가뜨리지 않고)

- `~/.openclaw/workspace` 와 `~/.openclaw/` 를 "내 것"으로 유지하세요; 개인 프롬프트/설정을 `openclaw` 레포에 넣지 마세요.
- 소스 업데이트: `git pull` + `pnpm install` (lockfile 변경 시) + `pnpm gateway:watch` 계속 사용.

## Linux (systemd 사용자 서비스)

Linux 설치는 systemd **사용자** 서비스를 사용합니다. 기본적으로 systemd 는 로그아웃/유휴 시 사용자 서비스를 중지하여 Gateway 를 종료합니다. 온보딩이 여러분을 위해 링거링을 활성화하려고 시도합니다(sudo 를 요청할 수 있음). 아직 꺼져 있다면 실행하세요:

```bash
sudo loginctl enable-linger $USER
```

항상 켜져 있거나 다중 사용자 서버의 경우, 사용자 서비스 대신 **시스템** 서비스를 고려하세요(링거링 불필요). systemd 참고 사항은 [Gateway 운영 가이드](/gateway)를 참조하세요.

## 관련 문서

- [Gateway 운영 가이드](/gateway) (플래그, 수퍼비전, 포트)
- [Gateway 설정](/gateway/configuration) (설정 스키마 + 예제)
- [Discord](/channels/discord) 및 [Telegram](/channels/telegram) (답장 태그 + replyToMode 설정)
- [OpenClaw 어시스턴트 설정](/start/openclaw)
- [macOS 앱](/platforms/macos) (Gateway 라이프사이클)
