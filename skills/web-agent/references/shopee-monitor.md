# Shopee 가격 모니터링 템플릿

## 워크플로우

### Step 1: 사이트 접근

```
browser navigate → targetUrl: "https://shopee.vn"
browser snapshot → refs: "aria"
```

### Step 2: 팝업 처리

Shopee는 첫 접근 시 팝업이 자주 뜸:

- 앱 다운로드 배너 → 닫기(X) 클릭
- 위치 선택 팝업 → 닫기 또는 지역 선택
- 언어 선택 → 필요 시 처리

```
snapshot → 팝업 요소 확인 → act click 닫기 버튼
```

### Step 3: 검색

```
snapshot → 검색 input 찾기 (보통 "Search" placeholder)
act → { kind: "type", ref: "<search-input>", text: "제품명", submit: true }
```

### Step 4: 검색 결과 대기 및 파싱

```
act → { kind: "wait", timeMs: 3000 }
snapshot → 상품 리스트 파싱
```

각 상품에서 추출:

- 제품명, 가격, 원래 가격, 할인율, 판매량, 평점

### Step 5: 상세 페이지 (선택)

```
act → { kind: "click", ref: "<product-link>" }
snapshot → 상세 정보 추출
```

### Step 6: 데이터 구조화

```json
{
  "product_name": "Anessa Perfect UV 60ml",
  "price": 450000,
  "original_price": 520000,
  "discount": "13%",
  "sold": "12.3k",
  "rating": 4.8,
  "shop_name": "Anessa Official",
  "url": "https://shopee.vn/...",
  "scraped_at": "2026-02-20T04:48:00+09:00"
}
```

### Step 7: 비교 및 알림

이전 데이터와 비교하여 가격 변동 감지 → Discord DM 알림.

## 데이터 스키마

| 필드           | 타입   | 설명               |
| -------------- | ------ | ------------------ |
| product_name   | string | 제품명             |
| price          | number | 현재 가격 (VND)    |
| original_price | number | 원래 가격          |
| discount       | string | 할인율             |
| sold           | string | 판매량             |
| rating         | number | 평점 (0-5)         |
| shop_name      | string | 판매자명           |
| url            | string | 상품 URL           |
| scraped_at     | string | ISO 8601 수집 시간 |

## 에러 대응

| 상황             | 대응                                           |
| ---------------- | ---------------------------------------------- |
| 앱 다운로드 팝업 | snapshot → X/닫기 버튼 클릭                    |
| 위치 선택 팝업   | 지역 선택 또는 닫기                            |
| 로그인 요구      | 공개 페이지만 접근, 로그인 필요 시 사용자 알림 |
| 가격 로딩 지연   | wait 2초 → 재 snapshot                         |
| "No results"     | 검색어 변경 제안                               |
| 반봇 차단        | 요청 간 3~5초 대기, 사용자 알림                |

## 저장 경로 예시

```
memory/shopee-prices-2026-02-20.md
docs/prices/shopee/sunscreen-daily.json
```
