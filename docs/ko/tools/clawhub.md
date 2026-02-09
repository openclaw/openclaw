---
summary: "ClawHub 가이드: 공개 Skills 레지스트리 + CLI 워크플로"
read_when:
  - 신규 사용자에게 ClawHub 소개 시
  - Skills 설치, 검색 또는 게시 시
  - ClawHub CLI 플래그와 동기화 동작 설명 시
title: "ClawHub"
---

# ClawHub

ClawHub 는 **OpenClaw 를 위한 공개 Skills 레지스트리**입니다. 이는 무료 서비스로, 모든 Skills 는 공개되어 있으며 누구나 공유하고 재사용할 수 있도록 열려 있습니다. Skill 은 단순히 `SKILL.md` 파일(및 이를 지원하는 텍스트 파일들)로 구성된 폴더입니다. 웹 앱에서 Skills 를 탐색하거나 CLI 를 사용하여 Skills 를 검색, 설치, 업데이트 및 게시할 수 있습니다.

사이트: [clawhub.ai](https://clawhub.ai)

## ClawHub 이란

- OpenClaw Skills 를 위한 공개 레지스트리입니다.
- Skill 번들과 메타데이터를 버전 관리하여 저장하는 저장소입니다.
- 검색, 태그 및 사용 신호를 위한 디바이스 검색 표면입니다.

## 동작 방식

1. 사용자가 Skill 번들(파일 + 메타데이터)을 게시합니다.
2. ClawHub 가 번들을 저장하고 메타데이터를 파싱한 뒤 버전을 할당합니다.
3. 레지스트리가 Skill 을 검색 및 디바이스 검색용으로 인덱싱합니다.
4. 사용자는 OpenClaw 에서 Skills 를 탐색, 다운로드 및 설치합니다.

## 할 수 있는 작업

- 새로운 Skills 및 기존 Skills 의 새 버전을 게시합니다.
- 이름, 태그 또는 검색으로 Skills 를 찾습니다.
- Skill 번들을 다운로드하고 파일을 검토합니다.
- 악의적이거나 안전하지 않은 Skills 를 신고합니다.
- 관리자인 경우 숨기기, 숨김 해제, 삭제 또는 차단을 수행할 수 있습니다.

## 대상 사용자(초보자 친화적)

OpenClaw 에이전트에 새로운 기능을 추가하고 싶다면, ClawHub 는 Skills 를 찾고 설치하는 가장 쉬운 방법입니다. 백엔드 동작 방식을 알 필요는 없습니다. 다음을 수행할 수 있습니다.

- 자연어로 Skills 를 검색합니다.
- 작업공간에 Skill 을 설치합니다.
- 하나의 명령으로 나중에 Skills 를 업데이트합니다.
- 자신의 Skills 를 게시하여 백업합니다.

## 빠른 시작 (비기술적)

1. CLI 를 설치합니다(다음 섹션 참고).
2. 필요한 항목을 검색합니다:
   - `clawhub search "calendar"`
3. Skill 을 설치합니다:
   - `clawhub install <skill-slug>`
4. 새 OpenClaw 세션을 시작하여 새로운 Skill 이 로드되도록 합니다.

## CLI 설치

다음 중 하나를 선택하십시오:

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

## OpenClaw 에서의 위치

기본적으로 CLI 는 현재 작업 디렉토리 아래의 `./skills` 에 Skills 를 설치합니다. OpenClaw 작업공간이 구성되어 있다면, `clawhub` 는 `--workdir` (또는 `CLAWHUB_WORKDIR`)로 재정의하지 않는 한 해당 작업공간으로 폴백합니다. OpenClaw 는 `<workspace>/skills` 에서 작업공간 Skills 를 로드하며, **다음** 세션에서 이를 반영합니다. 이미 `~/.openclaw/skills` 또는 번들된 Skills 를 사용 중이라면, 작업공간 Skills 가 우선합니다.

Skills 가 로드되고, 공유되며, 제한되는 방식에 대한 자세한 내용은 다음을 참고하십시오  
[Skills](/tools/skills).

## Skill 시스템 개요

Skill 은 OpenClaw 가 특정 작업을 수행하는 방법을 학습하도록 하는 버전 관리된 파일 번들입니다. 게시할 때마다 새 버전이 생성되며, 레지스트리는 사용자가 변경 사항을 감사할 수 있도록 버전 이력을 유지합니다.

일반적인 Skill 구성 요소는 다음과 같습니다:

- 주요 설명과 사용법을 포함한 `SKILL.md` 파일
- Skill 에서 사용하는 선택적 설정, 스크립트 또는 보조 파일
- 태그, 요약, 설치 요구 사항과 같은 메타데이터

ClawHub 는 메타데이터를 사용하여 디바이스 검색을 강화하고 Skill 기능을 안전하게 노출합니다.
또한 별점 및 다운로드와 같은 사용 신호를 추적하여 순위와 가시성을 개선합니다.

## 서비스 제공 기능 (기능)

- Skills 및 해당 `SKILL.md` 콘텐츠의 **공개 탐색**
- 키워드뿐 아니라 임베딩(벡터 검색) 기반의 **검색**
- semver, 변경 로그 및 태그(`latest` 포함)를 통한 **버전 관리**
- 버전별 zip 형태의 **다운로드**
- 커뮤니티 피드백을 위한 **별점 및 댓글**
- 승인 및 감사를 위한 **모더레이션** 훅
- 자동화 및 스크립팅을 위한 **CLI 친화적 API**

## 보안 및 모더레이션

ClawHub 는 기본적으로 개방되어 있습니다. 누구나 Skills 를 업로드할 수 있지만, 게시하려면 GitHub 계정이 최소 1주 이상 경과해야 합니다. 이는 합법적인 기여자를 차단하지 않으면서 악용을 줄이는 데 도움이 됩니다.

신고 및 모더레이션:

- 로그인한 모든 사용자는 Skill 을 신고할 수 있습니다.
- 신고 사유는 필수이며 기록됩니다.
- 각 사용자는 동시에 최대 20개의 활성 신고를 가질 수 있습니다.
- 고유 신고가 3건을 초과한 Skills 는 기본적으로 자동 숨김 처리됩니다.
- 관리자는 숨겨진 Skills 를 보고, 숨김 해제, 삭제 또는 사용자 차단을 할 수 있습니다.
- 신고 기능을 악용할 경우 계정이 차단될 수 있습니다.

모더레이터가 되는 데 관심이 있으신가요? OpenClaw Discord 에서 문의하고 모더레이터 또는 메인테이너에게 연락하십시오.

## CLI 명령과 파라미터

전역 옵션(모든 명령에 적용):

- `--workdir <dir>`: 작업 디렉토리(기본값: 현재 디렉토리; OpenClaw 작업공간으로 폴백)
- `--dir <dir>`: workdir 기준 Skills 디렉토리(기본값: `skills`)
- `--site <url>`: 사이트 기본 URL(브라우저 로그인)
- `--registry <url>`: 레지스트리 API 기본 URL
- `--no-input`: 프롬프트 비활성화(비대화형)
- `-V, --cli-version`: CLI 버전 출력

인증:

- `clawhub login` (브라우저 플로우) 또는 `clawhub login --token <token>`
- `clawhub logout`
- `clawhub whoami`

옵션:

- `--token <token>`: API 토큰 붙여넣기
- `--label <label>`: 브라우저 로그인 토큰에 저장되는 라벨(기본값: `CLI token`)
- `--no-browser`: 브라우저를 열지 않음(`--token` 필요)

검색:

- `clawhub search "query"`
- `--limit <n>`: 최대 결과 수

설치:

- `clawhub install <slug>`
- `--version <version>`: 특정 버전 설치
- `--force`: 폴더가 이미 존재하는 경우 덮어쓰기

업데이트:

- `clawhub update <slug>`
- `clawhub update --all`
- `--version <version>`: 특정 버전으로 업데이트(단일 slug 만 가능)
- `--force`: 로컬 파일이 게시된 어떤 버전과도 일치하지 않을 때 덮어쓰기

목록:

- `clawhub list` (`.clawhub/lock.json` 읽음)

게시:

- `clawhub publish <path>`
- `--slug <slug>`: Skill slug
- `--name <name>`: 표시 이름
- `--version <version>`: Semver 버전
- `--changelog <text>`: 변경 로그 텍스트(비어 있어도 됨)
- `--tags <tags>`: 쉼표로 구분된 태그(기본값: `latest`)

삭제/복구(소유자/관리자 전용):

- `clawhub delete <slug> --yes`
- `clawhub undelete <slug> --yes`

동기화(로컬 Skills 스캔 + 신규/업데이트 게시):

- `clawhub sync`
- `--root <dir...>`: 추가 스캔 루트
- `--all`: 프롬프트 없이 모두 업로드
- `--dry-run`: 업로드될 항목 미리보기
- `--bump <type>`: 업데이트 시 `patch|minor|major` 사용(기본값: `patch`)
- `--changelog <text>`: 비대화형 업데이트를 위한 변경 로그
- `--tags <tags>`: 쉼표로 구분된 태그(기본값: `latest`)
- `--concurrency <n>`: 레지스트리 검사(기본값: 4)

## 에이전트를 위한 일반적인 워크플로

### Skills 검색

```bash
clawhub search "postgres backups"
```

### 새로운 Skills 다운로드

```bash
clawhub install my-skill-pack
```

### 설치된 Skills 업데이트

```bash
clawhub update --all
```

### Skills 백업(게시 또는 동기화)

단일 Skill 폴더의 경우:

```bash
clawhub publish ./my-skill --slug my-skill --name "My Skill" --version 1.0.0 --tags latest
```

여러 Skills 를 한 번에 스캔하고 백업하려면:

```bash
clawhub sync --all
```

## 고급 세부 사항 (기술적)

### 버전 관리와 태그

- 각 게시 시 새로운 **semver** `SkillVersion` 이 생성됩니다.
- `latest` 와 같은 태그는 특정 버전을 가리키며, 태그 이동을 통해 롤백할 수 있습니다.
- 변경 로그는 버전별로 첨부되며, 동기화 또는 업데이트 게시 시 비워 둘 수 있습니다.

### 로컬 변경 사항과 레지스트리 버전 비교

업데이트 시 로컬 Skill 콘텐츠를 콘텐츠 해시로 레지스트리 버전과 비교합니다. 로컬 파일이 게시된 어떤 버전과도 일치하지 않으면, CLI 는 덮어쓰기 전에 확인을 요청합니다(또는 비대화형 실행 시 `--force` 필요).

### 동기화 스캔과 폴백 루트

`clawhub sync` 는 먼저 현재 workdir 를 스캔합니다. Skills 를 찾지 못하면, 알려진 레거시 위치(예: `~/openclaw/skills` 및 `~/.openclaw/skills`)로 폴백합니다. 이는 추가 플래그 없이도 오래된 Skill 설치를 찾기 위한 설계입니다.

### 저장소와 lockfile

- 설치된 Skills 는 workdir 아래의 `.clawhub/lock.json` 에 기록됩니다.
- 인증 토큰은 ClawHub CLI 설정 파일에 저장됩니다(`CLAWHUB_CONFIG_PATH` 로 재정의 가능).

### 텔레메트리(설치 수)

로그인한 상태에서 `clawhub sync` 를 실행하면, CLI 는 설치 수 계산을 위해 최소한의 스냅샷을 전송합니다. 이를 완전히 비활성화할 수 있습니다:

```bash
export CLAWHUB_DISABLE_TELEMETRY=1
```

## 환경 변수

- `CLAWHUB_SITE`: 사이트 URL 재정의
- `CLAWHUB_REGISTRY`: 레지스트리 API URL 재정의
- `CLAWHUB_CONFIG_PATH`: CLI 가 토큰/설정을 저장하는 위치 재정의
- `CLAWHUB_WORKDIR`: 기본 workdir 재정의
- `CLAWHUB_DISABLE_TELEMETRY=1`: `sync` 에서 텔레메트리 비활성화
