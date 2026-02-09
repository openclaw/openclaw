---
summary: "Doctor 명령: 상태 점검, 설정 마이그레이션 및 복구 단계"
read_when:
  - Doctor 마이그레이션을 추가하거나 수정할 때
  - Introducing breaking config changes
title: "Doctor"
---

# Doctor

`openclaw doctor` 은 OpenClaw 를 위한 복구 + 마이그레이션 도구입니다. 오래된
설정/상태를 수정하고, 상태를 점검하며, 실행 가능한 복구 단계를 제공합니다.

## 빠른 시작

```bash
openclaw doctor
```

### 헤드리스 / 자동화

```bash
openclaw doctor --yes
```

프롬프트 없이 기본값을 수락합니다(해당되는 경우 재시작/서비스/샌드박스 복구 단계 포함).

```bash
openclaw doctor --repair
```

프롬프트 없이 권장 복구를 적용합니다(안전한 경우 복구 + 재시작).

```bash
openclaw doctor --repair --force
```

공격적인 복구도 적용합니다(커스텀 supervisor 설정을 덮어씁니다).

```bash
openclaw doctor --non-interactive
```

프롬프트 없이 실행하고 안전한 마이그레이션만 적용합니다(설정 정규화 + 디스크 상태 이동). 사람의 확인이 필요한 재시작/서비스/샌드박스 작업은 건너뜁니다.
레거시 상태 마이그레이션은 감지되면 자동으로 실행됩니다.

```bash
openclaw doctor --deep
```

시스템 서비스에서 추가 Gateway 설치를 스캔합니다(launchd/systemd/schtasks).

쓰기 전에 변경 사항을 검토하고 싶다면 먼저 설정 파일을 여십시오:

```bash
cat ~/.openclaw/openclaw.json
```

## What it does (summary)

- git 설치에 대한 선택적 사전 업데이트(대화형 전용).
- UI 프로토콜 최신성 점검(프로토콜 스키마가 더 최신인 경우 Control UI 재빌드).
- 상태 점검 + 재시작 프롬프트.
- Skills 상태 요약(적격/누락/차단).
- 레거시 값에 대한 설정 정규화.
- OpenCode Zen 프로바이더 오버라이드 경고(`models.providers.opencode`).
- 레거시 디스크 상태 마이그레이션(세션/에이전트 디렉토리/WhatsApp 인증).
- 상태 무결성 및 권한 점검(세션, 트랜스크립트, 상태 디렉토리).
- 로컬 실행 시 설정 파일 권한 점검(chmod 600).
- 모델 인증 상태: OAuth 만료 확인, 만료 임박 토큰 갱신 가능, 인증 프로필 쿨다운/비활성화 상태 보고.
- 추가 워크스페이스 디렉토리 감지(`~/openclaw`).
- 샌드박스화가 활성화된 경우 샌드박스 이미지 복구.
- 레거시 서비스 마이그레이션 및 추가 Gateway 감지.
- Gateway 런타임 점검(서비스는 설치되어 있으나 실행 중이 아님; 캐시된 launchd 레이블).
- 채널 상태 경고(실행 중인 Gateway 에서 프로빙).
- supervisor 설정 감사(launchd/systemd/schtasks) 및 선택적 복구.
- Gateway 런타임 모범 사례 점검(Node vs Bun, 버전 관리자 경로).
- Gateway 포트 충돌 진단(기본값 `18789`).
- 열린 다이렉트 메시지 정책에 대한 보안 경고.
- `gateway.auth.token` 이 설정되지 않은 경우 Gateway 인증 경고(로컬 모드; 토큰 생성 제안).
- Linux 에서 systemd linger 점검.
- 소스 설치 점검(pnpm 워크스페이스 불일치, UI 자산 누락, tsx 바이너리 누락).
- 업데이트된 설정 + 마법사 메타데이터 기록.

## 상세 동작 및 근거

### 0. 선택적 업데이트(git 설치)

git 체크아웃이며 doctor 가 대화형으로 실행 중인 경우,
doctor 실행 전에 업데이트(fetch/rebase/build)를 제안합니다.

### 1. 설정 정규화

설정에 레거시 값 형태가 포함된 경우(예: 채널별 오버라이드 없이
`messages.ackReaction`), doctor 는 이를 현재 스키마로 정규화합니다.

### 2. 레거시 설정 키 마이그레이션

설정에 더 이상 사용되지 않는 키가 포함되어 있으면, 다른 명령은 실행을 거부하고
`openclaw doctor` 실행을 요청합니다.

Doctor 는 다음을 수행합니다:

- 발견된 레거시 키를 설명합니다.
- 적용한 마이그레이션을 표시합니다.
- 업데이트된 스키마로 `~/.openclaw/openclaw.json` 를 다시 작성합니다.

