# Tech Intelligence 누적 기록

## 2026-02-25

### 🚨 긴급

- **TikTok Shop Seller Shipping 종료 (오늘 2/25 시행)** → FBT/Upgraded/CBT만 허용. 3/31 완전 차단. MAIBEAUTY·MAITOK 커머스 아키텍처 반영 필수
- **OpenClaw v2026.2.23 SSRF Breaking Change** — browser SSRF `trusted-network` 기본값 변경. `openclaw doctor --fix` 마이그레이션 필요 (MAIBOTALKS·MAIBOT)
- **Zalo VND 8.1억 벌금** (소비자권리 위반) + 개인정보 확대수집 논란 → MAISTAR7 멀티채널 전략 재확인

### TTS (업데이트)

- **Kani-TTS-2** (2026-02-15): 400M param, LFM2+NanoCodec 아키텍처, 3GB VRAM, RTF 0.2 (10초→2초), 제로샷 음성 클로닝, Apache 2.0. 10K시간 데이터를 H100 8대로 6시간 학습
  - EN/PT 모델 공개, 한국어·베트남어 미지원 → edge-tts 하이브리드 운용 필요
  - Piper: CPU 실시간(10x 빠름), 엣지 디바이스 최적 → 경량 대안
- Kani-TTS-2 vs Kokoro(이전 기록) vs Pocket TTS: 용도별 선택지 확대

### Talking Head (업데이트)

- 2026 립싱크 8대 오픈소스 정리:
  - **Wav2Lip**: 더빙 강자 (기존 영상), **SadTalker**: 단일이미지→빠른 아바타
  - **LivePortrait**: 프리미엄 감정 표현, **GeneFace++**: 3D 아이덴티티 보존
  - **LipGAN**: 엣지/실시간, **PC-AVS**: 포즈·표정 세밀 제어
- SoulX-FlashHead (arxiv 2602.07449): Oracle-guided 실시간 스트리밍 — SadTalker·Hallo3·AniPortrait 대비 분석

### React Native / Expo

- **React Native 0.84** (2/11): Hermes V1 기본 엔진 (자동 성능↑), iOS 프리컴파일 바이너리 기본 (빌드 시간↓), Node.js 22 최소, Legacy Architecture 코드 제거 계속
- **Expo SDK 56 예고** (RN 0.85 기반) — SDK 55 canary에서 Expo SDK 55 GA 후 출시

### OpenClaw (업데이트)

- **v2026.2.23** (2/24): SSRF→trusted-network 기본, env.\* 키 자동 삭제, 난독화 명령어 승인 필수, Skills XSS 방어, OTEL 키 삭제
- Claude Opus 4.6 퍼스트클래스 지원, Kilo Gateway, Vercel AI Gateway Claude 정규화
- web_search에 Moonshot "kimi" 프로바이더 추가, Moonshot 비디오 네이티브 지원
- 40건+ 보안 수정 (CVE-2026-25253 포함, 이전 기록 참조)

### Zalo (업데이트)

- **VND 8.1억 벌금** 부과 (국가경쟁위원회, 소비자권리 위반)
- 2025-12 약관: 주민등록·가족·위치·콘텐츠 데이터 수집 강제 (미동의 시 45일 탈퇴)
- 유료화: 연락처/메시지 수 제한, 클라우드 1GB→500MB, 구독료 ₫200K/월
- 사용자 이탈 우려 but 80M 유저·정부기관 연결로 "사회적 비용" 때문에 완전 이탈 어려움
- **ZBS 2026 로드맵**: Zalo OA 대규모 대화 관리 + 멀티디바이스 + 자동 챗봇. ZBS Template Message(UID+전화번호 통합). Business Box(미팔로우 비즈 메시지 노출)

### TikTok (업데이트)

- **Seller Shipping 종료**: 2/25 단계 시행, 3/31 완전 차단. FBT(풀필먼트 위탁, 무료3일배송 뱃지), Upgraded Shipping(3PL 유지+TikTok 라벨), CBT(허브 픽업)
- Research API 확장: comment mentions + video post mentions 접근 확대 (2024~2025)
- 쇼핑 기능·크리에이터 수익화 파일럿 테스트 중, 규제 대응 투명성 업데이트 지속

