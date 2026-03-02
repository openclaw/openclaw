---
summary: "ClawHub 가이드: 공개 Skills 레지스트리 + CLI 워크플로우"
read_when:
  - 새 사용자들에게 ClawHub을 소개할 때
  - Skills을 설치, 검색 또는 게시할 때
  - ClawHub CLI 플래그 및 동기화 동작을 설명할 때
title: "ClawHub"
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: tools/clawhub.md
workflow: 15
---

# ClawHub

ClawHub은 **OpenClaw의 공개 Skill 레지스트리**입니다. 무료 서비스입니다: 모든 Skill은 공개, 개방되어 있으며 공유 및 재사용을 위해 모두에게 표시됩니다. Skill은 단순히 `SKILL.md` 파일(및 보조 텍스트 파일)이 있는 폴더입니다. 웹 앱에서 Skill을 탐색하거나 CLI를 사용하여 검색, 설치, 업데이트 및 게시할 수 있습니다.

사이트: [clawhub.ai](https://clawhub.ai)

## ClawHub이 무엇인가

- OpenClaw Skill용 공개 레지스트리.
- Skill 번들 및 메타데이터의 버전 관리 스토어.
- 검색, 태그 및 사용 신호를 위한 발견 표면.

## 작동 방식

1. 사용자가 Skill 번들(파일 + 메타데이터)을 게시합니다.
2. ClawHub이 번들을 저장하고, 메타데이터를 파싱하고, 버전을 할당합니다.
3. 레지스트리가 검색 및 발견을 위해 Skill을 색인합니다.
4. 사용자는 OpenClaw에서 Skill을 탐색, 다운로드 및 설치합니다.

## 수행할 수 있는 것

- 새로운 Skill 및 기존 Skill의 새 버전을 게시합니다.
- 이름, 태그 또는 검색별로 Skill을 발견합니다.
- Skill 번들을 다운로드하고 파일을 검사합니다.
- 학대 또는 안전하지 않은 Skill을 보고합니다.
- 중재자인 경우 숨기기, 표시, 삭제 또는 금지합니다.

## 누가 이것을 사용하는가(초보자 친화적)

OpenClaw 에이전트에 새로운 기능을 추가하려는 경우 ClawHub은 Skill을 찾고 설치하는 가장 쉬운 방법입니다. 백엔드 작동 방식을 알 필요가 없습니다. 다음을 수행할 수 있습니다:

- 일반 언어로 Skill 검색.
- Skill을 작업 공간에 설치합니다.
- 나중에 한 커맨드로 Skill을 업데이트합니다.
- 고유 Skill을 게시하여 백업합니다.

## 빠른 시작(기술 비 사용자)

1. CLI 설치(다음 섹션 참고).
2. 필요한 것을 검색:
   - `clawhub search "calendar"`
3. Skill 설치:
   - `clawhub install <skill-slug>`
4. 새로운 OpenClaw 세션을 시작하여 새 Skill을 선택합니다.

## CLI 설치

다음 중 하나를 선택합니다:

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

## OpenClaw에 어떻게 맞추어지는가

기본적으로 CLI는 현재 작업 디렉터리 아래의 `./skills`에 Skill을 설치합니다. OpenClaw 작업 공간이 구성된 경우 `clawhub`은 `--workdir`(또는 `CLAWHUB_WORKDIR`)를 오버라이드하지 않는 한 해당 작업 공간으로 돌아갑니다. OpenClaw는 `<workspace>/skills`에서 작업 공간 Skill을 로드하고 **다음** 세션에서 선택합니다. 이미 `~/.openclaw/skills` 또는 번들 Skill을 사용하는 경우 작업 공간 Skill이 우선합니다.

Skill이 로드, 공유 및 제어되는 방식에 대한 자세한 내용은
[Skills](/tools/skills)을 참고합니다.

## Skill 시스템 개요

Skill은 OpenClaw에 특정 작업을 수행하는 방법을 알려주는 파일의 버전 관리 번들입니다. 각 게시는 새 버전을 만들고 레지스트리는 사용자가 변경 사항을 감사할 수 있도록 버전 기록을 유지합니다.

일반적인 Skill에는 다음이 포함됩니다:

- 기본 설명 및 사용법이 포함된 `SKILL.md` 파일.
- Skill에서 사용하는 선택적 구성, 스크립트 또는 지원 파일.
- 태그, 요약 및 설치 요구 사항과 같은 메타데이터.

ClawHub은 메타데이터를 사용하여 발견을 강화하고 Skill 기능을 안전하게 노출합니다.
레지스트리는 또한 사용 신호(별 및 다운로드)를 추적하여 순위 및 가시성을 개선합니다.

## 서비스가 제공하는 것(기능)

- **공개 Skill 및 해당 `SKILL.md` 콘텐츠 탐색**.
- **검색** 키워드만 아니라 임베딩(벡터 검색)으로 구동.
- **버전 관리** semver, 변경 로그 및 태그 포함(`latest` 포함).
- **버전당 다운로드** zip으로.
- **별 및 댓글** 커뮤니티 피드백용.
- **중재** 승인 및 감사용 훅.
- **CLI 친화적 API** 자동화 및 스크립팅용.

## 보안 및 중재

ClawHub은 기본적으로 개방적입니다. 누구나 Skill을 업로드할 수 있지만 GitHub 계정이 게시하려면 최소 1주일이 되어야 합니다. 이는 합법적인 기여자를 차단하지 않고 학대를 진행하는 데 도움이 됩니다.

보고 및 중재:

- 로그인한 사용자는 Skill을 보고할 수 있습니다.
- 보고 이유는 필수이며 기록됩니다.
- 각 사용자는 최대 20개의 활성 보고서를 가질 수 있습니다.
- 3개 이상의 고유 보고서가 있는 Skill은 기본적으로 자동 숨겨집니다.
- 중재자는 숨겨진 Skill을 보거나, 숨기기를 해제하거나, 삭제하거나, 사용자를 금지할 수 있습니다.
- 보고 기능을 남용하면 계정 금지 처리될 수 있습니다.

중재자가 되는 데 관심이 있습니까? OpenClaw Discord에서 물어보고 중재자 또는 유지자에게 문의하세요.

## CLI 커맨드 및 파라미터

전역 옵션(모든 커맨드에 적용):

- `--workdir <dir>`: 작업 디렉터리(기본값: 현재 디렉터리; OpenClaw 작업 공간으로 돌아갑니다).
- `--dir <dir>`: Skill 디렉터리, workdir에 상대(기본값: `skills`).
- `--site <url>`: 사이트 기본 URL(브라우저 로그인).
- `--registry <url>`: 레지스트리 API 기본 URL.
- `--no-input`: 프롬프트 비활성화(비 대화형).
- `-V, --cli-version`: CLI 버전 출력.

인증:

- `clawhub login`(브라우저 흐름) 또는 `clawhub login --token <token>`
- `clawhub logout`
- `clawhub whoami`

옵션:

- `--token <token>`: API 토큰 붙여넣기.
- `--label <label>`: 브라우저 로그인 토큰용으로 저장된 레이블(기본값: `CLI token`).
- `--no-browser`: 브라우저를 열지 마십시오(`--token`이 필요함).

검색:

- `clawhub search "query"`
- `--limit <n>`: 최대 결과.

설치:

- `clawhub install <slug>`
- `--version <version>`: 특정 버전 설치.
- `--force`: 폴더가 이미 있으면 덮어씁니다.

업데이트:

- `clawhub update <slug>`
- `clawhub update --all`
- `--version <version>`: 특정 버전으로 업데이트(단일 slug만).
- `--force`: 로컬 파일이 게시된 버전과 일치하지 않을 때 덮어씁니다.

목록:

- `clawhub list`(`.clawhub/lock.json` 읽음)

게시:

- `clawhub publish <path>`
- `--slug <slug>`: Skill slug.
- `--name <name>`: 표시 이름.
- `--version <version>`: Semver 버전.
- `--changelog <text>`: 변경 로그 텍스트(비어있을 수 있음).
- `--tags <tags>`: 쉼표로 구분된 태그(기본값: `latest`).

삭제/삭제 취소(소유자/관리자만):

- `clawhub delete <slug> --yes`
- `clawhub undelete <slug> --yes`

동기화(로컬 Skill 검색 + 새로운/업데이트된 게시):

- `clawhub sync`
- `--root <dir...>`: 추가 검색 루트.
- `--all`: 프롬프트 없이 모든 항목 업로드.
- `--dry-run`: 업로드될 항목 표시.
- `--bump <type>`: 업데이트를 위한 `patch|minor|major`(기본값: `patch`).
- `--changelog <text>`: 비 대화형 업데이트를 위한 변경 로그.
- `--tags <tags>`: 쉼표로 구분된 태그(기본값: `latest`).
- `--concurrency <n>`: 레지스트리 확인(기본값: 4).

## 에이전트를 위한 공통 워크플로우

### Skill 검색

```bash
clawhub search "postgres backups"
```

### 새로운 Skill 다운로드

```bash
clawhub install my-skill-pack
```

### 설치된 Skill 업데이트

```bash
clawhub update --all
```

### Skill 백업(게시 또는 동기화)

단일 Skill 폴더의 경우:

```bash
clawhub publish ./my-skill --slug my-skill --name "My Skill" --version 1.0.0 --tags latest
```

한 번에 많은 Skill을 검색하고 백업:

```bash
clawhub sync --all
```

## 고급 세부 정보(기술)

### 버전 관리 및 태그

- 각 게시는 새로운 **semver** `SkillVersion`을 만듭니다.
- 태그(예: `latest`)는 버전을 가리킵니다; 태그를 이동하면 롤백할 수 있습니다.
- 변경 로그는 버전당 첨부되며 동기화 또는 게시 업데이트 시 비어있을 수 있습니다.

### 로컬 변경 vs 레지스트리 버전

업데이트는 콘텐츠 해시를 사용하여 로컬 Skill 콘텐츠를 레지스트리 버전과 비교합니다. 로컬 파일이 게시된 버전과 일치하지 않으면 CLI가 덮어쓰기 전에 물어봅니다(또는 비 대화형 실행에서 `--force`가 필요함).

### 동기화 검색 및 폴백 루트

`clawhub sync`는 현재 workdir을 먼저 검색합니다. Skill이 없으면 알려진 레거시 위치(예: `~/openclaw/skills` 및 `~/.openclaw/skills`)로 폴백합니다. 이는 추가 플래그 없이 이전 Skill 설치를 찾기 위해 설계되었습니다.

### 저장 및 잠금 파일

- 설치된 Skill은 workdir 아래의 `.clawhub/lock.json`에 기록됩니다.
- 인증 토큰은 ClawHub CLI 구성 파일에 저장됩니다(`CLAWHUB_CONFIG_PATH`로 오버라이드).

### 원격 측정(설치 횟수)

`clawhub sync`를 로그인한 상태에서 실행하면 CLI는 설치 횟수를 계산하기 위해 최소 스냅샷을 보냅니다. 이를 완전히 비활성화할 수 있습니다:

```bash
export CLAWHUB_DISABLE_TELEMETRY=1
```

## 환경 변수

- `CLAWHUB_SITE`: 사이트 URL 오버라이드.
- `CLAWHUB_REGISTRY`: 레지스트리 API URL 오버라이드.
- `CLAWHUB_CONFIG_PATH`: CLI가 토큰/구성을 저장하는 위치 오버라이드.
- `CLAWHUB_WORKDIR`: 기본 workdir 오버라이드.
- `CLAWHUB_DISABLE_TELEMETRY=1`: `sync`에서 원격 측정 비활성화.
