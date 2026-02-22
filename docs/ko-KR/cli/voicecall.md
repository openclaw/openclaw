---
summary: "`openclaw voicecall` (음성 통화 플러그인 명령 인터페이스)에 대한 CLI 참조"
read_when:
  - 음성 통화 플러그인을 사용하며 CLI 진입점을 원하는 경우
  - "`voicecall call|continue|status|tail|expose`에 대한 빠른 예제를 원하는 경우"
title: "voicecall"
---

# `openclaw voicecall`

`voicecall`은 플러그인이 제공하는 명령어입니다. 음성 통화 플러그인이 설치되고 활성화된 경우에만 나타납니다.

주요 문서:

- 음성 통화 플러그인: [Voice Call](/plugins/voice-call)

## 일반 명령어

```bash
openclaw voicecall status --call-id <id>
openclaw voicecall call --to "+15555550123" --message "Hello" --mode notify
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall end --call-id <id>
```

## 웹훅 노출하기 (Tailscale)

```bash
openclaw voicecall expose --mode serve
openclaw voicecall expose --mode funnel
openclaw voicecall unexpose
```

보안 주의사항: 신뢰할 수 있는 네트워크에만 웹훅 엔드포인트를 노출하십시오. 가능하면 Funnel보다 Tailscale Serve를 선호하십시오.
