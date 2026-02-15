---
summary: "CLI reference for `openclaw voicecall` (voice-call plugin command surface)"
read_when:
  - You use the voice-call plugin and want the CLI entry points
  - You want quick examples for `voicecall call|continue|status|tail|expose`
title: "voicecall"
x-i18n:
  source_hash: d93aaee6f6f5c9ac468d8d2905cb23f0f2db75809408cb305c055505be9936f2
---

# `openclaw voicecall`

`voicecall`는 플러그인에서 제공하는 명령어입니다. 음성 통화 플러그인이 설치되어 활성화된 경우에만 나타납니다.

기본 문서:

- 음성통화 플러그인: [음성통화](/plugins/voice-call)

## 일반적인 명령

```bash
openclaw voicecall status --call-id <id>
openclaw voicecall call --to "+15555550123" --message "Hello" --mode notify
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall end --call-id <id>
```

## 웹훅 노출(Tailscale)

```bash
openclaw voicecall expose --mode serve
openclaw voicecall expose --mode funnel
openclaw voicecall unexpose
```

보안 참고 사항: 신뢰할 수 있는 네트워크에만 웹훅 엔드포인트를 노출하세요. 가능하다면 깔때기보다 Tailscale Serving을 선호하세요.
