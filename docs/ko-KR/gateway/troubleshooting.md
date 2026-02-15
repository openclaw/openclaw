---
summary: "Deep troubleshooting runbook for gateway, channels, automation, nodes, and browser"
read_when:
  - The troubleshooting hub pointed you here for deeper diagnosis
  - You need stable symptom based runbook sections with exact commands
title: "Troubleshooting"
x-i18n:
  source_hash: 163c4af6be740e23aedb37808327b3ecc078c2906d98ba9cb3751e95a8530a17
---

# 게이트웨이 문제 해결

이 페이지는 Deep Runbook입니다.
빠른 분류 흐름을 먼저 원한다면 [/help/troubleshooting](/help/troubleshooting)에서 시작하세요.

## 명령 사다리

먼저 다음 순서대로 실행하세요.

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

예상되는 정상 신호:

- `openclaw gateway status`는 `Runtime: running` 및 `RPC probe: ok`를 표시합니다.
- `openclaw doctor`는 차단 구성/서비스 문제를 보고하지 않습니다.
- `openclaw channels status --probe`는 연결/준비된 채널을 보여줍니다.

## 답장이 없습니다

채널이 작동 중이지만 응답이 없으면 다시 연결하기 전에 라우팅과 정책을 확인하세요.

```bash
openclaw status
openclaw channels status --probe
openclaw pairing list <channel>
openclaw config get channels
openclaw logs --follow
```

다음을 찾으세요:

- DM 발신자에 대한 페어링 보류 중입니다.
- 그룹 멘션 게이팅(`requireMention`, `mentionPatterns`).
- 채널/그룹 허용 목록이 일치하지 않습니다.

일반적인 서명:

- `drop guild message (mention required` → 언급 전까지 그룹 메시지는 무시됩니다.
- `pairing request` → 보낸 사람의 승인이 필요합니다.
- `blocked` / `allowlist` → 보낸 사람/채널이 정책에 따라 필터링되었습니다.

관련 항목:

- [/채널/문제 해결](/channels/troubleshooting)
- [/채널/페어링](/channels/pairing)
- [/채널/그룹](/channels/groups)

## 대시보드 제어 UI 연결

대시보드/컨트롤 UI가 연결되지 않는 경우 URL, 인증 모드 및 보안 컨텍스트 가정을 검증하세요.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --json
```

다음을 찾으세요:

- 프로브 URL과 대시보드 URL을 수정하세요.
- 클라이언트와 게이트웨이 간의 인증 모드/토큰이 일치하지 않습니다.
- 장치 ID가 필요한 HTTP 사용.

일반적인 서명:

- `device identity required` → 비보안 컨텍스트 또는 장치 인증 누락.
- `unauthorized` / 루프 재연결 → 토큰/비밀번호 불일치.
- `gateway connect failed:` → 호스트/포트/URL 대상이 잘못되었습니다.

관련 항목:

- [/web/control-ui](/web/control-ui)
- [/gateway/인증](/gateway/authentication)
- [/게이트웨이/원격](/gateway/remote)

## 게이트웨이 서비스가 실행되고 있지 않습니다

서비스가 설치되었지만 프로세스가 유지되지 않는 경우에 사용하십시오.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --deep
```

다음을 찾으세요:

- 종료 힌트가 있는 `Runtime: stopped`.
- 서비스 구성 불일치(`Config (cli)` 대 `Config (service)`).
- 포트/리스너 충돌.

일반적인 서명:

- `Gateway start blocked: set gateway.mode=local` → 로컬 게이트웨이 모드가 활성화되지 않습니다.
- `refusing to bind gateway ... without auth` → 토큰/비밀번호 없이 비루프백 바인딩.
- `another gateway instance is already listening` / `EADDRINUSE` → 포트 충돌.

관련 항목:

- [/gateway/백그라운드 프로세스](/gateway/background-process)
- [/gateway/구성](/gateway/configuration)
- [/gateway/의사](/gateway/doctor)

## 채널에 연결된 메시지가 흐르지 않음

채널 상태가 연결되어 있지만 메시지 흐름이 중단된 경우 정책, 권한 및 채널별 전달 규칙에 중점을 둡니다.

```bash
openclaw channels status --probe
openclaw pairing list <channel>
openclaw status --deep
openclaw logs --follow
openclaw config get channels
```

다음을 찾으세요:

- DM 정책(`pairing`, `allowlist`, `open`, `disabled`).
- 그룹 허용 목록 및 언급 요구 사항.
- 채널 API 권한/범위가 누락되었습니다.

일반적인 서명:

- `mention required` → 그룹 멘션 정책에 따라 메시지가 무시됩니다.
- `pairing` / 승인 추적 보류 중 → 보낸 사람이 승인되지 않았습니다.
- `missing_scope`, `not_in_channel`, `Forbidden`, `401/403` → 채널 인증/권한 문제.

관련 항목:

- [/채널/문제 해결](/channels/troubleshooting)
- [/채널/whatsapp](/channels/whatsapp)
- [/채널/텔레그램](/channels/telegram)
- [/채널/불화](/channels/discord)

## Cron 및 하트비트 전달

