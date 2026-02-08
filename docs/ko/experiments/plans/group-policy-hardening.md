---
read_when:
    - 과거 텔레그램 허용 목록 변경 사항 검토
summary: '텔레그램 허용 목록 강화: 접두사 + 공백 정규화'
title: 텔레그램 허용 목록 강화
x-i18n:
    generated_at: "2026-02-08T15:52:37Z"
    model: gtx
    provider: google-translate
    source_hash: 70569968857d408456c5207270eebe8628671b9ef4ea8b3b6e2eb13dada1b6b5
    source_path: experiments/plans/group-policy-hardening.md
    workflow: 15
---

# 텔레그램 허용 목록 강화

**날짜**: 2026-01-05  
**상태**: 완벽한  
**홍보**: 216호

## 요약

이제 텔레그램 허용 목록이 허용됩니다. `telegram:` 그리고 `tg:` 대소문자를 구분하지 않고 접두사를 붙이고 허용합니다.
우연한 공백. 이는 인바운드 허용 목록 확인을 아웃바운드 전송 정규화와 일치시킵니다.

## 무엇이 바뀌었나

- 접두사 `telegram:` 그리고 `tg:` 동일하게 처리됩니다(대소문자 구분 안 함).
- 허용 목록 항목이 잘립니다. 빈 항목은 무시됩니다.

## 예

다음은 모두 동일한 ID에 허용됩니다.

- `telegram:123456`
- `TG:123456`
- `tg:123456`

## 왜 중요한가요?

로그 또는 채팅 ID에서 복사/붙여넣기에는 접두어와 공백이 포함되는 경우가 많습니다. 정규화 방지
DM 또는 그룹 응답 여부를 결정할 때 거짓 부정.

## 관련 문서

- [그룹 채팅](/channels/groups)
- [전보 제공자](/channels/telegram)
