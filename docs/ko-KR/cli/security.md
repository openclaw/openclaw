---
summary: "CLI reference for `openclaw security` (audit and fix common security footguns)"
read_when:
  - You want to run a quick security audit on config/state
  - You want to apply safe “fix” suggestions (chmod, tighten defaults)
title: "security"
---

# `openclaw security`

Security tools (audit + optional fixes).

Related:

- Security guide: [Security](/ko-KR/gateway/security)

## Audit

```bash
openclaw security audit
openclaw security audit --deep
openclaw security audit --fix
openclaw security audit --json
```

감사는 여러 다이렉트 메시지 발신자가 메인 세션을 공유할 때 경고하며, 공유 받은 편지함에 대해 **보안 DM 모드**를 권장합니다: `session.dmScope="per-channel-peer"` (멀티 계정 채널의 경우 `per-account-channel-peer`).
이는 협력적/공유 받은 편지함 강화를 위한 것입니다. 상호 신뢰하지 않는/적대적인 운영자가 공유하는 단일 게이트웨이는 권장되지 않는 설정입니다; 별도의 게이트웨이 (또는 별도의 OS 사용자/호스트)로 신뢰 경계를 분리하세요.
또한 작은 모델 (`<=300B`)이 샌드박싱 없이 웹/브라우저 도구가 활성화된 상태로 사용될 때도 경고합니다.
웹훅 수신의 경우, `hooks.defaultSessionKey`가 설정되지 않았을 때, 요청 `sessionKey` 오버라이드가 활성화되었을 때, 오버라이드가 `hooks.allowedSessionKeyPrefixes` 없이 활성화되었을 때 경고합니다.
또한 샌드박스 모드가 꺼져 있는 동안 샌드박스 Docker 설정이 구성되었을 때, `gateway.nodes.denyCommands`가 효과 없는 패턴형/알 수 없는 항목을 사용할 때, 전역 `tools.profile="minimal"`이 에이전트 도구 프로필로 오버라이드될 때, 설치된 확장 플러그인 도구가 관대한 도구 정책 하에서 도달 가능할 때 경고합니다.
또한 샌드박스 브라우저가 `sandbox.browser.cdpSourceRange` 없이 Docker `bridge` 네트워크를 사용할 때 경고합니다.
또한 기존 샌드박스 브라우저 Docker 컨테이너에 누락/오래된 해시 레이블이 있을 때 (예: `openclaw.browserConfigEpoch`가 누락된 마이그레이션 전 컨테이너) 경고하며 `openclaw sandbox recreate --browser --all`을 권장합니다.
npm 기반 플러그인/훅 설치 레코드가 고정되지 않거나 무결성 메타데이터가 누락되거나 현재 설치된 패키지 버전과 다를 때 경고합니다.
Discord 허용 목록 (`channels.discord.allowFrom`, `channels.discord.guilds.*.users`, 페어링 스토어)이 안정적인 ID 대신 이름 또는 태그 항목을 사용할 때 경고합니다.
`gateway.auth.mode="none"`으로 공유 비밀 없이 게이트웨이 HTTP API에 접근 가능할 때 (`/tools/invoke` 및 활성화된 `/v1/*` 엔드포인트) 경고합니다.

## JSON 출력

CI/정책 검사를 위해 `--json`을 사용하세요:

```bash
openclaw security audit --json | jq '.summary'
openclaw security audit --deep --json | jq '.findings[] | select(.severity=="critical") | .checkId'
```

`--fix`와 `--json`이 결합되면, 출력에는 수정 작업과 최종 보고서가 모두 포함됩니다:

```bash
openclaw security audit --fix --json | jq '{fix: .fix.ok, summary: .report.summary}'
```

## `--fix`가 변경하는 내용

`--fix`는 안전하고 결정적인 수정을 적용합니다:

- 일반적인 `groupPolicy="open"`을 `groupPolicy="allowlist"`로 변경합니다 (지원되는 채널의 계정 변형 포함)
- `logging.redactSensitive`를 `"off"`에서 `"tools"`로 설정합니다
- state/config 및 일반적인 민감한 파일의 권한을 강화합니다 (`credentials/*.json`, `auth-profiles.json`, `sessions.json`, 세션 `*.jsonl`)

`--fix`는 다음을 **하지 않습니다**:

- 토큰/비밀번호/API 키를 로테이션하지 않음
- 도구를 비활성화하지 않음 (`gateway`, `cron`, `exec` 등)
- 게이트웨이 바인드/인증/네트워크 노출 선택을 변경하지 않음
- 플러그인/스킬을 제거하거나 재작성하지 않음
