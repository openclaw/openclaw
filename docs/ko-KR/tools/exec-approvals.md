---
summary: "Exec 승인, 허용 목록, 및 샌드박스 탈출 프롬프트"
read_when:
  - Exec 승인 또는 허용 목록 구성
  - macOS 앱에서 Exec 승인 UX 구현
  - 샌드박스 탈출 프롬프트 및 관련 사항 검토
title: "Exec 승인"
---

# Exec 승인

Exec 승인은 샌드박스 격리된 에이전트가 실제 호스트 (`게이트웨이` 또는 `노드`)에서 명령어를 실행하도록 허용하는 **동반 앱 / 노드 호스트 가드레일**입니다. 안전 잠금 장치와 유사하다고 생각하세요: 정책 + 허용 목록 + (선택적) 사용자 승인이 모두 동의할 때만 명령어가 허용됩니다. Exec 승인은 도구 정책 및 상향 게이팅에 **추가**로 제공되며 (상향이 `full`으로 설정된 경우 승인이 건너뛰어집니다) `tools.exec.*` 및 승인 기본값 중 **더 엄격한** 정책이 유효합니다. 승인 필드가 생략되면 `tools.exec` 값이 사용됩니다.

동반 앱 UI가 **사용할 수 없는 경우**, 프롬프트가 필요한 요청은 **대체 요청**에 의해 해결됩니다 (기본: 거부).

## 적용 범위

Exec 승인은 실행 호스트에서 로컬로 적용됩니다:

- **게이트웨이 호스트** → 게이트웨이 머신의 `openclaw` 프로세스
- **노드 호스트** → 노드 러너 (macOS 동반 앱 또는 헤드리스 노드 호스트)

macOS 분할:

- **노드 호스트 서비스**가 `system.run`을 로컬 IPC를 통해 **macOS 앱**으로 전달합니다.
- **macOS 앱**은 승인을 강제하고 UI 컨텍스트에서 명령어를 실행합니다.

## 설정 및 저장

승인은 실행 호스트의 로컬 JSON 파일에 저장됩니다:

`~/.openclaw/exec-approvals.json`

예제 스키마:

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

## 정책 조정

### 보안 (`exec.security`)

- **deny**: 모든 호스트 Exec 요청 차단.
- **allowlist**: 허용 목록에 있는 명령어만 허용.
- **full**: 모든 것을 허용 (상향과 동일).

### 물어보기 (`exec.ask`)

- **off**: 절대 묻지 않음.
- **on-miss**: 허용 목록에 없을 때만 묻기.
- **always**: 모든 명령어에 대해 묻기.

### 대체 요청 (`askFallback`)

프롬프트가 필요하지만 UI에 도달할 수 없는 경우:

- **deny**: 차단.
- **allowlist**: 허용 목록이 일치할 때만 허용.
- **full**: 허용.

## 허용 목록 (에이전트별)

허용 목록은 **에이전트별**입니다. 여러 에이전트가 있는 경우, macOS 앱에서 편집 중인 에이전트를 전환하세요. 패턴은 **대소문자 구분 없는 글로브 일치**입니다. 패턴은 **바이너리 경로**로 해석되어야 합니다 (베이스네임만 있는 항목은 무시됨). 레거시 `agents.default` 항목은 로드 시 `agents.main`으로 이동됩니다.

예제:

- `~/Projects/**/bin/peekaboo`
- `~/.local/bin/*`
- `/opt/homebrew/bin/rg`

각 허용 목록 항목은 다음을 추적합니다:

- **id** 안정적인 UI 식별자용 UUID (선택적)
- **마지막 사용 시간**
- **마지막 사용 명령어**
- **마지막 해석 경로**

## 스킬 CLI 자동 허용

**스킬 CLI 자동 허용**이 활성화되면, 알려진 스킬에 의해 참조된 실행 파일은 노드 (macOS 노드 또는 헤드리스 노드 호스트)에서 허용 목록으로 간주됩니다. 이는 게이트웨이 RPC를 통해 스킬 바이너리 목록을 가져오는 `skills.bins`를 사용합니다. 엄격한 수동 허용 목록을 원할 경우 이를 비활성화하세요.

