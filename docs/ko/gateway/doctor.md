---
read_when:
    - 의사 마이그레이션 추가 또는 수정
    - 주요 구성 변경 사항 소개
summary: 'Doctor 명령: 상태 확인, 구성 마이그레이션 및 복구 단계'
title: 의사
x-i18n:
    generated_at: "2026-02-08T15:54:02Z"
    model: gtx
    provider: google-translate
    source_hash: df7b25f60fd08d508f4c6abfc8e7e06f29bd4bbb34c3320397f47eb72c8de83f
    source_path: gateway/doctor.md
    workflow: 15
---

# 의사

`openclaw doctor` OpenClaw용 수리 + 마이그레이션 도구입니다. 오래된 문제를 해결합니다
config/state를 확인하고, 상태를 확인하고, 실행 가능한 복구 단계를 제공합니다.

## 빠른 시작

```bash
openclaw doctor
```

### 헤드리스/자동화

```bash
openclaw doctor --yes
```

메시지를 표시하지 않고 기본값을 수락합니다(해당되는 경우 다시 시작/서비스/샌드박스 복구 단계 포함).

```bash
openclaw doctor --repair
```

메시지를 표시하지 않고 권장 수리를 적용합니다(안전한 경우 수리 + 다시 시작).

```bash
openclaw doctor --repair --force
```

공격적인 복구도 적용합니다(사용자 정의 감독자 구성 덮어쓰기).

```bash
openclaw doctor --non-interactive
```

프롬프트 없이 실행하고 안전한 마이그레이션(구성 정규화 + 디스크 상의 상태 이동)만 적용합니다. 사람의 확인이 필요한 재시작/서비스/샌드박스 작업을 건너뜁니다.
레거시 상태 마이그레이션은 감지되면 자동으로 실행됩니다.

```bash
openclaw doctor --deep
```

추가 게이트웨이 설치를 위해 시스템 서비스를 스캔합니다(launchd/systemd/schtasks).

작성하기 전에 변경 사항을 검토하려면 먼저 구성 파일을 엽니다.

```bash
cat ~/.openclaw/openclaw.json
```

## 기능(요약)

- Git 설치를 위한 선택적 사전 업데이트(대화형 전용).
- UI 프로토콜 최신성 확인(프로토콜 스키마가 최신일 때 Control UI를 다시 빌드함)
- 상태 확인 + 재시작 프롬프트.
- 기술 상태 요약(적격/누락/차단)
- 레거시 값에 대한 구성 정규화입니다.
- OpenCode Zen 공급자 재정의 경고(`models.providers.opencode`).
- 레거시 온디스크 상태 마이그레이션(세션/에이전트 디렉토리/WhatsApp 인증).
- 상태 무결성 및 권한 확인(세션, 기록, 상태 디렉터리)
- 로컬로 실행할 때 구성 파일 권한 확인(chmod 600)
- 모델 인증 상태: OAuth 만료를 확인하고, 만료되는 토큰을 새로 고칠 수 있으며, 인증 프로필 휴지/비활성화 상태를 보고합니다.
- 추가 작업 공간 디렉토리 감지(`~/openclaw`).
- 샌드박싱이 활성화된 경우 샌드박스 이미지 복구.
- 레거시 서비스 마이그레이션 및 추가 게이트웨이 감지.
- 게이트웨이 런타임 확인(서비스가 설치되었지만 실행되지 않음, 캐시된 실행 라벨)
- 채널 상태 경고(실행 중인 게이트웨이에서 검색)
- 선택적 복구가 포함된 감독자 구성 감사(launchd/systemd/schtasks).
- 게이트웨이 런타임 모범 사례 검사(노드 대 Bun, 버전 관리자 경로)
- 게이트웨이 포트 충돌 진단(기본값 `18789`).
- 개방형 DM 정책에 대한 보안 경고입니다.
- 게이트웨이 인증 경고가 없는 경우 `gateway.auth.token` 설정됩니다(로컬 모드, 토큰 생성 제공).
- Linux에서 systemd 지연 확인.
- 소스 설치 확인(pnpm 작업공간 불일치, UI 자산 누락, tsx 바이너리 누락)
- 업데이트된 구성 + 마법사 메타데이터를 작성합니다.