cron 또는 heartbeat가 실행되지 않거나 전달되지 않은 경우 먼저 스케줄러 상태를 확인한 다음 전달 대상을 확인하세요.

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw system heartbeat last
openclaw logs --follow
```

다음을 찾으세요:

- Cron이 활성화되어 있고 다음 깨우기가 존재합니다.
- 작업 실행 내역 상태(`ok`, `skipped`, `error`).
- 하트비트 건너뛰기 이유(`quiet-hours`, `requests-in-flight`, `alerts-disabled`).

일반적인 서명:

- `cron: scheduler disabled; jobs will not run automatically` → 크론이 비활성화되었습니다.
- `cron: timer tick failed` → 스케줄러 틱이 실패했습니다. 파일/로그/런타임 오류를 확인하세요.
- `heartbeat skipped`는 `reason=quiet-hours` → 활동 시간 범위를 벗어났습니다.
- `heartbeat: unknown accountId` → 하트비트 전달 대상의 계정 ID가 잘못되었습니다.

관련 항목:

- [/자동화/문제 해결](/automation/troubleshooting)
- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)

## 노드 쌍 도구가 실패합니다.

노드가 페어링되었지만 도구가 실패하는 경우 포그라운드, 권한 및 승인 상태를 격리합니다.

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
openclaw status
```

다음을 찾으세요:

- 예상되는 기능을 갖춘 온라인 노드.
- 카메라/마이크/위치/화면에 대한 OS 권한을 부여합니다.
- 임원 승인 및 허용 목록 상태.

일반적인 서명:

- `NODE_BACKGROUND_UNAVAILABLE` → 노드 앱이 포그라운드에 있어야 합니다.
- `*_PERMISSION_REQUIRED` / `LOCATION_PERMISSION_REQUIRED` → OS 권한이 누락되었습니다.
- `SYSTEM_RUN_DENIED: approval required` → 실행 승인 보류 중입니다.
- `SYSTEM_RUN_DENIED: allowlist miss` → 명령이 허용 목록에 의해 차단되었습니다.

관련 항목:

- [/nodes/문제 해결](/nodes/troubleshooting)
- [/노드/인덱스](/nodes/index)
- [/tools/exec-승인](/tools/exec-approvals)

## 브라우저 도구가 실패합니다.

게이트웨이 자체가 정상임에도 불구하고 브라우저 도구 작업이 실패하는 경우 이 기능을 사용하세요.

```bash
openclaw browser status
openclaw browser start --browser-profile openclaw
openclaw browser profiles
openclaw logs --follow
openclaw doctor
```

다음을 찾으세요:

- 유효한 브라우저 실행 경로입니다.
- CDP 프로필 도달 가능성.
- `profile="chrome"`에 대한 확장 릴레이 탭 부착.

일반적인 서명:

- `Failed to start Chrome CDP on port` → 브라우저 프로세스 실행에 실패했습니다.
- `browser.executablePath not found` → 구성된 경로가 유효하지 않습니다.
- `Chrome extension relay is running, but no tab is connected` → 확장 릴레이가 부착되지 않았습니다.
- `Browser attachOnly is enabled ... not reachable` → 연결 전용 프로필에는 도달 가능한 대상이 없습니다.

관련 항목:

- [/tools/browser-linux-문제 해결](/tools/browser-linux-troubleshooting)
- [/tools/chrome-extension](/tools/chrome-extension)
- [/tools/browser](/tools/browser)

## 업그레이드했는데 갑자기 문제가 발생한 경우

대부분의 업그레이드 후 중단은 구성 드리프트이거나 현재 시행되고 있는 더 엄격한 기본값입니다.

### 1) 인증 및 URL 재정의 동작이 변경되었습니다.

```bash
openclaw gateway status
openclaw config get gateway.mode
openclaw config get gateway.remote.url
openclaw config get gateway.auth.mode
```

확인해야 할 사항:

- `gateway.mode=remote`인 경우 CLI 호출은 로컬 서비스가 정상인 동안 원격을 대상으로 할 수 있습니다.
- 명시적인 `--url` 호출은 저장된 자격 증명으로 대체되지 않습니다.

일반적인 서명:

- `gateway connect failed:` → 대상 URL이 잘못되었습니다.
- `unauthorized` → 엔드포인트에 도달할 수 있지만 인증이 잘못되었습니다.

### 2) 바인드 및 인증 가드레일이 더욱 엄격해졌습니다.

```bash
openclaw config get gateway.bind
openclaw config get gateway.auth.token
openclaw gateway status
openclaw logs --follow
```

확인해야 할 사항:

- 루프백이 아닌 바인드(`lan`, `tailnet`, `custom`)에는 인증 구성이 필요합니다.
- `gateway.token`와 같은 이전 키는 `gateway.auth.token`를 대체하지 않습니다.

일반적인 서명:

- `refusing to bind gateway ... without auth` → 바인딩+인증 불일치.
- `RPC probe: failed` 런타임이 실행되는 동안 → 게이트웨이는 활성화되어 있지만 현재 인증/URL로는 액세스할 수 없습니다.

### 3) 페어링 및 장치 ID 상태가 변경되었습니다.

```bash
openclaw devices list
openclaw pairing list <channel>
openclaw logs --follow
openclaw doctor
```

확인해야 할 사항:

- 대시보드/노드에 대한 장치 승인이 보류 중입니다.
- 정책 또는 신원 변경 후 DM 페어링 승인이 보류 중입니다.

일반적인 서명:

- `device identity required` → 장치 인증이 만족되지 않습니다.
- `pairing required` → 발신자/장치를 승인해야 합니다.

검사 후에도 서비스 구성과 런타임이 여전히 일치하지 않으면 동일한 프로필/상태 디렉터리에서 서비스 메타데이터를 다시 설치하세요.

```bash
openclaw gateway install --force
openclaw gateway restart
```

관련 항목:

- [/게이트웨이/페어링](/gateway/pairing)
- [/gateway/인증](/gateway/authentication)
- [/gateway/백그라운드 프로세스](/gateway/background-process)
