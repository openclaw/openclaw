---
summary: "ClawHub 가이드: 공용 스킬 레지스트리 + CLI 워크플로우"
read_when:
  - ClawHub를 새로운 사용자에게 소개할 때
  - 스킬을 설치, 검색, 또는 게시할 때
  - ClawHub CLI 플래그와 동기화 동작을 설명할 때
title: "ClawHub"
---

# ClawHub

ClawHub는 **OpenClaw의 공용 스킬 레지스트리**입니다. 모든 스킬은 공개되고, 열려 있으며, 공유 및 재사용을 위해 모두에게 보이는 무료 서비스입니다. 스킬은 `SKILL.md` 파일이 포함된 폴더(및 지원 텍스트 파일)일 뿐입니다. 웹 앱에서 스킬을 브라우징하거나 CLI를 사용하여 스킬을 검색, 설치, 업데이트 및 게시할 수 있습니다.

사이트: [clawhub.ai](https://clawhub.ai)

## ClawHub의 특징

- OpenClaw 스킬의 공용 레지스트리
- 스킬 번들 및 메타데이터의 버전 저장소
- 검색, 태그 및 사용 신호를 위한 검색 인터페이스

## 작동 방식

1. 사용자가 스킬 번들(파일 + 메타데이터)을 게시합니다.
2. ClawHub가 번들을 저장하고 메타데이터를 파싱하며 버전을 할당합니다.
3. 레지스트리가 검색 및 발견을 위해 스킬을 색인화합니다.
4. 사용자는 OpenClaw에서 스킬을 브라우징하고, 다운로드하고, 설치합니다.

## 수행 가능한 작업

- 새로운 스킬 및 기존 스킬의 새 버전을 게시합니다.
- 이름, 태그 또는 검색을 통해 스킬을 발견합니다.
- 스킬 번들을 다운로드하고 파일을 확인합니다.
- 남용되거나 안전하지 않은 스킬을 신고합니다.
- 모더레이터라면 숨김, 숨김 해제, 삭제 또는 사용자 차단을 할 수 있습니다.

## 대상 사용자 (초보자 친화적)

OpenClaw 에이전트에 새로운 기능을 추가하고 싶다면 ClawHub는 스킬을 찾고 설치하는 가장 쉬운 방법입니다. 백엔드 작업 방식을 알 필요가 없습니다. 다음을 할 수 있습니다:

- 자연어로 스킬을 검색합니다.
- 스킬을 작업 공간에 설치합니다.
- 나중에 명령어 하나로 스킬을 업데이트합니다.
- 자신의 스킬을 게시하여 백업합니다.

## 빠른 시작 (비기술적)

1. CLI를 설치합니다 (다음 섹션 참조).
2. 필요한 것을 검색합니다:
   - `clawhub search "calendar"`
3. 스킬을 설치합니다:
   - `clawhub install <skill-slug>`
4. 새로운 OpenClaw 세션을 시작하여 새 스킬을 불러옵니다.

## CLI 설치

옵션 중 하나를 선택하세요:

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

## OpenClaw에서의 위치

기본적으로, CLI는 현재 작업 디렉토리의 `./skills`에 스킬을 설치합니다. OpenClaw 작업 공간이 구성된 경우, `clawhub`는 `--workdir`(또는 `CLAWHUB_WORKDIR`)로 덮어쓰지 않는 한 해당 작업 공간으로 돌아갑니다. OpenClaw는 작업 공간 스킬을 `<workspace>/skills`에서 로드하며 **다음** 세션에서 이를 사용합니다. 이미 `~/.openclaw/skills` 또는 번들 스킬을 사용하는 경우, 작업 공간 스킬이 우선권을 가집니다.

스킬이 어떻게 로드, 공유, 제한되는지에 대한 자세한 내용은 [스킬](/tools/skills)을 참조하세요.

## 스킬 시스템 개요

스킬은 OpenClaw가 특정 작업을 수행하는 방법을 가르치는 버전 관리된 파일 번들입니다. 각 게시 후 새로운 버전이 생성되며, 레지스트리는 버전 기록을 유지하여 사용자가 변경사항을 감사할 수 있게 합니다.

일반적인 스킬에는 다음이 포함됩니다:

- 기본 설명 및 사용법이 포함된 `SKILL.md` 파일
- 스킬에서 사용하는 선택적 설정, 스크립트 또는 지원 파일
- 태그, 요약 및 설치 요구사항 등의 메타데이터

ClawHub는 검색 기능을 강화하고 스킬 기능을 안전하게 노출하기 위해 메타데이터를 사용합니다. 레지스트리는 랭킹 및 가시성을 개선하기 위해 사용 신호(별점 및 다운로드 등)를 추적합니다.

## 서비스가 제공하는 것 (기능)

- 스킬 및 그 `SKILL.md` 내용의 **공용 브라우징**
- 단순한 키워드가 아닌 임베딩(벡터 검색)에 기반한 **검색**
- semver, 변경 로그 및 태그(포함 `latest`)가 있는 **버전 관리**
- 버전별로 zip 파일로 **다운로드**
- 커뮤니티 피드백을 위한 **별점 및 댓글**
- 승인 및 감사를 위한 **모더레이션** 훅
- 자동화 및 스크립팅을 위한 **CLI 친화적 API**

## 보안 및 모더레이션

ClawHub는 기본적으로 열려 있습니다. 누구나 스킬을 업로드할 수 있으나, GitHub 계정은 최소 1주일 이상이어야 게시할 수 있습니다. 이는 합법적인 기여자를 차단하지 않으면서 남용을 늦추는 데 도움이 됩니다.

신고 및 모더레이션:

- 로그인한 사용자는 누구나 스킬을 신고할 수 있습니다.
- 신고 사유는 필수이며 기록됩니다.
- 각 사용자는 한 번에 최대 20개의 활성 신고를 가질 수 있습니다.
- 3개 이상의 고유 신고를 받은 스킬은 기본적으로 자동으로 숨겨집니다.
- 모더레이터는 숨겨진 스킬을 볼 수 있으며, 숨김 해제, 삭제 또는 사용자 차단을 할 수 있습니다.
- 신고 기능을 남용하면 계정이 차단될 수 있습니다.

모더레이터가 되고 싶으신가요? OpenClaw Discord에서 질문하고 모더레이터나 유지관리자에게 연락하세요.

## CLI 명령어와 매개변수

전역 옵션 (모든 명령에 적용):

- `--workdir <dir>`: 작업 디렉토리 (기본값: 현재 디렉토리; OpenClaw 작업 공간으로 돌아감).
- `--dir <dir>`: 작업 디렉토리에 상대적인 스킬 디렉토리 (기본값: `skills`).
- `--site <url>`: 사이트 기본 URL (브라우저 로그인).
- `--registry <url>`: 레지스트리 API 기본 URL.
- `--no-input`: 프롬프트 비활성화 (비대화식).
- `-V, --cli-version`: CLI 버전 출력.

인증:

- `clawhub login` (브라우저 흐름) 또는 `clawhub login --token <token>`
- `clawhub logout`
- `clawhub whoami`

옵션:

- `--token <token>`: API 토큰 붙여넣기.
- `--label <label>`: 브라우저 로그인 토큰에 저장된 레이블 (기본값: `CLI token`).
- `--no-browser`: 브라우저를 열지 않음 (`--token` 필수).

검색:

- `clawhub search "query"`
- `--limit <n>`: 최대 결과 수.

설치:

- `clawhub install <slug>`
- `--version <version>`: 특정 버전 설치.
- `--force`: 폴더가 이미 존재하는 경우 덮어쓰기.

업데이트:

- `clawhub update <slug>`
- `clawhub update --all`
- `--version <version>`: 특정 버전으로 업데이트 (단일 슬러그만 해당).
- `--force`: 로컬 파일이 게시된 버전과 일치하지 않을 때 덮어쓰기.

목록:

- `clawhub list` (`.clawhub/lock.json` 읽기)

게시:

- `clawhub publish <path>`
- `--slug <slug>`: 스킬 슬러그.
- `--name <name>`: 표시 이름.
- `--version <version>`: Semver 버전.
- `--changelog <text>`: 변경 로그 텍스트 (비어있을 수 있음).
- `--tags <tags>`: 쉼표로 구분된 태그 (기본값: `latest`).

삭제/삭제 취소 (소유자/관리자 전용):

- `clawhub delete <slug> --yes`
- `clawhub undelete <slug> --yes`

동기화 (로컬 스킬 스캔 + 새/업데이트된 스킬 게시):

- `clawhub sync`
- `--root <dir...>`: 추가 스캔 루트.
- `--all`: 프롬프트 없이 모든 것 업로드.
- `--dry-run`: 업로드될 목록 표시.
- `--bump <type>`: `patch|minor|major` 업데이트 (기본값: `patch`).
- `--changelog <text>`: 비대화식 업데이트를 위한 변경 로그.
- `--tags <tags>`: 쉼표로 구분된 태그 (기본값: `latest`).
- `--concurrency <n>`: 레지스트리 검증 (기본값: 4).

## 에이전트를 위한 일반 워크플로우

### 스킬 검색

```bash
clawhub search "postgres backups"
```

### 새 스킬 다운로드

```bash
clawhub install my-skill-pack
```

### 설치된 스킬 업데이트

```bash
clawhub update --all
```

### 자신의 스킬 백업 (게시 또는 동기화)

단일 스킬 폴더의 경우:

```bash
clawhub publish ./my-skill --slug my-skill --name "My Skill" --version 1.0.0 --tags latest
```

여러 스킬을 한 번에 스캔하고 백업하려면:

```bash
clawhub sync --all
```

## 고급 정보 (기술적)

### 버전 관리 및 태그

- 각 게시 시 새로운 **semver** `SkillVersion`이 생성됩니다.
- 태그(`latest` 등)는 버전을 가리키며, 태그 이동은 롤백을 허용합니다.
- 각 버전마다 변경 로그가 첨부되며, 동기화 또는 게시 업데이트 시 비어있을 수 있습니다.

### 로컬 변경 사항 vs 레지스트리 버전

업데이트는 로컬 스킬 콘텐츠와 레지스트리 버전을 내용 해시를 사용하여 비교합니다. 로컬 파일이 게시된 버전과 일치하지 않으면, CLI는 덮어쓰기 전에 확인을 요청합니다 (또는 비대화식 실행에서 `--force` 필요).

### 동기화 스캔 및 대체 루트

`clawhub sync`는 현재 작업 디렉토리를 먼저 스캔합니다. 스킬이 발견되지 않으면, 알려진 레거시 위치(`~/openclaw/skills` 및 `~/.openclaw/skills` 등)로 돌아갑니다. 이는 추가 플래그 없이 이전 스킬 설치를 찾기 위한 방식입니다.

### 저장소 및 잠금파일

- 설치된 스킬은 작업 디렉토리의 `.clawhub/lock.json`에 기록됩니다.
- 인증 토큰은 ClawHub CLI 설정 파일에 저장됩니다 (`CLAWHUB_CONFIG_PATH`로 오버라이드 가능).

### 원격 측정 (설치 횟수)

로그인한 상태에서 `clawhub sync`를 실행하면, CLI는 설치 횟수를 계산하기 위해 최소 스냅샷을 보냅니다. 이를 완전히 비활성화할 수 있습니다:

```bash
export CLAWHUB_DISABLE_TELEMETRY=1
```

## 환경 변수

- `CLAWHUB_SITE`: 사이트 URL 오버라이드.
- `CLAWHUB_REGISTRY`: 레지스트리 API URL 오버라이드.
- `CLAWHUB_CONFIG_PATH`: CLI가 토큰/설정을 저장하는 위치 오버라이드.
- `CLAWHUB_WORKDIR`: 기본 작업 디렉토리 오버라이드.
- `CLAWHUB_DISABLE_TELEMETRY=1`: `sync`의 원격 측정 비활성화.
