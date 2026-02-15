---
summary: "Agent workspace: location, layout, and backup strategy"
read_when:
  - You need to explain the agent workspace or its file layout
  - You want to back up or migrate an agent workspace
title: "Agent Workspace"
x-i18n:
  source_hash: d3cc655c58f00965546ea92080c52a9affd45da4c613fe258271db46f279548e
---

# 에이전트 작업공간

작업공간은 상담원의 집입니다. 에 사용되는 유일한 작업 디렉토리입니다.
파일 도구 및 작업 공간 컨텍스트용. 비공개로 유지하고 추억으로 취급하세요.

이는 구성, 자격 증명 및 정보를 저장하는 `~/.openclaw/`와는 별개입니다.
세션.

**중요:** 작업공간은 하드 샌드박스가 아닌 **기본 cwd**입니다. 도구
작업공간에 대한 상대 경로를 확인하지만 절대 경로는 여전히 도달할 수 있습니다.
샌드박싱이 활성화되지 않는 한 호스트의 다른 곳에서. 격리가 필요한 경우 다음을 사용하세요.
[`agents.defaults.sandbox`](/gateway/sandboxing) (및/또는 에이전트별 샌드박스 구성).
샌드박싱이 활성화되고 `workspaceAccess`가 `"rw"`가 아닌 경우 도구가 작동합니다.
호스트 작업공간이 아닌 `~/.openclaw/sandboxes` 아래의 샌드박스 작업공간 내부에 있습니다.

## 기본 위치

- 기본값 : `~/.openclaw/workspace`
- `OPENCLAW_PROFILE`가 설정되어 있고 `"default"`가 아닌 경우 기본값은 다음과 같습니다.
  `~/.openclaw/workspace-<profile>`.
- `~/.openclaw/openclaw.json`에서 재정의:

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

`openclaw onboard`, `openclaw configure` 또는 `openclaw setup`는
작업 공간을 열고 부트스트랩 파일이 누락된 경우 시드합니다.

이미 작업공간 파일을 직접 관리하고 있다면 부트스트랩을 비활성화할 수 있습니다.
파일 생성:

```json5
{ agent: { skipBootstrap: true } }
```

## 추가 작업 공간 폴더

이전 설치로 인해 `~/openclaw`이 생성되었을 수 있습니다. 여러 작업 공간 유지
주변의 디렉터리는 혼란스러운 인증 또는 상태 드리프트를 일으킬 수 있습니다.
작업공간은 한 번에 활성화됩니다.

**권장사항:** 단일 활성 작업공간을 유지하세요. 더 이상 사용하지 않는 경우
추가 폴더를 보관하거나 휴지통으로 이동하세요(예: `trash ~/openclaw`).
의도적으로 여러 작업 공간을 유지하는 경우 다음을 확인하세요.
`agents.defaults.workspace`는 활성 항목을 가리킵니다.

`openclaw doctor`는 추가 작업공간 디렉토리를 감지하면 경고합니다.

## 작업공간 파일 맵(각 파일의 의미)

OpenClaw가 작업 공간 내에서 기대하는 표준 파일은 다음과 같습니다.

- `AGENTS.md`
  - 에이전트 작동 지침 및 메모리 사용 방법.
  - 매 세션이 시작될 때 로드됩니다.
  - 규칙, 우선순위, "행동 방법" 세부 사항을 기록하기에 좋은 곳입니다.

- `SOUL.md`
  - 페르소나, 어조, 경계.
  - 매 세션마다 로드됩니다.

- `USER.md`
  - 사용자가 누구이며 어떻게 대처해야 하는지.
  - 매 세션마다 로드됩니다.

- `IDENTITY.md`
  - 상담원의 이름, 느낌, 이모티콘입니다.
  - 부트스트랩 의식 중에 생성/업데이트되었습니다.

- `TOOLS.md`
  - 현지 도구 및 규칙에 대한 참고 사항입니다.
  - 도구 가용성을 제어하지 않습니다. 그것은 단지 지침일 뿐이다.

- `HEARTBEAT.md`
  - 심장 박동 실행을 위한 선택적인 작은 체크리스트입니다.
  - 토큰 소각을 방지하려면 짧게 유지하세요.

- `BOOT.md`
  - 내부 후크가 활성화된 경우 게이트웨이를 다시 시작할 때 실행되는 선택적 시작 체크리스트입니다.
  - 짧게 유지하세요. 아웃바운드 전송에는 메시지 도구를 사용하세요.

- `BOOTSTRAP.md`
  - 최초 실행 의식은 1회만 제공됩니다.
  - 새로운 작업 공간을 위해서만 생성되었습니다.
  - 의식이 완료된 후 삭제하세요.