## 상세한 행동과 근거

### 0) 선택적 업데이트(git 설치)

이것이 git checkout이고 doctor가 대화형으로 실행 중인 경우 다음을 제안합니다.
doctor를 실행하기 전에 업데이트(가져오기/리베이스/빌드)를 수행하세요.

### 1) 구성 정규화

구성에 레거시 값 형태가 포함된 경우(예: `messages.ackReaction`
채널별 재정의 없이) 의사는 이를 현재로 정규화합니다.
스키마.

### 2) 레거시 구성 키 마이그레이션

구성에 더 이상 사용되지 않는 키가 포함되어 있으면 다른 명령이 실행을 거부하고 묻습니다.
당신은 실행 `openclaw doctor`.

의사는:

- 어떤 레거시 키가 발견되었는지 설명하세요.
- 적용된 마이그레이션을 표시합니다.
- 고쳐 쓰기 `~/.openclaw/openclaw.json` 업데이트된 스키마로

게이트웨이는 또한 시작 시 의사 마이그레이션을 자동으로 실행합니다.
레거시 구성 형식이므로 오래된 구성은 수동 개입 없이 복구됩니다.

현재 마이그레이션:

- `routing.allowFrom` → `channels.whatsapp.allowFrom`
- `routing.groupChat.requireMention` → `channels.whatsapp/telegram/imessage.groups."*".requireMention`
- `routing.groupChat.historyLimit` → `messages.groupChat.historyLimit`
- `routing.groupChat.mentionPatterns` → `messages.groupChat.mentionPatterns`
- `routing.queue` → `messages.queue`
- `routing.bindings` → 최상위 수준 `bindings`
- `routing.agents`/`routing.defaultAgentId` → `agents.list` + `agents.list[].default`
- `routing.agentToAgent` → `tools.agentToAgent`
- `routing.transcribeAudio` → `tools.media.audio.models`
- `bindings[].match.accountID` → `bindings[].match.accountId`
- `identity` → `agents.list[].identity`
- `agent.*` → `agents.defaults` + `tools.*` (도구/상승된/exec/샌드박스/하위 에이전트)
- `agent.model`/`allowedModels`/`modelAliases`/`modelFallbacks`/`imageModelFallbacks`
   → `agents.defaults.models` + `agents.defaults.model.primary/fallbacks` + `agents.defaults.imageModel.primary/fallbacks`

### 2b) OpenCode Zen 공급자 재정의

추가한 경우 `models.providers.opencode` (또는 `opencode-zen`) 수동으로
내장된 OpenCode Zen 카탈로그를 재정의합니다. `@mariozechner/pi-ai`. 그럴 수 있어
모든 모델을 단일 API에 적용하거나 비용을 0으로 만들 수 있습니다. 의사는 그렇게 할 수 있다고 경고합니다.
재정의를 제거하고 모델별 API 라우팅 + 비용을 복원합니다.

### 3) 레거시 상태 마이그레이션(디스크 레이아웃)

Doctor는 이전의 디스크 레이아웃을 현재 구조로 마이그레이션할 수 있습니다.

- 세션 저장소 + 기록:
  - ~에서 `~/.openclaw/sessions/` 에게 `~/.openclaw/agents/<agentId>/sessions/`
- 상담원 디렉토리:
  - ~에서 `~/.openclaw/agent/` 에게 `~/.openclaw/agents/<agentId>/agent/`
- WhatsApp 인증 상태(Baileys):
  - 유산에서 `~/.openclaw/credentials/*.json` (제외하고 `oauth.json`)
  -  에게 `~/.openclaw/credentials/whatsapp/<accountId>/...` (기본 계정 ID: `default`)

