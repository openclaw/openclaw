# 교육 콘텐츠 리서치

> 프로젝트: MAITUTOR — 베트남인 대상 한국어 교육 서비스

## 1. 한국어 교육 사이트 크롤링

### 대상 사이트

| 사이트                   | URL                                     | 콘텐츠              |
| ------------------------ | --------------------------------------- | ------------------- |
| TOPIK 공식               | `https://www.topik.go.kr/`              | 시험 일정, 기출문제 |
| King Sejong Institute    | `https://www.iksi.or.kr/`               | 무료 한국어 강좌    |
| Talk To Me In Korean     | `https://talktomeinkorean.com/`         | 유료 커리큘럼       |
| KoreanClass101           | `https://www.koreanclass101.com/`       | 팟캐스트/영상       |
| Duolingo Korean          | `https://www.duolingo.com/course/ko/en` | 게이미피케이션      |
| VKLL (Vietnamese-Korean) | 베트남 한국어 교육 커뮤니티             | 현지화 콘텐츠       |

### 수집 항목

```
1. navigate → 대상 사이트
2. snapshot → 커리큘럼/코스 목록
3. 각 코스에서 추출:
   - 코스명, 레벨 (초급/중급/고급)
   - 수강료 (무료/유료/구독)
   - 수강 기간
   - 콘텐츠 형태 (영상/텍스트/퀴즈/라이브)
   - 수강생 수 또는 리뷰 수
```

## 2. 교재/커리큘럼 정보 수집

### TOPIK 레벨별 교재

- TOPIK I (1-2급): 기초 교재 목록
- TOPIK II (3-6급): 중급/고급 교재 목록

### 수집 방법

```
1. navigate → 교보문고/Yes24 → "한국어 교재" 검색
2. 또는: navigate → Amazon → "Korean textbook for Vietnamese"
3. snapshot → 검색 결과
4. 추출: 제목, 저자, 출판사, 가격, 평점, 리뷰 수
```

## 3. 경쟁 EdTech 서비스 비교

### 비교 스키마

| 필드            | 설명                           |
| --------------- | ------------------------------ |
| service_name    | 서비스명                       |
| url             | URL                            |
| target_audience | 대상 (베트남인/글로벌)         |
| languages       | 지원 언어                      |
| pricing         | 가격 모델 (무료/프리미엄/구독) |
| monthly_price   | 월 구독료 (USD/VND)            |
| content_type    | 콘텐츠 유형                    |
| unique_features | 차별화 기능                    |
| user_count      | 이용자 수 (공개 시)            |
| app_rating      | 앱스토어 평점                  |

### 주요 경쟁사

1. **Duolingo** — 게이미피케이션, 무료+광고 모델
2. **TTMIK** — 한국어 전문, 유료 구독
3. **Sejong Institute** — 정부 지원, 무료
4. **Hana Korean** — 베트남 현지 학원 온라인
5. **Korean Unnie (YouTube)** — 베트남어로 한국어 교육

## 4. 결과 저장

```
C:\MAIBOT\docs\maitutor\
├── competitor-comparison.md
├── curriculum-survey.json
└── textbook-list.json
```

## 주의사항

- 유료 콘텐츠 내용 자체는 복사 금지 — 메타데이터(제목, 가격, 구조)만 수집
- 로그인 필요 사이트: 공개 페이지만 수집, 로그인 자동화 안 함
- 교육부/TOPIK 공식 데이터 변경 주기 확인 (시험 일정 등)
- snapshot 기반 동적 탐색 — DOM 하드코딩 금지