Gateway 는 시작 시 레거시 설정 형식을 감지하면 doctor 마이그레이션을 자동 실행하므로,
수동 개입 없이 오래된 설정이 복구됩니다.

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

`models.providers.opencode`(또는 `opencode-zen`) 를 수동으로 추가한 경우,
`@mariozechner/pi-ai` 의 내장 OpenCode Zen 카탈로그를 오버라이드합니다. 이는 모든 모델을
단일 API 로 강제하거나 비용을 0 으로 만들 수 있습니다. Doctor 는 경고를 표시하여
오버라이드를 제거하고 모델별 API 라우팅 + 비용을 복원할 수 있도록 합니다.

### 3. 레거시 상태 마이그레이션(디스크 레이아웃)

Doctor 는 오래된 디스크 레이아웃을 현재 구조로 마이그레이션할 수 있습니다:

- 세션 저장소 + 트랜스크립트:
  - `~/.openclaw/sessions/` 에서 `~/.openclaw/agents/<agentId>/sessions/` 로
- 에이전트 디렉토리:
  - `~/.openclaw/agent/` 에서 `~/.openclaw/agents/<agentId>/agent/` 로
- WhatsApp 인증 상태(Baileys):
  - 레거시 `~/.openclaw/credentials/*.json` 에서(`oauth.json` 제외)
  - `~/.openclaw/credentials/whatsapp/<accountId>/...` 로(기본 계정 ID: `default`)

이 마이그레이션은 best-effort 이며 멱등적입니다. doctor 는 백업으로 남겨진 레거시
폴더가 있을 경우 경고를 출력합니다. Gateway/CLI 역시 시작 시 레거시 세션 +
에이전트 디렉토리를 자동 마이그레이션하여, 수동 doctor 실행 없이도 기록/인증/모델이
에이전트별 경로에 위치하도록 합니다. WhatsApp 인증은 의도적으로 `openclaw doctor`
를 통해서만 마이그레이션됩니다.

### 4. 상태 무결성 점검(세션 지속성, 라우팅, 안전성)

상태 디렉토리는 운영의 중추입니다. 이것이 사라지면 세션, 자격 증명, 로그,
설정이 손실됩니다(다른 위치에 백업이 없는 경우).

Doctor 점검 항목:

- **상태 디렉토리 누락**: 치명적인 상태 손실을 경고하고 디렉토리 재생성을
  제안하며, 누락된 데이터는 복구할 수 없음을 상기시킵니다.
- **상태 디렉토리 권한**: 쓰기 가능 여부를 확인하고 권한 복구를 제안합니다
  (소유자/그룹 불일치가 감지되면 `chown` 힌트를 출력).
- **세션 디렉토리 누락**: `sessions/` 및 세션 저장소 디렉토리는 기록을
  유지하고 `ENOENT` 크래시를 방지하는 데 필요합니다.
- **트랜스크립트 불일치**: 최근 세션 항목에 트랜스크립트 파일이 누락된 경우 경고.
- **메인 세션 “1줄 JSONL”**: 메인 트랜스크립트에 한 줄만 있는 경우(기록 누적 안 됨) 표시.
- **다중 상태 디렉토리**: 여러 홈 디렉토리에 `~/.openclaw` 폴더가 존재하거나
  `OPENCLAW_STATE_DIR` 가 다른 위치를 가리키는 경우 경고(기록이 설치 간 분산될 수 있음).
- **원격 모드 알림**: `gateway.mode=remote` 인 경우, 원격 호스트에서 실행해야 함을 알립니다
  (상태는 그곳에 존재).
- **설정 파일 권한**: `~/.openclaw/openclaw.json` 이 그룹/전체 읽기 가능이면 경고하고
  `600` 로 강화할 것을 제안합니다.

### 5. 모델 인증 상태(OAuth 만료)

Doctor 는 인증 저장소의 OAuth 프로필을 검사하여 토큰 만료/만료 임박을 경고하고,
안전한 경우 갱신할 수 있습니다. Anthropic Claude Code 프로필이 오래된 경우,
`claude setup-token` 실행(또는 설정 토큰 붙여넣기)을 제안합니다.
갱신 프롬프트는 대화형(TTY) 실행 시에만 표시되며, `--non-interactive` 은 갱신 시도를
건너뜁니다.

Doctor 는 다음으로 인해 일시적으로 사용 불가한 인증 프로필도 보고합니다:

- 짧은 쿨다운(요율 제한/타임아웃/인증 실패)
- 더 긴 비활성화(결제/크레딧 실패)

### 6. Hooks 모델 검증

`hooks.gmail.model` 가 설정된 경우, doctor 는 모델 참조를 카탈로그 및 허용 목록에 대해
검증하고, 해석되지 않거나 허용되지 않는 경우 경고합니다.

