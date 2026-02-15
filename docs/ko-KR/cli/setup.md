---
summary: "CLI reference for `openclaw setup` (initialize config + workspace)"
read_when:
  - You’re doing first-run setup without the full onboarding wizard
  - You want to set the default workspace path
title: "setup"
x-i18n:
  source_hash: 7f3fc8b246924edf48501785be2c0d356bd31bfbb133e75a139a5ee41dbf57f4
---

# `openclaw setup`

`~/.openclaw/openclaw.json` 및 에이전트 작업공간을 초기화합니다.

관련 항목:

- 시작하기: [시작하기](/start/getting-started)
- 마법사: [온보딩](/start/onboarding)

## 예

```bash
openclaw setup
openclaw setup --workspace ~/.openclaw/workspace
```

설정을 통해 마법사를 실행하려면:

```bash
openclaw setup --wizard
```
