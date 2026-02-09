---
summary: "한 머신에서 다른 머신으로 OpenClaw 설치를 이동(마이그레이션)합니다"
read_when:
  - OpenClaw 를 새 노트북/서버로 이동하는 경우
  - 세션, 인증, 채널 로그인(WhatsApp 등)을 유지하려는 경우
title: "마이그레이션 가이드"
---

# 새 머신으로 OpenClaw 마이그레이션

이 가이드는 **온보딩을 다시 수행하지 않고** 한 머신에서 다른 머신으로 OpenClaw Gateway(게이트웨이)를 마이그레이션하는 방법을 설명합니다.

개념적으로 마이그레이션은 간단합니다:

- **상태 디렉토리**(`$OPENCLAW_STATE_DIR`, 기본값: `~/.openclaw/`)를 복사합니다 — 여기에는 구성, 인증, 세션, 채널 상태가 포함됩니다.
- **워크스페이스**(기본값: `~/.openclaw/workspace/`)를 복사합니다 — 여기에는 에이전트 파일(메모리, 프롬프트 등)이 포함됩니다.

다만 **프로필**, **권한**, **부분 복사**와 관련된 흔한 함정이 있습니다.

## 시작하기 전에 (마이그레이션 대상 이해)

### 1. 상태 디렉토리 식별

대부분의 설치는 기본값을 사용합니다:

- **상태 디렉토리:** `~/.openclaw/`

하지만 다음을 사용하는 경우 다를 수 있습니다:

- `--profile <name>` (종종 `~/.openclaw-<profile>/` 이 됩니다)
- `OPENCLAW_STATE_DIR=/some/path`

확실하지 않다면 **이전** 머신에서 다음을 실행하십시오:

```bash
openclaw status
```

출력에서 `OPENCLAW_STATE_DIR` / 프로필 언급을 확인하십시오. 여러 Gateway 를 실행 중이라면 각 프로필마다 반복하십시오.

### 2. 워크스페이스 식별

일반적인 기본값:

- `~/.openclaw/workspace/` (권장 워크스페이스)
- 직접 생성한 사용자 지정 폴더

워크스페이스에는 `MEMORY.md`, `USER.md`, `memory/*.md` 과 같은 파일이 있습니다.

### 3. 무엇이 유지되는지 이해

상태 디렉토리와 워크스페이스를 **모두** 복사하면 다음이 유지됩니다:

- Gateway 구성(`openclaw.json`)
- 인증 프로필 / API 키 / OAuth 토큰
- 세션 기록 + 에이전트 상태
- 채널 상태(예: WhatsApp 로그인/세션)
- 워크스페이스 파일(메모리, Skills 노트 등)

워크스페이스만 **단독으로**(예: Git 을 통해) 복사하면 다음은 **유지되지 않습니다**:

- 세션
- 자격 증명
- 채널 로그인

이들은 `$OPENCLAW_STATE_DIR` 아래에 있습니다.

## 마이그레이션 단계 (권장)

### 단계 0 — 백업 생성 (이전 머신)

**이전** 머신에서, 복사 중 파일 변경을 방지하기 위해 먼저 Gateway 를 중지하십시오:

```bash
openclaw gateway stop
```

(선택 사항이지만 권장) 상태 디렉토리와 워크스페이스를 아카이브하십시오:

```bash
# Adjust paths if you use a profile or custom locations
cd ~
tar -czf openclaw-state.tgz .openclaw

tar -czf openclaw-workspace.tgz .openclaw/workspace
```

여러 프로필/상태 디렉토리(예: `~/.openclaw-main`, `~/.openclaw-work`)가 있다면 각각 아카이브하십시오.

### 단계 1 — 새 머신에 OpenClaw 설치

**새** 머신에서 CLI(필요한 경우 Node 포함)를 설치하십시오:

- 참고: [Install](/install)

이 단계에서 온보딩으로 새 `~/.openclaw/` 가 생성되어도 괜찮습니다 — 다음 단계에서 덮어씁니다.

