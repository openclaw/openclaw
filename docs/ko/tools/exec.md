---
read_when:
    - Exec 도구 사용 또는 수정
    - stdin 또는 TTY 동작 디버깅
summary: Exec 도구 사용, stdin 모드 및 TTY 지원
title: 실행 도구
x-i18n:
    generated_at: "2026-02-08T16:12:41Z"
    model: gtx
    provider: google-translate
    source_hash: 3b32238dd8dce93d4f24100eaa521ce9f8485eff6d8498e2680ce9ed6045d25f
    source_path: tools/exec.md
    workflow: 15
---

# 실행 도구

작업 공간에서 셸 명령을 실행합니다. 다음을 통해 포그라운드 + 백그라운드 실행을 지원합니다. `process`.
만약에 `process` 허용되지 않습니다. `exec` 동기식으로 실행되고 무시됩니다. `yieldMs`/`background`.
백그라운드 세션의 범위는 에이전트별로 지정됩니다. `process` 동일한 에이전트의 세션만 볼 수 있습니다.

## 매개변수

- `command` (필수의)
- `workdir` (기본값은 cwd)
- `env` (키/값 재정의)
- `yieldMs` (기본값 10000): 지연 후 자동 배경화면
- `background` (bool): 즉시 배경
- `timeout` (초, 기본값 1800): 만료 시 종료
- `pty` (bool): 가능한 경우 의사 터미널에서 실행합니다(TTY 전용 CLI, 코딩 에이전트, 터미널 UI).
- `host` (`sandbox | gateway | node`): 실행할 위치
- `security` (`deny | allowlist | full`): 적용 모드 `gateway`/`node`
- `ask` (`off | on-miss | always`): 승인 프롬프트 `gateway`/`node`
- `node` (문자열): 노드 ID/이름 `host=node`
- `elevated` (bool): 높은 모드를 요청합니다(게이트웨이 호스트). `security=full` 승격된 경우에만 강제됩니다. `full`

참고:

- `host` 기본값은 `sandbox`.
- `elevated` 샌드박싱이 꺼져 있으면 무시됩니다(exec가 이미 호스트에서 실행 중임).
- `gateway`/`node` 승인은 다음에 의해 제어됩니다. `~/.openclaw/exec-approvals.json`.
- `node` 페어링된 노드(동반 앱 또는 헤드리스 노드 호스트)가 필요합니다.
- 여러 노드를 사용할 수 있는 경우 다음을 설정합니다. `exec.node` 또는 `tools.exec.node` 하나를 선택합니다.
- Windows가 아닌 호스트에서 exec는 다음을 사용합니다. `SHELL` 설정되면; 만약에 `SHELL` ~이다 `fish`, 그것은 선호한다 `bash` (또는 `sh`)
  에서 `PATH` 물고기와 호환되지 않는 스크립트를 피하기 위해 다음으로 돌아갑니다. `SHELL` 둘 다 존재하지 않는 경우.
- 호스트 실행(`gateway`/`node`) 거부 `env.PATH` 및 로더 재정의(`LD_*`/`DYLD_*`) 에
  바이너리 하이재킹이나 코드 삽입을 방지합니다.
- 중요: 샌드박스는 **기본적으로 꺼짐**. 샌드박싱이 꺼져 있으면 `host=sandbox` 직접 실행
  게이트웨이 호스트(컨테이너 없음) 및 **승인이 필요하지 않습니다**. 승인을 요구하려면 다음을 실행하세요.
  `host=gateway` 실행 승인을 구성하거나 샌드박싱을 활성화합니다.

## 구성

- `tools.exec.notifyOnExit` (기본값: true): true인 경우 백그라운드 실행 세션이 시스템 이벤트를 대기열에 추가하고 종료 시 하트비트를 요청합니다.
- `tools.exec.approvalRunningNoticeMs` (기본값: 10000): 승인 관리 실행이 이보다 오래 실행되면 단일 "실행 중" 알림을 보냅니다(0은 비활성화됨).
- `tools.exec.host` (기본: `sandbox`)
- `tools.exec.security` (기본: `deny` 샌드박스의 경우, `allowlist` 설정되지 않은 경우 게이트웨이 + 노드의 경우)
- `tools.exec.ask` (기본: `on-miss`)
- `tools.exec.node` (기본값: 설정되지 않음)
- `tools.exec.pathPrepend`: 앞에 추가할 디렉터리 목록 `PATH` exec 실행을 위해.
- `tools.exec.safeBins`: 명시적인 허용 목록 항목 없이 실행할 수 있는 표준 입력 전용 안전 바이너리입니다.

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