### OSS 보안 (업데이트)

- 2026 top-11 도구 정리: DefectDojo(200+ 스캐너 통합), Dependency-Track(SBOM 지속 모니터링), Greenbone/OpenVAS, Wazuh(XDR+SIEM), Vuls(에이전트리스 SSH), Prowler(CSPM), OWASP ZAP, Trivy, Semgrep
- **Zen-AI-Pentest** (2026-02-11): 오픈소스 AI 기반 침투 테스트 프레임워크 — 자율 에이전트 + 표준 보안 유틸 결합
- MAIOSS 포지셔닝: 도달성 분석(reachability) 차별화 유효. AI 펜테스트 연동 기능 추가 검토

### STT (업데이트)

- NVIDIA Canary-Qwen 2.5B: Open ASR Leaderboard 1위 유지 (WER 5.63%)
- Microsoft PazaBench: 저자원 언어 39개 ASR 벤치마크·리더보드 공개 (한국어·베트남어 해당 가능성)
- Voice AI 인프라: L4 GPU당 ASR 50건 / TTS 20건 동시, 자연스러운 대화 < 500ms 임계값

### Digital Twin (업데이트)

- **TwinRL-VLA** (arxiv 2026-02): DT 기반 RL로 로봇 조작 학습. VLA+RL 결합으로 실제 환경 전이
- HD현대 × Siemens: Xcelerator 기반 조선 DT + Industrial Metaverse + 합성데이터 RL (2026 단계 도입)
- InfluxDB 3 Core: 실시간 수집 + 최근 데이터 쿼리 최적화 권장

### 어학교육 AI (업데이트)

- 2026 경쟁 구도: Speak(롤플레이), Langua(유창성), Jumpspeak(능동적 몰입), TalkPal(동적 대화)
- 차별화 = AI "통합 방식" (구조화 Pimsleur/Rosetta vs 대화형 TalkPal vs 하이브리드 Babbel)
- 한-베 양방향 AI 서비스 여전히 블루오션

### FastAPI

- v0.99.0 + Starlette 0.20.0: 비동기 I/O-bound 시나리오에서 **지연시간 30% 감소** (2026 벤치마크)

---

## 2026-02-24

### AI 커머스

- **Google UCP (Universal Commerce Protocol)** 출시 — AI 에이전트가 상품 발견→평가→구매 완료
- OpenAI+Stripe **Agentic Commerce Protocol (ACP)** 발표 — 업계 표준 경쟁
- Google AI Mode 내 직접 결제 가능 (UCP-powered checkout)
- 2026년 40% 고객이 AI 플랫폼에서 구매 여정 시작 예측

### Talking Head (신규)

- **InfiniteTalk (MeiGen-AI)**: Wan2.1 기반, 전신(입술+머리+어깨+눈) 동시 생성
  - 립싱크 오차: 1.8mm (SadTalker 3.2mm, MuseTalk 2.7mm)
  - Sparse-frame context window로 무제한 길이 생성
  - 480p: 6GB VRAM, 720p: 16GB+ — RTX 3090에서 구동 가능
  - **SadTalker 대체 1순위** (MAIBEAUTY Model 01 파이프라인 교체 후보)

### TTS (신규)

- **Pocket TTS**: 100M 파라미터, GPU 불필요, CPU 실시간 생성 + 음성 클로닝
- **Chatterbox Turbo**: 멀티스피커 대화 생성 + 프로소디 전이 2026 예정
- **Qwen3-TTS**: 10개 언어 (한국어 ✅, 베트남어 ❌), 음성 클로닝 + 프로소디 제어
  - 베트남어는 근사 발음으로 처리 (비공식)

### STT (신규)

- **NVIDIA Canary-Qwen 2.5B**: Open ASR Leaderboard 1위 (WER 5.63%)
- **Qwen3-ASR 1.7B**: 동시 128 처리 시 Whisper 대비 2000배 처리량
- onnx-asr에 Canary/Moonshine 모델 추가

### Expo / React Native

