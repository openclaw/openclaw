---
read_when:
    - 상담원 작업공간이나 해당 파일 레이아웃을 설명해야 합니다.
    - 에이전트 작업 영역을 백업하거나 마이그레이션하고 싶습니다.
summary: '에이전트 작업 공간: 위치, 레이아웃 및 백업 전략'
title: 상담원 작업 공간
x-i18n:
    generated_at: "2026-02-08T15:50:42Z"
    model: gtx
    provider: google-translate
    source_hash: d3cc655c58f00965546ea92080c52a9affd45da4c613fe258271db46f279548e
    source_path: concepts/agent-workspace.md
    workflow: 15
---

# 상담원 작업공간

작업공간은 상담원의 집입니다. 에 사용되는 유일한 작업 디렉토리입니다.
파일 도구 및 작업 공간 컨텍스트용. 비공개로 유지하고 추억으로 취급하세요.

이것은 별개이다. `~/.openclaw/`, 구성, 자격 증명 및
세션.

**중요한:** 작업공간은 **기본 cwd**, 하드 샌드박스가 아닙니다. 도구
작업공간에 대한 상대 경로를 확인하지만 절대 경로는 여전히 도달할 수 있습니다.
샌드박싱이 활성화되지 않는 한 호스트의 다른 곳에서. 격리가 필요한 경우 다음을 사용하세요.
[`agents.defaults.sandbox`](/gateway/sandboxing) (및/또는 에이전트별 샌드박스 구성)
샌드박싱이 활성화된 경우 `workspaceAccess` 아니다 `"rw"`, 도구가 작동합니다
샌드박스 작업 공간 내부 `~/.openclaw/sandboxes`, 호스트 작업공간이 아닙니다.

## 기본 위치

- 기본: `~/.openclaw/workspace`
- 만약에 `OPENCLAW_PROFILE` 설정되어 있고 그렇지 않음 `"default"`, 기본값은 다음과 같습니다.
  `~/.openclaw/workspace-<profile>`.
- 재정의 `~/.openclaw/openclaw.json`:

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

`openclaw onboard`, `openclaw configure`, 또는 `openclaw setup` 을 만들 것입니다
작업 공간을 열고 부트스트랩 파일이 누락된 경우 시드합니다.

이미 작업공간 파일을 직접 관리하고 있다면 부트스트랩을 비활성화할 수 있습니다.
파일 생성:

```json5
{ agent: { skipBootstrap: true } }
```

## 추가 작업 공간 폴더

이전 설치로 인해 생성되었을 수 있습니다. `~/openclaw`. 여러 작업 공간 유지
주변의 디렉터리는 혼란스러운 인증 또는 상태 드리프트를 일으킬 수 있습니다.
작업공간은 한 번에 활성화됩니다.

**추천:** 단일 활성 작업 공간을 유지합니다. 더 이상 사용하지 않는 경우
추가 폴더를 보관하거나 휴지통으로 이동합니다(예: `trash ~/openclaw`).
의도적으로 여러 작업 공간을 유지하는 경우 다음을 확인하세요.
`agents.defaults.workspace` 활동적인 것을 가리킨다.

`openclaw doctor` 추가 작업 공간 디렉토리를 감지하면 경고합니다.

## 작업공간 파일 맵(각 파일의 의미)

OpenClaw가 작업 공간 내에서 기대하는 표준 파일은 다음과 같습니다.

- `AGENTS.md`
  - 에이전트 작동 지침 및 에이전트의 메모리 사용 방법입니다.
  - 모든 세션이 시작될 때 로드됩니다.
  - 규칙, 우선순위, "행동 방법" 세부 사항을 확인하기 좋은 곳입니다.

- `SOUL.md`
  - 페르소나, 어조, 경계.
  - 모든 세션을 로드했습니다.

- `USER.md`
  - 사용자가 누구이며 이를 해결하는 방법
  - 모든 세션을 로드했습니다.

- `IDENTITY.md`
  - 상담원의 이름, 느낌, 이모티콘입니다.
  - 부트스트랩 의식 중에 생성/업데이트되었습니다.

- `TOOLS.md`
  - 로컬 도구 및 규칙에 대한 참고 사항입니다.
  - 도구 가용성을 제어하지 않습니다. 그것은 단지 지침일 뿐이다.

- `HEARTBEAT.md`
  - 하트비트 실행을 위한 선택적 작은 체크리스트입니다.
  - 토큰 소각을 방지하려면 짧게 유지하세요.

- `BOOT.md`
  - 내부 후크가 활성화된 경우 게이트웨이를 다시 시작할 때 실행되는 선택적 시작 체크리스트입니다.
  - 짧게 유지하세요. 아웃바운드 전송에는 메시지 도구를 사용하세요.