- `memory/YYYY-MM-DD.md`
  - 일일 메모리 로그(1일 1개 파일).
  - 오늘 + 어제 세션 시작 시 읽기를 권장합니다.

- `MEMORY.md` (선택 사항)
  - 선별된 장기 기억.
  - 기본 개인 세션에서만 로드됩니다(공유/그룹 컨텍스트 아님).

작업흐름과 자동 메모리 플러시에 대해서는 [메모리](/concepts/memory)를 참조하세요.

- `skills/` (선택 사항)
  - 작업 공간별 기술.
  - 이름이 충돌하면 관리/번들링된 스킬을 무시합니다.

- `canvas/` (선택 사항)
  - 노드 표시용 캔버스 UI 파일(예: `canvas/index.html`)

부트스트랩 파일이 누락된 경우 OpenClaw는 "누락된 파일" 마커를
세션이 계속됩니다. 큰 부트스트랩 파일은 삽입 시 잘립니다.
`agents.defaults.bootstrapMaxChars`로 제한을 조정합니다(기본값: 20000).
`openclaw setup`는 기존을 덮어쓰지 않고 누락된 기본값을 다시 생성할 수 있습니다.
파일.

## 작업공간에 없는 것

이는 `~/.openclaw/` 아래에 있으며 작업공간 저장소에 커밋되어서는 안 됩니다.

- `~/.openclaw/openclaw.json` (구성)
- `~/.openclaw/credentials/` (OAuth 토큰, API 키)
- `~/.openclaw/agents/<agentId>/sessions/` (세션 기록 + 메타데이터)
- `~/.openclaw/skills/` (관리 스킬)

세션이나 구성을 마이그레이션해야 하는 경우 별도로 복사하여 보관하세요.
버전 관리가 불가능합니다.

## Git 백업(권장, 비공개)

작업 공간을 개인 메모리로 취급하십시오. **비공개** git 저장소에 넣어두세요.
백업되어 복구 가능합니다.

게이트웨이가 실행되는 머신(즉, 게이트웨이가 실행되는 머신)에서 다음 단계를 실행하세요.
작업 공간 생활).

### 1) 저장소 초기화

git이 설치되면 새로운 작업 공간이 자동으로 초기화됩니다. 만약 이
작업공간은 아직 저장소가 아닙니다. 다음을 실행하세요.

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md SOUL.md TOOLS.md IDENTITY.md USER.md HEARTBEAT.md memory/
git commit -m "Add agent workspace"
```

### 2) 개인 리모컨 추가(초보자 친화적인 옵션)

옵션 A: GitHub 웹 UI

1. GitHub에 새로운 **비공개** 저장소를 만듭니다.
2. README로 초기화하지 마십시오(병합 충돌 방지).
3. HTTPS 원격 URL을 복사합니다.
4. 리모컨을 추가하고 다음을 누릅니다.

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

1. GitLab에 새로운 **비공개** 저장소를 생성합니다.
2. README로 초기화하지 마십시오(병합 충돌 방지).
3. HTTPS 원격 URL을 복사합니다.
4. 리모컨을 추가하고 다음을 누릅니다.

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

## 비밀을 커밋하지 마세요

비공개 리포지토리에서도 작업 공간에 비밀을 저장하지 마세요.

- API 키, OAuth 토큰, 비밀번호 또는 개인 자격 증명.
- `~/.openclaw/` 아래의 모든 것.
- 채팅 또는 민감한 첨부 파일의 원시 덤프입니다.

민감한 참조를 저장해야 하는 경우 자리 표시자를 사용하고 실제 참조를 유지하세요.
다른 곳의 비밀(비밀번호 관리자, 환경 변수 또는 `~/.openclaw/`).

제안된 `.gitignore` 스타터:

```gitignore
.DS_Store
.env
**/*.key
**/*.pem
**/secrets*
```

## 작업공간을 새 머신으로 이동

1. 리포지토리를 원하는 경로에 복제합니다(기본값 `~/.openclaw/workspace`).
2. `agents.defaults.workspace`을 `~/.openclaw/openclaw.json`의 해당 경로로 설정합니다.
3. `openclaw setup --workspace <path>`를 실행하여 누락된 파일을 시드합니다.
4. 세션이 필요한 경우 다음에서 `~/.openclaw/agents/<agentId>/sessions/`를 복사하세요.
   오래된 기계를 별도로.

## 고급 참고 사항

- 다중 에이전트 라우팅은 에이전트별로 서로 다른 작업 공간을 사용할 수 있습니다. 참조
  [채널 라우팅](/channels/channel-routing) 라우팅 구성을 위한 것입니다.
- `agents.defaults.sandbox`가 활성화되면 기본 세션이 아닌 세션에서 세션별 샌드박스를 사용할 수 있습니다.
  `agents.defaults.sandbox.workspaceRoot` 아래의 작업공간.
