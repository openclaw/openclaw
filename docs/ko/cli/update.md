---
summary: "`openclaw update`에 대한 CLI 레퍼런스 (안전한 소스 업데이트 + Gateway(게이트웨이) 자동 재시작)"
read_when:
  - 소스 체크아웃을 안전하게 업데이트하려는 경우
  - "`--update` 축약 동작을 이해해야 하는 경우"
title: "업데이트"
---

# `openclaw update`

OpenClaw 를 안전하게 업데이트하고 stable/beta/dev 채널 간을 전환합니다.

**npm/pnpm**(전역 설치, git 메타데이터 없음)으로 설치한 경우, 업데이트는 [Updating](/install/updating)에 설명된 패키지 매니저 흐름을 통해 수행됩니다.

## Usage

```bash
openclaw update
openclaw update status
openclaw update wizard
openclaw update --channel beta
openclaw update --channel dev
openclaw update --tag beta
openclaw update --no-restart
openclaw update --json
openclaw --update
```

## Options

- `--no-restart`: 성공적인 업데이트 후 Gateway(게이트웨이) 서비스 재시작을 건너뜁니다.
- `--channel <stable|beta|dev>`: 업데이트 채널을 설정합니다 (git + npm; 설정에 영구 저장됨).
- `--tag <dist-tag|version>`: 이번 업데이트에 한해 npm dist-tag 또는 버전을 재정의합니다.
- `--json`: 기계 판독 가능한 `UpdateRunResult` JSON 을 출력합니다.
- `--timeout <seconds>`: 단계별 타임아웃 (기본값은 1200s).

참고: 이전 버전으로의 다운그레이드는 오래된 버전이 구성을 손상시킬 수 있으므로 확인이 필요합니다.

## `update status`

활성 업데이트 채널 + git 태그/브랜치/SHA(소스 체크아웃의 경우)와 업데이트 가능 여부를 표시합니다.

```bash
openclaw update status
openclaw update status --json
openclaw update status --timeout 10
```

Options:

- `--json`: 기계 판독 가능한 상태 JSON 을 출력합니다.
- `--timeout <seconds>`: 검사 타임아웃 (기본값은 3s).

## `update wizard`

업데이트 채널을 선택하고 업데이트 후 Gateway(게이트웨이)를 재시작할지 여부를 확인하는 대화형 흐름입니다
(기본값은 재시작). git 체크아웃 없이 `dev` 를 선택하면,
체크아웃을 생성할지 제안합니다.

## What it does

채널을 명시적으로 전환하면 (`--channel ...`), OpenClaw 는
설치 방법도 함께 정렬합니다:

- `dev` → git 체크아웃을 보장합니다 (기본값: `~/openclaw`, `OPENCLAW_GIT_DIR` 로 재정의 가능),
  이를 업데이트하고 해당 체크아웃에서 전역 CLI 를 설치합니다.
- `stable`/`beta` → 일치하는 dist-tag 를 사용하여 npm 에서 설치합니다.

## Git checkout flow

Channels:

- `stable`: 최신 비 베타 태그를 체크아웃한 다음 build + doctor 를 실행합니다.
- `beta`: 최신 `-beta` 태그를 체크아웃한 다음 build + doctor 를 실행합니다.
- `dev`: `main` 를 체크아웃한 다음 fetch + rebase 를 수행합니다.

High-level:

1. 깨끗한 워크트리(커밋되지 않은 변경 사항 없음)가 필요합니다.
2. 선택한 채널(태그 또는 브랜치)로 전환합니다.
3. 업스트림을 fetch 합니다 (dev 전용).
4. dev 전용: 임시 워크트리에서 사전 검사 lint + TypeScript 빌드를 수행합니다; 최신 팁이 실패하면, 가장 최신의 정상 빌드를 찾기 위해 최대 10 커밋까지 거슬러 올라갑니다.
5. 선택한 커밋으로 rebase 합니다 (dev 전용).
6. 의존성을 설치합니다 (pnpm 우선; npm 대체).
7. Control UI 를 빌드하고 빌드합니다.
8. 최종 '안전 업데이트' 검사로 `openclaw doctor` 를 실행합니다.
9. 활성 채널로 플러그인을 동기화합니다 (dev 는 번들 확장을 사용; stable/beta 는 npm 사용) 그리고 npm 으로 설치된 플러그인을 업데이트합니다.

## `--update` shorthand

`openclaw --update` 는 `openclaw update` 로 재작성됩니다 (셸 및 런처 스크립트에 유용).

## See also

- `openclaw doctor` (git 체크아웃에서 먼저 업데이트를 실행하도록 제안)
- [Development channels](/install/development-channels)
- [Updating](/install/updating)
- [CLI reference](/cli)