- `host=gateway`: 로그인 쉘을 병합합니다. `PATH` 실행 환경에 들어갑니다. `env.PATH` 재정의는
  호스트 실행이 거부되었습니다. 데몬 자체는 여전히 최소한으로 실행됩니다. `PATH`:
  - 맥OS: `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`
  - 리눅스: `/usr/local/bin`, `/usr/bin`, `/bin`
- `host=sandbox`: 실행 `sh -lc` (로그인 셸) 컨테이너 내부에 있으므로 `/etc/profile` 재설정될 수 있음 `PATH`.
  OpenClaw 앞에 추가 `env.PATH` 내부 환경 변수를 통한 프로필 소싱 후(셸 보간 없음)
  `tools.exec.pathPrepend` 여기에도 적용됩니다.
- `host=node`: 전달한 차단되지 않은 환경 재정의만 노드로 전송됩니다. `env.PATH` 재정의는
  호스트 실행이 거부되었습니다. 헤드리스 노드 호스트는 허용합니다. `PATH` 노드 호스트 앞에 추가되는 경우에만
  PATH(대체 없음). macOS 노드 드롭 `PATH` 완전히 재정의됩니다.

에이전트별 노드 바인딩(구성에서 에이전트 목록 색인 사용):

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

제어 UI: 노드 탭에는 동일한 설정을 위한 작은 "Exec 노드 바인딩" 패널이 포함되어 있습니다.

## 세션 재정의(`/exec`)

사용 `/exec` 설정하다 **세션별** 기본값 `host`, `security`, `ask`, 그리고 `node`.
보내다 `/exec` 현재 값을 표시하는 인수가 없습니다.

예:

```
/exec host=gateway security=allowlist ask=on-miss node=mac-1
```

## 인증 모델

`/exec` 오직 존경받는다 **승인된 발신자** (채널 허용 목록/페어링 플러스 `commands.useAccessGroups`).
업데이트됩니다 **세션 상태만** 구성을 쓰지 않습니다. Exec를 하드 비활성화하려면 도구를 통해 거부하세요.
정책(`tools.deny: ["exec"]` 또는 에이전트별). 명시적으로 설정하지 않는 한 호스트 승인은 계속 적용됩니다.
`security=full` 그리고 `ask=off`.

## Exec 승인(동반 앱/노드 호스트)

샌드박스 에이전트는 이전에 요청별 승인을 요구할 수 있습니다. `exec` 게이트웨이 또는 노드 호스트에서 실행됩니다.
보다 [임원 승인](/tools/exec-approvals) 정책, 허용 목록, UI 흐름에 대한 것입니다.

승인이 필요한 경우 Exec 도구는 다음과 같이 즉시 반환됩니다.
`status: "approval-pending"` 그리고 승인 ID입니다. 승인(또는 거부/시간 초과)되면
게이트웨이는 시스템 이벤트(`Exec finished`/`Exec denied`). 명령이 여전히
뒤쫓아 가다 `tools.exec.approvalRunningNoticeMs`, 단일 `Exec running` 공지가 출력됩니다.

## 허용 목록 + 금고

허용 목록 시행 일치 **확인된 바이너리 경로만** (기본 이름이 일치하지 않음) 언제
`security=allowlist`, 셸 명령은 모든 파이프라인 세그먼트가 다음인 경우에만 자동으로 허용됩니다.
허용 목록에 있거나 안전한 보관함입니다. 체인화(`;`, `&&`, `||`) 및 리디렉션은 다음에서 거부됩니다.
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

`apply_patch` 의 하위 도구입니다 `exec` 구조화된 다중 파일 편집용.
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
- 도구 정책은 계속 적용됩니다. `allow: ["exec"]` 암묵적으로 허용 `apply_patch`.
- 구성은 아래에 있습니다. `tools.exec.applyPatch`.
