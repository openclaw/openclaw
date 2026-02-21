# 크론 연동 가이드

## 자동 모니터링 크론 설정 방법

web-agent 스킬을 크론 agentTurn으로 연동하여 매일 자동 실행할 수 있다.

### 크론 메시지 템플릿

#### 가격 모니터링 크론

message: |
web-agent 스킬을 사용하여 다음 가격 모니터링을 수행하세요:

1. skills/web-agent/references/shopee-monitor.md 참조
2. 모니터링 대상: [제품 리스트]
3. 결과를 memory/price-monitor.md에 누적 저장
4. 가격 변동 5% 이상 시 Discord DM 알림
5. 옵시디언 00.DAILY/{날짜}\_Price_Monitor.md에 저장

#### 경쟁사 분석 크론

message: |
web-agent 스킬을 사용하여 경쟁사 분석을 수행하세요:

1. skills/web-agent/references/competitor-analysis.md 참조
2. 경쟁 브랜드: [브랜드 리스트]
3. 신규 프로모션/가격 변동 감지
4. 결과를 memory/competitor-watch.md에 누적
5. 중요 변동 시 Discord DM 알림

### 데이터 누적 형식

#### memory/price-monitor.md

| 날짜       | 제품           | 플랫폼 | 가격        | 변동 | 비고     |
| ---------- | -------------- | ------ | ----------- | ---- | -------- |
| 2026-02-20 | DERMAEL 마스크 | Shopee | 150,000 VND | -5%  | 프로모션 |

최신 50건만 유지, 오래된 데이터는 월별 아카이브로 이동.

#### 옵시디언 데일리 노트 형식

```yaml
---
tags: [web-agent, price-monitor, daily]
date: { 날짜 }
---
```

# 가격 모니터링 — {날짜}

## 요약

- 모니터링 제품: X개
- 가격 변동 감지: Y건
- 주요 발견: ...

## 상세 데이터

[테이블]
