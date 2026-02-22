---
summary: "게이트웨이, 채널, 자동화, 노드, 브라우저에 대한 심층 문제 해결 런북"
read_when:
  - 문제 해결 허브에서 깊은 진단을 위해 여기에 안내
  - 정확한 명령어가 포함된 안정적인 증상 기반 런북 섹션 필요
title: "문제 해결"
---

# 게이트웨이 문제 해결

이 페이지는 심층적인 런북입니다.
빠른 조치를 원하시면 [/help/troubleshooting](/ko-KR/help/troubleshooting)에서 시작하세요.

## 명령어 순서

이 순서대로 실행하세요:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

예상되는 정상 신호:

- `openclaw gateway status`가 `Runtime: running`과 `RPC probe: ok`를 표시합니다.
- `openclaw doctor`가 차단되는 설정/서비스 문제를 보고하지 않습니다.
- `openclaw channels status --probe`가 연결/준비된 채널을 표시합니다.

## 응답 없음

채널이 활성화되어 있는데도 아무 응답이 없을 경우, 연결을 재설정하기 전에 라우팅과 정책을 점검하세요.

```bash
openclaw status
openclaw channels status --probe
openclaw pairing list <channel>
openclaw config get channels
openclaw logs --follow
```

확인할 사항:

- 다이렉트 메시지 발신자에 대한 페어링 상태 대기.
- 그룹 멘션 필요 (`requireMention`, `mentionPatterns`).
- 채널/그룹 허용 목록 일치 오류.

일반적인 서명:

- `drop guild message (mention required` → 멘션 없이는 그룹 메시지 무시.
- `pairing request` → 발신자는 승인 필요.
- `blocked` / `allowlist` → 발신자/채널이 정책에 의해 필터링됨.

관련 항목:

- [/channels/troubleshooting](/ko-KR/channels/troubleshooting)
- [/channels/pairing](/ko-KR/channels/pairing)
- [/channels/groups](/ko-KR/channels/groups)

## 대시보드 컨트롤 UI 연결

대시보드/컨트롤 UI가 연결되지 않을 경우, URL, 인증 모드, 안전한 컨텍스트 가정을 확인하세요.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --json
```

확인할 사항:

- 올바른 프로브 URL과 대시보드 URL.
- 클라이언트와 게이트웨이 간의 인증 모드/토큰 불일치.
- 장치 ID가 필요한 HTTP 사용.

일반적인 서명:

- `device identity required` → 보안 컨텍스트 없거나 장치 인증 없음.
- `unauthorized` / 재연결 루프 → 토큰/비밀번호 불일치.
- `gateway connect failed:` → 잘못된 호스트/포트/url 대상.

관련 항목:

- [/web/control-ui](/ko-KR/web/control-ui)
- [/gateway/authentication](/ko-KR/gateway/authentication)
- [/gateway/remote](/ko-KR/gateway/remote)

## 게이트웨이 서비스가 작동하지 않음

서비스가 설치되어 있지만 프로세스가 지속되지 않을 때 사용하세요.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --deep
```

확인할 사항:

- `Runtime: stopped`와 종료 힌트.
- 서비스 설정 불일치 (`Config (cli)` vs `Config (service)`).
- 포트/리스너 충돌.

일반적인 서명:

- `Gateway start blocked: set gateway.mode=local` → 로컬 게이트웨이 모드가 활성화되지 않았습니다. 수정: 설정에서 `gateway.mode="local"`로 설정하세요 (또는 `openclaw configure` 실행). Podman을 사용하여 `openclaw` 사용자로 OpenClaw를 실행 중인 경우, 설정은 `~openclaw/.openclaw/openclaw.json`에 있습니다.
- `refusing to bind gateway ... without auth` → 인증 없이 로컬 루프백 이외의 바인딩 설정.
- `another gateway instance is already listening` / `EADDRINUSE` → 포트 충돌.

관련 항목:

- [/gateway/background-process](/ko-KR/gateway/background-process)
- [/gateway/configuration](/ko-KR/gateway/configuration)
- [/gateway/doctor](/ko-KR/gateway/doctor)

## 채널 연결 메시지가 흐르지 않음

채널 상태가 연결되었지만 메시지 흐름이 없을 경우, 정책, 권한, 채널별 전달 규칙에 집중하세요.

```bash
openclaw channels status --probe
openclaw pairing list <channel>
openclaw status --deep
openclaw logs --follow
openclaw config get channels
```

확인할 사항:

- 다이렉트 메시지 정책 (`pairing`, `allowlist`, `open`, `disabled`).
- 그룹 허용 목록과 멘션 요구 사항.
- 채널 API 권한/스코프 누락.

일반적인 서명:

- `mention required` → 그룹 멘션 정책으로 인해 메시지 무시됨.
- `pairing` / 승인 대기 추적 → 발신자가 승인되지 않음.
- `missing_scope`, `not_in_channel`, `Forbidden`, `401/403` → 채널 인증/권한 문제.

관련 항목:

- [/channels/troubleshooting](/ko-KR/channels/troubleshooting)
- [/channels/whatsapp](/ko-KR/channels/whatsapp)
- [/channels/telegram](/ko-KR/channels/telegram)
- [/channels/discord](/ko-KR/channels/discord)

## 크론 및 하트비트 전달

