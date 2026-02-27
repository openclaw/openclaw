# MAI Universe 마켓플레이스 전략

_Created: 2026-02-25_

## 전체 마켓플레이스 (23개)

| 카테고리      | 마켓플레이스                               | 대상 프로젝트 수 |
| ------------- | ------------------------------------------ | ---------------- |
| 패키지        | PyPI, npm, Docker Hub, Homebrew            | 6~8              |
| 앱 스토어     | Apple App Store, Google Play               | 5                |
| 플러그인/스킬 | Obsidian, ClawHub, Chrome, VS Code         | 4~6              |
| AI/ML         | Hugging Face, Ollama, Replicate            | 4                |
| API           | RapidAPI, AWS Marketplace                  | 3                |
| 배포          | Railway Templates, Vercel Templates        | 3                |
| 디지털상품    | Gumroad, Lemon Squeezy, Udemy              | 3                |
| 기타          | Product Hunt, GitHub Sponsors, TikTok Shop | 전체             |

## 자동 배포 전략

- **트리거:** GitHub Release (모든 마켓플레이스 공통)
- **실행:** GitHub Actions 워크플로우 (마켓플레이스별)
- **MAIBOT 역할:** Release 생성 + 결과 모니터링 + Discord 보고

## 계정 상태 (2026-02-25)

- ✅ 활성: GitHub, PyPI, Expo, Railway, Docker Hub (`leejini92`), GitHub Sponsors (Pending)
- 🔄 진행중: Obsidian (PR #10406), Apple Developer (MAIBOTALKS 심사중)
- ❌ 미가입: npm, Google Play, Chrome, HuggingFace, RapidAPI, Product Hunt, Gumroad, Lemon Squeezy, Udemy, ClawHub
- 🔑 GitHub Secrets 설정: MAISECONDBRAIN에 `PYPI_API_TOKEN` 저장 완료

## 문서 위치

- **전체 가이드:** Obsidian `01.PROJECT/00.MAIBOT/MAI-Universe-Marketplace-Guide.md`
- 프로젝트별 매핑, 배포 워크플로우 코드, 우선순위 실행 계획 포함

## 우선순위

1. **Phase 1 (즉시):** GitHub Sponsors + FUNDING.yml + PyPI Trusted Publisher + Docker Hub
2. **Phase 2 (1~2주):** Obsidian 머지 후 릴리스 + Google Play + ClawHub
3. **Phase 3 (1~2월):** HuggingFace + Chrome + RapidAPI + Railway Template
4. **Phase 4 (3월+):** Gumroad + Lemon Squeezy + AWS + Udemy

---

_Last updated: 2026-02-25_
