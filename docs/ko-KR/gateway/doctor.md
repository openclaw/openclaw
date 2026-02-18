---
summary: "Doctor 명령어: 상태 점검, 설정 마이그레이션, 복구 단계"
read_when:
  - Doctor 마이그레이션을 추가하거나 수정할 때
  - 호환성을 깨는 설정 변경을 도입할 때
title: "Doctor"
---

# Doctor

`openclaw doctor`는 OpenClaw의 복구 + 마이그레이션 도구입니다. 오래된
설정/상태를 수정하고, 상태를 점검하며, 실행 가능한 복구 단계를 제공합니다.

## 빠른 시작

```bash
openclaw doctor
```

### 헤드리스 / 자동화

```bash
openclaw doctor --yes
```

프롬프트 없이 기본값을 수락합니다 (해당하는 경우 재시작/서비스/샌드박스 복구 단계 포함).

```bash
openclaw doctor --repair
```

프롬프트 없이 권장 복구를 적용합니다 (안전한 경우 복구 + 재시작).

```bash
openclaw doctor --repair --force
```

공격적인 복구도 적용합니다 (커스텀 슈퍼바이저 설정 덮어쓰기).

```bash
openclaw doctor --non-interactive
```

프롬프트 없이 실행하고 안전한 마이그레이션만 적용합니다 (설정 정규화 + 온디스크 상태 이동). 사람의 확인이 필요한 재시작/서비스/샌드박스 작업은 건너뜁니다.
레거시 상태 마이그레이션은 감지되면 자동으로 실행됩니다.

```bash
openclaw doctor --deep
```

시스템 서비스에서 추가 게이트웨이 설치를 스캔합니다 (launchd/systemd/schtasks).

쓰기 전에 변경 사항을 검토하려면 먼저 설정 파일을 여십시오:

```bash
cat ~/.openclaw/openclaw.json
```

## 수행 기능 (요약)

- git 설치를 위한 선택적 사전 업데이트 (대화형 전용).
- UI 프로토콜 신선도 점검 (프로토콜 스키마가 최신일 때 Control UI 재빌드).
- 상태 점검 + 재시작 프롬프트.
- 스킬 상태 요약 (적격/누락/차단).
- 레거시 값에 대한 설정 정규화.
- OpenCode Zen 프로바이더 오버라이드 경고 (`models.providers.opencode`).
- 레거시 온디스크 상태 마이그레이션 (세션/에이전트 디렉토리/WhatsApp 인증).
- 상태 무결성 및 권한 점검 (세션, 트랜스크립트, 상태 디렉토리).
- 로컬 실행 시 설정 파일 권한 점검 (chmod 600).
- 모델 인증 상태: OAuth 만료 점검, 만료되는 토큰 갱신, 인증 프로파일 쿨다운/비활성화 상태 보고.
- 추가 워크스페이스 디렉토리 감지 (`~/openclaw`).
- 샌드박싱이 활성화된 경우 샌드박스 이미지 복구.
- 레거시 서비스 마이그레이션 및 추가 게이트웨이 감지.
- 게이트웨이 런타임 점검 (서비스가 설치되었지만 실행 중이 아닌 경우; 캐시된 launchd 레이블).
- 채널 상태 경고 (실행 중인 게이트웨이에서 프로브됨).
- 슈퍼바이저 설정 감사 (launchd/systemd/schtasks), 선택적 복구 포함.
- 게이트웨이 런타임 모범 사례 점검 (Node vs Bun, 버전 관리자 경로).
- 게이트웨이 포트 충돌 진단 (기본 `18789`).
- 개방된 DM 정책에 대한 보안 경고.
- `gateway.auth.token`이 설정되지 않은 경우 게이트웨이 인증 경고 (로컬 모드; 토큰 생성 제안).
- Linux에서 systemd 링거 점검.
- 소스 설치 점검 (pnpm 워크스페이스 불일치, UI 에셋 누락, tsx 바이너리 누락).
- 업데이트된 설정 + 마법사 메타데이터 쓰기.

