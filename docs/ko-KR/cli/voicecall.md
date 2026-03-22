---
summary: "`openclaw voicecall` CLI 레퍼런스 (음성 통화 플러그인 명령어 인터페이스)"
read_when:
  - "음성 통화 플러그인을 사용하고 있으며 CLI 진입점을 알고 싶을 때"
  - "`voicecall call|continue|status|tail|expose`의 빠른 예시가 필요할 때"
title: "voicecall"
x-i18n:
  source_path: "docs/cli/voicecall.md"
---

# `openclaw voicecall`

`voicecall`은 플러그인이 제공하는 명령어입니다. 음성 통화 플러그인이 설치되고 활성화된 경우에만 나타납니다.

주요 문서:

- 음성 통화 플러그인: [Voice Call](/plugins/voice-call)

## 주요 명령어

```bash
openclaw voicecall status --call-id <id>
openclaw voicecall call --to "+15555550123" --message "Hello" --mode notify
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall end --call-id <id>
```

## 웹훅 노출 (Tailscale)

```bash
openclaw voicecall expose --mode serve
openclaw voicecall expose --mode funnel
openclaw voicecall expose --mode off
```

보안 참고: 웹훅 엔드포인트는 신뢰할 수 있는 네트워크에만 노출하세요. 가능하면 Funnel 보다 Tailscale Serve를 사용하는 것을 권장합니다.