크론 또는 하트비트가 실행되지 않았거나 전달되지 않았을 경우, 먼저 스케줄러 상태를 확인한 다음 전달 대상을 확인하세요.

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw system heartbeat last
openclaw logs --follow
```

확인할 사항:

- 크론이 활성화되고 다음 웨이크가 존재함.
- 작업 실행 이력 상태 (`ok`, `skipped`, `error`).
- 하트비트 건너뛴 이유 (`quiet-hours`, `requests-in-flight`, `alerts-disabled`).

일반적인 서명:

- `cron: scheduler disabled; jobs will not run automatically` → 크론 비활성화.
- `cron: timer tick failed` → 스케줄러 틱 실패; 파일/로그/런타임 오류 확인.
- `heartbeat skipped`와 `reason=quiet-hours` → 활성 시간대 외부.
- `heartbeat: unknown accountId` → 하트비트 전달 대상에 대한 잘못된 계정 ID.

관련 항목:

- [/automation/troubleshooting](/ko-KR/automation/troubleshooting)
- [/automation/cron-jobs](/ko-KR/automation/cron-jobs)
- [/gateway/heartbeat](/ko-KR/gateway/heartbeat)

## 노드 페어링 도구 실패

노드가 페어링되었지만 도구가 실패할 경우, 포그라운드, 권한, 승인 상태를 분리하세요.

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
openclaw status
```

확인할 사항:

- 노드가 기대한 기능과 함께 온라인 상태임.
- OS 권한 부여 상태 (카메라/마이크/위치/화면).
- 실행 승인 및 허용 목록 상태.

일반적인 서명:

- `NODE_BACKGROUND_UNAVAILABLE` → 노드 앱은 포그라운드에 있어야 합니다.
- `*_PERMISSION_REQUIRED` / `LOCATION_PERMISSION_REQUIRED` → OS 권한 누락.
- `SYSTEM_RUN_DENIED: approval required` → 실행 승인 대기 중.
- `SYSTEM_RUN_DENIED: allowlist miss` → 허용 목록에 의해 명령 차단.

관련 항목:

- [/nodes/troubleshooting](/ko-KR/nodes/troubleshooting)
- [/nodes/index](/ko-KR/nodes/index)
- [/tools/exec-approvals](/ko-KR/tools/exec-approvals)

## 브라우저 도구 실패

게이트웨이 자체가 정상임에도 불구하고 브라우저 도구 작업이 실패할 때 사용하세요.

```bash
openclaw browser status
openclaw browser start --browser-profile openclaw
openclaw browser profiles
openclaw logs --follow
openclaw doctor
```

확인할 사항:

- 올바른 브라우저 실행 파일 경로.
- CDP 프로파일 도달 가능성.
- `profile="chrome"`에 대한 확장 릴레이 탭 첨부.

일반적인 서명:

- `Failed to start Chrome CDP on port` → 브라우저 프로세스 실행 실패.
- `browser.executablePath not found` → 구성 경로가 잘못됨.
- `Chrome extension relay is running, but no tab is connected` → 확장 릴레이가 첨부되지 않음.
- `Browser attachOnly is enabled ... not reachable` → attach-only 프로파일에 도달 가능한 대상 없음.

관련 항목:

- [/tools/browser-linux-troubleshooting](/ko-KR/tools/browser-linux-troubleshooting)
- [/tools/chrome-extension](/ko-KR/tools/chrome-extension)
- [/tools/browser](/ko-KR/tools/browser)

## 업그레이드 후 무언가 갑자기 중단되었음

대부분의 업그레이드 이후 문제는 설정 드리프트나 더 엄격해진 기본값으로 인해 발생합니다.

### 1) 인증 및 URL 오버라이드 동작 변경

```bash
openclaw gateway status
openclaw config get gateway.mode
openclaw config get gateway.remote.url
openclaw config get gateway.auth.mode
```

확인할 사항:

- `gateway.mode=remote`인 경우, CLI 호출이 원격을 대상일 수 있지만 로컬 서비스는 정상일 수 있습니다.
- 명시적인 `--url` 호출은 저장된 자격 증명으로 대체되지 않습니다.

일반적인 서명:

- `gateway connect failed:` → 잘못된 URL 대상.
- `unauthorized` → 엔드포인트에 접근 가능하나 잘못된 인증.

### 2) 바인드 및 인증 가드레일이 더 엄격해짐

```bash
openclaw config get gateway.bind
openclaw config get gateway.auth.token
openclaw gateway status
openclaw logs --follow
```

확인할 사항:

- 로컬 루프백 이외의 바인드 (`lan`, `tailnet`, `custom`)에는 인증이 설정되어야 합니다.
- 이전 키인 `gateway.token`은 `gateway.auth.token`을 대체하지 않습니다.

일반적인 서명:

- `refusing to bind gateway ... without auth` → 바인딩+인증 불일치.
- `RPC probe: failed`가 런타임 상태에서 실행 중인 경우 → 게이트웨이가 활성화되었지만 현재 인증/url로 접근 불가.

### 3) 페어링 및 장치 ID 상태 변경

```bash
openclaw devices list
openclaw pairing list <channel>
openclaw logs --follow
openclaw doctor
```

확인할 사항:

- 대시보드/노드에 대한 대기 중인 장치 승인.
- 정책 또는 ID 변경 후 대기 중인 다이렉트 메시지 페어링 승인.

일반적인 서명:

- `device identity required` → 장치 인증이 충족되지 않음.
- `pairing required` → 발신자/장치가 승인되어야 함.

서비스 설정과 런타임이 확인 후에도 계속 불일치하면 동일한 프로파일/상태 디렉토리에서 서비스 메타데이터를 재설치하십시오:

```bash
openclaw gateway install --force
openclaw gateway restart
```

관련 항목:

- [/gateway/pairing](/ko-KR/gateway/pairing)
- [/gateway/authentication](/ko-KR/gateway/authentication)
- [/gateway/background-process](/ko-KR/gateway/background-process)