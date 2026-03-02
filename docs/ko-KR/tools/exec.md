---
summary: "Exec 도구 사용법, stdin 모드, TTY 지원"
read_when:
  - "exec 도구를 사용하거나 수정할 때"
  - "stdin 또는 TTY 동작을 디버깅할 때"
title: "Exec 도구"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: docs/tools/exec.md
  workflow: 15
---

# Exec 도구

워크스페이스에서 셸 명령을 실행합니다. `process`를 통한 포그라운드 및 백그라운드 실행을 지원합니다.
`process`가 허용되지 않으면 `exec`는 동기식으로 실행되고 `yieldMs`/`background`를 무시합니다.
백그라운드 세션은 에이전트당 스코프를 가집니다. `process`는 같은 에이전트의 세션만 볼 수 있습니다.

## 파라미터

- `command` (필수)
- `workdir` (기본값: cwd)
- `env` (키/값 오버라이드)
- `yieldMs` (기본값 10000): 지연 후 자동 백그라운드
- `background` (bool): 즉시 백그라운드 실행
- `timeout` (초, 기본값 1800): 만료 시 종료
- `pty` (bool): 가능할 때 의사 터미널에서 실행 (TTY 전용 CLI, 코딩 에이전트, 터미널 UI)
- `host` (`sandbox | gateway | node`): 실행 위치
- `security` (`deny | allowlist | full`): `gateway`/`node`에 대한 적용 모드
- `ask` (`off | on-miss | always`): `gateway`/`node`에 대한 승인 프롬프트
- `node` (문자열): `host=node`에 대한 노드 id/이름
- `elevated` (bool): 상승된 모드 요청 (게이트웨이 호스트); `security=full`은 상승이 `full`로 확인될 때만 강제됨

참고:

- `host`는 기본값 `sandbox`입니다.
- `elevated`는 샌드박싱이 꺼져 있을 때 무시됩니다 (exec은 이미 호스트에서 실행됨).
- `gateway`/`node` 승인은 `~/.openclaw/exec-approvals.json`으로 제어됩니다.
- `node`는 쌍을 이루는 노드 (컴패니언 앱 또는 헤드리스 노드 호스트)가 필요합니다.
- 여러 노드를 사용할 수 있으면 `exec.node` 또는 `tools.exec.node`를 설정하여 하나를 선택합니다.
- Windows가 아닌 호스트에서 exec은 `SHELL`이 설정될 때 사용합니다. `SHELL`이 `fish`이면 `bash` (또는 `sh`)를 선호합니다.
  `PATH`에서 fish 호환되지 않는 스크립트를 피하려고 하며, 둘 다 존재하지 않으면 `SHELL`로 폴백합니다.
- Windows 호스트에서 exec은 PowerShell 7 (`pwsh`) 검색을 선호합니다 (Program Files, ProgramW6432, 그 다음 PATH),
  그 다음 Windows PowerShell 5.1로 폴백합니다.
- 호스트 실행 (`gateway`/`node`)은 `env.PATH`와 로더 오버라이드 (`LD_*`/`DYLD_*`)를 거부합니다.
  바이너리 하이재킹 또는 주입된 코드를 방지하기 위해서입니다.
- 중요: 샌드박싱은 **기본적으로 비활성화되어 있습니다**. 샌드박싱이 꺼져 있고 `host=sandbox`가 명시적으로 구성/요청되면,
  exec은 이제 게이트웨이 호스트에서 자동 실행하지 않고 닫힌 상태로 실패합니다.
  샌드박싱을 활성화하거나 승인과 함께 `host=gateway`를 사용하세요.
- 스크립트 사전 검사 (일반적인 Python/Node 셸 구문 오류의 경우)는 효과적인 `workdir` 경계 내의 파일만 검사합니다.
  스크립트 경로가 `workdir` 외부로 해결되면 그 파일에 대해 사전 검사를 건너뜁니다.

## 구성

