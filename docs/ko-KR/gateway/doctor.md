---
summary: "Doctor 명령: 상태 검사, 설정 마이그레이션 및 복구 단계"
read_when:
  - doctor 마이그레이션 추가 또는 수정
  - 구획 설정 변경 도입
title: "Doctor"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: gateway/doctor.md
  workflow: 15
---

# Doctor

`openclaw doctor`는 OpenClaw의 복구 + 마이그레이션 도구입니다. 오래된 설정/상태를 수정하고 상태를 확인하고 실행 가능한 복구 단계를 제공합니다.

## 빠른 시작

```bash
openclaw doctor
```

### 헤드리스 / 자동화

```bash
openclaw doctor --yes
```

프롬프트 없이 기본값을 수락합니다(적용 가능한 경우 재시작/서비스/샌드박스 복구 단계 포함).

```bash
openclaw doctor --repair
```

프롬프트 없이 권장 복구를 적용합니다(복구 + 안전한 재시작).

```bash
openclaw doctor --repair --force
```

공격적인 복구도 적용합니다(사용자 정의 supervisor 설정 덮어씀).

```bash
openclaw doctor --non-interactive
```

프롬프트 없이 실행하고 안전한 마이그레이션만 적용합니다(설정 정규화 + 온디스크 상태 이동). 인간 확인이 필요한 재시작/서비스/샌드박스 작업은 건너뜁니다.

```bash
openclaw doctor --deep
```

시스템 서비스에서 추가 게이트웨이 설치를 검색합니다(launchd/systemd/schtasks).

변경 사항을 검토하기 전에 설정 파일을 먼저 열어보세요:

```bash
cat ~/.openclaw/openclaw.json
```

## 수행하는 작업(요약)

- git 설치를 위한 선택적 사전 비행 업데이트(대화형만).
- UI 프로토콜 신선도 확인(프로토콜 스키마가 더 최신일 때 Control UI 재구축).
- 상태 검사 + 재시작 프롬프트.
- 기술 상태 요약(적격/누락/차단).
- 레거시 값에 대한 설정 정규화.
- 설정 파일 권한 검사(로컬로 실행할 때 chmod 600).
- 모델 인증 상태: OAuth 만료 확인 가능, 만료 예정 토큰 새로 고침, 인증 프로파일 쿨다운/비활성화 상태 보고.
- 추가 작업 공간 디렉토리 감지(`~/openclaw`).
- 샌드박싱이 활성화된 경우 샌드박스 이미지 복구.
- 레거시 서비스 마이그레이션 및 추가 게이트웨이 감지.
- 게이트웨이 런타임 검사(서비스 설치되었지만 실행 중이 아님; 캐시된 launchd 레이블).
- 채널 상태 경고(실행 중인 게이트웨이에서 프로브됨).
- Supervisor 설정 감사(launchd/systemd/schtasks) 선택적 복구.
- 게이트웨이 런타임 최선의 관행 검사(Node vs Bun, 버전 관리자 경로).
- 게이트웨이 포트 충돌 진단(기본값 `18789`).
- 개방형 DM 정책에 대한 보안 경고.
- `gateway.auth.token`이 설정되지 않은 경우 게이트웨이 인증 경고(로컬 모드; 토큰 생성 제공).
- systemd linger 확인(Linux).
- 소스 설치 검사(pnpm 작업 공간 불일치, 누락된 UI 자산, 누락된 tsx 바이너리).
- 업데이트된 설정 + 마법사 메타데이터를 작성합니다.

## 세부 동작 및 근거

자세한 내용은 원본 문서를 참조하세요(너무 길어 축약됨).

### 0) 선택적 업데이트(git 설치)

이것이 git 체크아웃이고 doctor가 대화형으로 실행 중이면 업데이트를 제공합니다(페치/리베이스/빌드).

### 1) 설정 정규화

설정에 레거시 값 형태(예: 채널별 재정의 없이 `messages.ackReaction`)가 포함되면 doctor는 현재 스키마로 정규화합니다.

### 2) 레거시 설정 키 마이그레이션

설정에 더 이상 사용되지 않는 키가 포함되면 다른 명령이 실행을 거부하고 `openclaw doctor`를 실행하도록 요청합니다.

Doctor는 다음을 수행합니다:

- 발견된 레거시 키를 설명합니다.
- 적용한 마이그레이션을 표시합니다.
- 업데이트된 스키마로 `~/.openclaw/openclaw.json`을 재작성합니다.

게이트웨이는 또한 시작할 때 레거시 설정 형식을 감지하면 doctor 마이그레이션을 자동으로 실행하므로 오래된 설정이 수동 개입 없이 복구됩니다.

현재 마이그레이션:

- `routing.allowFrom` → `channels.whatsapp.allowFrom`
- `routing.groupChat.requireMention` → `channels.whatsapp/telegram/imessage.groups."*".requireMention`
- `routing.groupChat.historyLimit` → `messages.groupChat.historyLimit`
- `routing.queue` → `messages.queue`
- 기타(전체 목록은 원본 문서 참조)

## 상태 무결성 검사(세션 지속성, 라우팅 및 안전)

상태 디렉토리는 운영 두뇌입니다. 사라지면 백업이 없는 한 세션, 자격 증명, 로그 및 설정이 손실됩니다.

Doctor는 다음을 검사합니다:

- **상태 디렉토리 누락**: 치명적인 상태 손실 경고, 디렉토리 재생성 프롬프트, 누락된 데이터를 복구할 수 없다는 알림.
- **상태 디렉토리 권한**: 쓰기 가능성 확인; 권한 복구 제공(소유자/그룹 불일치 감지 시 `chown` 힌트 발생).
- **macOS 클라우드 동기화 상태 디렉토리**: 상태가 iCloud Drive 또는 `~/Library/CloudStorage/...` 아래에 있을 때 경고.
- **기타 검사**: 세션 디렉토리, 대본 일치, 여러 상태 디렉토리, 원격 모드 미리 알림.

## 모델 인증 상태(OAuth 만료)

Doctor는 인증 저장소의 OAuth 프로파일을 검사하고 토큰이 만료/만료 중일 때 경고합니다. Anthropic Claude Code 프로파일이 오래된 경우 `claude setup-token` 실행을 제안합니다.

Doctor는 또한 다음으로 인해 일시적으로 사용 불가능한 인증 프로파일을 보고합니다:

- 짧은 쿨다운(속도 제한/시간 초과/인증 실패)
- 더 긴 비활성화(청구/크레딧 실패)

## 관련 명령

자세한 내용은 원본 문서를 참조하세요:

- `openclaw doctor --yes` — 확인 프롬프트 없이 doctor 실행
- `openclaw doctor --repair` — 프롬프트 없이 권장 복구 적용
- `openclaw doctor --deep` — 추가 게이트웨이 설치 검색
