# Vapi AI 전화 예약 연동 가이드

## 환경 변수

```
VAPI_API_KEY=vapi_xxxxxxxxxxxxxxxx
VAPI_PHONE_NUMBER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

## Outbound Call API

### 전화 걸기

```bash
curl -X POST "https://api.vapi.ai/call/phone" \
  -H "Authorization: Bearer ${VAPI_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "phoneNumberId": "${VAPI_PHONE_NUMBER_ID}",
    "customer": {
      "number": "+84901234567"
    },
    "assistant": {
      "model": {
        "provider": "openai",
        "model": "gpt-4o-mini"
      },
      "voice": {
        "provider": "11labs",
        "voiceId": "적절한_음성_ID"
      },
      "firstMessage": "Xin chào, tôi muốn đặt lịch...",
      "instructions": "당신은 예약 전화를 거는 어시스턴트입니다. 다음 정보로 예약하세요: 서비스: {서비스}, 날짜: {날짜}, 시간: {시간}, 인원: {인원수}. 현지어로 자연스럽게 대화하세요."
    }
  }'
```

### MAIBOT에서 실행 (exec 도구)

```
exec → curl 명령 실행 (위 API 호출)
```

## 전화 예약 플로우

```
1. 사용자 → "AI 전화로 예약해줘"
2. MAIBOT → 환경변수 확인 (VAPI_API_KEY 존재?)
   ├─ 없음 → "Vapi API 키가 설정되지 않았습니다. 옵션 A(메시지) 또는 C(스크립트)를 이용해주세요."
   └─ 있음 → 계속
3. MAIBOT → 예약 정보 확인 (서비스, 날짜, 시간, 인원, 전화번호)
4. MAIBOT → 현지어 첫 인사말 + 지시사항 생성
5. MAIBOT → Vapi API 호출 (exec + curl)
6. Vapi → 업체에 전화 → AI가 현지어로 예약 대화
7. MAIBOT → 통화 결과 확인 (call status polling)
8. MAIBOT → 사용자에게 결과 보고
```

### 통화 상태 확인

```bash
curl -X GET "https://api.vapi.ai/call/{call_id}" \
  -H "Authorization: Bearer ${VAPI_API_KEY}"
```

상태값:

- `queued` → 대기 중
- `ringing` → 벨 울리는 중
- `in-progress` → 통화 중
- `ended` → 종료

## 언어별 음성 설정

| 국가 | 언어     | 추천 음성 provider | 비고           |
| ---- | -------- | ------------------ | -------------- |
| 🇻🇳   | 베트남어 | 11labs / deepgram  | 여성 음성 추천 |
| 🇹🇭   | 태국어   | 11labs             | ครับ/ค่ะ 구분  |
| 🇯🇵   | 일본어   | 11labs / openai    | 경어체 필수    |
| 🇨🇳   | 중국어   | 11labs / openai    | 보통화         |
| 🇬🇧   | 영어     | openai             | 범용           |

## 에러 처리

| 에러           | 원인                    | 대응                                         |
| -------------- | ----------------------- | -------------------------------------------- |
| 번호 불통      | 잘못된 번호 / 꺼진 전화 | 사용자에게 번호 재확인 요청, 옵션 A로 전환   |
| 영업시간 외    | 업체 부재               | 영업시간 안내 후 다음 영업시간에 재시도 제안 |
| API 키 무효    | 만료/오류               | "Vapi API 키를 확인해주세요" 안내            |
| 통화 시간 초과 | 3분 이상                | 자동 종료, 사용자에게 직접 전화 권유         |
| 언어 미지원    | 희귀 언어               | 영어로 폴백                                  |

## 비용 정보

- **통화료:** ~$0.05/분 (Vapi 기본 요금)
- **AI 모델:** ~$0.01/분 (GPT-4o-mini 기준)
- **음성:** ~$0.02/분 (11labs 기준)
- **총 예상:** 1회 예약 통화 (2-3분) ≈ $0.15~$0.25
- **참고:** 국제 전화 시 추가 요금 발생 가능

## 설정 안내 (사용자용)

Vapi 전화 예약 기능을 사용하려면:

1. [vapi.ai](https://vapi.ai) 가입
2. API 키 발급 (Dashboard → API Keys)
3. 전화번호 구매 (Phone Numbers → Buy)
4. 환경변수 설정:
   ```
   openclaw config set VAPI_API_KEY=vapi_xxx
   openclaw config set VAPI_PHONE_NUMBER_ID=xxx
   ```
