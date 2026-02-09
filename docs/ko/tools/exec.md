---
summary: "Exec 도구 사용법, stdin 모드 및 TTY 지원"
read_when:
  - Exec 도구를 사용하거나 수정할 때
  - stdin 또는 TTY 동작을 디버깅할 때
title: "Exec 도구"
---

# Exec 도구

워크스페이스에서 셸 명령을 실행합니다. `process` 를 통해 포그라운드 + 백그라운드 실행을 지원합니다.
`process` 이 허용되지 않으면 `exec` 은 동기적으로 실행되며 `yieldMs`/`background` 를 무시합니다.
백그라운드 세션은 에이전트별로 범위가 지정되며, `process` 는 동일한 에이전트의 세션만 봅니다.

## Parameters

- `command` (필수)
- `workdir` (기본값: cwd)
- `env` (키/값 오버라이드)
- `yieldMs` (기본값 10000): 지연 후 자동 백그라운드
- `background` (bool): 즉시 백그라운드
- `timeout` (초, 기본값 1800): 만료 시 종료
- `pty` (bool): 가능할 때 가상 터미널에서 실행 (TTY 전용 CLI, 코딩 에이전트, 터미널 UI)
- `host` (`sandbox | gateway | node`): 실행 위치
- `security` (`deny | allowlist | full`): `gateway`/`node` 에 대한 강제 모드
- `ask` (`off | on-miss | always`): `gateway`/`node` 에 대한 승인 프롬프트
- `node` (string): `host=node` 용 노드 id/이름
- `elevated` (bool): 권한 상승 모드 요청 (Gateway(게이트웨이) 호스트); `security=full` 는 권한 상승이 `full` 로 해석될 때만 강제됩니다

Notes:

- `host` 의 기본값은 `sandbox` 입니다.
- `elevated` 는 샌드박스화가 꺼져 있을 때 무시됩니다 (exec 는 이미 호스트에서 실행됨).
- `gateway`/`node` 승인은 `~/.openclaw/exec-approvals.json` 에 의해 제어됩니다.
- `node` 는 페어링된 노드(컴패니언 앱 또는 헤드리스 노드 호스트)가 필요합니다.
- 여러 노드가 사용 가능한 경우 `exec.node` 또는 `tools.exec.node` 를 설정하여 하나를 선택하십시오.
- Windows 가 아닌 호스트에서는 설정되어 있을 때 exec 가 `SHELL` 를 사용합니다. `SHELL` 가 `fish` 이면,
  fish 와 호환되지 않는 스크립트를 피하기 위해 `PATH` 에서 `bash` (또는 `sh`) 를 우선하며,
  둘 다 없으면 `SHELL` 로 폴백합니다.
- 호스트 실행 (`gateway`/`node`) 은 바이너리 하이재킹이나 주입 코드 방지를 위해
  `env.PATH` 와 로더 오버라이드 (`LD_*`/`DYLD_*`) 를 거부합니다.
- 중요: 샌드박스화는 **기본적으로 꺼져 있습니다**. 샌드박스화가 꺼져 있으면 `host=sandbox` 는
  게이트웨이 호스트에서 직접 실행되며 (컨테이너 없음) **승인이 필요하지 않습니다**. 승인을 요구하려면
  `host=gateway` 와 함께 실행하고 exec 승인 설정을 구성하십시오 (또는 샌드박스화를 활성화하십시오).

## Config

- `tools.exec.notifyOnExit` (기본값: true): true 일 때 백그라운드된 exec 세션은 시스템 이벤트를 큐에 넣고 종료 시 하트비트를 요청합니다.
- `tools.exec.approvalRunningNoticeMs` (기본값: 10000): 승인 게이트가 있는 exec 가 이 시간보다 오래 실행되면 단일 “running” 알림을 방출합니다 (0 은 비활성화).
- `tools.exec.host` (기본값: `sandbox`)
- `tools.exec.security` (기본값: 샌드박스의 경우 `deny`, 미설정 시 게이트웨이 + 노드의 경우 `allowlist`)
- `tools.exec.ask` (기본값: `on-miss`)
- `tools.exec.node` (기본값: 미설정)
- `tools.exec.pathPrepend`: exec 실행 시 `PATH` 앞에 추가할 디렉토리 목록입니다.
- `tools.exec.safeBins`: 명시적인 허용 목록 항목 없이 실행할 수 있는 stdin 전용 안전 바이너리입니다.

Example:

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

