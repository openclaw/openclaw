# 경쟁사 분석 자동화

> 프로젝트: MAIBEAUTY — 베트남 화장품 시장 경쟁사 모니터링

## 대상 플랫폼

| 플랫폼         | URL                            | 우선순위 |
| -------------- | ------------------------------ | -------- |
| Shopee Vietnam | `https://shopee.vn/`           | ★★★      |
| Lazada Vietnam | `https://www.lazada.vn/`       | ★★★      |
| TikTok Shop    | `https://www.tiktok.com/shop/` | ★★☆      |
| Tiki           | `https://tiki.vn/`             | ★☆☆      |

## 1. 경쟁 브랜드 제품 검색

### Shopee

```
1. navigate → https://shopee.vn/
2. act: click → 검색 필드
3. act: type → "kem chống nắng" (자외선 차단제) 등 키워드
4. act: press → Enter
5. snapshot → 결과 목록
6. 필터 적용: 카테고리, 가격대, 평점
```

### Lazada

```
1. navigate → https://www.lazada.vn/
2. 검색 → 키워드 입력
3. snapshot → 결과 그리드
4. 정렬: 판매량순, 가격순
```

### TikTok Shop

```
1. navigate → TikTok Shop 페이지
2. 카테고리 탐색 또는 검색
3. snapshot → 제품 카드
```

## 2. 데이터 추출 스키마

| 필드           | 설명                          |
| -------------- | ----------------------------- |
| platform       | 플랫폼 (shopee/lazada/tiktok) |
| product_name   | 제품명                        |
| brand          | 브랜드명                      |
| price          | 현재 가격 (VND)               |
| original_price | 원래 가격 (할인 전)           |
| discount_pct   | 할인율 (%)                    |
| rating         | 평점 (5점 만점)               |
| review_count   | 리뷰 수                       |
| sold_count     | 판매량 (표시된 경우)          |
| shop_name      | 판매 샵 이름                  |
| product_url    | 제품 URL                      |
| collected_at   | 수집 시간 (ISO 8601)          |

## 3. 프로모션/할인 이벤트 감지

### 모니터링 대상

- 플래시 세일 배너
- 쿠폰/바우처 존재 여부
- 번들 할인
- "Mall" 또는 공식 스토어 프로모션

### 감지 방법

```
1. snapshot → 배너/프로모션 영역 확인
2. 가격 비교: original_price vs price → 할인 여부 판별
3. "SALE", "Giảm giá", "Flash Sale" 텍스트 감지
```

## 4. 신규 상품 등록 감지

### 방법

- 경쟁 브랜드 샵 페이지 → "최신순" 정렬
- 이전 수집 결과와 비교 → 새 product_url 감지
- 주 1회 이상 수집 권장

## 5. 결과 저장

### 저장 경로

```
C:\TEST\MAIBEAUTY\docs\competitor-analysis\
├── YYYY-MM-DD-shopee.json
├── YYYY-MM-DD-lazada.json
├── YYYY-MM-DD-tiktok.json
└── summary.md          ← 주간 요약
```

### 요약 보고서 형식

```markdown
# 경쟁사 분석 요약 (YYYY-MM-DD)

## 가격 변동

- [브랜드A] 제품X: 250,000₫ → 199,000₫ (-20%)

## 신규 상품

- [브랜드B] 신제품Y 출시 (Shopee)

## 프로모션

- Lazada 플래시세일: 브랜드C 전품목 30% 할인
```

## 주의사항

- 스크래핑 빈도: 플랫폼당 하루 1회 이하 권장 (rate limit 방지)
- 로그인 불필요 — 공개 검색 결과만 수집
- DOM 구조 변경 빈번 → snapshot 기반 동적 탐색 필수
- Shopee anti-bot 감지 시 → error-recovery.md 참조
- 수집 데이터는 내부 분석용으로만 사용