- `tools.exec.notifyOnExit` (기본값: true): true일 때, 백그라운드 실행 세션은 시스템 이벤트를 대기열에 넣고 종료 시 하트비트를 요청합니다.
- `tools.exec.approvalRunningNoticeMs` (기본값: 10000): 승인 게이트된 exec이 이보다 오래 실행될 때 단일 "실행 중" 알림을 내보냅니다 (0은 비활성화).
- `tools.exec.host` (기본값: `sandbox`)
- `tools.exec.security` (기본값: 샌드박스의 `deny`, 게이트웨이 + 노드의 `allowlist` (설정되지 않은 경우))
- `tools.exec.ask` (기본값: `on-miss`)
- `tools.exec.node` (기본값: 미설정)
- `tools.exec.pathPrepend`: exec 실행을 위해 `PATH`에 앞에 붙일 디렉토리 목록 (게이트웨이 + 샌드박스만 해당).
- `tools.exec.safeBins`: stdin 전용 안전 바이너리는 명시적 allowlist 항목 없이 실행할 수 있습니다. 동작 세부 사항은 [안전 바이너리](/tools/exec-approvals#safe-bins-stdin-only)를 참조하세요.
- `tools.exec.safeBinTrustedDirs`: `safeBins` 경로 검사를 위해 신뢰할 추가 명시적 디렉토리입니다. `PATH` 항목은 자동 신뢰되지 않습니다. 기본 제공 기본값은 `/bin` 및 `/usr/bin`입니다.
- `tools.exec.safeBinProfiles`: 안전 바이너리당 선택 argv 정책 (`minPositional`, `maxPositional`, `allowedValueFlags`, `deniedFlags`).

예:

```json5
{
  tools: {
    exec: {
      pathPrepend: ["~/bin", "/opt/oss/bin"],
    },
  },
}
```

### PATH 처리

- `host=gateway`: 로그인 셸 `PATH`를 exec 환경에 병합합니다. `env.PATH` 오버라이드는 호스트 실행을 위해 거부됩니다.
  데몬 자체는 여전히 최소 `PATH`를 사용하여 실행됩니다:
  - macOS: `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`
  - Linux: `/usr/local/bin`, `/usr/bin`, `/bin`
- `host=sandbox`: 컨테이너 내에서 `sh -lc` (로그인 셸)를 실행하므로 `/etc/profile`이 `PATH`를 재설정할 수 있습니다.
  OpenClaw는 프로필 소싱 후 내부 env var를 통해 `env.PATH`를 앞에 붙입니다 (셸 보간 없음);
  `tools.exec.pathPrepend`도 여기에 적용됩니다.
- `host=node`: 전달하는 차단되지 않은 env 오버라이드만 노드로 전송됩니다. `env.PATH` 오버라이드는 호스트 실행을 위해 거부되고 노드 호스트에서 무시됩니다.
  노드에서 추가 PATH 항목이 필요하면 노드 호스트 서비스 환경 (systemd/launchd)을 구성하거나 표준 위치에 도구를 설치합니다.

에이전트별 노드 바인딩 (구성에서 에이전트 목록 인덱스 사용):

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

제어 UI: 노드 탭에는 동일한 설정을 위한 작은 "Exec 노드 바인딩" 패널이 포함되어 있습니다.

## 세션 오버라이드 (`/exec`)

`/exec`를 사용하여 **세션별** 기본값을 설정합니다: `host`, `security`, `ask`, 및 `node`.
인수 없이 `/exec`를 보내어 현재 값을 표시합니다.

예:

```
/exec host=gateway security=allowlist ask=on-miss node=mac-1
```

## 승인 모델

`/exec`는 **권한이 있는 발신자** (채널 allowlist/페어링 플러스 `commands.useAccessGroups`)에 대해서만 준수됩니다.
현재 세션 키의 상태만 업데이트하고 구성을 작성하지 않습니다. exec을 하드 비활성화하려면 도구 정책 (`tools.deny: ["exec"]` 또는 에이전트별)으로 거부합니다.
명시적으로 `security=full` 및 `ask=off`를 설정하지 않는 한 호스트 승인이 계속 적용됩니다.

## Exec 승인 (컴패니언 앱/노드 호스트)

샌드박스된 에이전트는 gateway 또는 노드 호스트에서 `exec`을 실행하기 전에 요청별 승인이 필요할 수 있습니다.
[Exec 승인](/tools/exec-approvals)에서 정책, allowlist, 및 UI 흐름을 참조하세요.

승인이 필요하면 exec 도구는 `status: "approval-pending"`과 승인 id를 즉시 반환합니다.
승인 (또는 거부/시간 초과) 후 Gateway는 시스템 이벤트 (`Exec finished` / `Exec denied`)를 내보냅니다.
명령이 `tools.exec.approvalRunningNoticeMs` 후에도 계속 실행 중이면 단일 `Exec running` 알림이 내보내집니다.

## Allowlist 및 안전 바이너리

수동 allowlist 적용은 **해결된 바이너리 경로만** (basename 일치 없음) 일치합니다.
`security=allowlist`일 때 셸 명령은 모든 파이프라인 세그먼트가 allowlisted되거나 안전 바이너리인 경우에만 자동 허용됩니다.
chaining (`;`, `&&`, `||`) 및 방향 변경은 모든 최상위 세그먼트가 allowlist를 만족할 때를 제외하고는 allowlist 모드에서 거부됩니다 (안전 바이너리 포함).
방향 변경은 allowlist 모드에서 계속 지원되지 않습니다.

`autoAllowSkills`는 exec 승인에서 별도의 편의 경로입니다. 수동 경로 allowlist 항목과는 다릅니다.
엄격한 명시적 신뢰를 위해 `autoAllowSkills` 비활성화를 유지하세요.

다양한 작업을 위해 두 제어를 사용합니다:

- `tools.exec.safeBins`: 작은, stdin 전용 스트림 필터.
- `tools.exec.safeBinTrustedDirs`: 안전 바이너리 실행 경로를 위한 추가 신뢰할 수 있는 디렉토리.
- `tools.exec.safeBinProfiles`: 사용자 정의 안전 바이너리에 대한 명시적 argv 정책.
- allowlist: 실행 가능한 경로에 대한 명시적 신뢰.

`safeBins`를 일반 allowlist로 취급하지 마세요. 인터프리터/런타임 바이너리 (예: `python3`, `node`, `ruby`, `bash`)를 추가하지 마세요.
필요하면 명시적 allowlist 항목을 사용하고 승인 프롬프트를 활성화 상태로 유지하세요.
`openclaw security audit`은 명시적 프로필이 누락된 인터프리터/런타임 `safeBins` 항목을 경고하고,
`openclaw doctor --fix`는 누락된 사용자 정의 `safeBinProfiles` 항목을 스캐폴드할 수 있습니다.

전체 정책 세부 사항 및 예제는 [Exec 승인](/tools/exec-approvals#safe-bins-stdin-only) 및 [안전 바이너리 대 allowlist](/tools/exec-approvals#safe-bins-versus-allowlist)를 참조하세요.

## 예

포그라운드:

```json
{ "tool": "exec", "command": "ls -la" }
```

백그라운드 + 폴:

```json
{"tool":"exec","command":"npm run build","yieldMs":1000}
{"tool":"process","action":"poll","sessionId":"<id>"}
```

키 전송 (tmux 스타일):

```json
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Enter"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["C-c"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Up","Up","Enter"]}
```

제출 (CR만 전송):

```json
{ "tool": "process", "action": "submit", "sessionId": "<id>" }
```

붙여넣기 (기본적으로 괄호로 표시):

```json
{ "tool": "process", "action": "paste", "sessionId": "<id>", "text": "line1\nline2\n" }
```

## apply_patch (실험적)

`apply_patch`는 구조화된 다중 파일 편집을 위한 `exec`의 하위 도구입니다.
명시적으로 활성화합니다:

```json5
{
  tools: {
    exec: {
      applyPatch: { enabled: true, workspaceOnly: true, allowModels: ["gpt-5.2"] },
    },
  },
}
```

참고:

- OpenAI/OpenAI Codex 모델에만 사용 가능합니다.
- 도구 정책이 계속 적용됩니다. `allow: ["exec"]`은 암묵적으로 `apply_patch`를 허용합니다.
- 구성은 `tools.exec.applyPatch`에만 있습니다.
- `tools.exec.applyPatch.workspaceOnly`는 기본값 `true` (워크스페이스 포함)입니다.
  `apply_patch`이 워크스페이스 디렉토리 외부에 쓰기/삭제하도록 의도하는 경우에만 `false`로 설정합니다.
