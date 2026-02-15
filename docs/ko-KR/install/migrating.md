---
summary: "Move (migrate) a OpenClaw install from one machine to another"
read_when:
  - You are moving OpenClaw to a new laptop/server
  - You want to preserve sessions, auth, and channel logins (WhatsApp, etc.)
title: "Migration Guide"
x-i18n:
  source_hash: 604d862c4bf86e7924d09028db8cc2514ca6f1d64ebe8bb7d1e2dde57ef70caa
---

# OpenClaw를 새 시스템으로 마이그레이션

이 가이드는 **온보딩을 다시 실행하지 않고** 한 시스템에서 다른 시스템으로 OpenClaw Gateway를 마이그레이션합니다.

마이그레이션은 개념적으로 간단합니다.

- **상태 디렉터리**(`$OPENCLAW_STATE_DIR`, 기본값: `~/.openclaw/`)를 복사합니다. 여기에는 구성, 인증, 세션 및 채널 상태가 포함됩니다.
- **작업 공간**(기본적으로 `~/.openclaw/workspace/`)을 복사합니다. 여기에는 에이전트 파일(메모리, 프롬프트 등)이 포함됩니다.

그러나 **프로필**, **권한** 및 **부분 복사본**에 대한 공통적인 문제가 있습니다.

## 시작하기 전에(이전하려는 항목)

### 1) 상태 디렉터리를 식별합니다.

대부분의 설치에서는 기본값을 사용합니다.

- **상태 디렉토리:** `~/.openclaw/`

그러나 다음을 사용하면 다를 수 있습니다.

- `--profile <name>` (종종 `~/.openclaw-<profile>/`가 됨)
- `OPENCLAW_STATE_DIR=/some/path`

확실하지 않은 경우 **이전** 머신에서 실행하세요.

```bash
openclaw status
```

출력에서 `OPENCLAW_STATE_DIR` / 프로필에 대한 언급을 찾아보세요. 여러 게이트웨이를 실행하는 경우 각 프로필에 대해 반복합니다.

### 2) 작업 공간 식별

공통 기본값:

- `~/.openclaw/workspace/` (권장 작업공간)
- 귀하가 생성한 사용자 정의 폴더

작업공간은 `MEMORY.md`, `USER.md`, `memory/*.md`와 같은 파일이 있는 곳입니다.

### 3) 무엇을 보존할지 이해하기

상태 디렉토리와 작업공간을 **둘 다** 복사하면 다음이 유지됩니다.

- 게이트웨이 구성 (`openclaw.json`)
- 인증 프로필 / API 키 / OAuth 토큰
- 세션 기록 + 상담원 상태
- 채널 상태(예: WhatsApp 로그인/세션)
- 작업 공간 파일(메모리, 스킬 노트 등)

작업공간 **만** 복사하는 경우(예: Git을 통해) 다음 항목은 보존되지 **않습니다**.

- 세션
- 자격 증명
- 채널 로그인

그들은 `$OPENCLAW_STATE_DIR` 아래에 살고 있습니다.

## 마이그레이션 단계(권장)

### 0단계 — 백업 만들기(기존 머신)

**기존** 머신에서는 먼저 게이트웨이를 중지하여 파일이 복사 도중에 변경되지 않도록 합니다.

```bash
openclaw gateway stop
```

(선택사항이지만 권장됨) 상태 디렉터리와 작업공간을 보관합니다.

```bash
# Adjust paths if you use a profile or custom locations
cd ~
tar -czf openclaw-state.tgz .openclaw

tar -czf openclaw-workspace.tgz .openclaw/workspace
```

여러 프로필/상태 디렉터리(예: `~/.openclaw-main`, `~/.openclaw-work`)가 있는 경우 각각을 보관하세요.

### 1단계 - 새 컴퓨터에 OpenClaw 설치

**새** 머신에 CLI(및 필요한 경우 Node)를 설치합니다.

- 참조: [설치](/install)

이 단계에서는 온보딩을 통해 새로운 `~/.openclaw/`를 생성해도 괜찮습니다. 다음 단계에서 이를 덮어쓰게 됩니다.

