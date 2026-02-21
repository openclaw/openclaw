# TikTok Shop 가격 모니터링 템플릿

## 워크플로우

### Step 1: 사이트 접근

```
browser navigate → targetUrl: "https://shop.tiktok.com" (또는 tiktokshop.com)
browser snapshot → refs: "aria"
```

> TikTok Shop은 지역별 URL이 다를 수 있음. 베트남: tiktok.com/shop

### Step 2: 팝업 처리

- 쿠키 동의 배너
- 앱 다운로드 유도
- 로그인 프롬프트

```
snapshot → 팝업 감지 → 닫기
```

### Step 3: 검색

```
snapshot → 검색 input 찾기
act → { kind: "type", ref: "<search-input>", text: "제품명", submit: true }
```

### Step 4: 검색 결과 파싱

```
act → { kind: "wait", timeMs: 3000 }
snapshot → 상품 리스트 파싱
```

### Step 5: 데이터 추출

| 필드           | 설명                       |
| -------------- | -------------------------- |
| product_name   | 제품명                     |
| price          | 현재 가격                  |
| original_price | 원래 가격                  |
| discount       | 할인율                     |
| sold           | 판매량                     |
| rating         | 평점                       |
| shop_name      | 판매자                     |
| video_reviews  | 영상 리뷰 수 (TikTok 특화) |
| url            | 상품 URL                   |
| scraped_at     | 수집 시간                  |

## TikTok Shop 특이사항

- 동적 로딩이 많음 → wait 시간 넉넉히 (3~5초)
- 가격이 로그인 후에만 보이는 경우 있음
- 플래시 세일 가격은 시간 제한적
- 영상 리뷰가 주요 지표 (텍스트 리뷰보다 중요)

## 에러 대응

| 상황             | 대응                              |
| ---------------- | --------------------------------- |
| 로그인 필수      | 사용자에게 알림, 공개 정보만 추출 |
| 동적 로딩 실패   | 스크롤 다운 → wait → 재시도       |
| 지역 차단        | URL/지역 설정 확인                |
| 플래시 세일 종료 | 정상가로 기록, 세일 종료 표기     |
