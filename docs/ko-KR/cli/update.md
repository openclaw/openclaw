---
summary: "`openclaw update` CLI 레퍼런스 (안전한 소스 업데이트 + Gateway 자동 재시작)"
read_when:
  - "소스 체크아웃을 안전하게 업데이트하고 싶을 때"
  - "`--update` 축약 동작을 이해해야 할 때"
title: "update"
x-i18n:
  source_path: "docs/cli/update.md"
---

# `openclaw update`

OpenClaw를 안전하게 업데이트하고 stable/beta/dev 채널 간 전환합니다.

**npm/pnpm** (글로벌 설치, git 메타데이터 없음)으로 설치한 경우, 업데이트는 [Updating](/install/updating)의 패키지 매니저 흐름을 통해 이루어집니다.

## 사용법

```bash
openclaw update
openclaw update status
openclaw update wizard
openclaw update --channel beta
openclaw update --channel dev
openclaw update --tag beta
openclaw update --tag main
openclaw update --dry-run
openclaw update --no-restart
openclaw update --json
openclaw --update
```

## 옵션

- `--no-restart`: 성공적인 업데이트 후 Gateway 서비스 재시작을 건너뜁니다.
- `--channel <stable|beta|dev>`: 업데이트 채널을 설정합니다 (git + npm; 설정에 저장됨).
- `--tag <dist-tag|version|spec>`: 이번 업데이트에 대해서만 패키지 대상을 재정의합니다. 패키지 설치의 경우, `main`은 `github:openclaw/openclaw#main`으로 매핑됩니다.
- `--dry-run`: 설정 쓰기, 설치, 플러그인 동기화 또는 재시작 없이 계획된 업데이트 작업 (채널/태그/대상/재시작 흐름)을 미리 봅니다.
- `--json`: 기계 판독 가능한 `UpdateRunResult` JSON을 출력합니다.
- `--timeout <seconds>`: 단계별 타임아웃 (기본값 1200초).

참고: 다운그레이드는 이전 버전이 설정을 깨뜨릴 수 있으므로 확인이 필요합니다.

## `update status`

활성 업데이트 채널 + git 태그/브랜치/SHA (소스 체크아웃의 경우), 그리고 업데이트 가용성을 표시합니다.

```bash
openclaw update status
openclaw update status --json
openclaw update status --timeout 10
```

옵션:

- `--json`: 기계 판독 가능한 상태 JSON을 출력합니다.
- `--timeout <seconds>`: 검사 타임아웃 (기본값 3초).

## `update wizard`

업데이트 채널을 선택하고 업데이트 후 Gateway를 재시작할지 확인하는 대화형 흐름입니다 (기본값은 재시작). git 체크아웃 없이 `dev`를 선택하면 체크아웃 생성을 제안합니다.

## 동작 방식

명시적으로 채널을 전환하면 (`--channel ...`), OpenClaw는 설치 방법도 맞춰 정렬합니다:

- `dev` → git 체크아웃을 보장하고 (기본값: `~/openclaw`, `OPENCLAW_GIT_DIR`로 재정의), 업데이트한 후 해당 체크아웃에서 글로벌 CLI를 설치합니다.
- `stable`/`beta` → 매칭되는 dist-tag를 사용하여 npm에서 설치합니다.

Gateway 코어 자동 업데이터 (설정을 통해 활성화된 경우)는 동일한 업데이트 경로를 재사용합니다.

## Git 체크아웃 흐름

채널:

- `stable`: 최신 비베타 태그를 체크아웃한 후 build + doctor.
- `beta`: 최신 `-beta` 태그를 체크아웃한 후 build + doctor.
- `dev`: `main`을 체크아웃한 후 fetch + rebase.

대략적인 흐름:

1. 클린 작업 트리가 필요합니다 (커밋되지 않은 변경 없음).
2. 선택한 채널 (태그 또는 브랜치)로 전환합니다.
3. 업스트림을 가져옵니다 (dev에만 해당).
4. dev에만 해당: 임시 작업 트리에서 lint + TypeScript 빌드 사전 검사. 팁이 실패하면 최신 클린 빌드를 찾기 위해 최대 10개 커밋을 거슬러 올라갑니다.
5. 선택한 커밋으로 리베이스합니다 (dev에만 해당).
6. 의존성을 설치합니다 (pnpm 선호; npm 폴백).
7. 빌드 + Control UI를 빌드합니다.
8. 최종 "안전한 업데이트" 점검으로 `openclaw doctor`를 실행합니다.
9. 활성 채널에 플러그인을 동기화하고 (dev는 번들 확장 사용; stable/beta는 npm 사용) npm으로 설치된 플러그인을 업데이트합니다.

## `--update` 축약

`openclaw --update`는 `openclaw update`로 재작성됩니다 (셸 및 런처 스크립트에 유용).

## 참고 문서

- `openclaw doctor` (git 체크아웃에서 먼저 업데이트 실행을 제안)
- [Development channels](/install/development-channels)
- [Updating](/install/updating)
- [CLI reference](/cli)
