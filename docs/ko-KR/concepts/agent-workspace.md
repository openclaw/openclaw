---
summary: "에이전트 워크스페이스: 위치, 레이아웃, 백업 전략"
read_when:
  - 에이전트 워크스페이스 또는 파일 레이아웃을 설명해야 할 때
  - 에이전트 워크스페이스를 백업 또는 마이그레이션하려고 할 때
title: "에이전트 워크스페이스"
---

# 에이전트 워크스페이스

워크스페이스는 에이전트의 집입니다. 파일 도구 및 워크스페이스 컨텍스트의 유일한 작업 디렉토리입니다. 이를 비공개로 유지하고 메모리로 취급합니다.

이는 설정, 자격증명 및 세션을 저장하는 `~/.openclaw/`와 별개입니다.

**중요:** 워크스페이스는 **기본 cwd**이며, hard sandbox가 아닙니다. 도구는 워크스페이스에 대해 상대 경로를 해결하지만, 샌드박싱이 활성화되지 않은 한 절대 경로는 여전히 호스트의 다른 곳에 도달할 수 있습니다. 격리가 필요한 경우 [`agents.defaults.sandbox`](/gateway/sandboxing)를 사용합니다 (및/또는 per‑agent sandbox 설정).
샌드박싱이 활성화되고 `workspaceAccess`가 `"rw"`이 아닌 경우, 도구는 `~/.openclaw/sandboxes` 아래의 sandbox 워크스페이스 내에서 작동하며, 호스트 워크스페이스가 아닙니다.

## 기본 위치

- 기본값: `~/.openclaw/workspace`
- `OPENCLAW_PROFILE`이 설정되고 `"default"`가 아닌 경우, 기본값은
  `~/.openclaw/workspace-<profile>`이 됩니다.
- `~/.openclaw/openclaw.json`에서 재정의:

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

`openclaw onboard`, `openclaw configure` 또는 `openclaw setup`은 워크스페이스를 생성하고 누락된 경우 bootstrap 파일을 시드합니다.

이미 워크스페이스 파일을 스스로 관리하는 경우, 부트스트랩 파일 생성을 비활성화할 수 있습니다:

```json5
{ agent: { skipBootstrap: true } }
```

## 추가 워크스페이스 폴더

오래된 설치는 `~/openclaw`를 생성했을 수 있습니다. 여러 워크스페이스 디렉토리를 유지하면
일시에 단일 워크스페이스만 활성화되므로 인증 또는 상태 drift를 혼동할 수 있습니다.

**권장:** 단일 활성 워크스페이스를 유지합니다. 더 이상 extra 폴더를 사용하지 않는 경우, 아카이브하거나 Trash로 이동합니다 (예: `trash ~/openclaw`).
의도적으로 여러 워크스페이스를 유지하는 경우 `agents.defaults.workspace`가 활성 워크스페이스를 가리키도록 하세요.

`openclaw doctor`는 extra 워크스페이스 디렉토리를 감지하면 경고합니다.

## 워크스페이스 파일 맵 (각 파일의 의미)

다음은 OpenClaw가 워크스페이스 내에서 예상하는 표준 파일입니다:

- `AGENTS.md`
  - 에이전트에 대한 작동 지침 및 메모리 사용 방법.
  - 모든 세션 시작에서 로드됩니다.
  - 규칙, 우선순위 및 "어떻게 동작할 것인가" 세부사항을 위한 좋은 장소입니다.

- `SOUL.md`
  - 페르소나, 톤, 경계.
  - 모든 세션에서 로드됩니다.

- `USER.md`
  - 사용자가 누구인지 및 이들을 어떻게 호칭해야 하는지.
  - 모든 세션에서 로드됩니다.

- `IDENTITY.md`
  - 에이전트의 이름, 분위기, 이모지.
  - bootstrap 의식 중 생성/업데이트됩니다.

- `TOOLS.md`
  - 로컬 도구 및 규칙에 대한 노트.
  - 도구 가용성을 제어하지 않습니다; 지침일 뿐입니다.

- `HEARTBEAT.md`
  - Optional tiny heartbeat 실행 체크리스트.
  - token burn을 피하기 위해 짧게 유지합니다.

- `BOOT.md`
  - Optional startup 체크리스트는 internal hooks가 활성화될 때 gateway restart에서 실행됩니다.
  - 짧게 유지; outbound sends를 위해 message 도구를 사용합니다.

- `BOOTSTRAP.md`
  - 일회성 첫 실행 의식.
  - 새로운 워크스페이스에만 생성됩니다.
  - 의식 완료 후 삭제합니다.

- `memory/YYYY-MM-DD.md`
  - 일일 메모리 로그 (하루에 하나의 파일).
  - 세션 시작 시 today + yesterday를 읽도록 권장됩니다.

