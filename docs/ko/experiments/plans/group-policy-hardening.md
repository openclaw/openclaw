---
summary: "Telegram allowlist 강화: 접두사 + 공백 정규화"
read_when:
  - 과거 Telegram allowlist 변경 사항을 검토할 때
title: "Telegram Allowlist 강화"
---

# Telegram Allowlist 강화

**날짜**: 2026-01-05  
**상태**: 완료  
**PR**: #216

## 요약

Telegram allowlist 는 대소문자를 구분하지 않고 `telegram:` 및 `tg:` 접두사를 허용하며,
실수로 포함된 공백을 허용합니다. 이는 인바운드 allowlist 검사 를 아웃바운드 전송 정규화 와 일치시킵니다.

## 변경 사항

- 접두사 `telegram:` 및 `tg:` 는 동일하게 처리됩니다(대소문자 구분 없음).
- allowlist 항목은 트리밍되며, 빈 항목은 무시됩니다.

## Examples

다음 항목들은 모두 동일한 ID 로 허용됩니다:

- `telegram:123456`
- `TG:123456`
- `tg:123456`

## 왜 중요한가

로그나 채팅 ID 에서 복사/붙여넣기를 할 때 접두사와 공백이 포함되는 경우가 많습니다. 정규화는 다이렉트 메시지 또는 그룹 에서 응답할지 여부를 결정할 때 발생하는
오탐(false negative)을 방지합니다.

## 관련 문서

- [그룹 채팅](/channels/groups)
- [Telegram 프로바이더](/channels/telegram)
