---
summary: "안정판, 베타, 개발 채널: 의미, 전환, 태깅"
read_when:
  - You want to switch between stable/beta/dev
  - 사전 릴리스를 태깅하거나 게시하는 경우
title: "개발 채널"
---

# 개발 채널

마지막 업데이트: 2026-01-21

OpenClaw 는 세 가지 업데이트 채널을 제공합니다:

- **stable**: npm dist-tag `latest`.
- **beta**: npm dist-tag `beta` (테스트 중인 빌드).
- **dev**: moving head of `main` (git). **dev**: `main` (git) 의 최신 헤드. npm dist-tag: `dev` (게시된 경우).

우리는 빌드를 **beta** 에 배포하고 테스트한 뒤, **검증된 빌드를 버전 번호를 변경하지 않고 `latest` 로 승격**합니다 — npm 설치의 단일 기준은 dist-tag 입니다.

## 채널 전환

Git 체크아웃:

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

- `stable`/`beta` 는 최신으로 일치하는 태그를 체크아웃합니다 (대개 동일한 태그).
- `dev` 는 `main` 로 전환하고 업스트림에 리베이스합니다.

npm/pnpm 전역 설치:

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

이는 해당 npm dist-tag (`latest`, `beta`, `dev`) 를 통해 업데이트됩니다.

`--channel` 로 채널을 **명시적으로** 전환하면, OpenClaw 는 설치 방식도 함께 정렬합니다:

- `dev` 는 git 체크아웃을 보장하고 (기본값 `~/openclaw`, `OPENCLAW_GIT_DIR` 로 재정의 가능),
  이를 업데이트한 뒤 해당 체크아웃에서 전역 CLI 를 설치합니다.
- `stable`/`beta` 는 일치하는 dist-tag 를 사용하여 npm 에서 설치합니다.

Tip: if you want stable + dev in parallel, keep two clones and point your gateway at the stable one.

## 플러그인과 채널

`openclaw update` 로 채널을 전환하면, OpenClaw 는 플러그인 소스도 동기화합니다:

- `dev` 는 git 체크아웃에 포함된 번들 플러그인을 우선합니다.
- `stable` 및 `beta` 는 npm 으로 설치된 플러그인 패키지를 복원합니다.

## Tagging best practices

- git 체크아웃이 도달하길 원하는 릴리스를 태깅하십시오 (`vYYYY.M.D` 또는 `vYYYY.M.D-<patch>`).
- 태그는 불변으로 유지하십시오: 태그를 이동하거나 재사용하지 마십시오.
- npm dist-tag 는 npm 설치의 기준으로 유지됩니다:
  - `latest` → stable
  - `beta` → 후보 빌드
  - `dev` → main 스냅샷 (선택 사항)

## macOS 앱 제공 여부

베타 및 개발 빌드에는 macOS 앱 릴리스가 **포함되지 않을 수 있습니다**. 이는 문제 없습니다:

- git 태그와 npm dist-tag 는 여전히 게시할 수 있습니다.
- 릴리스 노트 또는 변경 로그에 '이 베타에는 macOS 빌드가 없음' 을 명시하십시오.
