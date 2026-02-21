# Lazada 가격 모니터링 템플릿

## 워크플로우

### Step 1: 사이트 접근

```
browser navigate → targetUrl: "https://www.lazada.vn"
browser snapshot → refs: "aria"
```

### Step 2: 팝업 처리

- 쿠폰/프로모션 팝업 → 닫기
- 앱 다운로드 배너 → 닫기
- 쿠키 동의 → 수락

```
snapshot → 모달/오버레이 감지 → 닫기 버튼 클릭
```

### Step 3: 검색

```
snapshot → 검색 input 찾기
act → { kind: "type", ref: "<search-input>", text: "제품명", submit: true }
```

### Step 4: 검색 결과 파싱

```
act → { kind: "wait", timeMs: 3000 }
snapshot → 상품 카드 리스트 파싱
```

Lazada 상품 카드 구조 (Shopee와 다름):

- 가격이 별도 컨테이너에 표시
- 할인 배지가 이미지 위에 오버레이
- 리뷰 수가 별점 옆에 표시

### Step 5: 데이터 추출

| 필드           | 설명                  |
| -------------- | --------------------- |
| product_name   | 제품명                |
| price          | 현재 가격 (VND)       |
| original_price | 원래 가격             |
| discount       | 할인율                |
| sold           | 판매량 (없을 수 있음) |
| rating         | 평점                  |
| review_count   | 리뷰 수               |
| shop_name      | 판매자                |
| url            | 상품 URL              |
| scraped_at     | 수집 시간             |

### Step 6: 페이지네이션

```
snapshot → "Next" 또는 페이지 번호 버튼 찾기
act → { kind: "click", ref: "<next-btn>" }
act → { kind: "wait", timeMs: 2000 }
snapshot → 다음 페이지 파싱
```

## 에러 대응

| 상황              | 대응                         |
| ----------------- | ---------------------------- |
| 프로모션 팝업     | X 버튼 클릭                  |
| 로그인 리다이렉트 | 뒤로가기, 공개 페이지만 접근 |
| 가격 ₫0 표시      | 상세 페이지에서 재확인       |
| 지역 제한         | VN 도메인 사용 확인          |

## Shopee와의 차이점

- DOM 구조가 다름 (클래스명, 레이아웃)
- 판매량 정보가 항상 표시되지 않음
- 할인 표시 방식이 다름 (배지 vs 텍스트)
- 페이지네이션 방식 차이 (무한스크롤 vs 페이지 버튼)
