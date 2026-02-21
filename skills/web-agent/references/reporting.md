# 자동 리포팅 가이드

## 리포트 유형

### 1. 즉시 알림 (Realtime Alert)

- 트리거: 중요 변동 감지 시
- 채널: Discord DM (user:1466595769791283282)
- 형식: 이모지 + 1~3줄 요약 + 링크

### 2. 데일리 서머리 (Daily Summary)

- 트리거: 모닝 브리핑 크론 (06:00)에서 통합
- 채널: Discord DM
- 형식:
  📊 웹 모니터링 일일 요약
  - 모니터링 사이트: X개
  - 수집 데이터: Y건
  - 주요 발견: [리스트]
  - 상세: 옵시디언 00.DAILY 참조

### 3. 주간 트렌드 (Weekly Trend)

- 트리거: 주간 리뷰 크론 (월 07:00)에서 통합
- 채널: Discord DM + 옵시디언
- 형식: 가격 추이 테이블 + 인사이트

## Discord 메시지 형식

message tool 사용:

- action: send
- channel: discord
- target: user:1466595769791283282
- message: 알림 내용

## 옵시디언 저장 형식

Write tool로 직접 파일 생성:

- 경로: C:\Users\jini9\OneDrive\Documents\JINI_SYNC\00.DAILY\
- YAML frontmatter 포함
- 태그: web-agent + 카테고리
