---
summary: "`openclaw pairing`에 대한 CLI 참조 (페어링 요청 승인/목록)"
read_when:
  - 페어링 모드 다이렉트 메시지를 사용 중이며 발신자를 승인해야 할 때
title: "페어링"
x-i18n:
  source_path: cli/pairing.md
  source_hash: 785869d24d953141
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:24:22Z
---

# `openclaw pairing`

페어링을 지원하는 채널에 대해 다이렉트 메시지 페어링 요청을 승인하거나 검사합니다.

관련:

- 페어링 흐름: [Pairing](/channels/pairing)

## 명령

```bash
openclaw pairing list whatsapp
openclaw pairing approve whatsapp <code> --notify
```