## 안전한 바이너리 (stdin만)

`tools.exec.safeBins`는 명시적 허용 목록 항목 **없이** 허용 목록 모드에서 실행할 수 있는 **stdin 전용** 바이너리 목록을 정의합니다 (예: `jq`). 안전한 바이너리는 위치 파일 인수와 경로 유사 토큰을 거부하므로 들어오는 스트림에서만 작동할 수 있습니다. 유효성 검사는 argv 형태만으로 결정론적으로 수행됩니다 (호스트 파일 시스템 존재 여부 검사 없음). 파일 지향 옵션은 기본 안전 바이너리에 대해 거부됩니다 (예: `sort -o`, `sort --compress-program`, `wc --files0-from`, `jq -f/--from-file`, `grep -f/--file`). 또한 안전한 바이너리는 stdin 전용 세그먼트에 대해 실행 시 argv 토큰을 **리터럴 텍스트**로 처리하도록 강제하므로 `*` 또는 `$HOME/...`와 같은 패턴을 파일 읽기로 수송할 수 없습니다. 안전 바이너리는 신뢰할 수 있는 바이너리 디렉토리(시스템 기본값 및 게이트웨이 시작 시 `PATH`)에서만 해석됩니다. 쉘 체이닝 및 리디렉션은 허용 목록 모드에서 자동으로 허용되지 않습니다.

안전-바이너리 프로필에서 거부된 플래그:

<!-- SAFE_BIN_DENIED_FLAGS:START -->

- `grep`: `--dereference-recursive`, `--directories`, `--exclude-from`, `--file`, `--recursive`, `-R`, `-d`, `-f`, `-r`
- `jq`: `--argfile`, `--from-file`, `--library-path`, `--rawfile`, `--slurpfile`, `-L`, `-f`
- `sort`: `--compress-program`, `--files0-from`, `--output`, `-o`
- `wc`: `--files0-from`
<!-- SAFE_BIN_DENIED_FLAGS:END -->

