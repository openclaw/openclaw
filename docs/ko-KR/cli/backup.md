---
summary: "`openclaw backup` CLI 레퍼런스 (로컬 백업 아카이브 생성)"
read_when:
  - 로컬 OpenClaw 상태에 대한 공식 백업 아카이브를 원할 때
  - 초기화 또는 제거 전에 포함될 경로를 미리 확인하고 싶을 때
title: "backup"
x-i18n:
  source_path: "docs/cli/backup.md"
---

# `openclaw backup`

OpenClaw 상태, 설정, 자격 증명, 세션, 그리고 선택적으로 워크스페이스에 대한 로컬 백업 아카이브를 생성합니다.

```bash
openclaw backup create
openclaw backup create --output ~/Backups
openclaw backup create --dry-run --json
openclaw backup create --verify
openclaw backup create --no-include-workspace
openclaw backup create --only-config
openclaw backup verify ./2026-03-09T00-00-00.000Z-openclaw-backup.tar.gz
```

## 참고

- 아카이브에는 해석된 소스 경로와 아카이브 레이아웃이 포함된 `manifest.json` 파일이 있습니다.
- 기본 출력은 현재 작업 디렉터리의 타임스탬프가 포함된 `.tar.gz` 아카이브입니다.
- 현재 작업 디렉터리가 백업 소스 트리 내부에 있으면, OpenClaw는 기본 아카이브 위치로 홈 디렉터리를 사용합니다.
- 기존 아카이브 파일은 절대 덮어쓰지 않습니다.
- 소스 상태/워크스페이스 트리 내부의 출력 경로는 자기 포함을 방지하기 위해 거부됩니다.
- `openclaw backup verify <archive>`는 아카이브에 정확히 하나의 루트 매니페스트가 포함되어 있는지 확인하고, 경로 순회 스타일의 아카이브 경로를 거부하며, 매니페스트에 선언된 모든 페이로드가 tarball에 존재하는지 확인합니다.
- `openclaw backup create --verify`는 아카이브를 작성한 직후 해당 검증을 실행합니다.
- `openclaw backup create --only-config`는 활성 JSON 설정 파일만 백업합니다.

## 백업 대상

`openclaw backup create`는 로컬 OpenClaw 설치에서 백업 소스를 계획합니다:

- OpenClaw의 로컬 상태 리졸버가 반환하는 상태 디렉터리, 보통 `~/.openclaw`
- 활성 설정 파일 경로
- OAuth / 자격 증명 디렉터리
- 현재 설정에서 발견된 워크스페이스 디렉터리 (`--no-include-workspace`를 전달하지 않은 경우)

`--only-config`를 사용하면 OpenClaw는 상태, 자격 증명 및 워크스페이스 검색을 건너뛰고 활성 설정 파일 경로만 아카이브합니다.

OpenClaw는 아카이브를 빌드하기 전에 경로를 정규화합니다. 설정, 자격 증명 또는 워크스페이스가 이미 상태 디렉터리 내부에 있는 경우, 별도의 최상위 백업 소스로 중복되지 않습니다. 누락된 경로는 건너뜁니다.

아카이브 페이로드는 해당 소스 트리의 파일 내용을 저장하며, 포함된 `manifest.json`은 각 자산에 사용된 해석된 절대 소스 경로와 아카이브 레이아웃을 기록합니다.

## 잘못된 설정 동작

`openclaw backup`은 복구 중에도 도움을 줄 수 있도록 일반적인 설정 사전 검사를 의도적으로 우회합니다. 워크스페이스 검색은 유효한 설정에 의존하기 때문에, 설정 파일이 존재하지만 유효하지 않고 워크스페이스 백업이 활성화된 경우 `openclaw backup create`는 즉시 실패합니다.

해당 상황에서 부분 백업을 원한다면 다음을 다시 실행하세요:

```bash
openclaw backup create --no-include-workspace
```

이렇게 하면 워크스페이스 검색을 완전히 건너뛰면서 상태, 설정 및 자격 증명은 범위에 유지합니다.

설정 파일 자체의 사본만 필요한 경우, `--only-config`는 워크스페이스 검색을 위한 설정 파싱에 의존하지 않으므로 설정이 잘못된 경우에도 작동합니다.

## 크기 및 성능

OpenClaw는 내장된 최대 백업 크기나 파일별 크기 제한을 적용하지 않습니다.

실질적인 제한은 로컬 머신과 대상 파일시스템에서 옵니다:

- 임시 아카이브 쓰기와 최종 아카이브를 위한 사용 가능한 공간
- 대규모 워크스페이스 트리를 탐색하고 `.tar.gz`로 압축하는 시간
- `openclaw backup create --verify`를 사용하거나 `openclaw backup verify`를 실행할 때 아카이브를 다시 스캔하는 시간
- 대상 경로에서의 파일시스템 동작. OpenClaw는 비덮어쓰기 하드링크 발행 단계를 선호하며, 하드링크가 지원되지 않으면 독점 복사로 폴백합니다

대규모 워크스페이스가 보통 아카이브 크기의 주된 요인입니다. 더 작거나 빠른 백업을 원한다면 `--no-include-workspace`를 사용하세요.

가장 작은 아카이브를 원한다면 `--only-config`를 사용하세요.
