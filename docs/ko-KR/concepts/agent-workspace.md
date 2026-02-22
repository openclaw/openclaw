---
summary: "에이전트 작업 공간: 위치, 구성 및 백업 전략"
read_when:
  - 에이전트 작업 공간이나 그 파일 구성을 설명해야 할 때
  - 에이전트 작업 공간을 백업하거나 마이그레이션하고 싶을 때
title: "에이전트 작업 공간"
---

# 에이전트 작업 공간

작업 공간은 에이전트의 홈입니다. 파일 도구 및 작업 공간 컨텍스트에 사용되는 유일한 작업 디렉토리입니다. 개인적으로 유지하고 메모리처럼 취급하세요.

이는 설정, 자격 증명 및 세션을 저장하는 `~/.openclaw/`와는 별도로 존재합니다.

**중요:** 작업 공간은 **기본 현재 작업 디렉토리(cwd)**이며, 강력한 샌드박스가 아닙니다. 도구들은 작업 공간을 기준으로 상대 경로를 해석하지만, 샌드박스 격리 기능이 활성화되지 않으면 절대 경로로 호스트의 다른 위치에 도달할 수 있습니다. 고립이 필요하다면 [`agents.defaults.sandbox`](/ko-KR/gateway/sandboxing)(또는 에이전트별 샌드박스 설정)을 사용하세요. 샌드박스 격리가 활성화되어 있고 `workspaceAccess`가 `"rw"`가 아닌 경우, 도구는 호스트 작업 공간이 아닌 `~/.openclaw/sandboxes` 밑의 샌드박스 작업 공간 내부에서 작동합니다.

## 기본 위치

- 기본값: `~/.openclaw/workspace`
- `OPENCLAW_PROFILE`이 설정되어 있고 `"default"`가 아닌 경우, 기본값이 `~/.openclaw/workspace-<profile>`로 변경됩니다.
- `~/.openclaw/openclaw.json`에서 재정의할 수 있습니다:

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

`openclaw onboard`, `openclaw configure`, 또는 `openclaw setup`은 작업 공간을 생성하고 부트스트랩 파일을 생성합니다.

이미 작업 공간 파일을 관리하고 있다면, 부트스트랩 파일 생성을 끌 수 있습니다:

```json5
{ agent: { skipBootstrap: true } }
```

## 추가 작업 공간 폴더

이전 설치에서는 `~/openclaw`가 생성됐을 수 있습니다. 여러 작업 공간 디렉토리를 유지하는 것은 인증이나 상태 드리프트를 유발할 수 있으며, 한 번에 하나의 작업 공간만 활성화될 수 있습니다.

**추천:** 단 하나의 활성 작업 공간을 유지하세요. 추가 폴더를 더 이상 사용하지 않는다면, 이를 보관하거나 휴지통으로 이동하세요 (예시: `trash ~/openclaw`). 여러 작업 공간을 의도적으로 유지한다면, `agents.defaults.workspace`가 활성화된 작업 공간을 가리키도록 하세요.

`openclaw doctor`는 추가 작업 공간 디렉토리를 감지하면 경고합니다.

## 작업 공간 파일 맵 (각 파일의 의미)

작업 공간 내에 OpenClaw가 기대하는 표준 파일들은 다음과 같습니다:

- `AGENTS.md`
  - 에이전트를 위한 작동 지침과 메모리 사용 방식.
  - 매 세션 시작 시 로드.
  - 규칙, 우선순위 및 "행동 요령"을 위한 좋은 장소.

- `SOUL.md`
  - 페르소나, 어조, 경계.
  - 모든 세션에서 로드.

- `USER.md`
  - 사용자가 누구인지 및 그들에게 말하는 방법.
  - 모든 세션에서 로드.

- `IDENTITY.md`
  - 에이전트의 이름, 분위기, 이모지.
  - 부트스트랩 의식 중 생성/업데이트.

- `TOOLS.md`
  - 로컬 도구 및 컨벤션에 대한 노트.
  - 도구 가용성을 통제하지 않음; 단지 가이드.

- `HEARTBEAT.md`
  - 하트비트 실행을 위한 선택적 체크리스트.
  - 토큰 소모를 피하기 위해 짧게 유지.

- `BOOT.md`
  - 게이트웨이 재시작 시 내부 훅이 활성화된 경우 실행되는 선택적 시작 체크리스트.
  - 짧게 유지; 발신 전송에는 메시지 도구를 사용.

- `BOOTSTRAP.md`
  - 일회성 첫 실행 의식.
  - 새로운 작업 공간에만 생성.
  - 의식이 완료되면 삭제.

- `memory/YYYY-MM-DD.md`
  - 일일 메모리 로그 (하루에 한 파일).
  - 세션 시작 시 오늘 + 어제를 읽는 것을 권장.

- `MEMORY.md` (선택 사항)
  - 선별된 장기 메모리.
  - 메인, 비공개 세션에서만 로드 (공유/그룹 컨텍스트에서는 제외).