쉘 체이닝 (`&&`, `||`, `;`) 는 모든 최상위 세그먼트가 허용 목록을 만족하는 경우 허용됩니다 (안전한 바이너리 또는 스킬 자동 허용 포함). 리디렉션은 허용 목록 모드에서 지원되지 않습니다. 명령어 대체 (`$()` / 백틱)는 허용 목록 분석 중 거부되며, 이는 이중 인용부호 안에서도 마찬가지입니다; `$()` 리터럴 텍스트가 필요한 경우 단일 인용부호를 사용하세요.
macOS 컴패니언 앱 승인에서, 쉘 제어 또는 확장 구문 (`&&`, `||`, `;`, `|`, `` ` ``, `$`, `<`, `>`, `(`, `)`)을 포함하는 원시 쉘 텍스트는 쉘 바이너리 자체가 허용 목록에 없는 한 허용 목록 미스로 처리됩니다.

기본 안전한 바이너리: `jq`, `cut`, `uniq`, `head`, `tail`, `tr`, `wc`.

`grep`과 `sort`는 기본 목록에 없습니다. 사용을 원하는 경우, stdin 이외의 워크플로우에 대해 명시적 허용 목록 항목을 유지하세요.
`grep`을 안전-바이너리 모드에서 사용할 경우, `-e`/`--regexp`로 패턴을 제공하세요; 위치 패턴 형태는 거부되므로 파일 피연산자가 모호한 위치 인수로 수송될 수 없습니다.

## 컨트롤 UI 편집

기본값, 에이전트별 오버라이드, 허용 목록을 편집하려면 **컨트롤 UI → 노드 → Exec 승인** 카드를 사용하세요. 범위 (기본값 또는 에이전트)를 선택하고 정책을 조정하고, 허용 목록 패턴을 추가/제거한 후 **저장**하세요. UI는 패턴 당 **마지막 사용** 메타데이터를 표시하여 목록을 깔끔하게 유지할 수 있도록 도와줍니다.

대상 선택기로 **게이트웨이** (로컬 승인) 또는 **노드**를 선택하세요. 노드는 `system.execApprovals.get/set`을 광고해야 합니다 (macOS 앱 또는 헤드리스 노드 호스트). 노드가 아직 exec 승인을 광고하지 않는 경우, 로컬 `~/.openclaw/exec-approvals.json`을 직접 편집합니다.

CLI: `openclaw approvals`는 게이트웨이나 노드 편집을 지원합니다 (자세한 내용은 [Approvals CLI](/cli/approvals) 참조).

## 승인 흐름

프롬프트가 필요한 경우, 게이트웨이는 `exec.approval.requested`를 운영자 클라이언트에게 방송합니다. 컨트롤 UI 및 macOS 앱은 `exec.approval.resolve`를 통해 이를 해결한 다음, 게이트웨이는 승인된 요청을 노드 호스트에 전달합니다.

승인이 필요한 경우, exec 도구는 승인 ID와 함께 즉시 반환합니다. 그 ID를 사용하여 이후 시스템 이벤트 (`Exec 완료` / `Exec 거부`)를 연관시킬 수 있습니다. 시간 초과 전에 결정이 도착하지 않으면, 요청은 승인 시간 초과로 간주되며 거부 이유로 표시됩니다.

확인 대화 상자에는 다음이 포함됩니다:

- 명령어 + 인수
- 작업 디렉토리 (cwd)
- 에이전트 ID
- 해결된 실행 파일 경로
- 호스트 + 정책 메타데이터

작업:

- **한 번 허용** → 즉시 실행
- **항상 허용** → 허용 목록에 추가하고 실행
- **거부** → 차단

## 채팅 채널로 승인 포워딩

어떤 채팅 채널 (플러그인 채널 포함)로든 Exec 승인 프롬프트를 포워딩할 수 있으며 `/approve`로 승인을 받을 수 있습니다. 이는 일반적인 아웃바운드 전달 파이프라인을 사용합니다.

설정:

```json5
{
  approvals: {
    exec: {
      enabled: true,
      mode: "session", // "session" | "targets" | "both"
      agentFilter: ["main"],
      sessionFilter: ["discord"], // 서브스트링 또는 정규식
      targets: [
        { channel: "slack", to: "U12345678" },
        { channel: "telegram", to: "123456789" },
      ],
    },
  },
}
```

채팅에 응답:

```
/approve <id> allow-once
/approve <id> allow-always
/approve <id> deny
```

### macOS IPC 흐름

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + approvals + system.run)
```

보안 메모:

- 유닉스 소켓 모드 `0600`, 토큰은 `exec-approvals.json`에 저장.
- 동일 UID 피어 체크.
- 챌린지/응답 (nonce + HMAC 토큰 + 요청 해시) + 짧은 TTL.

## 시스템 이벤트

Exec 라이프사이클은 시스템 메시지로 표시됩니다:

- `Exec 실행 중` (명령어가 실행 알림 임계값을 초과할 경우에만)
- `Exec 완료`
- `Exec 거부`

이들은 노드가 이벤트를 보고한 후 에이전트의 세션에 게시됩니다. 게이트웨이 호스트 exec 승인은 명령어가 완료되면 동일한 라이프사이클 이벤트를 발생시키며 (옵션으로 실행이 임계값을 초과하는 경우), 승인으로 게이팅된 실행은 이러한 메시지에서 간편한 연관을 위해 `runId`로 승인 ID를 재사용합니다.

## 의미

- **full**은 강력합니다; 가능한 경우 허용 목록을 사용하세요.
- **ask**는 빠른 승인을 허용하면서 루프 안에 머물도록 합니다.
- 에이전트별 허용 목록은 한 에이전트의 승인 유출을 방지합니다.
- 승인은 **승인된 발신자**로부터의 호스트 exec 요청에만 적용됩니다. 승인되지 않은 발신자는 `/exec`를 발행할 수 없습니다.
- `/exec security=full`은 승인된 운영자에게 세션 수준의 편의를 제공하며, 설계상 승인을 건너뜁니다. 호스트 exec를 강제로 차단하려면 승인 보안을 `deny`로 설정하거나 도구 정책을 통해 `exec` 도구를 금지하세요.

관련 항목:

- [Exec 도구](/tools/exec)
- [Elevated 모드](/tools/elevated)
- [스킬](/tools/skills)
