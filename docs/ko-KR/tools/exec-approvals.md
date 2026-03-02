---
summary: "실행 승인, 허용 목록 및 샌드박스 탈출 프롬프트"
read_when:
  - 실행 승인 또는 허용 목록 구성할 때
  - macOS 앱에서 실행 승인 UX 구현할 때
  - 샌드박스 탈출 프롬프트 및 영향 검토할 때
title: "실행 승인"
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: tools/exec-approvals.md
workflow: 15
---

# 실행 승인

실행 승인은 **컴패니언 앱 / 노드 호스트 가드레일**로서 샌드박스된 에이전트가 실제 호스트(`gateway` 또는 `node`)에서 커맨드를 실행할 수 있도록 합니다. 안전 잠금처럼 생각하세요:
커맨드는 정책 + 허용 목록 + (선택 사항) 사용자 승인이 모두 동의할 때만 허용됩니다.
실행 승인은 도구 정책 및 높은 모드 제어에 **추가**로 적용됩니다(`elevated`가 `full`로 설정되지 않은 경우).

컴패니언 앱 UI를 **사용할 수 없는** 경우 프롬프트가 필요한 모든 요청은
**물어보기 폴백**으로 해결됩니다(기본값: 거부).

## 적용되는 위치

실행 승인은 실행 호스트에서 로컬로 적용됩니다:

- **gateway 호스트** → gateway 머신의 `openclaw` 프로세스
- **노드 호스트** → 노드 러너(macOS 컴패니언 앱 또는 헤드리스 노드 호스트)

신뢰 모델 참고:

- Gateway 인증 호출자는 해당 Gateway의 신뢰 운영자입니다.
- 쌍을 이룬 노드는 그 신뢰 운영자 기능을 노드 호스트로 확장합니다.
- 실행 승인은 우발적 실행 위험을 감소시키지만 사용자별 인증 경계가 아닙니다.

macOS 분할:

- **노드 호스트 서비스**는 `system.run`을 로컬 IPC를 통해 **macOS 앱**으로 전달합니다.
- **macOS 앱**은 승인을 적용하고 UI 컨텍스트에서 커맨드를 실행합니다.

## 설정 및 저장

승인은 실행 호스트의 로컬 JSON 파일에 있습니다:

`~/.openclaw/exec-approvals.json`

예 스키마:

```json
{
  "version": 1,
  "socket": {
    "path": "~/.openclaw/exec-approvals.sock",
    "token": "base64url-token"
  },
  "defaults": {
    "security": "deny",
    "ask": "on-miss",
    "askFallback": "deny",
    "autoAllowSkills": false
  },
  "agents": {
    "main": {
      "security": "allowlist",
      "ask": "on-miss",
      "askFallback": "deny",
      "autoAllowSkills": true,
      "allowlist": [
        {
          "id": "B0C8C0B3-2C2D-4F8A-9A3C-5A4B3C2D1E0F",
          "pattern": "~/Projects/**/bin/rg",
          "lastUsedAt": 1737150000000,
          "lastUsedCommand": "rg -n TODO",
          "lastResolvedPath": "/Users/user/Projects/.../bin/rg"
        }
      ]
    }
  }
}
```

## 정책 노브

### 보안(`exec.security`)

- **deny**: 모든 호스트 실행 요청을 차단합니다.
- **allowlist**: 허용 목록 커맨드만 허용합니다.
- **full**: 모든 것을 허용합니다(높은 모드와 동등).

### 물어보기(`exec.ask`)

- **off**: 절대 프롬프트하지 않습니다.
- **on-miss**: 허용 목록이 일치하지 않을 때만 프롬프트합니다.
- **always**: 모든 커맨드에 대해 프롬프트합니다.

### 물어보기 폴백(`askFallback`)

프롬프트가 필요하지만 UI에 도달할 수 없으면 폴백이 결정합니다:

- **deny**: 차단합니다.
- **allowlist**: 허용 목록이 일치하는 경우만 허용합니다.
- **full**: 허용합니다.

## 허용 목록(에이전트별)

허용 목록은 **에이전트별**입니다. 여러 에이전트가 있으면 macOS 앱에서 편집할 에이전트를 전환합니다. 패턴은 **대소문자를 구분하지 않는 glob 일치**입니다.
패턴은 **바이너리 경로**(basename 전용 항목은 무시됨)로 해결되어야 합니다.
레거시 `agents.default` 항목은 로드 시 `agents.main`으로 마이그레이션됩니다.

예:

- `~/Projects/**/bin/peekaboo`
- `~/.local/bin/*`
- `/opt/homebrew/bin/rg`

각 허용 목록 항목은 다음을 추적합니다:

- **id** UI 신원용으로 사용되는 안정적인 UUID(선택 사항)
- **마지막 사용** 타임스탐프
- **마지막 사용 커맨드**
- **마지막 해결된 경로**

## 안전 바이너리(stdin 전용)

