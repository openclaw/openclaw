---
summary: "Exec approvals, allowlists, and sandbox escape prompts"
read_when:
  - Configuring exec approvals or allowlists
  - Implementing exec approval UX in the macOS app
  - Reviewing sandbox escape prompts and implications
title: "Exec Approvals"
x-i18n:
  source_hash: 66630b5d79671dd4b320cab9d018fa30c497480b955a17cb0b1c7fd609947983
---

# 임원 승인

Exec 승인은 샌드박스 에이전트를 실행하기 위한 **동반 앱/노드 호스트 가드레일**입니다.
실제 호스트의 명령(`gateway` 또는 `node`). 안전 인터록처럼 생각해보세요.
정책 + 허용 목록 + (선택 사항) 사용자 승인이 모두 동의하는 경우에만 명령이 허용됩니다.
Exec 승인은 도구 정책 및 승격된 게이팅에 **추가**됩니다(승격이 승인을 건너뛰는 `full`로 설정되지 않은 경우).
효과적인 정책은 `tools.exec.*`의 **더 엄격한** 정책이며 승인 기본값입니다. 승인 필드가 생략되면 `tools.exec` 값이 사용됩니다.

컴패니언 앱 UI를 **사용할 수 없는** 경우 프롬프트가 필요한 모든 요청은
**대체 질문**으로 해결됩니다(기본값: 거부).

## 적용되는 곳

Exec 승인은 실행 호스트에서 로컬로 적용됩니다.

- **게이트웨이 호스트** → 게이트웨이 머신의 `openclaw` 프로세스
- **노드 호스트** → 노드 러너(macOS 도우미 앱 또는 헤드리스 노드 호스트)

macOS 분할:

- **노드 호스트 서비스**는 `system.run`를 로컬 IPC를 통해 **macOS 앱**으로 전달합니다.
- **macOS 앱**은 승인을 시행하고 UI 컨텍스트에서 명령을 실행합니다.

## 설정 및 저장

승인은 실행 호스트의 로컬 JSON 파일에 있습니다.

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

## 정책 손잡이

### 보안 (`exec.security`)

- **거부**: 모든 호스트 실행 요청을 차단합니다.
- **허용 목록**: 허용 목록에 있는 명령만 허용합니다.
- **전체**: 모든 것을 허용합니다(상승된 것과 동일).

### 물어보세요 (`exec.ask`)

- **해제**: 메시지를 표시하지 않습니다.
- **on-miss**: 허용 목록이 일치하지 않는 경우에만 메시지를 표시합니다.
- **항상**: 모든 명령에 대해 프롬프트를 표시합니다.

### 대체 요청(`askFallback`)

프롬프트가 필요하지만 UI에 접근할 수 없는 경우 대체는 다음을 결정합니다.

- **거부**: 차단합니다.
- **허용 목록**: 허용 목록이 일치하는 경우에만 허용합니다.
- **전체**: 허용합니다.

## 허용 목록(에이전트별)

허용 목록은 **에이전트별**입니다. 상담원이 여러 명인 경우 어떤 상담원으로 전환하세요.
macOS 앱에서 편집. 패턴은 **대소문자를 구분하지 않는 전역 일치**입니다.
패턴은 **바이너리 경로**로 해석되어야 합니다(기본 이름만 있는 항목은 무시됨).
기존 `agents.default` 항목은 로드 시 `agents.main`로 마이그레이션됩니다.

예:

- `~/Projects/**/bin/peekaboo`
- `~/.local/bin/*`
- `/opt/homebrew/bin/rg`

각 허용 목록 항목은 다음을 추적합니다.

- **id** UI ID에 사용되는 안정적인 UUID(선택 사항)
- **마지막 사용** 타임스탬프
- **마지막으로 사용한 명령**
- **마지막으로 확인된 경로**

## 스킬 CLI 자동 허용

**자동 허용 기술 CLI**가 활성화되면 알려진 기술이 참조하는 실행 파일
노드(macOS 노드 또는 헤드리스 노드 호스트)에서 허용 목록으로 처리됩니다. 이는 다음을 사용합니다.
`skills.bins` 게이트웨이 RPC를 통해 스킬 빈 목록을 가져옵니다. 엄격한 수동 허용 목록을 원하는 경우 이 기능을 비활성화하세요.

## 금고(표준 입력 전용)

`tools.exec.safeBins`는 **stdin 전용** 바이너리의 작은 목록을 정의합니다(예: `jq`)
명시적인 허용 목록 항목 **없이** 허용 목록 모드에서 실행될 수 있습니다. 안전한 쓰레기통은 거부합니다
위치 파일 인수 및 경로 유사 토큰이므로 들어오는 스트림에서만 작동할 수 있습니다.
셸 연결 및 리디렉션은 허용 목록 모드에서 자동으로 허용되지 않습니다.

