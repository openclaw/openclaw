# 범용 웹 스크래핑 가이드

## 기본 워크플로우

```
1. navigate → 대상 URL
2. snapshot (refs="aria") → 페이지 구조 파악
3. 요소 식별 → 데이터가 있는 ref 확인
4. 데이터 추출 → snapshot 텍스트에서 파싱
5. 구조화 → JSON/마크다운으로 변환
6. 저장 → memory/ 또는 docs/
```

## 페이지네이션 처리

### 페이지 번호 방식

```
snapshot → "Next" 또는 페이지 번호 버튼 찾기
act → { kind: "click", ref: "<next-btn>" }
wait 2초 → snapshot → 다음 페이지 파싱
반복 (최대 페이지 수 설정)
```

### 무한 스크롤 방식

```
snapshot → 현재 항목 수 확인
act → { kind: "press", key: "End" }  # 페이지 끝으로 스크롤
wait 2초 → snapshot → 새 항목 확인
새 항목이 없을 때까지 반복
```

### "더 보기" 버튼 방식

```
snapshot → "Load More" / "더 보기" 버튼 찾기
act → { kind: "click", ref: "<load-more>" }
wait 2초 → snapshot
```

## 동적 로딩 대응

- SPA(Single Page App): navigate 후 wait 2~3초 필수
- 레이지 로딩 이미지: 스크롤해야 로드됨
- AJAX 데이터: 클릭/스크롤 후 wait 필요
- 스켈레톤 UI: 실제 데이터 로드까지 대기

```
# 동적 콘텐츠 대기 패턴
act → { kind: "wait", timeMs: 3000 }
snapshot → 데이터 존재 확인
없으면 → 추가 wait 또는 스크롤
```

## Rate Limiting

- 요청 간 **2~5초** 대기 (사이트별 조절)
- 연속 페이지 접근 시 **3초** 이상 간격
- 차단 감지 시 즉시 중단, 사용자 알림
- CAPTCHA 발생 시 사용자에게 알림

## 데이터 추출 패턴

### 테이블 데이터

```
snapshot → table 요소 찾기 → 행/열 텍스트 추출
→ 헤더를 키로 사용하여 JSON 배열 생성
```

### 리스트 데이터

```
snapshot → list item 요소들 찾기
→ 각 아이템에서 필드 추출 (이름, 가격, 링크 등)
```

### 단일 페이지 상세

```
snapshot → 특정 섹션의 텍스트 추출
→ 라벨-값 쌍으로 구조화
```

## 주의사항

- robots.txt 존중 (공개 데이터만 수집)
- 로그인 필요 시 사용자 동의 확인
- 개인정보 수집 금지
- 과도한 요청으로 서버 부하 주지 않기
