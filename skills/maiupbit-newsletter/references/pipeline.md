# 뉴스레터 파이프라인 상세 설계

## 파일 구조 (C:\TEST\M.AI.UPbit)

```
scripts/
├── ci_weekly_report.py       # 퀀트 데이터 생성 (JSON 출력)
├── generate_newsletter.py    # 뉴스레터 초안 생성 (blog/drafts/ 저장)
├── generate_newsletter_html.py  # HTML 형식 뉴스레터
├── update_readme_badges.py   # README 배지 자동 업데이트
├── publish_substack.py       # Substack 발행 시도 (SUBSTACK_SID 사용, 403 가능)
└── publish_newsletter.py     # Substack 발행 시도 (SUBSTACK_COOKIE 사용, 403 가능)

blog/
├── drafts/    # 자동 생성된 초안 (날짜별)
└── published/ # 발행 완료 파일 이동

.github/workflows/
└── weekly-report.yml  # 메인 자동화 워크플로우
```

## 워크플로우 파일 (weekly-report.yml) 주요 설정

```yaml
on:
  schedule:
    - cron: '0 22 * * 0'   # 매주 월요일 07:00 KST
  workflow_dispatch:         # 수동 실행 가능

jobs:
  generate-newsletter:
    runs-on: ubuntu-latest
    permissions:
      contents: write        # git push 권한 필수
```

## n8n 워크플로우 노드 구성

```
Weekly Schedule (scheduleTrigger)
  cron: "0 0 * * 1"  (매주 월요일 00:00 UTC)
    ↓
Trigger GitHub Actions (httpRequest)
  POST https://api.github.com/repos/jini92/M.AI.UPbit/actions/workflows/weekly-report.yml/dispatches
  Headers: Authorization: Bearer <gh_token>
  Body: {"ref": "main"}
```

## 문제 해결 가이드

### GitHub Actions 실패 시

```powershell
# 최근 실행 목록
gh run list -R jini92/M.AI.UPbit --limit 5

# 실패 로그 확인
gh run view <run_id> --log-failed -R jini92/M.AI.UPbit
```

### n8n 100% 실패율 문제

**원인**: `executeCommand` 노드 사용 시 n8n Cloud 서버에는 Python 없음
**해결**: GitHub Actions workflow_dispatch HTTP Request로 대체 (완료)

### pandas-ta 설치 실패

**원인**: `pandas-ta` PyPI에서 제거됨 (2026-03 기준)
**해결**: `ta>=0.10.2` + `pip install -e .` 사용

### DataFetcher import 오류

**원인**: `ci_weekly_report.py`에서 존재하지 않는 클래스 import
**해결**: `scripts/ci_weekly_report.py`에 pyupbit 기반 DataFetcher 직접 구현

## 수익화 현황

| 항목 | 상태 |
|------|------|
| Substack 무료 운영 | ✅ 진행중 |
| Stripe 연동 (유료화) | ❌ SSN 없어 차단 |
| ITIN 신청 | 미진행 (5~7주 소요) |
| 유료 전환 목표 | ITIN 발급 후 |

**유료 티어 계획:**
- Free: 주간 TOP5 (1주 딜레이)
- Basic ₩4,900/월: 실시간 TOP5 + BTC/ETH 분석
- Pro ₩14,900/월: 전종목 시그널 + MAIBOTALKS 알림
