---
summary: "Gateway, 채널, 자동화, 노드, 브라우저에 대한 심층 문제 해결 런북"
read_when:
  - 문제 해결 허브에서 더 깊은 진단을 위해 이곳으로 안내된 경우
  - 정확한 명령어가 포함된 안정적인 증상 기반 런북 섹션이 필요한 경우
title: "문제 해결"
---

# Gateway 문제 해결

이 페이지는 심층 런북입니다.
빠른 트리아지 흐름을 먼저 원하시면 [/help/troubleshooting](/help/troubleshooting)에서 시작하십시오.

## 명령어 단계표

다음 명령을 이 순서대로 먼저 실행하십시오:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

예상되는 정상 신호:

- `openclaw gateway status` 에서 `Runtime: running` 및 `RPC probe: ok` 가 표시됩니다.
- `openclaw doctor` 에서 차단되는 구성 또는 서비스 문제가 없다고 보고됩니다.
- `openclaw channels status --probe` 에서 연결됨/준비됨 상태의 채널이 표시됩니다.

## 응답 없음

채널은 올라와 있지만 아무 응답이 없으면, 무엇이든 재연결하기 전에 라우팅과 정책을 확인하십시오.

```bash
openclaw status
openclaw channels status --probe
openclaw pairing list <channel>
openclaw config get channels
openclaw logs --follow
```

Look for:

- Pairing pending for DM senders.
- 그룹 멘션 게이팅 (`requireMention`, `mentionPatterns`).
- 채널/그룹 허용 목록 불일치.

일반적인 시그니처:

- `drop guild message (mention required` → 멘션될 때까지 그룹 메시지가 무시됨.
- `pairing request` → 발신자 승인 필요.
- `blocked` / `allowlist` → 발신자/채널이 정책에 의해 필터링됨.

관련 항목:

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/pairing](/channels/pairing)
- [/channels/groups](/channels/groups)

## 대시보드 제어 UI 연결성

대시보드/제어 UI 가 연결되지 않을 때는 URL, 인증 모드, 보안 컨텍스트 가정을 검증하십시오.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --json
```

Look for:

- 올바른 프로브 URL 과 대시보드 URL.
- 클라이언트와 Gateway(게이트웨이) 간 인증 모드/토큰 불일치.
- 디바이스 식별이 필요한 상황에서의 HTTP 사용.

일반적인 시그니처:

- `device identity required` → 비보안 컨텍스트 또는 디바이스 인증 누락.
- `unauthorized` / 재연결 루프 → 토큰/비밀번호 불일치.
- `gateway connect failed:` → 잘못된 호스트/포트/URL 대상.

관련 항목:

- [/web/control-ui](/web/control-ui)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/remote](/gateway/remote)

## Gateway 서비스가 실행되지 않음

서비스는 설치되어 있으나 프로세스가 유지되지 않을 때 사용하십시오.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --deep
```

Look for:

- 종료 힌트가 포함된 `Runtime: stopped`.
- 서비스 구성 불일치 (`Config (cli)` vs `Config (service)`).
- 포트/리스너 충돌.

일반적인 시그니처:

- `Gateway start blocked: set gateway.mode=local` → 로컬 Gateway 모드가 활성화되지 않음.
- `refusing to bind gateway ... without auth` → 토큰/비밀번호 없이 non-loopback 바인드.
- `another gateway instance is already listening` / `EADDRINUSE` → 포트 충돌.

관련 항목:

- [/gateway/background-process](/gateway/background-process)
- [/gateway/configuration](/gateway/configuration)
- [/gateway/doctor](/gateway/doctor)

## 채널 연결됨, 메시지 흐름 없음

채널 상태는 연결됨이지만 메시지 흐름이 중단된 경우, 정책, 권한, 채널별 전달 규칙에 집중하십시오.

```bash
openclaw channels status --probe
openclaw pairing list <channel>
openclaw status --deep
openclaw logs --follow
openclaw config get channels
```

Look for:

- 다이렉트 메시지 정책 (`pairing`, `allowlist`, `open`, `disabled`).
- 그룹 허용 목록 및 멘션 요구 사항.
- 누락된 채널 API 권한/스코프.

일반적인 시그니처:

- `mention required` → 그룹 멘션 정책으로 인해 메시지가 무시됨.
- `pairing` / 승인 대기 트레이스 → 발신자가 승인되지 않음.
- `missing_scope`, `not_in_channel`, `Forbidden`, `401/403` → 채널 인증/권한 문제.

관련 항목:

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/whatsapp](/channels/whatsapp)
- [/channels/telegram](/channels/telegram)
- [/channels/discord](/channels/discord)

## Cron 및 하트비트 전달