## 상세 동작 및 근거

### 0) 선택적 업데이트 (git 설치)

이것이 git 체크아웃이고 doctor가 대화형으로 실행 중인 경우, doctor를 실행하기 전에
업데이트(fetch/rebase/build)를 제안합니다.

### 1) 설정 정규화

설정에 레거시 값 형태가 포함된 경우 (예: 채널별 오버라이드 없이 `messages.ackReaction`),
doctor는 이를 현재 스키마로 정규화합니다.

### 2) 레거시 설정 키 마이그레이션

설정에 더 이상 사용되지 않는 키가 포함된 경우, 다른 명령어는 실행을 거부하고
`openclaw doctor`를 실행하도록 요청합니다.

Doctor는 다음을 수행합니다:

- 어떤 레거시 키가 발견되었는지 설명합니다.
- 적용된 마이그레이션을 표시합니다.
- 업데이트된 스키마로 `~/.openclaw/openclaw.json`을 재작성합니다.

게이트웨이는 레거시 설정 형식을 감지하면 시작 시 doctor 마이그레이션을 자동으로 실행하므로,
오래된 설정은 수동 개입 없이 복구됩니다.

현재 마이그레이션:

- `routing.allowFrom` → `channels.whatsapp.allowFrom`
- `routing.groupChat.requireMention` → `channels.whatsapp/telegram/imessage.groups."*".requireMention`
- `routing.groupChat.historyLimit` → `messages.groupChat.historyLimit`
- `routing.groupChat.mentionPatterns` → `messages.groupChat.mentionPatterns`
- `routing.queue` → `messages.queue`
- `routing.bindings` → 최상위 `bindings`
- `routing.agents`/`routing.defaultAgentId` → `agents.list` + `agents.list[].default`
- `routing.agentToAgent` → `tools.agentToAgent`
- `routing.transcribeAudio` → `tools.media.audio.models`
- `bindings[].match.accountID` → `bindings[].match.accountId`
- `identity` → `agents.list[].identity`
- `agent.*` → `agents.defaults` + `tools.*` (tools/elevated/exec/sandbox/subagents)
- `agent.model`/`allowedModels`/`modelAliases`/`modelFallbacks`/`imageModelFallbacks`
  → `agents.defaults.models` + `agents.defaults.model.primary/fallbacks` + `agents.defaults.imageModel.primary/fallbacks`

### 2b) OpenCode Zen 프로바이더 오버라이드

`models.providers.opencode` (또는 `opencode-zen`)를 수동으로 추가한 경우,
`@mariozechner/pi-ai`의 내장 OpenCode Zen 카탈로그가 오버라이드됩니다. 이로 인해
모든 모델이 단일 API로 강제되거나 비용이 0이 될 수 있습니다. Doctor는 이를 경고하여
오버라이드를 제거하고 모델별 API 라우팅 + 비용을 복원할 수 있도록 합니다.

### 3) 레거시 상태 마이그레이션 (디스크 레이아웃)

Doctor는 이전 온디스크 레이아웃을 현재 구조로 마이그레이션할 수 있습니다:

- 세션 스토어 + 트랜스크립트:
  - `~/.openclaw/sessions/`에서 `~/.openclaw/agents/<agentId>/sessions/`로
- 에이전트 디렉토리:
  - `~/.openclaw/agent/`에서 `~/.openclaw/agents/<agentId>/agent/`로
- WhatsApp 인증 상태 (Baileys):
  - 레거시 `~/.openclaw/credentials/*.json`에서 (`oauth.json` 제외)
  - `~/.openclaw/credentials/whatsapp/<accountId>/...`로 (기본 계정 id: `default`)

이러한 마이그레이션은 최선의 방식이며 멱등적입니다; doctor는 레거시 폴더를 백업으로
남겨둘 때 경고를 발생시킵니다. 게이트웨이/CLI도 시작 시 레거시 세션 + 에이전트 디렉토리를
자동으로 마이그레이션하므로, 수동 doctor 실행 없이도 기록/인증/모델이 에이전트별 경로에
저장됩니다. WhatsApp 인증은 의도적으로 `openclaw doctor`를 통해서만 마이그레이션됩니다.

