---
summary: "`openclaw setup` CLI 레퍼런스 (설정 + 워크스페이스 초기화)"
read_when:
  - 전체 CLI 온보딩 없이 초기 설정을 수행할 때
  - 기본 워크스페이스 경로를 설정하고 싶을 때
title: "setup"
x-i18n:
  source_path: "docs/cli/setup.md"
---

# `openclaw setup`

`~/.openclaw/openclaw.json`과 에이전트 워크스페이스를 초기화합니다.

관련 문서:

- 시작하기: [Getting started](/start/getting-started)
- CLI 온보딩: [Onboarding (CLI)](/start/wizard)

## 예시

```bash
openclaw setup
openclaw setup --workspace ~/.openclaw/workspace
```

setup을 통해 온보딩을 실행하려면:

```bash
openclaw setup --wizard
```