- `MEMORY.md` (optional)
  - Curated 장기 메모리.
  - 오직 main, private 세션에서만 로드됩니다 (shared/group 컨텍스트 불가).

메모리에 대해서는 [메모리](/concepts/memory)를 참조하고 자동 메모리 flush를 확인합니다.

- `skills/` (optional)
  - Workspace-specific 스킬.
  - 이름이 충돌할 때 managed/bundled 스킬을 재정의합니다.

- `canvas/` (optional)
  - 노드 디스플레이용 Canvas UI 파일 (예: `canvas/index.html`).

bootstrap 파일이 누락된 경우, OpenClaw는 "missing file" 마커를 세션에 주입하고 계속합니다. 큰 bootstrap 파일은 주입될 때 잘립니다;
`agents.defaults.bootstrapMaxChars` (기본값: 20000) 및
`agents.defaults.bootstrapTotalMaxChars` (기본값: 150000)로 제한을 조정합니다.
`openclaw setup`은 기존 파일을 덮어쓰지 않고 누락된 기본값을 재생성할 수 있습니다.

## 워크스페이스에 있지 않은 것

다음은 `~/.openclaw/` 아래에 있으며 워크스페이스 repo에 **커밋되지 않아야 합니다**:

- `~/.openclaw/openclaw.json` (설정)
- `~/.openclaw/credentials/` (OAuth tokens, API 키)
- `~/.openclaw/agents/<agentId>/sessions/` (세션 트랜스크립트 + 메타데이터)
- `~/.openclaw/skills/` (managed 스킬)

세션 또는 설정을 마이그레이션해야 하는 경우 별도로 복사하고 버전 제어 외부로 유지합니다.

## Git 백업 (권장, 비공개)

워크스페이스를 비공개 메모리로 취급합니다. **비공개** git repo에 넣으면 백업되고 복구할 수 있습니다.

Gateway가 실행되는 머신에서 이 단계들을 실행합니다 (워크스페이스가 사는 곳입니다).

### 1) repo 초기화

git이 설치된 경우 새로운 워크스페이스는 자동으로 초기화됩니다. 이 워크스페이스가 이미 repo가 아닌 경우 다음을 실행합니다:

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md SOUL.md TOOLS.md IDENTITY.md USER.md HEARTBEAT.md memory/
git commit -m "Add agent workspace"
```

### 2) 비공개 remote 추가 (초보자 친화적 옵션)

옵션 A: GitHub web UI

1. GitHub에 새 **비공개** 저장소 생성.
2. README로 초기화하지 마십시오 (merge 충돌 회피).
3. HTTPS remote URL 복사.
4. Remote 추가 및 푸시:

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

옵션 C: GitLab web UI

1. GitLab에 새 **비공개** 저장소 생성.
2. README로 초기화하지 마십시오 (merge 충돌 회피).
3. HTTPS remote URL 복사.
4. Remote 추가 및 푸시:

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

### 3) 진행 중인 업데이트

```bash
git status
git add .
git commit -m "Update memory"
git push
```

## 비밀을 커밋하지 마십시오

비공개 repo에서도 워크스페이스에 비밀을 저장하지 마십시오:

- API 키, OAuth tokens, passwords, 또는 비공개 자격증명.
- `~/.openclaw/` 아래 모든 것.
- 민감한 첨부파일의 원본 dumping.

민감한 참고사항을 저장해야 하는 경우 placeholder를 사용하고 실제 비밀을 다른 곳 (password manager, 환경 변수, 또는 `~/.openclaw/`)에 유지합니다.

제안된 `.gitignore` starter:

```gitignore
.DS_Store
.env
**/*.key
**/*.pem
**/secrets*
```

## 워크스페이스를 새 머신으로 이동

1. 원하는 경로로 repo를 clone합니다 (기본값 `~/.openclaw/workspace`).
2. `~/.openclaw/openclaw.json`에서 `agents.defaults.workspace`를 해당 경로로 설정합니다.
3. `openclaw setup --workspace <path>`를 실행하여 누락된 파일을 시드합니다.
4. 세션이 필요한 경우 `~/.openclaw/agents/<agentId>/sessions/`를 old 머신에서 별도로 복사합니다.

## 고급 노트

- Multi-agent 라우팅은 에이전트별로 다른 워크스페이스를 사용할 수 있습니다. 라우팅 설정은 [채널 라우팅](/channels/channel-routing)을 참조합니다.
- `agents.defaults.sandbox`가 활성화된 경우, non-main 세션은 `agents.defaults.sandbox.workspaceRoot` 아래서 per-session sandbox 워크스페이스를 사용할 수 있습니다.