- `host=gateway`: 로그인 셸의 `PATH` 를 exec 환경으로 병합합니다. `env.PATH` 오버라이드는
  호스트 실행에서 거부됩니다. 데몬 자체는 여전히 최소한의 `PATH` 로 실행됩니다:
  - macOS: `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`
  - Linux: `/usr/local/bin`, `/usr/bin`, `/bin`
- `host=sandbox`: 컨테이너 내부에서 `sh -lc` (로그인 셸) 을 실행하므로 `/etc/profile` 가 `PATH` 를 재설정할 수 있습니다.
  OpenClaw 는 내부 환경 변수를 통해 프로파일 소싱 이후 `env.PATH` 를 앞에 추가합니다 (셸 보간 없음). `tools.exec.pathPrepend` 도 여기 적용됩니다.
- `host=node`: 차단되지 않은 환경 변수 오버라이드만 노드로 전송됩니다. `env.PATH` 오버라이드는
  호스트 실행에서 거부됩니다. 헤드리스 노드 호스트는 노드 호스트 PATH 를 앞에 추가하는 경우에만 `PATH` 를 허용합니다
  (대체 없음). macOS 노드는 `PATH` 오버라이드를 완전히 제거합니다.

에이전트별 노드 바인딩 (config 에서 에이전트 목록 인덱스 사용):

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

Control UI: Nodes 탭에는 동일한 설정을 위한 작은 “Exec node binding” 패널이 포함되어 있습니다.

## 세션 오버라이드 (`/exec`)

`/exec` 를 사용하여 **세션별** 기본값으로 `host`, `security`, `ask`, `node` 를 설정합니다.
인자 없이 `/exec` 을 보내면 현재 값을 표시합니다.

Example:

```
/exec host=gateway security=allowlist ask=on-miss node=mac-1
```

## Authorization 모델

`/exec` 는 **권한이 부여된 발신자** 에 대해서만 존중됩니다 (채널 허용 목록/페어링 + `commands.useAccessGroups`).
이는 **세션 상태만** 업데이트하며 config 에 기록하지 않습니다. exec 를 완전히 비활성화하려면 도구
정책 (`tools.deny: ["exec"]` 또는 에이전트별) 에서 거부하십시오. 호스트 승인은
`security=full` 와 `ask=off` 를 명시적으로 설정하지 않는 한 계속 적용됩니다.

## Exec 승인 (컴패니언 앱 / 노드 호스트)

샌드박스화된 에이전트는 `exec` 가 게이트웨이 또는 노드 호스트에서 실행되기 전에 요청별 승인을 요구할 수 있습니다.
정책, 허용 목록 및 UI 흐름은 [Exec approvals](/tools/exec-approvals) 를 참조하십시오.

승인이 필요할 때 exec 도구는 즉시 `status: "approval-pending"` 와 승인 id 를 반환합니다. 승인되면 (또는 거부 / 시간 초과되면)
Gateway(게이트웨이) 는 시스템 이벤트 (`Exec finished` / `Exec denied`) 를 방출합니다. 명령이
`tools.exec.approvalRunningNoticeMs` 이후에도 실행 중이면 단일 `Exec running` 알림이 방출됩니다.

## 허용 목록 + 안전 바이너리

허용 목록 강제는 **해결된 바이너리 경로만** 일치시킵니다 (basename 일치 없음). `security=allowlist` 인 경우 셸 명령은 모든 파이프라인 세그먼트가
허용 목록에 있거나 안전 바이너리일 때만 자동 허용됩니다. 체이닝 (`;`, `&&`, `||`) 과 리다이렉션은
허용 목록 모드에서 거부됩니다.

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

제출 (CR 만 전송):

```json
{ "tool": "process", "action": "submit", "sessionId": "<id>" }
```

붙여넣기 (기본적으로 브래킷됨):

```json
{ "tool": "process", "action": "paste", "sessionId": "<id>", "text": "line1\nline2\n" }
```

## apply_patch (실험적)

`apply_patch` 는 구조화된 다중 파일 편집을 위한 `exec` 의 하위 도구입니다.
명시적으로 활성화하십시오:

```json5
{
  tools: {
    exec: {
      applyPatch: { enabled: true, allowModels: ["gpt-5.2"] },
    },
  },
}
```

Notes:

- OpenAI/OpenAI Codex 모델에서만 사용 가능합니다.
- 도구 정책은 계속 적용되며, `allow: ["exec"]` 는 암묵적으로 `apply_patch` 를 허용합니다.
- Config 는 `tools.exec.applyPatch` 아래에 위치합니다.
