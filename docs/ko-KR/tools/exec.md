---
summary: "Exec tool 사용법, stdin 모드 및 TTY 지원"
read_when:
  - exec tool 사용 또는 수정 중
  - stdin 또는 TTY 동작 디버깅 중
title: "Exec Tool"
---

# Exec tool

워크스페이스에서 셸 명령어를 실행합니다. `process`를 통해 포그라운드 + 백그라운드 실행을 지원합니다.
`process`가 허용되지 않으면, `exec`는 동기적으로 실행되며 `yieldMs`/`background`를 무시합니다.
백그라운드 세션은 에이전트 별로 범위가 지정되며, `process`는 동일한 에이전트의 세션만 볼 수 있습니다.

## Parameters

- `command` (필수)
- `workdir` (기본값: cwd)
- `env` (키/값 재정의)
- `yieldMs` (기본값 10000): 지연 후 자동 백그라운드
- `background` (bool): 즉시 백그라운드
- `timeout` (초, 기본값 1800): 만료 시 종료
- `pty` (bool): 사용 가능한 경우 의사 터미널에서 실행 (TTY 전용 CLI, 코딩 에이전트, 터미널 UI)
- `host` (`sandbox | gateway | node`): 실행 위치
- `security` (`deny | allowlist | full`): `gateway`/`node`의 강제 모드
- `ask` (`off | on-miss | always`): `gateway`/`node`에 대한 승인 요청
- `node` (문자열): `host=node`를 위한 노드 ID/이름
- `elevated` (bool): 상위 모드를 요청 (게이트웨이 호스트); `elevated`가 `full`로 해석될 때만 `security=full`이 강제됨

노트:

- `host`의 기본값은 `sandbox`입니다.
- 샌드박스 격리가 꺼져 있을 때 `elevated`는 무시됩니다 (exec는 이미 호스트에서 실행).
- `gateway`/`node` 승인 관리는 `~/.openclaw/exec-approvals.json`에서 이루어집니다.
- `node`는 짝맞춘 노드(동반 앱 또는 헤드리스 노드 호스트)를 필요로 합니다.
- 여러 노드가 사용할 수 있는 경우, `exec.node` 또는 `tools.exec.node`를 설정하여 하나를 선택하십시오.
- Windows가 아닌 호스트에서는, `exec`가 `SHELL`을 사용하고, `SHELL`이 `fish`인 경우, fish와 호환되지 않는 스크립트를 피하려고 `PATH`에서 `bash`(또는 `sh`)를 선호하며, 존재하지 않으면 `SHELL`로 되돌립니다.
- 호스트 실행(`gateway`/`node`)은 바이너리 하이재킹 또는 주입된 코드를 방지하기 위해 `env.PATH`와 로더 재정의(`LD_*`/`DYLD_*`)를 거부합니다.
- 중요: 샌드박스 격리는 **기본적으로 꺼져** 있습니다. 샌드박스 격리가 꺼져 있으면, `host=sandbox`는 게이트웨이 호스트에서 직접 실행됩니다 (컨테이너 없음) 그리고 **승인이 필요하지 않습니다**. 승인이 필요하면, `host=gateway`로 실행하고 exec 승인을 구성하십시오 (또는 샌드박스 격리를 활성화).
- 스크립트 사전 검사 (일반적인 Python/Node 쉘 구문 오류 검사)는 유효한 `workdir` 경계 내의 파일만 검사합니다. 스크립트 경로가 `workdir` 밖으로 해석되는 경우, 해당 파일에 대한 사전 검사는 건너뜁니다.

## Config