### 7. 샌드박스 이미지 복구

샌드박스화가 활성화된 경우, doctor 는 Docker 이미지를 점검하고 현재 이미지가 없는 경우
빌드하거나 레거시 이름으로 전환하도록 제안합니다.

### 8. Gateway 서비스 마이그레이션 및 정리 힌트

Doctor 는 레거시 Gateway 서비스(launchd/systemd/schtasks)를 감지하고,
현재 Gateway 포트를 사용하는 OpenClaw 서비스 설치 및 기존 서비스 제거를 제안합니다. 또한 추가 Gateway 유사 서비스를 스캔하고 정리 힌트를 출력할 수 있습니다.
프로필 이름이 지정된 OpenClaw Gateway 서비스는 1급으로 간주되며 “추가”로 표시되지 않습니다.

### 9. 보안 경고

Doctor 는 허용 목록 없이 다이렉트 메시지에 열려 있는 프로바이더나,
위험한 방식으로 구성된 정책이 있을 때 경고를 출력합니다.

### 10. systemd linger(Linux)

systemd 사용자 서비스로 실행 중인 경우, 로그아웃 후에도 Gateway 가 유지되도록
linger 활성화를 확인합니다.

### 11. Skills 상태

Doctor 는 현재 워크스페이스에 대해 적격/누락/차단된 Skills 의 간단한 요약을 출력합니다.

### 12. Gateway 인증 점검(로컬 토큰)

Doctor 는 로컬 Gateway 에서 `gateway.auth` 가 누락된 경우 경고하고 토큰 생성을 제안합니다. 자동화에서는 `openclaw doctor --generate-gateway-token` 를 사용하여 토큰 생성을 강제할 수 있습니다.

### 13. Gateway 상태 점검 + 재시작

Doctor 는 상태 점검을 실행하고 비정상으로 보일 경우 Gateway 재시작을 제안합니다.

### 14. 채널 상태 경고

Gateway 가 정상인 경우, doctor 는 채널 상태 프로브를 실행하고
권장 수정 사항과 함께 경고를 보고합니다.

### 15. supervisor 설정 감사 + 복구

Doctor 는 설치된 supervisor 설정(launchd/systemd/schtasks)에서 누락되었거나
오래된 기본값(예: systemd network-online 의존성, 재시작 지연)을 점검합니다. 불일치를 발견하면 업데이트를 권장하고, 서비스 파일/작업을 현재 기본값으로
다시 작성할 수 있습니다.

참고:

- `openclaw doctor` 는 supervisor 설정을 다시 작성하기 전에 프롬프트를 표시합니다.
- `openclaw doctor --yes` 는 기본 복구 프롬프트를 수락합니다.
- `openclaw doctor --repair` 은 프롬프트 없이 권장 수정 사항을 적용합니다.
- `openclaw doctor --repair --force` 은 커스텀 supervisor 설정을 덮어씁니다.
- `openclaw gateway install --force` 를 통해 언제든지 전체 재작성을 강제할 수 있습니다.

### 16. Gateway 런타임 + 포트 진단

Doctor 는 서비스 런타임(PID, 마지막 종료 상태)을 검사하고,
서비스가 설치되어 있으나 실제로 실행 중이 아닌 경우 경고합니다. 또한 Gateway 포트(기본값 `18789`)의 충돌을 점검하고,
가능한 원인(Gateway 이미 실행 중, SSH 터널)을 보고합니다.

### 17. Gateway 런타임 모범 사례

Doctor 는 Gateway 서비스가 Bun 이나 버전 관리된 Node 경로
(`nvm`, `fnm`, `volta`, `asdf` 등)에서
실행 중인 경우 경고합니다. WhatsApp + Telegram 채널은 Node 가 필요하며,
버전 관리자 경로는 서비스가 셸 초기화를 로드하지 않기 때문에 업그레이드 후
깨질 수 있습니다. 가능한 경우(Homebrew/apt/choco) 시스템 Node 설치로
마이그레이션을 제안합니다.

### 18. 설정 기록 + 마법사 메타데이터

Doctor 는 모든 설정 변경을 저장하고 doctor 실행을 기록하기 위해
마법사 메타데이터를 스탬프합니다.

### 19. 워크스페이스 팁(백업 + 메모리 시스템)

Doctor 는 누락된 경우 워크스페이스 메모리 시스템을 제안하고,
워크스페이스가 아직 git 관리 하에 있지 않다면 백업 팁을 출력합니다.

워크스페이스 구조와 git 백업(권장: 비공개 GitHub 또는 GitLab)에 대한 전체 가이드는
[/concepts/agent-workspace](/concepts/agent-workspace) 를 참고하십시오.
