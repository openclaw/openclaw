---
summary: "Exec tool usage, stdin modes, and TTY support"
read_when:
  - Using or modifying the exec tool
  - Debugging stdin or TTY behavior
title: "Exec Tool"
x-i18n:
  source_hash: 3b32238dd8dce93d4f24100eaa521ce9f8485eff6d8498e2680ce9ed6045d25f
---

# 실행 도구

작업 공간에서 셸 명령을 실행합니다. `process`를 통해 포그라운드 + 백그라운드 실행을 지원합니다.
`process`가 허용되지 않으면 `exec`는 동기식으로 실행되고 `yieldMs`/`background`를 무시합니다.
백그라운드 세션의 범위는 에이전트별로 지정됩니다. `process`는 동일한 에이전트의 세션만 볼 수 있습니다.

## 매개변수

- `command` (필수)
- `workdir` (기본값은 cwd)
- `env` (키/값 재정의)
- `yieldMs` (기본값 10000): 지연 후 자동 배경화면
- `background` (bool): 즉시 배경 설정
- `timeout` (초, 기본값 1800): 만료 시 종료
- `pty` (부울): 가능한 경우 의사 터미널에서 실행합니다(TTY 전용 CLI, 코딩 에이전트, 터미널 UI).
- `host` (`sandbox | gateway | node`) : 실행할 위치
- `security` (`deny | allowlist | full`): `gateway`/`node`에 대한 시행 모드
- `ask` (`off | on-miss | always`): `gateway`/`node`에 대한 승인 프롬프트
- `node` (문자열): `host=node`에 대한 노드 ID/이름
- `elevated` (부울): 높은 모드를 요청합니다(게이트웨이 호스트). `security=full`는 상승된 해결이 `full`인 경우에만 강제됩니다.

참고:

- `host`의 기본값은 `sandbox`입니다.
- `elevated`는 샌드박싱이 꺼진 경우 무시됩니다(exec가 이미 호스트에서 실행 중임).
- `gateway`/`node` 승인은 `~/.openclaw/exec-approvals.json`에 의해 제어됩니다.
- `node`에는 쌍을 이루는 노드(동반 앱 또는 헤드리스 노드 호스트)가 필요합니다.
- 여러 개의 노드를 사용할 수 있는 경우 `exec.node` 또는 `tools.exec.node`를 설정하여 하나를 선택합니다.
- Windows가 아닌 호스트에서 exec는 설정 시 `SHELL`를 사용합니다. `SHELL`가 `fish`인 경우 `bash`(또는 `sh`)를 선호합니다.
  fish와 호환되지 않는 스크립트를 피하기 위해 `PATH`에서, 둘 다 존재하지 않으면 `SHELL`로 대체합니다.
- 호스트 실행(`gateway`/`node`)은 `env.PATH`를 거부하고 로더는 (`LD_*`/`DYLD_*`)를 무시합니다.
  바이너리 하이재킹이나 코드 삽입을 방지합니다.
- 중요: 샌드박싱은 **기본적으로 꺼져 있습니다**. 샌드박스가 꺼져 있으면 `host=sandbox`가 직접 실행됩니다.
  게이트웨이 호스트(컨테이너 없음)이며 **승인이 필요하지 않습니다**. 승인을 요구하려면 다음을 실행하세요.
  `host=gateway` 실행 승인을 구성하거나 샌드박싱을 활성화합니다.

## 구성

- `tools.exec.notifyOnExit` (기본값: true): true인 경우 백그라운드 exec 세션이 시스템 이벤트를 대기열에 추가하고 종료 시 하트비트를 요청합니다.
- `tools.exec.approvalRunningNoticeMs` (기본값: 10000): 승인 관리 실행이 이보다 오래 실행되면 단일 "실행" 알림을 보냅니다(0은 비활성화).
- `tools.exec.host` (기본값: `sandbox`)
- `tools.exec.security` (기본값: 샌드박스의 경우 `deny`, 설정 해제 시 게이트웨이 + 노드의 경우 `allowlist`)
- `tools.exec.ask` (기본값: `on-miss`)
- `tools.exec.node` (기본값: 설정 해제)
- `tools.exec.pathPrepend`: exec 실행을 위해 `PATH` 앞에 추가할 디렉터리 목록입니다.
- `tools.exec.safeBins`: 명시적인 허용 목록 항목 없이 실행할 수 있는 stdin 전용 안전 바이너리입니다.

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

- `host=gateway`: 로그인 쉘 `PATH`을 exec 환경에 병합합니다. `env.PATH` 재정의는 다음과 같습니다.
  호스트 실행이 거부되었습니다. 데몬 자체는 여전히 최소한의 `PATH`로 실행됩니다.
  - macOS: `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`
  - 리눅스: `/usr/local/bin`, `/usr/bin`, `/bin`
