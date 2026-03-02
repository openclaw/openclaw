---
summary: "게이트웨이, 채널, 자동화, 노드 및 브라우저에 대한 깊은 문제 해결 실행책"
read_when:
  - 문제 해결 허브가 더 깊은 진단을 위해 당신을 여기로 지시했을 때
  - 정확한 증상 기반 실행책 섹션과 정확한 명령이 필요할 때
title: "문제 해결"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: gateway/troubleshooting.md
  workflow: 15
---

# 게이트웨이 문제 해결

이 페이지는 깊은 실행책입니다.
빠른 분류 흐름을 원하면 먼저 [/help/troubleshooting](/help/troubleshooting)을 시작합니다.

## 명령 래더

순서대로 실행하세요:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

건강한 신호:

- `openclaw gateway status`는 `Runtime: running` 및 `RPC probe: ok`를 표시합니다.
- `openclaw doctor`는 차단 설정/서비스 문제를 보고하지 않습니다.
- `openclaw channels status --probe`는 연결됨/준비 상태 채널을 표시합니다.

## 회신 없음

채널이 활성화되어 있지만 아무것도 응답하지 않으면 재연결하기 전에 라우팅 및 정책에 집중합니다.

```bash
openclaw status
openclaw channels status --probe
openclaw pairing list --channel <channel> [--account <id>]
openclaw config get channels
openclaw logs --follow
```

확인:

- DM 발신자를 위한 페어링 보류 중.
- 그룹 언급 게이팅(`requireMention`, `mentionPatterns`).
- 채널/그룹 허용 목록 불일치.

일반적인 서명:

- `drop guild message (mention required` → 언급까지 그룹 메시지 무시됨.
- `pairing request` → 발신자는 승인 필요.
- `blocked` / `allowlist` → 발신자/채널이 정책으로 필터링됨.

관련:

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/pairing](/channels/pairing)
- [/channels/groups](/channels/groups)

## 대시보드 제어 UI 연결성

대시보드/제어 UI가 연결되지 않으면 URL, 인증 모드 및 보안 컨텍스트 가정을 확인합니다.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --json
```

일반적인 서명:

- `device identity required` → 비보안 컨텍스트 또는 누락된 디바이스 인증.
- `device nonce required` / `device nonce mismatch` → 클라이언트가 챌린지 기반 디바이스 인증 흐름을 완료하지 않고 있습니다(`connect.challenge` + `device.nonce`).
- `device signature invalid` / `device signature expired` → 클라이언트가 현재 핸드셰이크에 대해 잘못된 페이로드(또는 오래된 타임스탬프)에 서명했습니다.
- `unauthorized` / 재연결 루프 → 토큰/암호 불일치.
- `gateway connect failed:` → 잘못된 호스트/포트/URL 대상.

## 게이트웨이 서비스가 실행되지 않음

서비스가 설치되지만 프로세스가 활성 상태를 유지하지 않을 때 사용합니다.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --deep
```

일반적인 서명:

- `Gateway start blocked: set gateway.mode=local` → 로컬 게이트웨이 모드가 활성화되지 않음. 수정: 설정에서 `gateway.mode="local"`을 설정합니다(또는 `openclaw configure` 실행). Podman을 통해 OpenClaw를 실행 중이고 전용 `openclaw` 사용자를 사용하는 경우 설정은 `~openclaw/.openclaw/openclaw.json`에 있습니다.
- `refusing to bind gateway ... without auth` → 루프백 외 바인드에 토큰/암호 없음.
- `another gateway instance is already listening` / `EADDRINUSE` → 포트 충돌.

관련:

- [/gateway/background-process](/gateway/background-process)
- [/gateway/configuration](/gateway/configuration)
- [/gateway/doctor](/gateway/doctor)

## 채널 연결 메시지가 흐르지 않음

채널 상태가 연결되어 있지만 메시지 흐름이 죽으면 정책, 권한 및 채널별 배달 규칙에 집중합니다.

```bash
openclaw channels status --probe
openclaw pairing list --channel <channel> [--account <id>]
openclaw status --deep
openclaw logs --follow
openclaw config get channels
```

## Cron 및 하트비트 배달

