---
summary: "Legacy iMessage 지원 via imsg (JSON-RPC over stdio). 새로운 설정은 BlueBubbles 사용."
read_when:
  - iMessage 지원 설정 중
  - iMessage 전송/수신 디버깅 중
title: "iMessage"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
  source_path: "docs/channels/imessage.md"
  workflow: 15
---

# iMessage (레거시: imsg)

<Warning>
새로운 iMessage 배포의 경우 <a href="/channels/bluebubbles">BlueBubbles</a> 사용.

`imsg` 통합은 레거시이며 향후 릴리스에서 제거될 수 있습니다.
</Warning>

상태: 레거시 외부 CLI 통합. 게이트웨이는 `imsg rpc`를 생성하고 JSON-RPC over stdio (별도 데몬/포트 없음)를 통해 통신합니다.

[전체 내용은 원본 영문 문서를 참조하세요.]