이러한 마이그레이션은 최선을 다하고 멱등성을 갖습니다. 의사는 다음과 같은 경우 경고를 발할 것입니다.
레거시 폴더는 백업으로 남겨둡니다. 게이트웨이/CLI도 자동 마이그레이션됩니다.
시작 시 레거시 세션 + 에이전트 디렉토리가 있으므로 기록/인증/모델이
수동 의사 실행이 없는 에이전트별 경로입니다. WhatsApp 인증은 의도적으로만 가능합니다.
다음을 통해 마이그레이션됨 `openclaw doctor`.

### 4) 상태 무결성 검사(세션 지속성, 라우팅 및 안전성)

상태 디렉토리는 운영 두뇌간입니다. 사라지면 지는거다
세션, 자격 증명, 로그 및 구성(다른 곳에 백업이 없는 경우)

의사가 확인하는 사항:

- **상태 디렉토리가 누락되었습니다.**: 치명적인 상태 손실에 대해 경고하고 재생성하라는 메시지를 표시합니다.
  누락된 데이터를 복구할 수 없음을 알려줍니다.
- **상태 디렉토리 권한**: 쓰기 가능성을 확인합니다. 권한 복구 제안
  (그리고 `chown` 소유자/그룹 불일치가 감지되면 힌트를 제공합니다.)
- **세션 디렉터리가 누락되었습니다.**: `sessions/` 세션 저장소 디렉토리는 다음과 같습니다.
  기록을 유지하고 방지하는 데 필요 `ENOENT` 충돌.
- **성적 불일치**: 최근 세션 항목이 누락되면 경고합니다.
  성적표 파일.
- **메인 세션 “1-line JSONL”**: 기본 성적표에 하나만 있는 경우 플래그를 지정합니다.
  라인(이력은 누적되지 않습니다).
- **다중 상태 디렉터리**: 여러 개일 때 경고 `~/.openclaw` 폴더가 걸쳐 존재
  홈 디렉토리 또는 언제 `OPENCLAW_STATE_DIR` 다른 곳의 포인트(역사는
  설치 간에 분할됨).
- **원격 모드 알림**: 만약에 `gateway.mode=remote`, 의사가 달리라고 상기시켜줍니다
  원격 호스트에 있습니다(상태는 거기에 있습니다).
- **구성 파일 권한**: 다음과 같은 경우 경고합니다. `~/.openclaw/openclaw.json` 이다
  그룹/전 세계가 읽을 수 있고 강화할 수 있는 제안 `600`.

### 5) 모델 인증 상태(OAuth 만료)

의사는 인증 저장소에서 OAuth 프로필을 검사하고 토큰이 있을 때 경고합니다.
만료/만료되었으며 안전할 때 새로 고칠 수 있습니다. 인류 클로드 코드라면
프로필이 오래되었습니다. 실행하라는 메시지가 표시됩니다. `claude setup-token` (또는 설정 토큰 붙여넣기).
새로 고침 프롬프트는 대화형(TTY)으로 실행할 때만 나타납니다. `--non-interactive`
새로 고침 시도를 건너뜁니다.

Doctor는 다음과 같은 이유로 일시적으로 사용할 수 없는 인증 프로필도 보고합니다.

- 짧은 휴지 시간(비율 제한/시간 초과/인증 실패)
- 더 이상 비활성화됨(청구/신용 실패)

### 6) Hooks 모델 검증

만약에 `hooks.gmail.model` 설정되면 의사는 모델 참조를 검증합니다.
카탈로그 및 허용 목록을 작성하고 해결되지 않거나 허용되지 않는 경우 경고합니다.

### 7) 샌드박스 이미지 복구

샌드박싱이 활성화되면 의사는 Docker 이미지를 확인하고 빌드 또는 제안을 제안합니다.
현재 이미지가 누락된 경우 레거시 이름으로 전환합니다.

### 8) 게이트웨이 서비스 마이그레이션 및 정리 힌트

Doctor는 레거시 게이트웨이 서비스(launchd/systemd/schtasks)를 감지하고
이를 제거하고 현재 게이트웨이를 사용하여 OpenClaw 서비스를 설치하도록 제안합니다.
항구. 또한 추가 게이트웨이와 유사한 서비스를 검색하고 정리 힌트를 인쇄할 수도 있습니다.
프로필 이름이 지정된 OpenClaw 게이트웨이 서비스는 최고 수준으로 간주되지만
"추가"로 표시됩니다.

