---
summary: "Stable, beta, and dev channels: semantics, switching, and tagging"
read_when:
  - You want to switch between stable/beta/dev
  - You are tagging or publishing prereleases
title: "Development Channels"
x-i18n:
  source_hash: 2b01219b7e705044ce39838a0da7c7fa65c719809ab2f8a51e14529064af81bf
---

# 개발 채널

최종 업데이트 날짜: 2026-01-21

OpenClaw는 세 가지 업데이트 채널을 제공합니다.

- **안정적**: npm dist-tag `latest`.
- **베타**: npm dist-tag `beta` (테스트 중인 빌드).
- **개발자**: `main`(git)의 헤드를 이동합니다. npm dist-tag: `dev` (게시 시).

빌드를 **베타**로 출시하고 테스트한 다음 **검토된 빌드를 `latest`로 승격합니다**
버전 번호를 변경하지 않고 — dist-tags는 npm 설치의 정보 소스입니다.

## 채널 전환

Git 체크아웃:

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

- `stable`/`beta` 최근 일치하는 태그(종종 동일한 태그)를 확인하세요.
- `dev`는 `main`로 전환되고 업스트림을 기준으로 리베이스됩니다.

npm/pnpm 전역 설치:

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

이는 해당 npm dist-tag(`latest`, `beta`, `dev`)를 통해 업데이트됩니다.

`--channel`를 사용하여 **명시적으로** 채널을 전환하면 OpenClaw도 정렬합니다.
설치 방법:

- `dev` git 체크아웃을 보장합니다(기본값 `~/openclaw`, `OPENCLAW_GIT_DIR`로 재정의),
  이를 업데이트하고 해당 체크아웃에서 전역 CLI를 설치합니다.
- `stable`/`beta`는 일치하는 dist-tag를 사용하여 npm에서 설치합니다.

팁: stable + dev를 병렬로 사용하려면 두 개의 클론을 유지하고 게이트웨이가 stable 복제본을 가리키도록 하세요.

## 플러그인 및 채널

`openclaw update`로 채널을 전환하면 OpenClaw는 플러그인 소스도 동기화합니다.

- `dev`는 git 체크아웃에서 번들 플러그인을 선호합니다.
- `stable` 및 `beta` npm이 설치된 플러그인 패키지를 복원합니다.

## 태그 지정 모범 사례

- git 체크아웃이 시작되기를 원하는 태그 릴리스(`vYYYY.M.D` 또는 `vYYYY.M.D-<patch>`).
- 태그를 변경할 수 없도록 유지: 태그를 이동하거나 재사용하지 마세요.
- npm dist-tags는 npm 설치에 대한 정보 소스로 남아 있습니다.
  - `latest` → 안정
  - `beta` → 후보 빌드
  - `dev` → 메인 스냅샷(선택)

## macOS 앱 가용성

베타 및 개발 빌드에는 macOS 앱 릴리스가 포함되지 **않을** 수 있습니다. 괜찮습니다:

- git 태그와 npm dist-tag는 계속 게시할 수 있습니다.
- 릴리스 노트나 변경 로그에 "이 베타용 macOS 빌드가 없습니다"라고 명시하세요.
