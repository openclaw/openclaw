---
summary: "`openclaw security` CLI 레퍼런스 (일반적인 보안 취약점 감사 및 수정)"
read_when:
  - 설정/상태에 대한 빠른 보안 감사를 실행하고 싶을 때
  - 안전한 수정 제안을 적용하고 싶을 때 (chmod, 기본값 강화)
title: "security"
x-i18n:
  source_path: "docs/cli/security.md"
---

# `openclaw security`

보안 도구 (감사 + 선택적 수정).

관련 문서:

- 보안 가이드: [Security](/gateway/security)

## 감사

```bash
openclaw security audit
openclaw security audit --deep
openclaw security audit --deep --password <password>
openclaw security audit --deep --token <token>
openclaw security audit --fix
openclaw security audit --json
```

감사는 여러 DM 발신자가 메인 세션을 공유할 때 경고하며, 공유 인박스에 대해 **보안 DM 모드**: `session.dmScope="per-channel-peer"` (다중 계정 채널의 경우 `per-account-channel-peer`)를 권장합니다.
이것은 협력적/공유 인박스 강화를 위한 것입니다. 상호 신뢰하지 않는/적대적인 운영자가 공유하는 단일 Gateway는 권장 설정이 아닙니다. 별도의 Gateway (또는 별도의 OS 사용자/호스트)로 신뢰 경계를 분리하세요.
또한 설정이 공유 사용자 수신 가능성을 시사할 때 `security.trust_model.multi_user_heuristic`을 출력합니다 (예: 열린 DM/그룹 정책, 설정된 그룹 대상 또는 와일드카드 발신자 규칙). OpenClaw는 기본적으로 개인 비서 신뢰 모델임을 상기시킵니다.
의도적인 공유 사용자 설정의 경우, 감사 안내는 모든 세션을 샌드박스하고 파일시스템 접근을 워크스페이스 범위로 유지하며 해당 런타임에서 개인/비공개 ID나 자격 증명을 제외하는 것입니다.
또한 소규모 모델 (`<=300B`)이 샌드박싱 없이 웹/브라우저 도구가 활성화된 상태로 사용될 때 경고합니다.
웹훅 수신의 경우, `hooks.token`이 Gateway 토큰을 재사용할 때, `hooks.defaultSessionKey`가 설정되지 않을 때, `hooks.allowedAgentIds`가 제한되지 않을 때, 요청 `sessionKey` 재정의가 활성화될 때, 재정의가 `hooks.allowedSessionKeyPrefixes` 없이 활성화될 때 경고합니다.
샌드박스 모드가 꺼진 상태에서 샌드박스 Docker 설정이 구성되었을 때, `gateway.nodes.denyCommands`가 비효과적인 패턴형/알 수 없는 항목을 사용할 때 (정확한 노드 명령명 매칭만 가능, 셸 텍스트 필터링 아님), `gateway.nodes.allowCommands`가 위험한 노드 명령을 명시적으로 활성화할 때, 전역 `tools.profile="minimal"`이 에이전트 도구 프로필에 의해 재정의될 때, 열린 그룹이 샌드박스/워크스페이스 가드 없이 런타임/파일시스템 도구를 노출할 때, 설치된 확장 플러그인 도구가 허용적인 도구 정책 하에서 접근 가능할 때도 경고합니다.
`gateway.allowRealIpFallback=true` (프록시가 잘못 설정된 경우 헤더 스푸핑 위험)와 `discovery.mdns.mode="full"` (mDNS TXT 레코드를 통한 메타데이터 유출)도 플래그합니다.
샌드박스 브라우저가 `sandbox.browser.cdpSourceRange` 없이 Docker `bridge` 네트워크를 사용할 때도 경고합니다.
위험한 샌드박스 Docker 네트워크 모드 (`host` 및 `container:*` 네임스페이스 결합 포함)도 플래그합니다.
기존 샌드박스 브라우저 Docker 컨테이너에 누락되었거나 오래된 해시 레이블이 있을 때 (예: `openclaw.browserConfigEpoch`가 누락된 마이그레이션 이전 컨테이너) `openclaw sandbox recreate --browser --all`을 권장합니다.
npm 기반 플러그인/훅 설치 기록이 고정되지 않았거나, 무결성 메타데이터가 누락되었거나, 현재 설치된 패키지 버전과 차이가 날 때 경고합니다.
채널 허용 목록이 안정적인 ID 대신 변경 가능한 이름/이메일/태그에 의존할 때 경고합니다 (해당되는 경우 Discord, Slack, Google Chat, Microsoft Teams, Mattermost, IRC 범위).
`gateway.auth.mode="none"`이 공유 시크릿 없이 Gateway HTTP API를 접근 가능하게 남길 때 경고합니다 (`/tools/invoke` 및 활성화된 `/v1/*` 엔드포인트).
`dangerous`/`dangerously` 접두사가 붙은 설정은 명시적인 비상 해제 운영자 재정의입니다. 하나를 활성화하는 것 자체가 보안 취약점 보고는 아닙니다.
위험 매개변수의 전체 목록은 [Security](/gateway/security)의 "Insecure or dangerous flags summary" 섹션을 참조하세요.

SecretRef 동작:

- `security audit`는 대상 경로에 대해 읽기 전용 모드로 지원되는 SecretRef를 해석합니다.
- 현재 명령 경로에서 SecretRef를 사용할 수 없는 경우, 감사는 계속되고 (크래시 대신) `secretDiagnostics`를 보고합니다.
- `--token`과 `--password`는 해당 명령 호출에 대한 딥 프로브 인증만 재정의합니다. 설정이나 SecretRef 매핑을 다시 쓰지 않습니다.

## JSON 출력

CI/정책 검사에 `--json`을 사용하세요:

```bash
openclaw security audit --json | jq '.summary'
openclaw security audit --deep --json | jq '.findings[] | select(.severity=="critical") | .checkId'
```

`--fix`와 `--json`을 결합하면, 출력에 수정 작업과 최종 보고서가 모두 포함됩니다:

```bash
openclaw security audit --fix --json | jq '{fix: .fix.ok, summary: .report.summary}'
```

## `--fix`가 변경하는 것

`--fix`는 안전하고 결정론적인 해결 방법을 적용합니다:

- 일반적인 `groupPolicy="open"`을 `groupPolicy="allowlist"`로 전환 (지원되는 채널의 계정 변형 포함)
- `logging.redactSensitive`를 `"off"`에서 `"tools"`로 설정
- 상태/설정 및 일반적인 민감한 파일의 권한 강화 (`credentials/*.json`, `auth-profiles.json`, `sessions.json`, 세션 `*.jsonl`)

`--fix`는 다음을 **하지 않습니다**:

- 토큰/비밀번호/API 키 교체
- 도구 비활성화 (`gateway`, `cron`, `exec` 등)
- Gateway 바인드/인증/네트워크 노출 선택 변경
- 플러그인/Skills 제거 또는 재작성
