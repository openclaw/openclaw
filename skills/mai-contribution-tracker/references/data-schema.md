# Data Schema Reference

## contributions.md 이벤트 로그 형식

```markdown
| 날짜       | 프로젝트          | 유형          | 설명              | 링크        | 점수 |
| ---------- | ----------------- | ------------- | ----------------- | ----------- | ---- |
| 2026-03-01 | openclaw/openclaw | OSS_PR_MERGED | fix(discord): ... | https://... | 10   |
```

- **날짜**: YYYY-MM-DD
- **프로젝트**: `owner/repo` 또는 프로젝트명
- **유형**: 점수표의 유형 코드
- **설명**: 한 줄 요약 (`|` 문자 포함 시 `-`로 대체)
- **링크**: PR/이슈/포스트 URL (없으면 `-`)
- **점수**: 숫자만

## revenue-tracker.md 월별 테이블 형식

```markdown
| 월      | MAIBOTALKS | MAIOSS | MAIBEAUTY | MAITUTOR | MAITOK | 합계 MRR |
| ------- | ---------- | ------ | --------- | -------- | ------ | -------- |
| 2026-03 | 3900       | 0      | 0         | 0        | 0      | 3900     |
```

- **월**: YYYY-MM
- **각 프로젝트**: 해당 월 수익 (KRW, 숫자만)
- 새 프로젝트 추가 시 열 추가 + revenue-tracker.md 헤더 업데이트

## AUTO 블록 구조 (Dashboard.md)

```markdown
<!-- AUTO:contribution-dashboard:START -->

...자동 생성 내용...

<!-- AUTO:contribution-dashboard:END -->
```

스크립트가 이 마커 사이 내용을 자동 교체한다. 마커 자체는 수정하지 말 것.
