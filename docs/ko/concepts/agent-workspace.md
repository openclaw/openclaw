---
summary: "에이전트 워크스페이스: 위치, 레이아웃 및 백업 전략"
read_when:
  - 에이전트 워크스페이스 또는 파일 레이아웃을 설명해야 할 때
  - 에이전트 워크스페이스를 백업하거나 마이그레이션하려는 경우
title: "에이전트 워크스페이스"
---

# 에이전트 워크스페이스

워크스페이스는 에이전트의 집입니다. 파일 도구와 워크스페이스 컨텍스트에 사용되는 유일한 작업 디렉토리입니다. 이를 비공개로 유지하고 메모리처럼 취급하십시오.

이는 구성, 자격 증명, 세션을 저장하는 `~/.openclaw/` 와는 별개입니다.

**중요:** 워크스페이스는 **기본 cwd** 이며, 하드 샌드박스가 아닙니다. 도구는 상대 경로를 워크스페이스 기준으로 해석하지만, 샌드박스화가 활성화되지 않은 경우 절대 경로는 호스트의 다른 위치에 접근할 수 있습니다. 격리가 필요하다면 [`agents.defaults.sandbox`](/gateway/sandboxing) (및/또는 에이전트별 샌드박스 설정)를 사용하십시오.
샌드박스화가 활성화되고 `workspaceAccess` 이 `"rw"` 이 아닌 경우, 도구는 호스트 워크스페이스가 아니라 `~/.openclaw/sandboxes` 아래의 샌드박스 워크스페이스 내부에서 동작합니다.

## 기본 위치

- 기본값: `~/.openclaw/workspace`
- `OPENCLAW_PROFILE` 가 설정되어 있고 `"default"` 가 아닌 경우, 기본값은
  `~/.openclaw/workspace-<profile>` 이 됩니다.
- `~/.openclaw/openclaw.json` 에서 재정의할 수 있습니다:

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

`openclaw onboard`, `openclaw configure` 또는 `openclaw setup` 는 워크스페이스를 생성하고 누락된 경우 부트스트랩 파일을 시드합니다.

이미 워크스페이스 파일을 직접 관리하는 경우, 부트스트랩 파일 생성을 비활성화할 수 있습니다:

```json5
{ agent: { skipBootstrap: true } }
```

## 추가 워크스페이스 폴더

이전 설치에서는 `~/openclaw` 이 생성되었을 수 있습니다. 여러 워크스페이스 디렉토리를 유지하면 한 번에 하나의 워크스페이스만 활성화되기 때문에 인증이나 상태 드리프트로 혼란이 생길 수 있습니다.

**권장 사항:** 단일 활성 워크스페이스를 유지하십시오. 더 이상 추가 폴더를 사용하지 않는다면 아카이브하거나 휴지통으로 이동하십시오(예: `trash ~/openclaw`).
의도적으로 여러 워크스페이스를 유지하는 경우, `agents.defaults.workspace` 이 활성 워크스페이스를 가리키는지 확인하십시오.

`openclaw doctor` 는 추가 워크스페이스 디렉토리를 감지하면 경고합니다.

## 워크스페이스 파일 맵(각 파일의 의미)

다음은 OpenClaw 가 워크스페이스 내부에서 기대하는 표준 파일입니다:

- `AGENTS.md`
  - 에이전트의 운영 지침과 메모리 사용 방식.
  - 모든 세션 시작 시 로드됩니다.
  - 규칙, 우선순위, '행동 방식' 세부 사항을 두기에 적합합니다.

- `SOUL.md`
  - 페르소나, 톤, 경계.
  - 매 세션마다 로드됩니다.

- `USER.md`
  - 사용자가 누구인지와 어떻게 호칭할지.
  - 매 세션마다 로드됩니다.

- `IDENTITY.md`
  - 에이전트의 이름, 분위기, 이모지.
  - 부트스트랩 의식 중에 생성/업데이트됩니다.

- `TOOLS.md`
  - 로컬 도구와 관례에 대한 메모.
  - 도구 가용성을 제어하지 않으며, 안내용일 뿐입니다.

- `HEARTBEAT.md`
  - 하트비트 실행을 위한 선택적 소형 체크리스트.
  - 토큰 소모를 피하기 위해 짧게 유지하십시오.

- `BOOT.md`
  - 내부 훅이 활성화된 경우 Gateway(게이트웨이) 재시작 시 실행되는 선택적 시작 체크리스트.
  - 짧게 유지하고, 외부 전송은 메시지 도구를 사용하십시오.

- `BOOTSTRAP.md`
  - 최초 실행 시의 일회성 의식.
  - 완전히 새로운 워크스페이스에 대해서만 생성됩니다.
  - 의식이 완료되면 삭제하십시오.

- `memory/YYYY-MM-DD.md`
  - 일일 메모리 로그(하루에 하나의 파일).
  - 세션 시작 시 오늘 + 어제를 읽는 것을 권장합니다.

