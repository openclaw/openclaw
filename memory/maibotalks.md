---
type: project-memory
project: MAIBOTALKS
tags: [voice, conversation, ai-agent, app]
related:
  - "[[maitutor|MAITUTOR - AI 튜터]]"
  - "[[maicon|MAICON - 컨시어지]]"
  - "[[maibot-commands|MAIBOT 명령어]]"
---

# MAIBOTALKS

- **정식명:** MAIBOTALKS
- **브랜드:** BOTALKS (Bot + Talks, 보톡스 💉)
- **설명:** OpenClaw 클라이언트 — AI 음성 대화 모바일 앱
- **전략:** OpenClaw 앱 팩토리 — BOT 시리즈 첫 제품
- **시작일:** 2026-02-15
- **상태:** 🟢 진행중
- **로컬:** `C:\TEST\MAIBOTALKS`
- **GitHub:** [jini92/MAIBOTALKS](https://github.com/jini92/MAIBOTALKS)
- **Obsidian:** `01.PROJECT/11.MAIBOTALKS`

## 주요 마일스톤

| 날짜       | 내용                                                  | 상태         |
| ---------- | ----------------------------------------------------- | ------------ |
| 2026-02-15 | 프로젝트 초기화                                       | ✅ 완료      |
| 2026-02-15 | PRD v2.0 완료 (모바일앱+수익화)                       | ✅ 완료      |
| 2026-02-15 | Sprint 1 — Core Foundation 완료                       | ✅ 완료      |
| 2026-02-15 | Sprint 2 — UI/Middleware/Config 완료                  | ✅ 완료      |
| 2026-02-15 | 문서화 & 아키텍처 개요 작성                           | ✅ 완료      |
| 2026-02-15 | 실기기 테스트 가이드 작성                             | ✅ 완료      |
| 2026-02-15 | CHANGELOG 작성                                        | ✅ 완료      |
| 2026-02-15 | Expo Go 실기기 테스트 (iOS) — 풀 플로우 성공          | ✅ 완료      |
| 2026-02-15 | 버그 7개 수정 (녹음/STT/TTS/스트리밍)                 | ✅ 완료      |
| 2026-02-15 | 앱 아이콘 + 스플래시 + EAS Build 설정                 | ✅ 완료      |
| 2026-02-17 | 아키텍처 리팩토링 — 미들웨어 제거, Gateway 직접 연결  | ✅ 완료      |
| 2026-02-17 | 수익 모델 확정 → ₩9,900 일회성 + 7일 트라이얼         | ✅ 완료      |
| 2026-02-17 | QR 코드 스캔 + 딥링크 자동 연결                       | ✅ 완료      |
| 2026-02-17 | 온보딩 5스텝 + 구매 게이트 + 사용자 가이드            | ✅ 완료      |
| 2026-02-17 | clawhub botalks 스킬 패키지 생성                      | ✅ 완료      |
| 2026-02-17 | OpenClaw 앱 팩토리 사업계획서 (A002)                  | ✅ 완료      |
| 2026-02-17 | 실기기 테스트 가이드 (T003)                           | ✅ 완료      |
| 2026-02-22 | EAS Build + App Store Connect 제출                    | ✅ 완료      |
| 2026-02-22 | TestFlight 외부 베타 통과                             | ✅ 완료      |
| 2026-02-22 | **App Store 심사 제출** (v1.0.0)                      | 🟡 심사 대기 |
| 2026-02-24 | botalks-web GitHub Pages 배포 (privacy/terms/support) | ✅ 완료      |
| 2026-02-24 | 심사 긴급 수정 가이드 (I007) 작성                     | ✅ 완료      |
| 2026-02-24 | ASC Support URL + Marketing URL 변경                  | ✅ 완료      |
| 2026-02-24 | ASC Privacy Policy URL + Review Notes + Description   | 🔴 미완료    |

## ⚠️ App Store 심사 — URL 수정 진행 중

**상태:** 심사 대기 중 (2026-02-22 제출) → 도메인 등록 + URL 수정 진행 중 (2026-02-24)
**문제:** 제출 시 `botalks.app` 도메인 미존재 → 리젝 위험
**해결:** ✅ `botalks.app` 도메인 등록 (whois.co.kr) + GitHub Pages 연결

### botalks-web 정적 사이트

- **로컬:** `C:\TEST\botalks-web\` (순수 HTML/CSS)
- **GitHub:** `jini92/botalks-web`
- **URL:** `https://botalks.app/` (커스텀 도메인)
- **페이지:** 메인(`/`), privacy(`/privacy/`, `/privacy/ko/`), terms(`/terms/`), support(`/support/`)

### botalks.app 도메인 설정

- **등록:** whois.co.kr (2026-02-24)
- **DNS:** A 레코드 4개 필요 → `185.199.108.153` / `109` / `110` / `111`
- **GitHub Pages CNAME:** 설정 완료 (CNAME 파일 + `gh api` 설정)
- **HTTPS:** DNS 전파 후 GitHub가 Let's Encrypt 자동 발급

### App Store Connect URL — 최종 정리

| 항목               | 최종 URL                       | ASC 수정 |
| ------------------ | ------------------------------ | -------- |
| Privacy Policy URL | `https://botalks.app/privacy/` | ❌ 필요  |
| Support URL        | `https://botalks.app/support/` | ✅ 완료  |
| Marketing URL      | `https://botalks.app/`         | ✅ 완료  |
| Review Notes       | I007 가이드 참고               | ❌ 필요  |
| Description 내 URL | privacy/, terms/ 수정          | ❌ 필요  |

**잔여 작업:** DNS 전파 확인 → ASC에서 Support/Marketing URL도 `botalks.app`으로 재변경 → Privacy + Review Notes + Description 수정 → 저장 → 재제출
**상세 가이드:** `docs/I007-appstore-review-fix.md`

## Tech Intelligence 인사이트 (2026-02-24)

- **⚠️ Expo SDK 55**: New Architecture 필수화, expo-av 제거, Reanimated v4 필수 — SDK 54→55 마이그레이션 계획 필요
- SDK 55 신기능: Home Screen 위젯, Live Activities, OTA 75% 축소 — UX 차별화 기회
- **NVIDIA Canary-Qwen 2.5B**: ASR 1위 (WER 5.63%) — Whisper 대체 STT 후보
- **Qwen3-ASR 1.7B**: 128동시 처리 2000배 처리량 — 서버 비용 절감 가능
- **OpenClaw v2026.2.22**: 한국어 FTS 조사 인식 개선, iOS Talk TTS prefetch
- **Pocket TTS (100M)**: CPU 실시간 음성 클로닝 — 모바일 에지 배포 후보

## 구현 완료 항목

### Sprint 1 (Core Foundation)

- ✅ Expo SDK 54 프로젝트 초기화 (expo-router v6, NativeWind)
- ✅ 프로젝트 구조 확립 (src/components, hooks, services, stores, types, constants)
- ✅ 메인 대화 화면 UI (MicButton, TypingIndicator, ErrorToast, SkeletonLoader)
- ✅ 오디오 파이프라인 (expo-av 녹음/재생, STT, TTS 서비스)
- ✅ 상태 관리 (Zustand: chat, auth, subscription, settings stores)
- ✅ useVoiceChat 훅 — 전체 파이프라인 오케스트레이션
- ✅ OpenClaw Gateway API 연동 (SSE 스트리밍)
- ✅ 통합 완료 (TypeScript zero errors, Metro bundler OK)

### Sprint 2 (UI Polish & Middleware)

- ✅ 미들웨어 서버 (Hono + Node.js) — auth, rate limiting, chat/stt/tts 프록시
- ✅ UI 애니메이션, 에러 핸들링, 로딩 상태
- ✅ App config (EAS Build), 개인정보처리방침, 이용약관
- ✅ 온보딩/구독 화면
- ✅ 탭 네비게이션 (채팅, 설정)

## 기술 스택

- **프론트:** React Native + Expo SDK 54 (EAS Build) → iOS/Android 동시
- **라우터:** Expo Router v6 (file-based)
- **스타일:** NativeWind (Tailwind CSS)
- **상태관리:** Zustand
- **오디오:** expo-av (recording & playback)
- **STT:** Gateway `/v1/audio/transcriptions` (Whisper)
- **TTS:** Gateway `/v1/audio/speech` + expo-speech 폴백
- **백엔드:** 없음 (사용자 OpenClaw Gateway 직접 연결)
- **연결:** QR 코드 스캔 / 딥링크 (`botalks://connect`) / 수동 입력
- **결제:** 앱 유료 ₩9,900 (일회성, 7일 트라이얼)
- **스킬:** clawhub `botalks` 스킬 (QR 페어링 + 딥링크)

## App Store 배포 (2026-02-22)

| 항목                     | 값                                     |
| ------------------------ | -------------------------------------- |
| Apple Team ID            | 54XQEMHTJU                             |
| Bundle ID                | com.botalks.app                        |
| ASC App ID               | 6759508239                             |
| Distribution Certificate | AAFCFEA20F30E158... (만료: 2027-02-22) |
| Provisioning Profile     | PF4B29M6GY                             |
| ASC API Key              | 73SAA346TL                             |
| EAS Project ID           | 71da9f38-678f-4fb5-973a-72b55d9d9eed   |
| 빌드 성공 ID             | b308162e-b4a8-4043-a3e4-b9b4003cf62c   |
| 제출 ID                  | 57d6b07f-a71b-4d93-b437-2167f53d047a   |

### 배포 교훈

- sharp 등 네이티브 패키지는 devDeps에서 제거 (EAS macOS 빌드 충돌)
- 최초 빌드는 interactive 필수 (Apple 인증서 생성)
- Apple 2FA: device 실패 시 sms로 전환
- `ITSAppUsesNonExemptEncryption: false` 필수 설정

## 수익화

- 앱 유료 ₩9,900 (일회성 구매, 무료 없음)
- 7일 트라이얼 후 구매 필수
- 사용자가 자기 OpenClaw Gateway 인프라 비용 부담
- 구독 없음, 사용량 제한 없음

## 사업 모델: OpenClaw 앱 팩토리 (A002)

- clawhub 스킬(무료) + 전용 앱(유료) 조합
- 서버 비용 ₩0 → 고마진
- BOT 시리즈: BOTALKS → BOTNOTE → BOTCAM → BOTWATCH → BOTHOME → BOTCON
- 사업계획서: `docs/A002-openclaw-app-factory.md`

## 문서

- `docs/D-technical-design.md` — 기술 설계 문서
- `docs/D-development-plan.md` — 개발 계획 (스프린트별)
- `docs/D-architecture-overview.md` — 아키텍처 개요 (시스템 다이어그램)
- `docs/integration-report.md` — 통합 리포트
- `docs/privacy-policy.md` / `docs/privacy-policy-ko.md` — 개인정보처리방침
- `docs/terms-of-service.md` — 이용약관
- `docs/D-testing-guide.md` — 실기기 테스트 가이드
- `docs/CHANGELOG.md` — 변경 이력

## 다음 액션

- [x] Apple Developer 가입 ($99/yr) — 완료
- [ ] Google Play Developer 가입 ($25) — 신청 완료, 인증 절차 중 (2026-02-21)
- [x] EAS Build (iOS) — 완료 (빌드 ID: b308162e)
- [x] App Store 심사 제출 — 완료 (2026-02-22)
- [ ] **🔴 ASC Privacy Policy URL 변경** → `https://jini92.github.io/botalks-web/privacy/`
- [ ] **🔴 ASC Review Notes 업데이트** → I007 가이드 참고
- [ ] **🔴 ASC Description 내 old URL 수정** → `botalks.app` → `jini92.github.io/botalks-web/`
- [ ] **🔴 ASC 저장 + 심사 재제출**
- [ ] `botalks.app` 커스텀 도메인 구매 → GitHub Pages CNAME 연결
- [ ] EAS Build (Android) + Google Play 제출
- [ ] Tailscale funnel/VPS 데모 Gateway (다음 버전 심사용)

## 아키텍처 변경 이력

- 2026-02-15: 중앙 미들웨어 서버 방식 (Hono proxy → OpenClaw Gateway)
- 2026-02-17: **사용자 독립 방식으로 전환** — 미들웨어 제거, 앱이 사용자의 OpenClaw Gateway에 직접 연결
  - 이유: 사용자 독립성, 심플한 아키텍처
  - QR 코드 + 딥링크로 원클릭 연결
  - server/ 폴더 deprecated

## 메모

- docs 폴더는 Obsidian에 robocopy로 동기화 (NOT symlink)
- 고혈압 약 알림: 매일 아침 6시 (2026-02-16부터 변경)
- 문서 명명규칙: A000(분석)/D000(설계)/I000(구현)/T000(테스트)
- BOTALKS 미들웨어 Windows 스케줄 태스크: "BOTALKS Middleware" (deprecated — 더 이상 불필요)
- 설날: 2026-02-17 (음력 설)