[메모리](/ko-KR/concepts/memory)를 참조하여 워크플로우 및 자동 메모리 플러시 확인.

- `skills/` (선택 사항)
  - 작업 공간 전용 스킬.
  - 이름이 충돌할 때 관리/번들링된 스킬을 대체.

- `canvas/` (선택 사항)
  - 노드 디스플레이를 위한 캔버스 UI 파일 (예: `canvas/index.html`).

누락된 부트스트랩 파일이 있는 경우, OpenClaw는 "누락된 파일" 마커를 세션에 주입하고 계속 진행합니다. 대형 부트스트랩 파일은 주입 시 잘려집니다; 'agents.defaults.bootstrapMaxChars' (기본값: 20000) 및 `agents.defaults.bootstrapTotalMaxChars` (기본값: 150000)로 조정합니다. `openclaw setup`은 기존 파일을 덮어쓰지 않고 누락된 기본값을 재생성할 수 있습니다.

## 작업 공간에 포함되지 않는 항목

다음 항목은 `~/.openclaw/`에 있으며 작업 공간 저장소에 커밋되지 않아야 합니다:

- `~/.openclaw/openclaw.json` (설정)
- `~/.openclaw/credentials/` (OAuth 토큰, API 키)
- `~/.openclaw/agents/<agentId>/sessions/` (세션 기록 + 메타데이터)
- `~/.openclaw/skills/` (관리된 스킬)

세션이나 설정을 마이그레이션해야 하는 경우, 이를 별도로 복사하고 버전 컨트롤에서 제외하세요.

## Git 백업 (권장, 비공개)

작업 공간을 개인 메모리로 취급하세요. 개인 git 저장소에 넣어 백업하고 복구 가능하게 합니다.

게이트웨이가 실행되는 머신에서 다음 단계를 수행합니다 (작업 공간이 존재하는 곳).

### 1) 저장소 초기화

git이 설치되어 있으면, 새로운 작업 공간은 자동으로 초기화됩니다. 이 작업 공간이 이미 저장소가 아니라면, 다음을 실행하세요:

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md SOUL.md TOOLS.md IDENTITY.md USER.md HEARTBEAT.md memory/
git commit -m "Add agent workspace"
```

### 2) 비공개 원격 추가 (초보자 친화적 옵션)

옵션 A: GitHub 웹 UI

1. GitHub에서 새로운 **비공개** 저장소를 생성합니다.
2. README를 초기화하지 않습니다 (병합 충돌 방지).
3. HTTPS 원격 URL을 복사합니다.
4. 원격을 추가하고 푸시합니다:

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

옵션 B: GitHub CLI (`gh`)

```bash
gh auth login
gh repo create openclaw-workspace --private --source . --remote origin --push
```

옵션 C: GitLab 웹 UI

1. GitLab에서 새로운 **비공개** 저장소를 생성합니다.
2. README를 초기화하지 않습니다 (병합 충돌 방지).
3. HTTPS 원격 URL을 복사합니다.
4. 원격을 추가하고 푸시합니다:

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

### 3) 지속적인 업데이트

```bash
git status
git add .
git commit -m "Update memory"
git push
```

## 비밀 커밋 금지

비공개 저장소에서도, 작업 공간에 비밀을 저장하지 않도록 하세요:

- API 키, OAuth 토큰, 비밀번호 또는 개인 자격 증명.
- `~/.openclaw/` 아래의 모든 것.
- 채팅이나 민감한 첨부 파일의 원시 덤프.

민감한 참조를 저장해야 한다면, 플레이스홀더를 사용하고 실제 비밀은 다른 곳에 보관하세요 (비밀번호 관리자, 환경 변수 또는 `~/.openclaw/`).

제안 `.gitignore` 시작기:

```gitignore
.DS_Store
.env
**/*.key
**/*.pem
**/secrets*
```

## 새로운 머신으로 작업 공간 이동

1. 저장소를 원하는 경로로 복제합니다 (기본값 `~/.openclaw/workspace`).
2. 그 경로에서 `agents.defaults.workspace`를 `~/.openclaw/openclaw.json`에 설정합니다.
3. 누락된 파일을 생성하기 위해 `openclaw setup --workspace <path>`를 실행합니다.
4. 세션이 필요하다면, 예전 머신에서 `~/.openclaw/agents/<agentId>/sessions/`를 별도로 복사합니다.

## 고급 참고 사항

- 멀티 에이전트 라우팅은 에이전트별로 다른 작업 공간을 사용할 수 있습니다. 라우팅 설정에 대해서는 [채널 라우팅](/ko-KR/channels/channel-routing)을 참조하세요.
- `agents.defaults.sandbox`가 활성화된 경우, 비주 메인 세션은 `agents.defaults.sandbox.workspaceRoot` 아래의 세션별 샌드박스 작업 공간을 사용할 수 있습니다.