- `BOOTSTRAP.md`
  - 첫 번째 실행 의식은 한 번만 수행됩니다.
  - 새로운 작업 공간을 위해서만 만들어졌습니다.
  - 의식이 끝나면 삭제하세요.

- `memory/YYYY-MM-DD.md`
  - 일일 메모리 로그(하루에 파일 1개).
  - 세션 시작 시 오늘 + 어제 읽으시길 권장합니다.

- `MEMORY.md` (선택 과목)
  - 선별된 장기 기억.
  - 기본 비공개 세션에서만 로드됩니다(공유/그룹 컨텍스트 아님).

보다 [메모리](/concepts/memory) 워크플로 및 자동 메모리 플러시를 위한 것입니다.

- `skills/` (선택 과목)
  - 작업공간별 기술.
  - 이름이 충돌하면 관리/번들 기술을 재정의합니다.

- `canvas/` (선택 과목)
  - 노드 표시용 캔버스 UI 파일(예: `canvas/index.html`).

부트스트랩 파일이 누락된 경우 OpenClaw는 "누락된 파일" 마커를
세션이 계속됩니다. 큰 부트스트랩 파일은 삽입 시 잘립니다.
으로 한도를 조정하세요. `agents.defaults.bootstrapMaxChars` (기본값: 20000)
`openclaw setup` 기존을 덮어쓰지 않고 누락된 기본값을 다시 생성할 수 있습니다.
파일.

## 작업 공간에 없는 것

이들은 아래에 산다 `~/.openclaw/` 작업공간 저장소에 커밋하면 안 됩니다.

- `~/.openclaw/openclaw.json` (구성)
- `~/.openclaw/credentials/` (OAuth 토큰, API 키)
- `~/.openclaw/agents/<agentId>/sessions/` (세션 기록 + 메타데이터)
- `~/.openclaw/skills/` (관리 기술)

세션이나 구성을 마이그레이션해야 하는 경우 별도로 복사하여 보관하세요.
버전 관리가 불가능합니다.

## Git 백업(권장, 비공개)

작업 공간을 개인 메모리로 취급하십시오. 에 넣어 **사적인** git repo는 그렇습니다
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

1. 새로 만들기 **사적인** GitHub의 저장소.
2. README로 초기화하지 마십시오(병합 충돌 방지).
3. HTTPS 원격 URL을 복사합니다.
4. 리모컨을 추가하고 푸시하세요.

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

옵션 B: GitHub CLI(`gh`)

```bash
gh auth login
gh repo create openclaw-workspace --private --source . --remote origin --push
```

옵션 C: GitLab 웹 UI

1. 새로 만들기 **사적인** GitLab의 저장소.
2. README로 초기화하지 마십시오(병합 충돌 방지).
3. HTTPS 원격 URL을 복사합니다.
4. 리모컨을 추가하고 푸시하세요.

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

## 비밀을 저지르지 마세요

비공개 리포지토리에서도 작업 공간에 비밀을 저장하지 마세요.

- API 키, OAuth 토큰, 비밀번호 또는 개인 자격 증명.
- 아래의 모든 것 `~/.openclaw/`.
- 채팅 또는 민감한 첨부 파일의 원시 덤프입니다.

민감한 참조를 저장해야 하는 경우 자리 표시자를 사용하고 실제 참조를 유지하세요.
다른 곳의 비밀(비밀번호 관리자, 환경 변수 또는 `~/.openclaw/`).

제안 `.gitignore` 기동기:

```gitignore
.DS_Store
.env
**/*.key
**/*.pem
**/secrets*
```

## 작업 공간을 새 컴퓨터로 이동

1. 저장소를 원하는 경로로 복제합니다(기본값 `~/.openclaw/workspace`).
2. 세트 `agents.defaults.workspace` 그 길로 `~/.openclaw/openclaw.json`.
3. 달리다 `openclaw setup --workspace <path>` 누락된 파일을 시드합니다.
4. 세션이 필요한 경우 복사하세요. `~/.openclaw/agents/<agentId>/sessions/` 에서
   오래된 기계를 별도로.

## 고급 메모

- 다중 에이전트 라우팅은 에이전트별로 서로 다른 작업 영역을 사용할 수 있습니다. 보다
  [채널 라우팅](/channels/channel-routing) 라우팅 구성을 위한 것입니다.
- 만약에 `agents.defaults.sandbox` 활성화되면 기본 세션이 아닌 세션에서 세션별 샌드박스를 사용할 수 있습니다.
  작업공간 `agents.defaults.sandbox.workspaceRoot`.
