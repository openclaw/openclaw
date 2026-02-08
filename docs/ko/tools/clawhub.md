---
read_when:
    - 신규 사용자에게 ClawHub 소개
    - 설치, 검색 또는 게시 기술
    - ClawHub CLI 플래그 및 동기화 동작 설명
summary: 'ClawHub 가이드: 공개 기술 레지스트리 + CLI 워크플로'
title: 클로허브
x-i18n:
    generated_at: "2026-02-08T16:10:39Z"
    model: gtx
    provider: google-translate
    source_hash: b572473a1124635744cfe537143249cd57659b511d060bb631ffddba7c8c8315
    source_path: tools/clawhub.md
    workflow: 15
---

# 클로허브

클로허브는 **OpenClaw용 공개 기술 등록**. 무료 서비스입니다. 모든 기술은 공개적이고 개방적이며 모든 사람이 공유하고 재사용할 수 있습니다. 스킬은 단지 `SKILL.md` 파일(지원 텍스트 파일 포함). 웹 앱에서 스킬을 찾아보거나 CLI를 사용하여 스킬을 검색, 설치, 업데이트 및 게시할 수 있습니다.

대지: [클로허브.ai](https://clawhub.ai)

## ClawHub가 무엇인가요?

- OpenClaw 기술을 위한 공개 등록부입니다.
- 버전이 지정된 스킬 번들 및 메타데이터 저장소입니다.
- 검색, 태그, 사용 신호를 위한 검색 표면입니다.

## 작동 원리

1. 사용자가 기술 번들(파일 + 메타데이터)을 게시합니다.
2. ClawHub는 번들을 저장하고, 메타데이터를 구문 분석하고, 버전을 할당합니다.
3. 레지스트리는 검색 및 발견을 위한 기술을 색인화합니다.
4. 사용자는 OpenClaw에서 기술을 탐색, 다운로드 및 설치합니다.

## 당신이 할 수 있는 일

- 새로운 기술과 기존 기술의 새 버전을 게시합니다.
- 이름, 태그 또는 검색으로 기술을 찾아보세요.
- 스킬 번들을 다운로드하고 해당 파일을 검사하세요.
- 모욕적이거나 안전하지 않은 기술을 신고하세요.
- 귀하가 중재자라면 숨기기, 숨기기 해제, 삭제 또는 차단을 수행하세요.

## 누구를 위한 것인지(초보자 친화적)

OpenClaw 에이전트에 새로운 기능을 추가하려는 경우 ClawHub가 기술을 찾고 설치하는 가장 쉬운 방법입니다. 백엔드가 어떻게 작동하는지 알 필요가 없습니다. 다음을 수행할 수 있습니다.

- 일반 언어로 기술을 검색합니다.
- 작업 공간에 스킬을 설치하십시오.
- 나중에 하나의 명령으로 스킬을 업데이트하세요.
- 자신의 기술을 게시하여 백업하세요.

## 빠른 시작(비기술적)

1. CLI를 설치합니다(다음 섹션 참조).
2. 필요한 것을 검색하세요:
   - `clawhub search "calendar"`
3. 스킬 설치:
   - `clawhub install <skill-slug>`
4. 새로운 OpenClaw 세션을 시작하여 새로운 기술을 습득하세요.

## CLI 설치

하나를 선택하세요:

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

## OpenClaw에 어떻게 적용되나요?

기본적으로 CLI는 다음에 기술을 설치합니다. `./skills` 현재 작업 디렉토리 아래에 있습니다. OpenClaw 작업공간이 구성된 경우, `clawhub` 재정의하지 않는 한 해당 작업 공간으로 돌아갑니다. `--workdir` (또는 `CLAWHUB_WORKDIR`). OpenClaw는 다음에서 작업 공간 기술을 로드합니다. `<workspace>/skills` 그리고 그 곳에서 그것들을 데리러 갈 거예요 **다음** 세션. 이미 사용하고 계시다면 `~/.openclaw/skills` 또는 번들 기술인 경우 작업 공간 기술이 우선 적용됩니다.

기술을 로드, 공유 및 제한하는 방법에 대한 자세한 내용은 다음을 참조하세요.
[기술](/tools/skills).

## 스킬 시스템 개요

스킬은 OpenClaw에게 작업을 수행하는 방법을 가르치는 버전이 지정된 파일 번들입니다.
특정 작업. 게시할 때마다 새 버전이 생성되고 레지스트리는
사용자가 변경 사항을 감사할 수 있도록 버전 기록.

일반적인 기술에는 다음이 포함됩니다.

- 에이 `SKILL.md` 기본 설명과 사용법이 포함된 파일입니다.
- 스킬에서 사용하는 선택적 구성, 스크립트 또는 지원 파일입니다.
- 태그, 요약, 설치 요구 사항 등의 메타데이터입니다.

ClawHub는 메타데이터를 사용하여 검색을 강화하고 기술 기능을 안전하게 노출합니다.
또한 레지스트리는 사용 신호(예: 별표 및 다운로드)를 추적하여 개선합니다.
순위 및 가시성.

## 서비스가 제공하는 것(기능)

- **공개 브라우징** 기술과 그들의 `SKILL.md` 콘텐츠.
- **찾다** 키워드뿐만 아니라 임베딩(벡터 검색)을 기반으로 합니다.
- **버전 관리** semver, 변경 로그 및 태그 포함(포함 `latest`).
- **다운로드** 버전별로 zip으로.
- **별표 및 댓글** 커뮤니티 피드백을 위해.
- **절도** 승인 및 감사를 위한 후크.
- **CLI 친화적인 API** 자동화 및 스크립팅용.

## 보안 및 조정

ClawHub는 기본적으로 열려 있습니다. 누구나 기술을 업로드할 수 있지만 GitHub 계정이 있어야 합니다.
게시하려면 최소 1주일이 지나야 합니다. 이렇게 하면 차단하지 않고 악용을 늦추는 데 도움이 됩니다.
합법적인 기여자.

보고 및 조정:

- 로그인한 사용자는 누구나 기술을 보고할 수 있습니다.
- 신고사유를 필수로 기재하고 기록합니다.
- 각 사용자는 한 번에 최대 20개의 활성 보고서를 보유할 수 있습니다.
- 3개 이상의 고유 보고서가 있는 스킬은 기본적으로 자동으로 숨겨집니다.
- 중재자는 숨겨진 기술을 보고, 숨김을 해제하고, 삭제하거나 사용자를 차단할 수 있습니다.
- 신고 기능을 남용하면 계정이 차단될 수 있습니다.

중재자가 되는 데 관심이 있으십니까? OpenClaw Discord에 문의하고 담당자에게 문의하세요.
중재자 또는 유지관리자.

## CLI 명령 및 매개변수

전역 옵션(모든 명령에 적용):

- `--workdir <dir>`: 작업 디렉터리(기본값: 현재 디렉터리, OpenClaw 작업 공간으로 대체).
- `--dir <dir>`: workdir을 기준으로 한 Skills 디렉터리(기본값: `skills`).
- `--site <url>`: 사이트 기본 URL(브라우저 로그인)입니다.
- `--registry <url>`: 레지스트리 API 기본 URL입니다.
- `--no-input`: 프롬프트를 비활성화합니다(비대화형).
- `-V, --cli-version`: CLI 버전을 인쇄합니다.

인증:

- `clawhub login` (브라우저 흐름) 또는 `clawhub login --token <token>`
- `clawhub logout`
- `clawhub whoami`

옵션:

- `--token <token>`: API 토큰을 붙여넣습니다.
- `--label <label>`: 브라우저 로그인 토큰에 대해 저장된 라벨(기본값: `CLI token`).
- `--no-browser`: 브라우저를 열지 마십시오(필수 `--token`).

찾다:

- `clawhub search "query"`
- `--limit <n>`: 최대 결과.

설치하다:

- `clawhub install <slug>`
- `--version <version>`: 특정 버전을 설치합니다.
- `--force`: 폴더가 이미 존재하는 경우 덮어씁니다.

업데이트:

- `clawhub update <slug>`
- `clawhub update --all`
- `--version <version>`: 특정 버전으로 업데이트합니다(단일 슬러그에만 해당).
- `--force`: 로컬 파일이 게시된 버전과 일치하지 않으면 덮어씁니다.

목록:

- `clawhub list` (읽는다 `.clawhub/lock.json`)

게시:

- `clawhub publish <path>`
- `--slug <slug>`: 스킬슬러그.
- `--name <name>`: 표시 이름.
- `--version <version>`: 셈버 버전.
- `--changelog <text>`: 변경 로그 텍스트(비어 있을 수 있음)
- `--tags <tags>`: 쉼표로 구분된 태그(기본값: `latest`).

삭제/삭제 취소(소유자/관리자 전용):

- `clawhub delete <slug> --yes`
- `clawhub undelete <slug> --yes`

동기화(로컬 기술 스캔 + 신규/업데이트 게시):

- `clawhub sync`
- `--root <dir...>`: 추가 스캔 루트.
- `--all`: 프롬프트 없이 모든 것을 업로드합니다.
- `--dry-run`: 업로드할 내용을 표시합니다.
- `--bump <type>`: `patch|minor|major` 업데이트용(기본값: `patch`).
- `--changelog <text>`: 비대화형 업데이트에 대한 변경 로그입니다.
- `--tags <tags>`: 쉼표로 구분된 태그(기본값: `latest`).
- `--concurrency <n>`: 레지스트리 검사(기본값: 4).

## 상담원을 위한 일반적인 워크플로

### 기술 검색

```bash
clawhub search "postgres backups"
```

### 새로운 기술 다운로드

```bash
clawhub install my-skill-pack
```

### 설치된 스킬 업데이트

```bash
clawhub update --all
```

### 기술 백업(게시 또는 동기화)

단일 스킬 폴더의 경우:

```bash
clawhub publish ./my-skill --slug my-skill --name "My Skill" --version 1.0.0 --tags latest
```

한 번에 여러 기술을 스캔하고 백업하려면:

```bash
clawhub sync --all
```

## 고급 세부정보(기술적)

### 버전 관리 및 태그

- 게시할 때마다 새로운 **셈버** `SkillVersion`.
- 태그(예: `latest`) 버전을 가리킵니다. 태그를 이동하면 롤백할 수 있습니다.
- 변경 로그는 버전별로 첨부되며 업데이트를 동기화하거나 게시할 때 비어 있을 수 있습니다.

### 로컬 변경 사항과 레지스트리 버전 비교

업데이트는 콘텐츠 해시를 사용하여 로컬 기술 콘텐츠를 레지스트리 버전과 비교합니다. 로컬 파일이 게시된 버전과 일치하지 않는 경우 CLI는 덮어쓰기 전에 묻습니다(또는 `--force` 비대화형 실행에서).

### 동기화 검색 및 대체 루트

`clawhub sync` 현재 작업 디렉토리를 먼저 스캔합니다. 기술이 발견되지 않으면 알려진 레거시 위치로 대체됩니다(예: `~/openclaw/skills` 그리고 `~/.openclaw/skills`). 이는 추가 플래그 없이 이전 기술 설치를 찾도록 설계되었습니다.

### 저장소 및 잠금 파일

- 장착된 스킬은 다음과 같이 기록됩니다. `.clawhub/lock.json` 귀하의 작업 디렉토리 아래에 있습니다.
- 인증 토큰은 ClawHub CLI 구성 파일에 저장됩니다(다음을 통해 재정의됨). `CLAWHUB_CONFIG_PATH`).

### 원격 측정(설치 수)

당신이 달릴 때 `clawhub sync` 로그인한 동안 CLI는 설치 수를 계산하기 위해 최소 스냅샷을 보냅니다. 이 기능을 완전히 비활성화할 수 있습니다.

```bash
export CLAWHUB_DISABLE_TELEMETRY=1
```

## 환경변수

- `CLAWHUB_SITE`: 사이트 URL을 재정의합니다.
- `CLAWHUB_REGISTRY`: 레지스트리 API URL을 재정의합니다.
- `CLAWHUB_CONFIG_PATH`: CLI가 토큰/구성을 저장하는 위치를 재정의합니다.
- `CLAWHUB_WORKDIR`: 기본 작업 디렉터리를 재정의합니다.
- `CLAWHUB_DISABLE_TELEMETRY=1`: 원격 측정 비활성화 `sync`.
