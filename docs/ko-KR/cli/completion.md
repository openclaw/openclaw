---
summary: "`openclaw completion` CLI 레퍼런스 (셸 자동완성 스크립트 생성/설치)"
read_when:
  - zsh/bash/fish/PowerShell 셸 자동완성이 필요할 때
  - OpenClaw 상태 디렉터리에 자동완성 스크립트를 캐시해야 할 때
title: "completion"
x-i18n:
  source_path: "docs/cli/completion.md"
---

# `openclaw completion`

셸 자동완성 스크립트를 생성하고 선택적으로 셸 프로필에 설치합니다.

## 사용법

```bash
openclaw completion
openclaw completion --shell zsh
openclaw completion --install
openclaw completion --shell fish --install
openclaw completion --write-state
openclaw completion --shell bash --write-state
```

## 옵션

- `-s, --shell <shell>`: 셸 대상 (`zsh`, `bash`, `powershell`, `fish`; 기본값: `zsh`)
- `-i, --install`: 셸 프로필에 source 라인을 추가하여 자동완성을 설치
- `--write-state`: stdout에 출력하지 않고 `$OPENCLAW_STATE_DIR/completions`에 자동완성 스크립트를 기록
- `-y, --yes`: 설치 확인 프롬프트 건너뛰기

## 참고

- `--install`은 셸 프로필에 작은 "OpenClaw Completion" 블록을 작성하고 캐시된 스크립트를 가리킵니다.
- `--install`이나 `--write-state` 없이 실행하면 스크립트를 stdout에 출력합니다.
- 자동완성 생성 시 중첩된 하위 명령어가 포함되도록 명령어 트리를 즉시 로드합니다.