`tools.exec.safeBins`는 허용 목록 모드에서 실행할 수 있는 **stdin 전용** 바이너리(예: `jq`)의 작은 목록을 정의합니다.
명시적 허용 목록 항목. 안전 바이너리는 위치 파일 인수 및 경로 유사 토큰을 거부하므로 들어오는 스트림에만 작동할 수 있습니다.
이를 스트림 필터용 좁은 빠른 경로로 취급하지 일반 신뢰 목록이 아닙니다.

인터프리터 또는 런타임 바이너리(예: `python3`, `node`, `ruby`, `bash`, `sh`, `zsh`)를 `safeBins`에 추가하지 **마세요**.
커맨드가 코드를 평가하거나, 서브커맨드를 실행하거나, 설계상 파일을 읽을 수 있으면 명시적 허용 목록 항목을 선호하고 승인 프롬프트를 활성화된 상태로 유지합니다.

커스텀 안전 바이너리는 `tools.exec.safeBinProfiles.<bin>`에서 명시적 프로필을 정의해야 합니다.
검증은 argv 형태만(호스트 파일 시스템 존재 확인 없음)에서 결정론적이며,
이는 allow/deny 차이로부터 파일 존재 oracle 동작을 방지합니다.

파일 지향 옵션은 기본 안전 바이너리(예: `sort -o`, `sort --output`,
`sort --files0-from`, `sort --compress-program`, `sort --random-source`,
`sort --temporary-directory`/`-T`, `wc --files0-from`, `jq -f/--from-file`,
`grep -f/--file`)에 대해 거부됩니다.

안전 바이너리는 또한 stdin 전용 동작을 깨뜨리는 옵션에 대한 명시적 바이너리별 플래그 정책을 적용합니다(예: `sort -o/--output/--compress-program` 및 grep 재귀 플래그).

안전 바이너리 모드에서 알 수 없는 플래그 및 모호한
약어는 거부됩니다(fail-closed).

안전 바이너리 프로필별 거부된 플래그:

<!-- SAFE_BIN_DENIED_FLAGS:START -->

- `grep`: `--dereference-recursive`, `--directories`, `--exclude-from`, `--file`, `--recursive`, `-R`, `-d`, `-f`, `-r`
- `jq`: `--argfile`, `--from-file`, `--library-path`, `--rawfile`, `--slurpfile`, `-L`, `-f`
- `sort`: `--compress-program`, `--files0-from`, `--output`, `--random-source`, `--temporary-directory`, `-T`, `-o`
- `wc`: `--files0-from`
<!-- SAFE_BIN_DENIED_FLAGS:END -->

안전 바이너리는 또한 argv 토큰을 stdin 전용 세그먼트에 대해 **리터럴 텍스트**로 취급하도록 강제합니다(globbing 없음
및 `$VARS` 확장 없음). 그래서 `*` 또는 `$HOME/...` 같은 패턴은 파일 읽기를 몰래 반입할 수 없습니다.

안전 바이너리는 또한 신뢰하는 바이너리 디렉터리에서 해결되어야 합니다(시스템 기본값 플러스 선택 사항
`tools.exec.safeBinTrustedDirs`). `PATH` 항목은 절대 자동 신뢰됩니다.

기본 신뢰 안전 바이너리 디렉터리는 의도적으로 최소입니다: `/bin`, `/usr/bin`.

안전 바이너리 실행 가능 파일이 패키지 관리자/사용자 경로(예:
`/opt/homebrew/bin`, `/usr/local/bin`, `/opt/local/bin`, `/snap/bin`)에 있으면 명시적으로
`tools.exec.safeBinTrustedDirs`에 추가합니다.

셸 체이닝 및 리다이렉션은 허용 목록 모드에서 자동 허용되지 않습니다.

셸 체이닝(`&&`, `||`, `;`)은 모든 최상위 세그먼트가 허용 목록을 충족할 때 허용됩니다
(안전 바이너리 포함 또는 Skill 자동 허용). 리다이렉션은 허용 목록 모드에서 계속 미지원됩니다.

커맨드 대체(`$()` / backticks)는 큰따옴표 안 포함하여 허용 목록 구문 분석 중에 거부됩니다; 리터럴 `$()`를 원하면 한 따옴표를 사용합니다.