### 2단계 — 상태 디렉터리 + 작업 공간을 새 컴퓨터에 복사합니다.

**둘 다** 복사:

- `$OPENCLAW_STATE_DIR` (기본값 `~/.openclaw/`)
- 귀하의 작업공간 (기본값 `~/.openclaw/workspace/`)

일반적인 접근 방식:

- `scp` 타르볼 및 추출
- SSH를 통한 `rsync -a`
- 외장 드라이브

복사한 후 다음을 확인하세요.

- 숨겨진 디렉터리가 포함되었습니다(예: `.openclaw/`).
- 게이트웨이를 실행하는 사용자의 파일 소유권이 정확합니다.

### 3단계 - Doctor 실행(마이그레이션 + 서비스 복구)

**새** 머신에서:

```bash
openclaw doctor
```

닥터는 "안전한 지루함" 명령이다. 서비스를 복구하고 구성 마이그레이션을 적용하며 불일치에 대해 경고합니다.

그런 다음:

```bash
openclaw gateway restart
openclaw status
```

## 일반적인 풋건(및 이를 피하는 방법)

### Footgun: 프로필/상태-디렉토리 불일치

프로필(또는 `OPENCLAW_STATE_DIR`)을 사용하여 이전 게이트웨이를 실행했는데 새 게이트웨이가 다른 게이트웨이를 사용하는 경우 다음과 같은 증상이 표시됩니다.

- 구성 변경 사항이 적용되지 않습니다.
- 채널 누락/로그아웃
- 빈 세션 기록

해결 방법: 마이그레이션한 **동일한** 프로필/상태 디렉터리를 사용하여 게이트웨이/서비스를 실행한 후 다시 실행하세요.

```bash
openclaw doctor
```

### 풋건: `openclaw.json` 복사만 가능

`openclaw.json`로는 충분하지 않습니다. 많은 공급자는 다음 위치에 상태를 저장합니다.

- `$OPENCLAW_STATE_DIR/credentials/`
- `$OPENCLAW_STATE_DIR/agents/<agentId>/...`

항상 `$OPENCLAW_STATE_DIR` 폴더 전체를 마이그레이션하세요.

### Footgun: 권한/소유권

루트로 복사했거나 사용자를 변경한 경우 게이트웨이가 자격 증명/세션을 읽지 못할 수 있습니다.

수정 사항: 상태 디렉터리 + 작업 공간이 게이트웨이를 실행하는 사용자가 소유하고 있는지 확인하세요.

### Footgun: 원격/로컬 모드 간 전환

- UI(WebUI/TUI)가 **원격** 게이트웨이를 가리키는 경우 원격 호스트는 세션 저장소와 작업 공간을 소유합니다.
- 노트북을 마이그레이션해도 원격 게이트웨이의 상태는 변경되지 않습니다.

원격 모드인 경우 **게이트웨이 호스트**를 마이그레이션하세요.

### Footgun: 백업의 비밀

`$OPENCLAW_STATE_DIR`에는 비밀(API 키, OAuth 토큰, WhatsApp 자격 증명)이 포함되어 있습니다. 백업을 프로덕션 비밀처럼 취급하십시오.

- 암호화된 저장
- 안전하지 않은 채널을 통한 공유 방지
- 노출이 의심되는 경우 키를 회전하세요.

## 확인 체크리스트

새 머신에서 다음을 확인합니다.

- `openclaw status`는 실행 중인 게이트웨이를 보여줍니다.
- 채널이 아직 연결되어 있습니다(예: WhatsApp은 다시 페어링할 필요가 없습니다).
- 대시보드가 열리고 기존 세션이 표시됩니다.
- 작업공간 파일(메모리, 구성)이 존재합니다.

## 관련

- [의사](/gateway/doctor)
- [게이트웨이 문제 해결](/gateway/troubleshooting)
- [OpenClaw는 데이터를 어디에 저장하나요?](/help/faq#where-does-openclaw-store-its-data)