Cron 또는 하트비트가 실행되지 않았거나 전달되지 않았다면, 먼저 스케줄러 상태를 확인한 다음 전달 대상을 확인하십시오.

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw system heartbeat last
openclaw logs --follow
```

Look for:

- Cron 활성화 여부 및 다음 깨우기 시점 존재 여부.
- 작업 실행 이력 상태 (`ok`, `skipped`, `error`).
- 하트비트 스킵 사유 (`quiet-hours`, `requests-in-flight`, `alerts-disabled`).

일반적인 시그니처:

- `cron: scheduler disabled; jobs will not run automatically` → Cron 비활성화됨.
- `cron: timer tick failed` → 스케줄러 틱 실패; 파일/로그/런타임 오류를 확인하십시오.
- `heartbeat skipped` 와 `reason=quiet-hours` → 활성 시간대 범위를 벗어남.
- `heartbeat: unknown accountId` → 하트비트 전달 대상에 대한 잘못된 계정 ID.

관련 항목:

- [/automation/troubleshooting](/automation/troubleshooting)
- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)

## 노드 페어링됨, 도구 실패

노드는 페어링되어 있으나 도구가 실패하는 경우, 포그라운드, 권한, 승인 상태를 분리하여 점검하십시오.

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
openclaw status
```

Look for:

- 예상되는 기능을 갖춘 노드가 온라인인지 여부.
- 카메라/마이크/위치/화면에 대한 OS 권한 부여.
- exec 승인 및 허용 목록 상태.

일반적인 시그니처:

- `NODE_BACKGROUND_UNAVAILABLE` → 노드 앱은 포그라운드에 있어야 함.
- `*_PERMISSION_REQUIRED` / `LOCATION_PERMISSION_REQUIRED` → OS 권한 누락.
- `SYSTEM_RUN_DENIED: approval required` → exec 승인 대기 중.
- `SYSTEM_RUN_DENIED: allowlist miss` → 허용 목록에 의해 명령이 차단됨.

관련 항목:

- [/nodes/troubleshooting](/nodes/troubleshooting)
- [/nodes/index](/nodes/index)
- [/tools/exec-approvals](/tools/exec-approvals)

## 브라우저 도구 실패

Gateway 자체는 정상이나 브라우저 도구 동작이 실패할 때 사용하십시오.

```bash
openclaw browser status
openclaw browser start --browser-profile openclaw
openclaw browser profiles
openclaw logs --follow
openclaw doctor
```

Look for:

- 유효한 브라우저 실행 파일 경로.
- CDP 프로파일 접근 가능 여부.
- `profile="chrome"` 에 대한 확장 릴레이 탭 연결 상태.

일반적인 시그니처:

- `Failed to start Chrome CDP on port` → 브라우저 프로세스 시작 실패.
- `browser.executablePath not found` → 구성된 경로가 유효하지 않음.
- `Chrome extension relay is running, but no tab is connected` → 확장 릴레이가 연결되지 않음.
- `Browser attachOnly is enabled ... not reachable` → attach-only 프로파일에 접근 가능한 대상이 없음.

관련 항목:

- [/tools/browser-linux-troubleshooting](/tools/browser-linux-troubleshooting)
- [/tools/chrome-extension](/tools/chrome-extension)
- [/tools/browser](/tools/browser)

## 업그레이드 이후 갑자기 문제가 발생한 경우

업그레이드 이후의 대부분의 장애는 구성 드리프트 또는 더 엄격해진 기본값이 이제 적용되기 때문입니다.

### 1. 인증 및 URL 오버라이드 동작 변경

```bash
openclaw gateway status
openclaw config get gateway.mode
openclaw config get gateway.remote.url
openclaw config get gateway.auth.mode
```

확인할 사항:

- `gateway.mode=remote` 인 경우, 로컬 서비스는 정상이어도 CLI 호출이 원격을 대상으로 할 수 있습니다.
- 명시적인 `--url` 호출은 저장된 자격 증명으로 폴백되지 않습니다.

일반적인 시그니처:

- `gateway connect failed:` → 잘못된 URL 대상.
- `unauthorized` → 엔드포인트는 도달 가능하지만 인증이 잘못됨.

### 2. 바인드 및 인증 가드레일이 더 엄격해짐

```bash
openclaw config get gateway.bind
openclaw config get gateway.auth.token
openclaw gateway status
openclaw logs --follow
```

확인할 사항:

- non-loopback 바인드 (`lan`, `tailnet`, `custom`) 에는 인증 구성이 필요합니다.
- `gateway.token` 과 같은 이전 키는 `gateway.auth.token` 를 대체하지 않습니다.

일반적인 시그니처:

- `refusing to bind gateway ... without auth` → 바인드+인증 불일치.
- 런타임이 실행 중인 상태에서의 `RPC probe: failed` → Gateway 는 살아 있으나 현재 인증/URL 로는 접근 불가.

### 3. 페어링 및 디바이스 식별 상태 변경

```bash
openclaw devices list
openclaw pairing list <channel>
openclaw logs --follow
openclaw doctor
```

확인할 사항:

- 대시보드/노드에 대한 디바이스 승인 대기 상태.
- 정책 또는 식별 변경 이후의 다이렉트 메시지 페어링 승인 대기 상태.

일반적인 시그니처:

- `device identity required` → 디바이스 인증이 충족되지 않음.
- `pairing required` → 발신자/디바이스 승인 필요.

점검 후에도 서비스 구성과 런타임이 계속 불일치한다면, 동일한 프로파일/상태 디렉토리에서 서비스 메타데이터를 재설치하십시오:

```bash
openclaw gateway install --force
openclaw gateway restart
```

관련 항목:

- [/gateway/pairing](/gateway/pairing)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/background-process](/gateway/background-process)