macOS 컴패니언 앱 승인에서 셸 제어 또는 확장 구문(`&&`, `||`, `;`, `|`, `` ` ``, `$`, `<`, `>`, `(`, `)`)을 포함하는 원본 셸 텍스트는 셸 바이너리 자체가 허용 목록 상태가 아닌 한 허용 목록 누락으로 처리됩니다.

셸 래퍼(`bash|sh|zsh ... -c/-lc`)의 경우 요청 범위 env 오버라이드는 작은 명시적 허용 목록(`TERM`, `LANG`, `LC_*`, `COLORTERM`, `NO_COLOR`, `FORCE_COLOR`)로 축소됩니다.

allow-always 결정의 허용 목록 모드의 경우 알려진 전달 래퍼
(`env`, `nice`, `nohup`, `stdbuf`, `timeout`)는 내부 실행 경로를 유지하는 대신 래퍼
경로를 유지합니다. 셸 멀티플렉서(`busybox`, `toybox`)는 또한 셸 애플릿(`sh`, `ash` 등)에 대해 래핑 해제되므로 내부 실행 파일은 멀티플렉서 바이너리 대신 유지됩니다. 래퍼 또는 멀티플렉서를 안전하게 래핑 해제할 수 없으면 허용 목록 항목이 자동 유지되지 않습니다.

기본 안전 바이너리: `jq`, `cut`, `uniq`, `head`, `tail`, `tr`, `wc`.

`grep` 및 `sort`는 기본 목록에 없습니다. 옵션 선택 시 비 stdin 워크플로우에 대한 명시적 허용 목록 항목을 유지합니다.

## 제어 UI 편집

**Control UI → Nodes → Exec approvals** 카드를 사용하여 기본값, 에이전트별
오버라이드 및 허용 목록을 편집합니다. 범위(기본값 또는 에이전트)를 선택하고 정책을 조정한 다음 **Save**합니다. UI는 **마지막 사용** 메타데이터를
패턴별로 표시하므로 목록을 정리할 수 있습니다.

대상 선택기는 **Gateway**(로컬 승인) 또는 **Node**를 선택합니다. 노드
는 `system.execApprovals.get/set`을 광고해야 합니다(macOS 앱 또는 헤드리스 노드 호스트).

노드가 아직 실행 승인을 광고하지 않으면 로컬
`~/.openclaw/exec-approvals.json`을 직접 편집합니다.

CLI: `openclaw approvals`는 Gateway 또는 노드 편집을 지원합니다([Approvals CLI](/cli/approvals) 참고).

## 승인 흐름

프롬프트가 필요하면 Gateway는 `exec.approval.requested`를 운영자 클라이언트로 브로드캐스트합니다.
Control UI 및 macOS 앱은 `exec.approval.resolve`를 통해 해결한 다음 Gateway는 승인된 요청을 노드 호스트로 전달합니다.

`host=node`의 경우 승인 요청은 정규 `systemRunPlan` 페이로드를 포함합니다. Gateway는 승인된 `system.run` 요청을 전달할 때 정규 커맨드/cwd/세션 컨텍스트로 해당 계획을 사용합니다.

승인이 필요하면 실행 도구는 승인 ID로 즉시 반환됩니다. 해당 ID를 사용하여 이후 시스템 이벤트(`Exec finished` / `Exec denied`)와 연결합니다. 타임아웃 전에 결정이 없으면 요청은 승인 타임아웃으로 처리되고 거부 이유로 표시됩니다.

확인 대화상자에는 다음이 포함됩니다:

- 커맨드 + 인수
- cwd
- 에이전트 ID
- 해결된 실행 경로
- 호스트 + 정책 메타데이터

액션:

- **Allow once** → 지금 실행
- **Always allow** → 허용 목록에 추가 + 실행
- **Deny** → 차단

## 승인을 채팅 채널로 전달

실행 승인 프롬프트를 모든 채팅 채널(플러그인 채널 포함)로 전달하고 `/approve`로 승인할 수 있습니다. 이는 정상 아웃바운드 전달 파이프라인을 사용합니다.

구성:

```json5
{
  approvals: {
    exec: {
      enabled: true,
      mode: "session", // "session" | "targets" | "both"
      agentFilter: ["main"],
      sessionFilter: ["discord"], // substring 또는 regex
      targets: [
        { channel: "slack", to: "U12345678" },
        { channel: "telegram", to: "123456789" },
      ],
    },
  },
}
```

채팅 회신:

```
/approve <id> allow-once
/approve <id> allow-always
/approve <id> deny
```

## 시스템 이벤트

실행 라이프사이클은 시스템 메시지로 표시됩니다:

- `Exec running`(커맨드가 실행 알림 임계값을 초과할 경우만)
- `Exec finished`
- `Exec denied`

이들은 노드가 이벤트를 보고한 후 에이전트의 세션에 게시됩니다.
Gateway 호스트 실행 승인은 커맨드가 마칠 때(선택적으로 임계값보다 오래 실행될 때) 동일 라이프사이클 이벤트를 방출합니다.
승인 제어 실행은 이들 메시지에서 `runId`로 승인 ID를 재사용하여 쉽게 연결됩니다.

## 영향

- **full**은 강력합니다; 가능하면 허용 목록을 선호합니다.
- **ask**는 빠른 승인을 허용하면서 반복합니다.
- 에이전트별 허용 목록은 한 에이전트의 승인이 다른 에이전트로 누출되는 것을 방지합니다.
- 승인은 **권한 있는 발신자**로부터의 호스트 실행 요청에만 적용됩니다. 권한 없는 발신자는 `/exec`을 발급할 수 없습니다.
- `/exec security=full`은 세션 수준 편의 기능으로서 권한 있는 운영자용이며 설계상 승인을 건너뜁니다.
  호스트 실행을 하드 차단하려면 승인 보안을 `deny`로 설정하거나 도구 정책을 통해 `exec` 도구를 거부합니다.

관련:

- [Exec 도구](/tools/exec)
- [높은 모드](/tools/elevated)
- [Skills](/tools/skills)