### 4) 상태 무결성 점검 (세션 지속성, 라우팅, 안전성)

상태 디렉토리는 운영상의 핵심입니다. 이것이 사라지면 세션, 자격 증명, 로그,
설정을 잃게 됩니다 (다른 곳에 백업이 없는 경우).

Doctor 점검 사항:

- **상태 디렉토리 누락**: 치명적인 상태 손실에 대해 경고하고, 디렉토리를 재생성하도록
  프롬프트하며, 누락된 데이터를 복구할 수 없음을 상기시킵니다.
- **상태 디렉토리 권한**: 쓰기 가능성을 확인합니다; 권한 복구를 제안합니다
  (소유자/그룹 불일치가 감지되면 `chown` 힌트를 제공합니다).
- **세션 디렉토리 누락**: `sessions/`와 세션 스토어 디렉토리는 기록 유지와
  `ENOENT` 충돌 방지에 필요합니다.
- **트랜스크립트 불일치**: 최근 세션 항목에 트랜스크립트 파일이 누락된 경우 경고합니다.
- **메인 세션 "1줄 JSONL"**: 메인 트랜스크립트가 한 줄만 있을 때 (기록이 누적되지 않음) 플래그합니다.
- **여러 상태 디렉토리**: 홈 디렉토리 전체에 여러 `~/.openclaw` 폴더가 있거나
  `OPENCLAW_STATE_DIR`이 다른 곳을 가리킬 때 경고합니다 (기록이 설치 간에 분리될 수 있음).
- **원격 모드 알림**: `gateway.mode=remote`인 경우, doctor는 상태가 거기에 있으므로
  원격 호스트에서 실행하도록 상기시킵니다.
- **설정 파일 권한**: `~/.openclaw/openclaw.json`이 그룹/모든 사용자에게 읽기 가능한 경우
  경고하고 `600`으로 강화하도록 제안합니다.

### 5) 모델 인증 상태 (OAuth 만료)

Doctor는 인증 스토어의 OAuth 프로파일을 검사하고, 토큰이 만료되거나 만료 예정일 때 경고하며,
안전한 경우 이를 갱신할 수 있습니다. Anthropic Claude Code 프로파일이 오래된 경우,
`claude setup-token` 실행을 제안합니다 (또는 설정 토큰 붙여넣기).
갱신 프롬프트는 대화형으로 실행할 때만 표시됩니다 (TTY); `--non-interactive`는
갱신 시도를 건너뜁니다.

Doctor는 다음과 같은 이유로 일시적으로 사용할 수 없는 인증 프로파일도 보고합니다:

- 단기 쿨다운 (속도 제한/타임아웃/인증 실패)
- 장기 비활성화 (결제/크레딧 실패)

### 6) 훅 모델 유효성 검사

`hooks.gmail.model`이 설정된 경우, doctor는 카탈로그 및 허용 목록에 대해 모델 참조를
검증하고 해석되지 않거나 허용되지 않는 경우 경고합니다.

### 7) 샌드박스 이미지 복구

샌드박싱이 활성화된 경우, doctor는 Docker 이미지를 점검하고 현재 이미지가 누락된 경우
빌드하거나 레거시 이름으로 전환하도록 제안합니다.

### 8) 게이트웨이 서비스 마이그레이션 및 정리 힌트

Doctor는 레거시 게이트웨이 서비스 (launchd/systemd/schtasks)를 감지하고
현재 게이트웨이 포트를 사용하는 OpenClaw 서비스를 제거하고 설치하도록 제안합니다.
또한 추가 게이트웨이 유사 서비스를 스캔하고 정리 힌트를 출력할 수 있습니다.
프로파일 이름의 OpenClaw 게이트웨이 서비스는 1등급으로 간주되며 "추가"로 표시되지 않습니다.