### 9) 보안 경고

의사는 제공자가 허용 목록 없이 DM에 열려 있는 경우 경고를 내보냅니다.
정책이 위험한 방식으로 구성된 경우.

### 10) 시스템 링거(Linux)

시스템 사용자 서비스로 실행하는 경우 의사는 링링이 활성화되어 있는지 확인합니다.
게이트웨이는 로그아웃 후에도 계속 살아있습니다.

### 11) 스킬 현황

의사는 현재 적격/누락/차단된 기술에 대한 빠른 요약을 인쇄합니다.
작업 공간.

### 12) 게이트웨이 인증 확인(로컬 토큰)

의사는 다음과 같은 경우 경고합니다. `gateway.auth` 로컬 게이트웨이에서 누락되었으며 다음을 제공합니다.
토큰을 생성합니다. 사용 `openclaw doctor --generate-gateway-token` 토큰을 강제로
자동화의 창조.

### 13) 게이트웨이 상태 확인 + 다시 시작

의사는 상태 점검을 실행하고 게이트웨이가 이상해지면 다시 시작하겠다고 제안합니다.
건강에 해로운.

### 14) 채널 상태 경고

게이트웨이가 정상이면 의사는 채널 상태 프로브를 실행하고 보고합니다.
제안된 수정 사항이 포함된 경고.

### 15) 감독자 구성 감사 + 수리

의사는 설치된 감독자 구성(launchd/systemd/schtasks)을 확인합니다.
누락되거나 오래된 기본값(예: 시스템 네트워크 온라인 종속성 및
재시작 지연). 불일치가 발견되면 업데이트를 권장하고 다음을 수행할 수 있습니다.
서비스 파일/작업을 현재 기본값으로 다시 작성합니다.

참고:

- `openclaw doctor` 감독자 구성을 다시 작성하기 전에 메시지가 표시됩니다.
- `openclaw doctor --yes` 기본 수리 프롬프트를 수락합니다.
- `openclaw doctor --repair` 프롬프트 없이 권장 수정 사항을 적용합니다.
- `openclaw doctor --repair --force` 사용자 정의 감독자 구성을 덮어씁니다.
- 언제든지 다음을 통해 전체 재작성을 강제할 수 있습니다. `openclaw gateway install --force`.

### 16) 게이트웨이 런타임 + 포트 진단

의사는 서비스 런타임(PID, 마지막 종료 상태)을 검사하고
서비스가 설치되었지만 실제로 실행되지는 않습니다. 또한 포트 충돌도 확인합니다.
게이트웨이 포트(기본값 `18789`) 및 가능한 원인을 보고합니다(게이트웨이는 이미
실행 중, SSH 터널).

### 17) 게이트웨이 런타임 모범 사례

의사는 게이트웨이 서비스가 Bun 또는 버전 관리 노드 경로에서 실행될 때 경고합니다.
(`nvm`, `fnm`, `volta`, `asdf`, 등.). WhatsApp + Telegram 채널에는 Node가 필요합니다.
버전 관리자 경로는 서비스가 업그레이드되지 않기 때문에 업그레이드 후에 중단될 수 있습니다.
쉘 초기화를로드하십시오. Doctor는 다음과 같은 경우 시스템 노드 설치로 마이그레이션할 것을 제안합니다.
사용 가능합니다(Homebrew/apt/choco).

### 18) 구성 쓰기 + 마법사 메타데이터

Doctor는 모든 구성 변경 사항을 유지하고 마법사 메타데이터에 스탬프를 찍어
닥터 런.

### 19) 작업 공간 팁(백업 + 메모리 시스템)

누락된 경우 의사가 작업 공간 메모리 시스템을 제안하고 백업 팁을 인쇄합니다.
작업공간이 아직 git 아래에 있지 않은 경우.

보다 [/개념/에이전트-작업 공간](/concepts/agent-workspace) 전체 가이드를 보려면
작업 공간 구조 및 git 백업(개인 GitHub 또는 GitLab 권장)
