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

## 계정 상태 (2026-03-01 업데이트)

- ✅ 활성: GitHub, PyPI, Expo, Railway, Docker Hub (`leejini92`), GitHub Sponsors (Pending), **ClawHub (`jini92`)**
- 🔄 진행중: Obsidian (PR #10406 봇 재스캔 대기), Apple Developer (MAIBOTALKS 심사중)
- ❌ 미가입: npm, Google Play, Chrome, HuggingFace, RapidAPI, Product Hunt, Gumroad, Lemon Squeezy, Udemy
- 🔑 GitHub Secrets 설정: MAISECONDBRAIN에 `PYPI_API_TOKEN` 저장 완료

## ClawHub 퍼블리시 현황 (2026-03-01)

| 스킬                  | 슬러그                 | 버전   | 퍼블리시일 |
| --------------------- | ---------------------- | ------ | ---------- | -------------------- | ------ | ---------- |
| Advisory Committee    | `advisory-committee`   | v1.0.0 | 2026-03-01 |
| Expo App Store Deploy | `expo-appstore-deploy` | v1.0.0 | 2026-03-01 |
| Obsidian Daily Note   | `obsidian-daily-mai`   | v1.0.0 | 2026-03-01 |
| Open Source Release   |
| ClawHub Publish       | `clawhub-publish-mai`  | v1.0.0 | 2026-03-01 | `opensource-release` | v1.0.0 | 2026-03-01 |

**대기 중 (정리 후 등록 예정):**

- `hybrid-coding` — MAIBOT 특화 용어 정리 필요
- `mnemo` — MAISECONDBRAIN API 공개 배포 후
- `upstream-sync` — OpenClaw 버전 업 후

## 문서 위치

- **전체 가이드:** Obsidian `01.PROJECT/00.MAIBOT/MAI-Universe-Marketplace-Guide.md`
- **비즈니스 모델:** Obsidian `01.PROJECT/00.MAIBOT/OpenClaw-Skills-Business-Models.md`
- 프로젝트별 매핑, 배포 워크플로우 코드, 우선순위 실행 계획 포함

## 우선순위

1. **Phase 1 (완료):** ClawHub 스킬 4개 등록 ✅
2. **Phase 2 (진행중):** Obsidian PR #10406 머지 대기 + Google Play 가입
3. **Phase 3 (1~2월):** HuggingFace + Chrome + RapidAPI + Railway Template
4. **Phase 4 (3월+):** Gumroad + Lemon Squeezy + AWS + Udemy

---

_Last updated: 2026-03-01_