모든 최상위 세그먼트가 허용 목록을 충족하는 경우 셸 체이닝(`&&`, `||`, `;`)이 허용됩니다.
(금고함이나 스킬 자동 허용 포함) 허용 목록 모드에서는 리디렉션이 지원되지 않습니다.
내부를 포함하여 허용 목록 구문 분석 중에 명령 대체(`$()` / 백틱)가 거부됩니다.
큰따옴표; 리터럴 `$()` 텍스트가 필요한 경우 작은따옴표를 사용하세요.

기본 안전 저장소: `jq`, `grep`, `cut`, `sort`, `uniq`, `head`, `tail`, `tr`, `wc`.

## 컨트롤 UI 편집

**제어 UI → 노드 → 실행 승인** 카드를 사용하여 에이전트별로 기본값을 편집합니다.
재정의 및 허용 목록. 범위(기본값 또는 에이전트)를 선택하고, 정책을 조정하고,
허용 목록 패턴을 추가/제거한 다음 **저장**하세요. UI에 **마지막으로 사용된** 메타데이터가 표시됩니다.
패턴별로 목록을 깔끔하게 유지할 수 있습니다.

대상 선택기는 **게이트웨이**(로컬 승인) 또는 **노드**를 선택합니다. 노드
`system.execApprovals.get/set`(macOS 앱 또는 헤드리스 노드 호스트)를 광고해야 합니다.
노드가 아직 exec 승인을 알리지 않으면 로컬을 편집하십시오.
`~/.openclaw/exec-approvals.json` 직접적으로.

CLI: `openclaw approvals`는 게이트웨이 또는 노드 편집을 지원합니다([승인 CLI](/cli/approvals) 참조).

## 승인 흐름

프롬프트가 필요할 때 게이트웨이는 `exec.approval.requested`를 운영자 클라이언트에게 브로드캐스트합니다.
Control UI 및 macOS 앱은 `exec.approval.resolve`를 통해 이를 해결한 다음 게이트웨이가
노드 호스트에 대한 요청이 승인되었습니다.

승인이 필요한 경우 실행 도구는 승인 ID와 함께 즉시 반환됩니다. 해당 ID를 사용하여
이후 시스템 이벤트(`Exec finished` / `Exec denied`)를 연관시킵니다. 만약 그 이전에 결정이 나오지 않는다면
시간 초과된 경우 요청은 승인 시간 초과로 처리되고 거부 사유로 표시됩니다.

확인 대화 상자에는 다음이 포함됩니다.

- 명령 + 인수
- cwd
- 에이전트 ID
- 해결된 실행 파일 경로
- 호스트 + 정책 메타데이터

작업:

- **한 번 허용** → 지금 실행
- **항상 허용** → 허용 목록에 추가 + 실행
- **거부** → 차단

## 채팅채널로 승인 전달

실행 승인 메시지를 모든 채팅 채널(플러그인 채널 포함)에 전달하고 승인할 수 있습니다.
`/approve`로 처리하세요. 이는 일반적인 아웃바운드 전달 파이프라인을 사용합니다.

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

채팅으로 답장하기:

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

- Unix 소켓 모드 `0600`, 토큰은 `exec-approvals.json`에 저장됩니다.
- 동일한 UID 피어 확인.
- 챌린지/응답(nonce + HMAC 토큰 + 요청 해시) + 짧은 TTL.

## 시스템 이벤트

Exec 수명주기는 시스템 메시지로 표시됩니다.

- `Exec running` (명령이 실행 알림 임계값을 초과하는 경우에만)
- `Exec finished`
- `Exec denied`

이는 노드가 이벤트를 보고한 후 에이전트 세션에 게시됩니다.
게이트웨이-호스트 실행 승인은 명령이 완료될 때(선택적으로 임계값보다 오래 실행될 때) 동일한 수명 주기 이벤트를 내보냅니다.
승인 관리 실행자는 쉬운 상관관계를 위해 이러한 메시지에서 승인 ID를 `runId`로 재사용합니다.

## 시사점

- **전체**는 강력합니다. 가능하다면 허용 목록을 선호하세요.
- **질문**을 통해 계속해서 빠른 승인을 받을 수 있습니다.
- 에이전트별 허용 목록은 한 에이전트의 승인이 다른 에이전트로 유출되는 것을 방지합니다.
- 승인은 **승인된 발신자**의 호스트 실행 요청에만 적용됩니다. 승인되지 않은 발신자는 `/exec`를 발행할 수 없습니다.
- `/exec security=full`는 승인된 운영자를 위한 세션 수준 편의이며 설계상 승인을 건너뜁니다.
  호스트 실행을 하드 차단하려면 승인 보안을 `deny`로 설정하거나 도구 정책을 통해 `exec` 도구를 거부하세요.

관련 항목:

- [실행 도구](/tools/exec)
- [승격 모드](/tools/elevated)
- [스킬](/tools/skills)
