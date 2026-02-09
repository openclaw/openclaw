---
summary: "Exec 승인, 허용 목록, 그리고 샌드박스 탈출 프롬프트"
read_when:
  - Exec 승인 또는 허용 목록을 구성할 때
  - macOS 앱에서 Exec 승인 UX 를 구현할 때
  - 샌드박스 탈출 프롬프트와 그 영향을 검토할 때
title: "Exec 승인"
---

# Exec 승인

Exec 승인은 샌드박스화된 에이전트가 실제 호스트에서 명령을 실행하도록 허용하기 위한 **컴패니언 앱 / 노드 호스트 가드레일**입니다
(`gateway` 또는 `node`). 안전 인터록과 유사하게 생각할 수 있습니다. 정책 + 허용 목록 + (선택적) 사용자 승인이 모두 일치할 때만 명령이 허용됩니다.
Exec 승인은 도구 정책과 상승된 게이팅에 **추가로** 적용됩니다(단, elevated 가 `full` 로 설정된 경우에는 승인이 생략됩니다).
유효 정책은 `tools.exec.*` 과 승인 기본값 중 **더 엄격한 쪽**입니다. 승인 필드가 생략된 경우 `tools.exec` 값이 사용됩니다.

컴패니언 앱 UI 를 **사용할 수 없는 경우**, 프롬프트가 필요한 모든 요청은
**ask fallback**(기본값: 거부)에 의해 처리됩니다.

## 적용 범위

Exec 승인은 실행 호스트에서 로컬로 강제됩니다:

- **gateway host** → 게이트웨이 머신의 `openclaw` 프로세스
- **node host** → 노드 러너(macOS 컴패니언 앱 또는 헤드리스 노드 호스트)

macOS 분리 구조:

- **node host service** 는 로컬 IPC 를 통해 `system.run` 을 **macOS 앱**으로 전달합니다.
- **macOS 앱** 은 승인을 집행하고 UI 컨텍스트에서 명령을 실행합니다.

## 설정 및 저장소

승인은 실행 호스트의 로컬 JSON 파일에 저장됩니다:

`~/.openclaw/exec-approvals.json`

예시 스키마:

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

## 정책 조정 항목

### 보안 (`exec.security`)

- **deny**: 모든 호스트 exec 요청을 차단합니다.
- **allowlist**: 허용 목록에 포함된 명령만 허용합니다.
- **full**: 모든 것을 허용합니다(elevated 와 동일).

### Ask (`exec.ask`)

- **off**: 프롬프트를 표시하지 않습니다.
- **on-miss**: 허용 목록이 일치하지 않을 때만 프롬프트를 표시합니다.
- **always**: 모든 명령에 대해 프롬프트를 표시합니다.

### Ask fallback (`askFallback`)

프롬프트가 필요하지만 UI 에 접근할 수 없는 경우, fallback 이 동작을 결정합니다:

- **deny**: 차단합니다.
- **allowlist**: 허용 목록이 일치하는 경우에만 허용합니다.
- **full**: 허용합니다.

## 허용 목록(에이전트별)

허용 목록은 **에이전트별**입니다. 여러 에이전트가 있는 경우 macOS 앱에서
편집 중인 에이전트를 전환하십시오. 패턴은 **대소문자를 구분하지 않는 glob 매칭**입니다.
패턴은 **바이너리 경로**로 해석되어야 합니다(베이스네임만 있는 항목은 무시됩니다).
레거시 `agents.default` 항목은 로드 시 `agents.main` 으로 마이그레이션됩니다.

예시:

- `~/Projects/**/bin/peekaboo`
- `~/.local/bin/*`
- `/opt/homebrew/bin/rg`

각 허용 목록 항목은 다음을 추적합니다:

- **id** UI 식별에 사용되는 안정적인 UUID (선택 사항)
- **last used** 타임스탬프
- **last used command**
- **last resolved path**

## Skill CLI 자동 허용

**Auto-allow skill CLIs** 가 활성화되면, 알려진 Skills 에서 참조되는 실행 파일은
노드(macOS 노드 또는 헤드리스 노드 호스트)에서 허용 목록에 포함된 것으로 처리됩니다. 이는 Gateway RPC 를 통해 `skills.bins` 을 사용하여 Skill bin 목록을 가져옵니다. 엄격한 수동 허용 목록을 원한다면 이 옵션을 비활성화하십시오.

## Safe bin(stdin 전용)

`tools.exec.safeBins` 은 **stdin 전용** 바이너리의 소규모 목록(예: `jq`)을 정의하며,
이들은 명시적인 허용 목록 항목 **없이도** 허용 목록 모드에서 실행될 수 있습니다. Safe bin 은 위치 인자 파일과 경로 형태의 토큰을 거부하므로, 입력 스트림에 대해서만 동작할 수 있습니다.
셸 체이닝과 리다이렉션은 허용 목록 모드에서 자동 허용되지 않습니다.

