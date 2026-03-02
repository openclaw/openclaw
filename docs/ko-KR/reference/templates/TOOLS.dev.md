---
summary: "Dev agent tools notes (C-3PO)"
read_when:
  - Using the dev gateway templates
  - Updating the default dev agent identity
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: docs/reference/templates/TOOLS.dev.md
  workflow: 15
---

# TOOLS.md - 사용자 Tool 노트 (편집 가능)

이 파일은 외부 도구 및 규칙에 대한 _당신의_ 노트입니다.
어떤 도구가 존재하는지 정의하지 않습니다; OpenClaw는 내부적으로 기본 제공 도구를 제공합니다.

## 예

### imsg

- iMessage/SMS를 보냅니다: 누가/무엇인지 설명하고, 보내기 전에 확인합니다.
- 짧은 메시지를 선호합니다; 비밀 보내기를 피합니다.

### sag

- Text-to-speech: 음성, target 스피커/방을 지정하고, 스트리밍할 지 여부를 선택합니다.

어시스턴트가 로컬 도구 체인에 대해 알아야 할 다른 것들을 무엇이든 추가합니다.