### 9) 보안 경고

Doctor는 프로바이더가 허용 목록 없이 DM에 개방되어 있거나 정책이 위험한 방식으로
구성된 경우 경고를 발생시킵니다.

### 10) systemd 링거 (Linux)

systemd 사용자 서비스로 실행 중인 경우, doctor는 로그아웃 후에도 게이트웨이가
유지될 수 있도록 링거가 활성화되어 있는지 확인합니다.

### 11) 스킬 상태

Doctor는 현재 워크스페이스에 대한 적격/누락/차단 스킬의 빠른 요약을 출력합니다.

### 12) 게이트웨이 인증 점검 (로컬 토큰)

Doctor는 로컬 게이트웨이에서 `gateway.auth`가 누락된 경우 경고하고 토큰 생성을 제안합니다.
자동화에서 토큰 생성을 강제하려면 `openclaw doctor --generate-gateway-token`을 사용하십시오.

### 13) 게이트웨이 상태 점검 + 재시작

Doctor는 상태 점검을 실행하고 게이트웨이가 비정상으로 보일 때 재시작을 제안합니다.

### 14) 채널 상태 경고

게이트웨이가 정상인 경우, doctor는 채널 상태 프로브를 실행하고 제안된 수정 사항과 함께
경고를 보고합니다.

### 15) 슈퍼바이저 설정 감사 + 복구

Doctor는 설치된 슈퍼바이저 설정 (launchd/systemd/schtasks)에서 누락되거나 오래된 기본값을
점검합니다 (예: systemd network-online 의존성 및 재시작 지연). 불일치가 발견되면 업데이트를
권장하고 서비스 파일/작업을 현재 기본값으로 재작성할 수 있습니다.

참고:

- `openclaw doctor`는 슈퍼바이저 설정을 재작성하기 전에 프롬프트합니다.
- `openclaw doctor --yes`는 기본 복구 프롬프트를 수락합니다.
- `openclaw doctor --repair`는 프롬프트 없이 권장 수정 사항을 적용합니다.
- `openclaw doctor --repair --force`는 커스텀 슈퍼바이저 설정을 덮어씁니다.
- `openclaw gateway install --force`를 통해 언제든지 전체 재작성을 강제할 수 있습니다.

### 16) 게이트웨이 런타임 + 포트 진단

Doctor는 서비스 런타임 (PID, 마지막 종료 상태)을 검사하고 서비스가 설치되었지만
실제로 실행 중이 아닐 때 경고합니다. 또한 게이트웨이 포트 (기본 `18789`)의 포트 충돌을
확인하고 가능한 원인 (게이트웨이 이미 실행 중, SSH 터널)을 보고합니다.

### 17) 게이트웨이 런타임 모범 사례

Doctor는 게이트웨이 서비스가 Bun 또는 버전 관리 Node 경로
(`nvm`, `fnm`, `volta`, `asdf` 등)에서 실행될 때 경고합니다. WhatsApp + Telegram 채널은
Node가 필요하며, 버전 관리자 경로는 서비스가 셸 초기화를 로드하지 않기 때문에
업그레이드 후 중단될 수 있습니다. Doctor는 사용 가능한 경우 시스템 Node 설치로
마이그레이션을 제안합니다 (Homebrew/apt/choco).

### 18) 설정 쓰기 + 마법사 메타데이터

Doctor는 설정 변경 사항을 저장하고 doctor 실행을 기록하는 마법사 메타데이터를 스탬프합니다.

### 19) 워크스페이스 팁 (백업 + 메모리 시스템)

Doctor는 누락된 경우 워크스페이스 메모리 시스템을 제안하고, 워크스페이스가 이미 git 아래에
있지 않은 경우 백업 팁을 출력합니다.

워크스페이스 구조와 git 백업에 대한 전체 가이드는
[/concepts/agent-workspace](/ko-KR/concepts/agent-workspace)를 참조하세요
(비공개 GitHub 또는 GitLab 권장).