### 단계 2 — 상태 디렉토리 + 워크스페이스를 새 머신으로 복사

다음 **둘 다**를 복사하십시오:

- `$OPENCLAW_STATE_DIR` (기본값: `~/.openclaw/`)
- 워크스페이스(기본값: `~/.openclaw/workspace/`)

일반적인 방법:

- `scp` the tarballs and extract
- `rsync -a` 로 SSH 를 통해 복사
- 외장 드라이브

복사 후 다음을 확인하십시오:

- 숨김 디렉토리가 포함되었는지(예: `.openclaw/`)
- Gateway 를 실행하는 사용자 기준으로 파일 소유권이 올바른지

### 단계 3 — Doctor 실행 (마이그레이션 + 서비스 복구)

**새** 머신에서 다음을 실행하십시오:

```bash
openclaw doctor
```

Doctor 는 “안전하고 단순한” 명령입니다. 서비스를 복구하고, 구성 마이그레이션을 적용하며, 불일치를 경고합니다.

그다음:

```bash
openclaw gateway restart
openclaw status
```

## Common footguns (and how to avoid them)

### 함정: 프로필 / 상태 디렉토리 불일치

이전 Gateway 를 프로필(또는 `OPENCLAW_STATE_DIR`)로 실행했고, 새 Gateway 가 다른 프로필을 사용하는 경우 다음과 같은 증상이 나타날 수 있습니다:

- 구성 변경이 적용되지 않음
- 채널이 누락되거나 로그아웃됨
- 세션 기록이 비어 있음

해결: 마이그레이션한 **동일한** 프로필/상태 디렉토리를 사용하여 Gateway/서비스를 실행한 뒤, 다음을 다시 실행하십시오:

```bash
openclaw doctor
```

### 함정: `openclaw.json` 만 복사

`openclaw.json` 만으로는 충분하지 않습니다. 많은 프로바이더가 다음 경로 아래에 상태를 저장합니다:

- `$OPENCLAW_STATE_DIR/credentials/`
- `$OPENCLAW_STATE_DIR/agents/<agentId>/...`

항상 전체 `$OPENCLAW_STATE_DIR` 폴더를 마이그레이션하십시오.

### 함정: 권한 / 소유권

root 로 복사했거나 사용자 변경이 있었다면, Gateway 가 자격 증명/세션을 읽지 못할 수 있습니다.

해결: 상태 디렉토리와 워크스페이스의 소유자가 Gateway 를 실행하는 사용자와 일치하는지 확인하십시오.

### 함정: 원격/로컬 모드 간 마이그레이션

- UI(WebUI/TUI)가 **원격** Gateway 를 가리키는 경우, 세션 저장소와 워크스페이스는 원격 호스트가 소유합니다.
- 노트북을 마이그레이션해도 원격 Gateway 의 상태는 이동되지 않습니다.

원격 모드라면 **Gateway 호스트**를 마이그레이션하십시오.

### 함정: 백업에 포함된 비밀 정보

`$OPENCLAW_STATE_DIR` 에는 비밀 정보(API 키, OAuth 토큰, WhatsApp 자격 증명)가 포함됩니다. 백업은 운영 환경의 비밀 정보처럼 취급하십시오:

- 암호화하여 저장
- 안전하지 않은 채널로 공유하지 않기
- 노출이 의심되면 키를 회전

## 검증 체크리스트

새 머신에서 다음을 확인하십시오:

- `openclaw status` 에서 Gateway 가 실행 중으로 표시됨
- 채널이 여전히 연결되어 있음(예: WhatsApp 이 재페어링을 요구하지 않음)
- 대시보드가 열리고 기존 세션이 표시됨
- 워크스페이스 파일(메모리, 구성)이 존재함

## 관련 문서

- [Doctor](/gateway/doctor)
- [Gateway 문제 해결](/gateway/troubleshooting)
- [OpenClaw 는 데이터를 어디에 저장하나요?](/help/faq#where-does-openclaw-store-its-data)
