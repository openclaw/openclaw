---
title: "릴리스 채널"
summary: "Stable, beta, dev 채널: 의미론, 전환, 고정 및 태깅"
read_when:
  - stable/beta/dev 간 전환하고 싶을 때
  - 특정 버전, 태그 또는 SHA 를 고정하고 싶을 때
  - 프리릴리스를 태깅하거나 게시할 때
sidebarTitle: "릴리스 채널"
x-i18n:
  source_path: docs/install/development-channels.md
---

# 릴리스 채널

OpenClaw 는 세 가지 업데이트 채널을 제공합니다:

- **stable**: npm dist-tag `latest`. 대부분의 사용자에게 권장됩니다.
- **beta**: npm dist-tag `beta` (테스트 중인 빌드).
- **dev**: `main` 의 이동하는 헤드 (git). npm dist-tag: `dev` (게시된 경우).
  `main` 브랜치는 실험 및 활발한 개발을 위한 것입니다. 불완전한 기능이나
  호환성을 깨는 변경사항이 포함될 수 있습니다. 프로덕션 Gateway 에 사용하지 마세요.

빌드를 **beta** 로 발송하고, 테스트한 다음, 버전 번호를 변경하지 않고
**검증된 빌드를 `latest` 로 승격**합니다 -- dist-tag 이 npm 설치의 정보 출처입니다.

## 채널 전환

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

`--channel` 은 설정 (`update.channel`) 에 선택을 영속하고
설치 방법을 정렬합니다:

- **`stable`/`beta`** (패키지 설치): 일치하는 npm dist-tag 를 통해 업데이트합니다.
- **`stable`/`beta`** (git 설치): 최신 일치하는 git 태그를 체크아웃합니다.
- **`dev`**: git 체크아웃 (기본 `~/openclaw`, `OPENCLAW_GIT_DIR` 로 재정의) 을 확인하고,
  `main` 으로 전환하고, upstream 에서 리베이스하고, 빌드하고, 해당 체크아웃에서
  전역 CLI 를 설치합니다.

팁: stable + dev 를 병렬로 원하면 두 클론을 유지하고 Gateway 를 stable 로
지정하세요.

## 일회성 버전 또는 태그 대상 지정

`--tag` 를 사용하여 영속된 채널을 **변경하지 않고** 단일 업데이트에 특정
dist-tag, 버전 또는 패키지 사양을 대상으로 지정합니다:

```bash
# 특정 버전 설치
openclaw update --tag 2026.3.14

# beta dist-tag 에서 설치 (일회성, 영속되지 않음)
openclaw update --tag beta

# GitHub main 브랜치에서 설치 (npm tarball)
openclaw update --tag main

# 특정 npm 패키지 사양 설치
openclaw update --tag openclaw@2026.3.12
```

참고:

- `--tag` 는 **패키지 (npm) 설치에만** 적용됩니다. Git 설치에서는 무시됩니다.
- 태그는 영속되지 않습니다. 다음 `openclaw update` 는 구성된 채널을
  평소대로 사용합니다.
- 다운그레이드 보호: 대상 버전이 현재 버전보다 오래된 경우 OpenClaw 가
  확인을 요청합니다 (`--yes` 로 건너뛰기).

## Dry run

변경 없이 `openclaw update` 가 수행할 작업을 미리봅니다:

```bash
openclaw update --dry-run
openclaw update --channel beta --dry-run
openclaw update --tag 2026.3.14 --dry-run
openclaw update --dry-run --json
```

Dry run 은 유효 채널, 대상 버전, 계획된 작업 및
다운그레이드 확인이 필요한지 여부를 보여줍니다.

## 플러그인과 채널

`openclaw update` 로 채널을 전환하면 OpenClaw 가 플러그인 소스도
동기화합니다:

- `dev` 는 git 체크아웃의 번들 플러그인을 선호합니다.
- `stable` 과 `beta` 는 npm 으로 설치된 플러그인 패키지를 복원합니다.
- npm 으로 설치된 플러그인은 코어 업데이트 완료 후 업데이트됩니다.

## 현재 상태 확인

```bash
openclaw update status
```

활성 채널, 설치 종류 (git 또는 package), 현재 버전 및
소스 (설정, git 태그, git 브랜치 또는 기본값) 를 보여줍니다.

## 태깅 모범 사례

- git 체크아웃이 도달할 릴리스에 태그를 지정합니다 (stable 의 경우 `vYYYY.M.D`,
  beta 의 경우 `vYYYY.M.D-beta.N`).
- `vYYYY.M.D.beta.N` 도 호환성을 위해 인식되지만 `-beta.N` 을 선호합니다.
- 레거시 `vYYYY.M.D-<patch>` 태그는 여전히 stable (비 beta) 로 인식됩니다.
- 태그를 불변으로 유지합니다: 태그를 이동하거나 재사용하지 마세요.
- npm dist-tag 이 npm 설치의 정보 출처로 유지됩니다:
  - `latest` -> stable
  - `beta` -> 후보 빌드
  - `dev` -> main 스냅샷 (선택 사항)

## macOS 앱 가용성

Beta 와 dev 빌드에는 macOS 앱 릴리스가 **포함되지 않을 수** 있습니다. 이것은 괜찮습니다:

- Git 태그와 npm dist-tag 는 여전히 게시할 수 있습니다.
- 릴리스 노트 또는 변경 로그에 "이 beta 에 대한 macOS 빌드 없음"을 명시하세요.
