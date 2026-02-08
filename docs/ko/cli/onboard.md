---
read_when:
    - 게이트웨이, 작업 영역, 인증, 채널 및 기술에 대한 안내 설정이 필요합니다.
summary: '`openclaw onboard`에 대한 CLI 참조(대화형 온보딩 마법사)'
title: 온보드
x-i18n:
    generated_at: "2026-02-08T15:52:47Z"
    model: gtx
    provider: google-translate
    source_hash: 69a96accb2d571ff53ca48cfd2c74700536d06208ee25c626741ce7925db94ff
    source_path: cli/onboard.md
    workflow: 15
---

# `openclaw onboard`

대화형 온보딩 마법사(로컬 또는 원격 게이트웨이 설정)

## 관련 가이드

- CLI 온보딩 허브: [온보딩 마법사(CLI)](/start/wizard)
- CLI 온보딩 참조: [CLI 온보딩 참조](/start/wizard-cli-reference)
- CLI 자동화: [CLI 자동화](/start/wizard-cli-automation)
- macOS 온보딩: [온보딩(macOS 앱)](/start/onboarding)

## 예

```bash
openclaw onboard
openclaw onboard --flow quickstart
openclaw onboard --flow manual
openclaw onboard --mode remote --remote-url ws://gateway-host:18789
```

흐름 참고사항:

- `quickstart`: 최소한의 프롬프트가 표시되고 게이트웨이 토큰이 자동 생성됩니다.
- `manual`: 포트/바인드/인증에 대한 전체 프롬프트(별칭: `advanced`).
- 가장 빠른 첫 번째 채팅: `openclaw dashboard` (컨트롤 UI, 채널 설정 없음).

## 일반적인 후속 명령

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json`은 비대화형 모드를 의미하지 않습니다. 스크립트에는 `--non-interactive`을 사용하세요.
</Note>