- `host=sandbox`: 컨테이너 내부에서 `sh -lc`(로그인 셸)을 실행하므로 `/etc/profile`는 `PATH`를 재설정할 수 있습니다.
  OpenClaw는 내부 환경 변수(셸 보간 없음)를 통해 프로필 소싱 후에 `env.PATH`를 앞에 추가합니다.
  `tools.exec.pathPrepend` 여기에도 적용됩니다.
- `host=node`: 전달한 차단되지 않은 환경 재정의만 노드로 전송됩니다. `env.PATH` 재정의는 다음과 같습니다.
  호스트 실행이 거부되었습니다. 헤드리스 노드 호스트는 노드 호스트 앞에 추가되는 경우에만 `PATH`를 허용합니다.
  PATH(대체 없음). macOS 노드는 `PATH`를 완전히 재정의합니다.

에이전트별 노드 바인딩(구성에서 에이전트 목록 색인 사용):

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

제어 UI: 노드 탭에는 동일한 설정을 위한 작은 "Exec 노드 바인딩" 패널이 포함되어 있습니다.

## 세션 재정의 (`/exec`)

`/exec`를 사용하여 `host`, `security`, `ask` 및 `node`에 대한 **세션별** 기본값을 설정합니다.
현재 값을 표시하려면 인수 없이 `/exec`를 보냅니다.

예:

```
/exec host=gateway security=allowlist ask=on-miss node=mac-1
```

## 인증 모델

`/exec`는 **승인된 발신자**(채널 허용 목록/페어링 및 `commands.useAccessGroups`)에 대해서만 적용됩니다.
**세션 상태만** 업데이트하고 구성은 작성하지 않습니다. Exec를 하드 비활성화하려면 도구를 통해 거부하세요.
정책(`tools.deny: ["exec"]` 또는 에이전트별). 명시적으로 설정하지 않는 한 호스트 승인은 계속 적용됩니다.
`security=full` 및 `ask=off`.

## Exec 승인(동반 앱/노드 호스트)

샌드박스 에이전트는 게이트웨이 또는 노드 호스트에서 `exec`가 실행되기 전에 요청별 승인을 요구할 수 있습니다.
정책, 허용 목록, UI 흐름은 [실행 승인](/tools/exec-approvals)을 참조하세요.

승인이 필요한 경우 Exec 도구는 다음과 같이 즉시 반환됩니다.
`status: "approval-pending"` 및 승인 ID입니다. 승인(또는 거부/시간 초과)되면
게이트웨이는 시스템 이벤트(`Exec finished` / `Exec denied`)를 발생시킵니다. 명령이 여전히
`tools.exec.approvalRunningNoticeMs` 이후 실행되면 단일 `Exec running` 알림이 표시됩니다.

## 허용 목록 + 안전 쓰레기통

허용 목록 적용은 **확인된 바이너리 경로만** 일치합니다(기본 이름 일치 없음). 언제
`security=allowlist`, 쉘 명령은 모든 파이프라인 세그먼트가
허용 목록에 있거나 안전한 보관함입니다. 연결(`;`, `&&`, `||`) 및 리디렉션은 다음에서 거부됩니다.
허용 목록 모드.

## 예

전경:

```json
{ "tool": "exec", "command": "ls -la" }
```

배경 + 설문조사:

```json
{"tool":"exec","command":"npm run build","yieldMs":1000}
{"tool":"process","action":"poll","sessionId":"<id>"}
```

키 보내기(tmux 스타일):

```json
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Enter"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["C-c"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Up","Up","Enter"]}
```

제출(CR만 보내기):

```json
{ "tool": "process", "action": "submit", "sessionId": "<id>" }
```

붙여넣기(기본적으로 괄호 안에 있음):

```json
{ "tool": "process", "action": "paste", "sessionId": "<id>", "text": "line1\nline2\n" }
```

## apply_patch (실험적)

`apply_patch`는 구조화된 다중 파일 편집을 위한 `exec`의 하위 도구입니다.
명시적으로 활성화합니다.

```json5
{
  tools: {
    exec: {
      applyPatch: { enabled: true, allowModels: ["gpt-5.2"] },
    },
  },
}
```

참고:

- OpenAI/OpenAI Codex 모델에서만 사용할 수 있습니다.
- 도구 정책은 계속 적용됩니다. `allow: ["exec"]`는 `apply_patch`를 암시적으로 허용합니다.
- 구성은 `tools.exec.applyPatch`에 있습니다.
