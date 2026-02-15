---
summary: "Telegram allowlist hardening: prefix + whitespace normalization"
read_when:
  - Reviewing historical Telegram allowlist changes
title: "Telegram Allowlist Hardening"
x-i18n:
  source_hash: 70569968857d408456c5207270eebe8628671b9ef4ea8b3b6e2eb13dada1b6b5
---

# 텔레그램 허용 목록 강화

**날짜**: 2026-01-05  
**상태**: 완료  
**홍보**: #216

## 요약

텔레그램 허용 목록은 이제 `telegram:` 및 `tg:` 접두사를 대소문자를 구분하지 않고 허용하며 우연한 공백을 허용합니다. 이는 인바운드 허용 목록 확인을 아웃바운드 전송 정규화와 일치시킵니다.

## 달라진 점

- 접두사 `telegram:` 및 `tg:`는 동일하게 처리됩니다(대소문자를 구분하지 않음).
- 허용 목록 항목이 잘립니다. 빈 항목은 무시됩니다.

## 예

다음은 모두 동일한 ID에 허용됩니다.

- `telegram:123456`
- `TG:123456`
- `tg:123456`

## 그것이 중요한 이유

로그 또는 채팅 ID에서 복사/붙여넣기에는 접두어와 공백이 포함되는 경우가 많습니다. 정규화 방지
DM 또는 그룹 응답 여부를 결정할 때 거짓 부정.

## 관련 문서

- [그룹 채팅](/channels/groups)
- [텔레그램 공급자](/channels/telegram)