- `tools.exec.notifyOnExit` (기본값: true): 참일 경우, 백그라운드로 전환된 exec 세션이 시스템 이벤트를 대기열에 추가하고 종료 시 하트비트를 요청합니다.
- `tools.exec.approvalRunningNoticeMs` (기본값: 10000): 승인 제한 exec이 이 시간을 초과하여 실행될 때 단일 "실행 중" 알림을 발생시킵니다 (0은 비활성화).
- `tools.exec.host` (기본값: `sandbox`)
- `tools.exec.security` (기본값: 샌드박스는 `deny`, 게이트웨이 + 노드가 설정되지 않은 경우 `allowlist`)
- `tools.exec.ask` (기본값: `on-miss`)
- `tools.exec.node` (기본값: 설정되지 않음)
- `tools.exec.pathPrepend`: exec 실행을 위해 `PATH`에 추가할 디렉토리 목록 (게이트웨이 + 샌드박스 전용).
- `tools.exec.safeBins`: 명시적 승인이 필요 없는 표준 입력 전용 안전 바이너리. 동작 세부 사항은 [안전한 바이너리](/tools/exec-approvals#safe-bins-stdin-only)를 참조하세요.

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

### PATH handling

- `host=gateway`: 로그인 셸 `PATH`를 exec 환경에 병합합니다. 호스트 실행에 대한 `env.PATH` 재정의는 거부됩니다. 데몬 자체는 최소한의 `PATH`로 실행됩니다:
  - macOS: `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`
  - Linux: `/usr/local/bin`, `/usr/bin`, `/bin`
- `host=sandbox`: 컨테이너 내부에서 `sh -lc` (로그인 셸)를 실행하므로 `/etc/profile`이 `PATH`를 재설정할 수 있습니다. OpenClaw는 쉘 인터폴레이션 없이 내부 환경 변수를 통해 프로필 소싱 후 `env.PATH`를 선행합니다; `tools.exec.pathPrepend`도 여기 적용됩니다.
- `host=node`: 전달하는 차단되지 않은 환경 변수만 노드로 전송됩니다. 호스트 실행은 `env.PATH` 재정의를 거부하며 노드 호스트에 의해 무시됩니다. 노드에 추가적인 PATH 항목이 필요한 경우, 노드 호스트 서비스 환경을 구성하십시오 (systemd/launchd) 또는 표준 위치에 도구를 설치하세요.

에이전트 별 노드 바인딩 (설정에서 에이전트 목록 인덱스를 사용):

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

제어 UI: "Exec node binding" 설정을 위한 작은 패널이 Nodes 탭에 포함되어 있습니다.

## Session overrides (`/exec`)

`/exec`를 사용하여 `host`, `security`, `ask`, 그리고 `node`에 대한 **세션별** 기본값을 설정합니다.
인수를 제공하지 않고 `/exec`를 전송하여 현재 값을 표시하세요.

예:

```
/exec host=gateway security=allowlist ask=on-miss node=mac-1
```

## Authorization model

`/exec`는 **승인된 발신자**(채널 허용 목록/페어링과 `commands.useAccessGroups`)만 인정됩니다.
이것은 **세션 상태만** 업데이트하며 설정을 기록하지 않습니다. exec을 완전히 비활성화하려면 도구 정책을 통해 거부하십시오 (`tools.deny: ["exec"]` 또는 에이전트별). 호스트 승인은 명시적으로 `security=full` 및 `ask=off`로 설정하지 않는 한 여전히 적용됩니다.

## Exec approvals (동반 앱 / 노드 호스트)

샌드박스 격리된 에이전트는 게이트웨이 또는 노드 호스트에서 `exec`이 실행되기 전에 요청별 승인을 요구할 수 있습니다.
[Exec approvals](/ko-KR/tools/exec-approvals)에서 정책, 허용 목록 및 UI 흐름을 확인하세요.

승인이 필요한 경우, exec 도구는 즉시 `status: "approval-pending"`와 승인 ID를 반환합니다. 승인(또는 거부/시간 초과)되면, 게이트웨이가 시스템 이벤트 (`Exec finished` / `Exec denied`)를 발생시킵니다. 명령어가 `tools.exec.approvalRunningNoticeMs` 이후에도 실행 중일 경우, 단일 `Exec running` 알림이 발생됩니다.

## Allowlist + safe bins

허용 목록 강제는 **해결된 바이너리 경로만**과 일치합니다 (베이스 이름과는 무관함). `security=allowlist`일 때, 셸 명령은 각 파이프라인 세그먼트가 허용 목록에 포함되거나 안전한 바이너리인 경우에만 자동 허용됩니다. 연결 (`;`, `&&`, `||`) 및 리다이렉션은 허용 목록 모드에서 거부됩니다. 허용 목록 조건을 만족할 경우에만 최상위 세그먼트를 포함하여 (안전한 바이너리를 포함) 허용되며, 리다이렉션은 여전히 지원되지 않습니다.

## Examples

포그라운드:

```json
{ "tool": "exec", "command": "ls -la" }
```

백그라운드 + 폴링:

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

붙여넣기 (기본적으로 대괄호):

```json
{ "tool": "process", "action": "paste", "sessionId": "<id>", "text": "line1\nline2\n" }
```

## apply_patch (실험적)

`apply_patch`는 구조화된 다중 파일 편집을 위한 `exec`의 하위 도구입니다.
명시적으로 활성화하세요:

```json5
{
  tools: {
    exec: {
      applyPatch: { enabled: true, workspaceOnly: true, allowModels: ["gpt-5.2"] },
    },
  },
}
```

노트:

- OpenAI/OpenAI Codex 모델에서만 사용 가능합니다.
- 도구 정책은 여전히 적용됩니다; `allow: ["exec"]`는 `apply_patch`를 암시적으로 허용합니다.
- 설정은 `tools.exec.applyPatch`에 저장됩니다.
- `tools.exec.applyPatch.workspaceOnly`는 기본적으로 `true` (워크스페이스 내). 의도적으로 워크스페이스 디렉토리 외부에 쓰기/삭제하려는 경우에만 `false`로 설정하세요.