cron 또는 하트비트가 실행되지 않았거나 배달되지 않은 경우 먼저 스케줄러 상태를 확인한 다음 배달 대상을 확인합니다.

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw system heartbeat last
openclaw logs --follow
```

관련:

- [/automation/troubleshooting](/automation/troubleshooting)
- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)

## 노드 페어링 도구 실패

노드가 페어링되었지만 도구가 실패하면 포그라운드, 권한 및 승인 상태를 격리합니다.

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
openclaw status
```

일반적인 서명:

- `NODE_BACKGROUND_UNAVAILABLE` → 노드 앱이 포그라운드에 있어야 함.
- `*_PERMISSION_REQUIRED` / `LOCATION_PERMISSION_REQUIRED` → OS 권한 누락.
- `SYSTEM_RUN_DENIED: approval required` → exec 승인 보류 중.
- `SYSTEM_RUN_DENIED: allowlist miss` → 명령이 허용 목록으로 차단됨.

관련:

- [/nodes/troubleshooting](/nodes/troubleshooting)
- [/nodes/index](/nodes/index)
- [/tools/exec-approvals](/tools/exec-approvals)

## 브라우저 도구 실패

게이트웨이 자체가 건강할 때 브라우저 도구 작업이 실패하면 사용합니다.

```bash
openclaw browser status
openclaw browser start --browser-profile openclaw
openclaw browser profiles
openclaw logs --follow
openclaw doctor
```

일반적인 서명:

- `Failed to start Chrome CDP on port` → 브라우저 프로세스가 시작되지 못함.
- `browser.executablePath not found` → 구성된 경로가 유효하지 않음.
- `Chrome extension relay is running, but no tab is connected` → 확장 프로그램 릴레이가 연결되지 않음.
- `Browser attachOnly is enabled ... not reachable` → attach만 프로필에 도달할 수 있는 대상이 없음.

관련:

- [/tools/browser-linux-troubleshooting](/tools/browser-linux-troubleshooting)
- [/tools/chrome-extension](/tools/chrome-extension)
- [/tools/browser](/tools/browser)

## 업그레이드 후 문제 해결

대부분의 업그레이드 후 잠금은 설정 드리프트 또는 더 엄격한 기본값이 적용되고 있습니다.

### 1) 인증 및 URL 재정의 동작 변경

```bash
openclaw gateway status
openclaw config get gateway.mode
openclaw config get gateway.remote.url
openclaw config get gateway.auth.mode
```

확인:

- `gateway.mode=remote`인 경우 CLI 호출이 로컬 서비스가 정상이어도 원격을 대상으로 할 수 있습니다.
- 명시적 `--url` 호출이 저장된 자격 증명으로 폴백하지 않습니다.

### 2) 바인드 및 인증 보호장치가 더 엄격함

```bash
openclaw config get gateway.bind
openclaw config get gateway.auth.token
openclaw gateway status
openclaw logs --follow
```

확인:

- 루프백이 아닌 바인드(`lan`, `tailnet`, `custom`)에는 설정된 인증이 필요합니다.
- `gateway.token` 같은 오래된 키가 `gateway.auth.token`을 대체하지 않습니다.

일반적인 서명:

- `refusing to bind gateway ... without auth` → 바인드+인증 불일치.
- `RPC probe: failed` 런타임은 실행되지만 → 게이트웨이가 활성 있지만 현재 인증/URL과 함께 접근할 수 없습니다.

### 3) 페어링 및 디바이스 신원 상태 변경

```bash
openclaw devices list
openclaw pairing list --channel <channel> [--account <id>]
openclaw logs --follow
openclaw doctor
```

확인:

- 대시보드/노드에 대한 보류 중 디바이스 승인.
- 정책 또는 신원 변경 후 보류 중 DM 페어링 승인.

서비스 설정과 런타임이 검사 후에도 여전히 불일치하면 동일한 프로파일/상태 디렉토리에서 서비스 메타데이터를 다시 설치합니다:

```bash
openclaw gateway install --force
openclaw gateway restart
```

관련:

- [/gateway/pairing](/gateway/pairing)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/background-process](/gateway/background-process)
