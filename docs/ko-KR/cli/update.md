---
summary: "`openclaw update` CLI 참조 (안전한 소스 업데이트 + 게이트웨이 자동 재시작)"
read_when:
  - 소스 검사를 안전하게 업데이트하려는 경우
  - "`--update` 축약 동작을 이해할 필요가 있는 경우"
title: "업데이트"
---

# `openclaw update`

OpenClaw를 안전하게 업데이트하고 안정/베타/개발 채널 간 전환합니다.

**npm/pnpm**을 통해 설치한 경우(글로벌 설치, git 메타데이터 없음), 업데이트는 [업데이트](/install/updating)에서 패키지 관리자 플로우를 통해 이루어집니다.

## 사용법

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

- `--no-restart`: 업데이트 성공 후 게이트웨이 서비스를 재시작하지 않음.
- `--channel <stable|beta|dev>`: 업그레이드 채널 설정 (git + npm; 설정에 지속됨).
- `--tag <dist-tag|version>`: 이번 업데이트에만 npm 배포 태그 또는 버전 재정의.
- `--json`: 기계 가독성 `UpdateRunResult` JSON 출력.
- `--timeout <seconds>`: 단계별 타임아웃 (기본값은 1200초).

참고: 다운그레이드는 이전 버전이 설정을 깨뜨릴 수 있으므로 확인이 필요합니다.

## `update status`

활성 업데이트 채널 + git 태그/분기/SHA (소스 확인용) 및 업데이트 가능성 표시.

```bash
openclaw update status
openclaw update status --json
openclaw update status --timeout 10
```

옵션:

- `--json`: 기계 가독성 상태 JSON 출력.
- `--timeout <seconds>`: 검사용 타임아웃 (기본값은 3초).

## `update wizard`

업데이트 채널을 선택하고 업데이트 후 게이트웨이를 재시작할지 확인하는 상호작용 플로우(기본값은 재시작). git 체크아웃이 없을 경우 `dev`를 선택하면 체크아웃을 생성하라는 제안이 표시됩니다.

## 수행 작업

채널을 명시적으로 전환할 때 (`--channel ...`), OpenClaw는 설치 방법도 일치시킵니다:

- `dev`: git 체크아웃 보장 (기본: `~/openclaw`, `OPENCLAW_GIT_DIR`로 재정의 가능), 업데이트하고 해당 체크아웃에서 글로벌 CLI 설치.
- `stable`/`beta`: 일치하는 배포 태그를 사용하여 npm에서 설치.

## Git 체크아웃 플로우

채널:

- `stable`: 최신 비베타 태그 체크아웃, 빌드 + 검증.
- `beta`: 최신 `-beta` 태그 체크아웃, 빌드 + 검증.
- `dev`: `main` 체크아웃, 가져오기 + 리베이스.

고수준:

1. 깨끗한 작업 트리 필요 (커밋되지 않은 변경 사항 없음).
2. 선택한 채널로 전환 (태그 또는 분기).
3. 상위 소스 가져오기 (개발 전용).
4. 개발 전용: 사전 비행 린트 + TypeScript 빌드 임시 작업 트리; 최종 트리가 실패하면 깨끗한 빌드를 찾기 위해 최대 10 커밋까지 되돌아감.
5. 선택한 커밋에 리베이스 (개발 전용).
6. 종속성 설치 (pnpm 선호; npm 대체).
7. 제어 UI 빌드 + 빌드.
8. 최종 “안전한 업데이트” 검증으로 `openclaw doctor` 실행.
9. 활성 채널로 플러그인 동기화 (개발은 번들 확장 사용; 안정/베타는 npm 사용) 및 npm 설치된 플러그인 업데이트.

## `--update` 축약

`openclaw --update`는 `openclaw update`로 다시 작성됩니다 (셸 및 런처 스크립트에 유용).

## 참조

- `openclaw doctor` (git 체크아웃에서 업데이트를 먼저 실행하도록 제안)
- [개발 채널](/install/development-channels)
- [업데이트](/install/updating)
- [CLI 참조](/cli)