- `MEMORY.md` (선택 사항)
  - 선별된 장기 메모리.
  - 메인 개인 세션에서만 로드하십시오(공유/그룹 컨텍스트 제외).

워크플로와 자동 메모리 플러시에 대해서는 [Memory](/concepts/memory)를 참고하십시오.

- `skills/` (선택 사항)
  - 워크스페이스별 Skills.
  - 이름이 충돌하는 경우 관리/번들된 Skills 를 재정의합니다.

- `canvas/` (선택 사항)
  - 노드 표시를 위한 Canvas UI 파일(예: `canvas/index.html`).

부트스트랩 파일이 누락되면 OpenClaw 는 세션에 '누락된 파일' 마커를 주입하고 계속 진행합니다. 큰 부트스트랩 파일은 주입 시 잘립니다. 제한은 `agents.defaults.bootstrapMaxChars` (기본값: 20000)으로 조정할 수 있습니다.
`openclaw setup` 는 기존 파일을 덮어쓰지 않고 누락된 기본값을 재생성할 수 있습니다.

## 워크스페이스에 포함되지 않는 항목

다음 항목은 `~/.openclaw/` 아래에 있으며 워크스페이스 저장소에 커밋해서는 **안 됩니다**:

- `~/.openclaw/openclaw.json` (구성)
- `~/.openclaw/credentials/` (OAuth 토큰, API 키)
- `~/.openclaw/agents/<agentId>/sessions/` (세션 트랜스크립트 + 메타데이터)
- `~/.openclaw/skills/` (관리되는 Skills)

세션이나 구성을 마이그레이션해야 한다면, 별도로 복사하고 버전 관리에서 제외하십시오.

## Git 백업(권장, 비공개)

워크스페이스를 비공개 메모리로 취급하십시오. **비공개** git 저장소에 두어 백업과 복구가 가능하도록 하십시오.

다음 단계는 Gateway(게이트웨이)가 실행되는 머신에서 수행하십시오(워크스페이스가 위치한 곳입니다).

### 1. 저장소 초기화

git 이 설치되어 있다면, 새 워크스페이스는 자동으로 초기화됩니다. 이 워크스페이스가 아직 저장소가 아니라면 다음을 실행하십시오:

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md SOUL.md TOOLS.md IDENTITY.md USER.md HEARTBEAT.md memory/
git commit -m "Add agent workspace"
```

### 2. 비공개 원격 추가(초보자 친화적 옵션)

옵션 A: GitHub 웹 UI

1. GitHub 에서 새 **비공개** 저장소를 생성합니다.
2. README 로 초기화하지 마십시오(병합 충돌을 방지).
3. HTTPS 원격 URL 을 복사합니다.
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

1. GitLab 에서 새 **비공개** 저장소를 생성합니다.
2. README 로 초기화하지 마십시오(병합 충돌을 방지).
3. HTTPS 원격 URL 을 복사합니다.
4. 원격을 추가하고 푸시합니다:

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

### 3. 지속적인 업데이트

```bash
git status
git add .
git commit -m "Update memory"
git push
```

## 비밀 정보는 커밋하지 마십시오

비공개 저장소라 하더라도, 워크스페이스에 비밀 정보를 저장하는 것은 피하십시오:

- API 키, OAuth 토큰, 비밀번호 또는 개인 자격 증명.
- `~/.openclaw/` 아래의 모든 항목.
- 채팅의 원시 덤프나 민감한 첨부 파일.

민감한 참조를 반드시 저장해야 한다면, 플레이스홀더를 사용하고 실제 비밀 정보는 다른 곳(비밀번호 관리자, 환경 변수 또는 `~/.openclaw/`)에 보관하십시오.

권장되는 `.gitignore` 시작 템플릿:

```gitignore
.DS_Store
.env
**/*.key
**/*.pem
**/secrets*
```

## 새 머신으로 워크스페이스 이동

1. 원하는 경로로 저장소를 클론합니다(기본값 `~/.openclaw/workspace`).
2. `~/.openclaw/openclaw.json` 에서 `agents.defaults.workspace` 를 해당 경로로 설정합니다.
3. 누락된 파일을 시드하기 위해 `openclaw setup --workspace <path>` 를 실행합니다.
4. 세션이 필요하다면, 이전 머신에서 `~/.openclaw/agents/<agentId>/sessions/` 를 별도로 복사하십시오.

## 고급 참고 사항

- 멀티 에이전트 라우팅은 에이전트별로 서로 다른 워크스페이스를 사용할 수 있습니다. 라우팅 구성은 [Channel routing](/channels/channel-routing)을 참고하십시오.
- `agents.defaults.sandbox` 가 활성화된 경우, 메인 세션이 아닌 세션은 `agents.defaults.sandbox.workspaceRoot` 아래의 세션별 샌드박스 워크스페이스를 사용할 수 있습니다.