- **Expo SDK 55 릴리스**: New Architecture 필수화, 레거시 브릿지 폐기
  - Home Screen 위젯 (@expo/ui), Live Activities 지원
  - OTA 업데이트 75% 축소 (Hermes bytecode diffing)
  - expo-av 제거, Reanimated v4 필수 — ⚠️ MAIBOTALKS 마이그레이션 필요

### OpenClaw

- **v2026.2.22**: Mistral 프로바이더, 한국어 FTS 조사 인식, 자동 업데이터, Synology Chat, iOS Talk TTS prefetch
- 브라우저 sandbox Docker 전용 네트워크 보안 강화

### Zalo (업데이트)

- **Zalo Business Solutions (ZBS)** 공식 출범 — 파트너센터 중앙 허브
- ZBS Template Message: UID + 전화번호 발송 통합
- Business Box: 미팔로우 사용자 비즈니스 메시지 표시 (차단률 관리)

### 카카오톡

- 카카오비즈니스 **파트너센터 통합 개편** (2025-12-08)
- Slack형 협업 기능, Open Chat 스레드, 스마트 알림 추가

### Digital Twin (업데이트)

- 2026 패러다임: **Smart Factory → Cognitive Factory** (Industry 5.0)
- Decision-Grade DT: 실시간 센서 + 공급망 + 에너지 통합
- **Agentic OT**: AI 에이전트 자율 생산라인 재배치/속도 조정
- NSF Center for Digital Twins in Manufacturing 설립 (표준 프레임워크)
- MDPI TDME: Deep RL + 다차원 경제 지표 보상 시그널

### OSS 보안 (업데이트)

- 핵심 진화: **도달성 분석(reachability analysis)** — 실제 호출 여부 분석으로 오탐 대폭 감소
- OSV-Scanner v2: guided remediation, Trivy: 멀티스캐너, Grype: EPSS 리스크 스코어

### TikTok (업데이트)

- 댓글 쓰기 API 여전히 없음 (2026-02-24 재확인)
- 미국 금지 해소 → "규제·구조화 시대" 진입
- **Local Feed** 기능 출시 — 지역 기반 콘텐츠 우선 노출

### 어학교육 AI (업데이트)

- 차별화: "AI 유무"가 아닌 "통합 방식" (구조화 vs 대화형 vs 하이브리드)
- 한국어↔베트남어 양방향 AI 서비스 = 여전히 블루오션 확인
- Speak, Langua, Ling App, TalkPal 주요 경쟁자

---

## 2026-02-22

### 🚨 보안

- OpenClaw 6건 취약점 공개 (Endor Labs, 2026-02-18). CVE-2026-26322 (Gateway SSRF, 7.6), CVE-2026-26319, CVE-2026-26329 등. **v2026.2.14+ 패치 완료.**

### TTS

- Kokoro TTS: 오픈웨이트, OpenAI 호환, $0.70/M chars — edge-tts 대안 1순위
- S1-mini, NeuTTS-air/nano: 2026-02 커뮤니티 최고 평가 로컬 TTS

### Talking Head

- SoulX-FlashHead: 실시간 스트리밍 talking head (논문 2026-02)
- LivePortrait: SadTalker 대비 품질↑, 커뮤니티 추천
- MuseTalk: 실시간 립싱크 특화

### STT

- Whisper v4 Turbo: 로컬, 커스텀 어휘 99%+ 정확도
- Parakeet V3 (NVIDIA): 로컬 ASR
- ONNX ASR (OpenVoiceOS, 2026-02-16): fasterwhisper C++ 가속 오프라인

### Zalo

- Zalo OA 2026: 대규모 대화 분류, 멀티디바이스, 챗봇 심층 통합

### Digital Twin / RL

- HD현대 × Siemens: 조선소 DT + 합성데이터 RL, 2026 단계 도입
- MDPI 종합 리뷰: DES + 다목적최적화 + 하이브리드 시뮬-최적화 + ML/RL + DT

### 어학교육 AI

- AI 챗봇 24/7 회화 연습 주류화. Langua, Copilot 등
- 핵심: STT + LLM + TTS 파이프라인 저비용 구현 가능

### TikTok

- 2026-02 알고리즘 변화 → 도달률 하락 보고
- Smart+ Ads API 통합 (GMV Max)
