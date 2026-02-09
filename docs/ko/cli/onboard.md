---
summary: "`openclaw onboard`에 대한 CLI 레퍼런스(대화형 온보딩 마법사)"
read_when:
  - Gateway(게이트웨이), 워크스페이스, 인증, 채널, Skills에 대한 안내식 설정이 필요할 때
title: "온보드"
---

# `openclaw onboard`

대화형 온보딩 마법사(로컬 또는 원격 Gateway(게이트웨이) 설정).

## 관련 가이드

- CLI 온보딩 허브: [Onboarding Wizard (CLI)](/start/wizard)
- CLI 온보딩 레퍼런스: [CLI Onboarding Reference](/start/wizard-cli-reference)
- CLI 자동화: [CLI Automation](/start/wizard-cli-automation)
- macOS 온보딩: [Onboarding (macOS App)](/start/onboarding)

## 예제

```bash
openclaw onboard
openclaw onboard --flow quickstart
openclaw onboard --flow manual
openclaw onboard --mode remote --remote-url ws://gateway-host:18789
```

플로우 참고 사항:

- `quickstart`: 최소한의 프롬프트, Gateway(게이트웨이) 토큰을 자동 생성합니다.
- `manual`: 포트/바인드/인증에 대한 전체 프롬프트(`advanced`의 별칭).
- 가장 빠른 첫 채팅: `openclaw dashboard` (Control UI, 채널 설정 없음).

## 일반적인 후속 명령

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json`는 비대화형 모드를 의미하지 않습니다. 스크립트에는 `--non-interactive`를 사용하십시오.
</Note>
