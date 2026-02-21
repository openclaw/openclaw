# TikTok 댓글 수집 템플릿

> 프로젝트: MAITOK — TikTok 댓글 수집/관리 (API 없이, 브라우저 자동화)

## 워크플로우

1. `navigate` → TikTok 영상 URL (`https://www.tiktok.com/@user/video/ID`)
2. `snapshot` → 댓글 섹션 찾기 (보통 영상 오른쪽 또는 하단)
3. 스크롤 → 댓글 더 로딩 (동적 렌더링, 3초 대기)
4. 각 댓글에서 추출: 작성자, 내용, 좋아요 수, 시간
5. 감성분석 대상으로 구조화 (JSON)
6. 대댓글 게시 (로그인 필요 시 사용자 알림)

## 브라우저 도구 사용 예시

```
# 1. 영상 페이지 열기
browser: navigate → targetUrl: "https://www.tiktok.com/@user/video/123"

# 2. 댓글 영역 확인
browser: snapshot → 댓글 컨테이너 ref 확인

# 3. 스크롤로 댓글 더 로딩
browser: act → kind: press, key: "End"
(3초 대기 후 다시 snapshot)

# 4. 댓글 데이터 추출
browser: act → kind: evaluate, fn: "document.querySelectorAll('[class*=comment]')"
```

## 데이터 스키마

| 필드       | 타입   | 설명                                                      |
| ---------- | ------ | --------------------------------------------------------- |
| video_url  | string | 영상 URL                                                  |
| comment_id | string | 댓글 식별자 (DOM 위치 기반, 예: `comment-0`, `comment-1`) |
| author     | string | 작성자 닉네임                                             |
| text       | string | 댓글 내용                                                 |
| likes      | number | 좋아요 수                                                 |
| timestamp  | string | 작성 시간 (상대 시간 → 절대 시간 변환)                    |
| language   | string | 감지된 언어 (vi, ko, en 등)                               |

## 출력 예시

```json
{
  "video_url": "https://www.tiktok.com/@brand/video/7300000000",
  "collected_at": "2026-02-20T04:00:00+09:00",
  "comments": [
    {
      "comment_id": "comment-0",
      "author": "user123",
      "text": "Sản phẩm đẹp quá!",
      "likes": 42,
      "timestamp": "2d ago",
      "language": "vi"
    }
  ]
}
```

## 주의사항

- TikTok은 로그인 없이 댓글 조회 가능하나 대댓글 게시는 불가
- 스크롤 시 동적 로딩 → **3초 대기** 필요 (act:wait 사용)
- 댓글 100개 이상 시 성능 저하 → 배치 처리 권장 (50개씩)
- DOM 구조가 자주 변경됨 → **snapshot 기반 동적 탐색**을 기본으로 사용
- 클래스명/ID 하드코딩 금지, role/aria 기반 탐색 우선
- Rate limiting 감지 시 → error-recovery.md 참조
- 수집 데이터는 개인정보 포함 가능 → 저장 시 주의
