---
summary: "안정, 베타, 및 개발 채널: 의미, 전환, 태그 지정"
read_when:
  - 안정/베타/개발간 전환을 원할 때
  - 태그를 지정하거나 사전 릴리스를 게시할 때
title: "개발 채널"
---

# 개발 채널

마지막 업데이트: 2026-01-21

OpenClaw는 세 가지 업데이트 채널을 제공합니다:

- **stable**: npm dist-tag `latest`.
- **beta**: npm dist-tag `beta` (테스트 중인 빌드).
- **dev**: moving head of `main` (git). npm dist-tag: `dev` (게시 시).

우리는 빌드를 **beta**로 발송하고, 테스트한 후, 버전 번호를 변경하지 않고 검증된 빌드를 `latest`로 승격시킵니다 — dist-tag는 npm 설치의 진실의 원천입니다.

## 채널 전환하기

Git 체크아웃:

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

- `stable`/`beta`는 최신의 일치하는 태그를 체크 아웃합니다 (종종 동일한 태그).
- `dev`는 `main`으로 전환하고 업스트림에 리베이스합니다.

npm/pnpm 글로벌 설치:

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

이는 해당하는 npm dist-tag (`latest`, `beta`, `dev`)를 통해 업데이트합니다.

`--channel`로 **명시적으로** 채널을 전환할 때, OpenClaw는 설치 방법도 정렬합니다:

- `dev`는 git 체크아웃을 보장하고 (기본값 `~/openclaw`, `OPENCLAW_GIT_DIR`로 재정의),
  이를 업데이트하며, 체크아웃에서 글로벌 CLI를 설치합니다.
- `stable`/`beta`는 일치하는 dist-tag를 사용하여 npm을 통해 설치합니다.

팁: 안정 + 개발을 병렬로 사용하고 싶다면, 두 개의 클론을 유지하고 당신의 게이트웨이를 안정 버전으로 지정하세요.

## 플러그인 및 채널

`openclaw update`로 채널을 전환할 때, OpenClaw는 플러그인 소스를 동기화합니다:

- `dev`는 git 체크아웃에서 번들된 플러그인을 선호합니다.
- `stable` 및 `beta`는 npm에서 설치된 플러그인 패키지를 복원합니다.

## 태그 지정 모범 사례

- git 체크아웃이 도달하기를 원하는 릴리스를 태그 지정하세요 (`vYYYY.M.D` 또는 `vYYYY.M.D-<patch>`).
- 태그를 변하지 않게 유지하세요: 태그를 이동하거나 재사용하지 마세요.
- npm dist-tag는 npm 설치의 진실의 원천으로 남아 있습니다:
  - `latest` → stable
  - `beta` → candidate build
  - `dev` → main snapshot (선택 사항)

## macOS 앱 가용성

베타 및 개발 빌드는 **macOS 앱 릴리스**를 포함하지 않을 수 있습니다. 괜찮습니다:

- git 태그와 npm dist-tag는 여전히 게시될 수 있습니다.
- 릴리스 노트나 변경 로그에서 "이 베타 버전에 macOS 빌드 없음" 을 언급하세요.