셸 체이닝(`&&`, `||`, `;`)은 모든 최상위 세그먼트가
허용 목록을 충족하는 경우( safe bin 또는 Skill 자동 허용 포함) 허용됩니다. 리다이렉션은 허용 목록 모드에서 여전히 지원되지 않습니다.
명령 치환(`$()` / 백틱)은 허용 목록 파싱 중 거부되며,
큰따옴표 내부도 포함됩니다. 리터럴 `$()` 텍스트가 필요하면 작은따옴표를 사용하십시오.

기본 safe bin: `jq`, `grep`, `cut`, `sort`, `uniq`, `head`, `tail`, `tr`, `wc`.

## Control UI 편집

**Control UI → Nodes → Exec approvals** 카드에서 기본값, 에이전트별
오버라이드, 그리고 허용 목록을 편집하십시오. 범위(기본값 또는 에이전트)를 선택하고,
정책을 조정한 뒤 허용 목록 패턴을 추가/제거하고 **Save** 를 클릭합니다. UI 는 각 패턴별 **last used** 메타데이터를 표시하므로 목록을 깔끔하게 유지할 수 있습니다.

대상 선택기는 **Gateway**(로컬 승인) 또는 **Node** 를 선택합니다. 노드는
`system.execApprovals.get/set` 을 광고해야 합니다(macOS 앱 또는 헤드리스 노드 호스트).
노드가 아직 exec 승인을 광고하지 않는 경우, 로컬
`~/.openclaw/exec-approvals.json` 을 직접 편집하십시오.

CLI: `openclaw approvals` 는 게이트웨이 또는 노드 편집을 지원합니다([Approvals CLI](/cli/approvals) 참조).

## 승인 흐름

프롬프트가 필요한 경우, 게이트웨이는 운영자 클라이언트로 `exec.approval.requested` 을 브로드캐스트합니다.
Control UI 와 macOS 앱은 `exec.approval.resolve` 을 통해 이를 처리한 다음,
게이트웨이는 승인된 요청을 노드 호스트로 전달합니다.

승인이 필요한 경우, exec 도구는 즉시 승인 id 와 함께 반환됩니다. 이 id 를 사용하여
이후 시스템 이벤트(`Exec finished` / `Exec denied`)와 상관관계를 맺으십시오. 타임아웃 전에 결정이 도착하지 않으면, 요청은 승인 타임아웃으로 처리되며 거부 사유로 표시됩니다.

확인 대화상자에는 다음이 포함됩니다:

- 명령 + 인자
- cwd
- 에이전트 id
- 해석된 실행 파일 경로
- 호스트 + 정책 메타데이터

동작:

- **Allow once** → 즉시 실행
- **Always allow** → 허용 목록에 추가 + 실행
- **Deny** → 차단

## 채팅 채널로 승인 전달

Exec 승인 프롬프트를 플러그인 채널을 포함한 어떤 채널로도 전달할 수 있으며,
`/approve` 로 승인할 수 있습니다. 이는 일반적인 아웃바운드 전달 파이프라인을 사용합니다.

구성:

```json5
{
  approvals: {
    exec: {
      enabled: true,
      mode: "session", // "session" | "targets" | "both"
      agentFilter: ["main"],
      sessionFilter: ["discord"], // substring or regex
      targets: [
        { channel: "slack", to: "U12345678" },
        { channel: "telegram", to: "123456789" },
      ],
    },
  },
}
```

채팅에서 응답:

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

보안 참고 사항:

- Unix 소켓 모드 `0600`, 토큰은 `exec-approvals.json` 에 저장됩니다.
- 동일 UID 피어 검사.
- 챌린지/응답(논스 + HMAC 토큰 + 요청 해시) + 짧은 TTL.

## 시스템 이벤트

Exec 라이프사이클은 시스템 메시지로 노출됩니다:

- `Exec running` (명령이 실행 중 알림 임계값을 초과한 경우에만)
- `Exec finished`
- `Exec denied`

이 이벤트들은 노드가 이벤트를 보고한 후 에이전트의 세션에 게시됩니다.
게이트웨이 호스트 exec 승인도 명령이 완료될 때 동일한 라이프사이클 이벤트를 발생시키며
(선택적으로 임계값을 초과하여 실행 중일 때도 발생시킬 수 있습니다).
승인 게이트가 적용된 exec 는 상관관계를 쉽게 하기 위해 이 메시지에서 `runId` 로 승인 id 를 재사용합니다.

## 시사점

- **full** 은 강력하므로, 가능하면 허용 목록을 선호하십시오.
- **ask** 는 빠른 승인을 유지하면서도 상황을 파악할 수 있게 해줍니다.
- 에이전트별 허용 목록은 한 에이전트의 승인이 다른 에이전트로 누출되는 것을 방지합니다.
- 승인은 **인증된 발신자**로부터의 호스트 exec 요청에만 적용됩니다. 인증되지 않은 발신자는 `/exec` 을 발행할 수 없습니다.
- `/exec security=full` 는 인증된 운영자를 위한 세션 수준의 편의 기능이며, 설계상 승인을 건너뜁니다.
  호스트 exec 를 강제로 차단하려면 승인 보안을 `deny` 으로 설정하거나,
  도구 정책을 통해 `exec` 도구를 거부하십시오.

관련 항목:

- [Exec tool](/tools/exec)
- [Elevated mode](/tools/elevated)
- [Skills](/tools/skills)
