---
read_when:
    - 소스 체크아웃을 안전하게 업데이트하고 싶습니다.
    - '`--update` 속기 동작을 이해해야 합니다.'
summary: '`openclaw update`에 대한 CLI 참조(안전한 소스 업데이트 + 게이트웨이 자동 다시 시작)'
title: 업데이트
x-i18n:
    generated_at: "2026-02-08T15:49:48Z"
    model: gtx
    provider: google-translate
    source_hash: 3a08e8ac797612c498eef54ecb83e61c9a1ee5de09162a01dbb4b3bd72897206
    source_path: cli/update.md
    workflow: 15
---

# `openclaw update`

OpenClaw를 안전하게 업데이트하고 안정/베타/개발 채널 간에 전환하세요.

통해 설치한 경우 **npm/pnpm** (전역 설치, Git 메타데이터 없음), 업데이트는 패키지 관리자 흐름을 통해 발생합니다. [업데이트 중](/install/updating).

## 용법

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

## 옵션

- `--no-restart`: 업데이트 성공 후 게이트웨이 서비스 다시 시작을 건너뜁니다.
- `--channel <stable|beta|dev>`: 업데이트 채널을 설정합니다(git + npm, 구성에 유지됨).
- `--tag <dist-tag|version>`: 이 업데이트에 대해서만 npm dist-tag 또는 버전을 재정의합니다.
- `--json`: 기계가 읽을 수 있는 인쇄 `UpdateRunResult` JSON.
- `--timeout <seconds>`: 단계당 시간 제한(기본값은 1200초)입니다.

참고: 이전 버전에서는 구성이 중단될 수 있으므로 다운그레이드하려면 확인이 필요합니다.

## `update status`

활성 업데이트 채널 + git tag/branch/SHA(소스 체크아웃용) 및 업데이트 가용성을 표시합니다.

```bash
openclaw update status
openclaw update status --json
openclaw update status --timeout 10
```

옵션:

- `--json`: 기계가 읽을 수 있는 상태 JSON을 인쇄합니다.
- `--timeout <seconds>`: 확인 시간 초과(기본값은 3초)

## `update wizard`

업데이트 채널을 선택하고 게이트웨이를 다시 시작할지 여부를 확인하는 대화형 흐름
업데이트 후(기본값은 다시 시작) 선택하면 `dev` git checkout 없이는
만들겠다고 제안합니다.

## 기능

명시적으로 채널을 전환하는 경우(`--channel ...`), OpenClaw는 또한
설치 방법 정렬:

- `dev` → git 체크아웃을 보장합니다(기본값: `~/openclaw`, 다음으로 재정의 `OPENCLAW_GIT_DIR`),
  이를 업데이트하고 해당 체크아웃에서 전역 CLI를 설치합니다.
- `stable`/`beta` → 일치하는 dist-tag를 사용하여 npm에서 설치합니다.

## Git 체크아웃 흐름

채널:

- `stable`: 최신 비베타 태그를 확인한 다음 빌드 + 닥터를 확인하세요.
- `beta`: 최신 정보 확인 `-beta` 태그를 지정한 다음 빌드 + 의사를 선택하세요.
- `dev`: 결제 `main`, 가져오기 + 리베이스를 수행합니다.

상위 수준:

1. 깨끗한 작업 트리가 필요합니다(커밋되지 않은 변경 사항 없음).
2. 선택한 채널(태그 또는 분기)로 전환합니다.
3. 업스트림을 가져옵니다(개발자에게만 해당).
4. 개발자 전용: 임시 작업 트리에서 프리플라이트 린트 + TypeScript 빌드; 팁이 실패하면 최대 10개의 커밋을 다시 확인하여 최신 클린 빌드를 찾습니다.
5. 선택한 커밋을 기준으로 리베이스합니다(개발자 전용).
6. deps를 설치합니다(pnpm 선호, npm fallback).
7. 컨트롤 UI를 빌드하고 빌드합니다.
8. 실행 `openclaw doctor` 최종 "안전한 업데이트" 확인으로.
9. 플러그인을 활성 채널에 동기화하고(개발자는 번들 확장을 사용하고 stable/beta는 npm을 사용함) npm이 설치된 플러그인을 업데이트합니다.

## `--update` 속기

`openclaw --update` 다시 작성 `openclaw update` (셸 및 실행 프로그램 스크립트에 유용함)

## 또한보십시오

- `openclaw doctor` (git 체크아웃 시 업데이트를 먼저 실행하도록 제안)
- [개발 채널](/install/development-channels)
- [업데이트 중](/install/updating)
- [CLI 참조](/cli)
