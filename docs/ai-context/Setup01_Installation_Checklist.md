# MAIBOT 설치 및 설정 체크리스트

## 개요

MAIBOT(Moltbot) 설치부터 운영까지 필요한 작업 목록을 단계별로 정리한 문서입니다.

**대상 환경**: Windows (WSL2 권장), macOS, Linux
**필수 요구사항**: Node.js ≥22, pnpm (소스 빌드 시)

---

## Phase 1: 사전 준비

### 1.1 시스템 요구사항 확인
- [ ] **Node.js 버전**: `node -v` 실행 → 22.x 이상 확인
- [ ] **npm 버전**: `npm -v` 실행 → 정상 작동 확인
- [ ] **pnpm 설치** (소스 빌드 시): `corepack enable && corepack prepare pnpm@10.23.0 --activate`
- [ ] **Windows 사용자**: WSL2 설치 (Ubuntu 권장) - 네이티브 Windows는 비권장

### 1.2 개발 도구 설치 (선택사항)
- [ ] **macOS**: Xcode Command Line Tools (앱 빌드 시)
- [ ] **Git**: 소스 빌드나 버전 관리용
- [ ] **Bun**: TypeScript 직접 실행용 (선택사항)

### 1.3 API 키 준비
- [ ] **Anthropic API 키**: Claude 모델 사용 (권장)
- [ ] **OpenAI API 키**: GPT 모델 사용 (대체용)
- [ ] **Brave Search API 키**: 웹 검색 기능용 (선택사항)

---

## Phase 2: MAIBOT 설치

### 2.1 설치 방법 선택

**옵션 A: 자동 설치 스크립트 (권장)**
```bash
# Linux/macOS
curl -fsSL https://molt.bot/install.sh | bash

# Windows (PowerShell)
iwr -useb https://molt.bot/install.ps1 | iex
```

- [ ] 설치 스크립트 실행
- [ ] 설치 완료 메시지 확인
- [ ] `moltbot --version` 명령어로 설치 확인

**옵션 B: npm 글로벌 설치**
```bash
npm install -g moltbot@latest
# 또는
pnpm add -g moltbot@latest
```

- [ ] npm/pnpm으로 설치
- [ ] PATH 설정 확인: `echo $PATH` → `$(npm prefix -g)/bin` 포함 여부
- [ ] `moltbot --version` 실행 확인

**옵션 C: 소스에서 빌드 (개발자용)**
```bash
git clone https://github.com/jini92/MAIBOT.git
cd MAIBOT
pnpm install
pnpm ui:build  # UI 의존성 자동 설치
pnpm build
```

- [ ] 저장소 클론
- [ ] 의존성 설치 (`pnpm install`)
- [ ] UI 빌드 (`pnpm ui:build`)
- [ ] TypeScript 빌드 (`pnpm build`)
- [ ] 빌드 산출물 확인: `dist/` 디렉토리 생성

### 2.2 PATH 문제 해결 (필요 시)

**증상**: `moltbot` 명령어를 찾을 수 없음

**진단**:
```bash
node -v
npm -v
npm prefix -g
echo "$PATH"
```

**해결**:
```bash
# macOS/Linux - ~/.zshrc 또는 ~/.bashrc에 추가
export PATH="$(npm prefix -g)/bin:$PATH"

# 적용
source ~/.zshrc  # 또는 source ~/.bashrc
```

- [ ] PATH에 npm 글로벌 bin 디렉토리 추가
- [ ] 새 터미널 열기 또는 `rehash` (zsh) / `hash -r` (bash)
- [ ] `moltbot --version` 재확인

---

## Phase 3: 온보딩 및 초기 설정

### 3.1 온보딩 마법사 실행
```bash
moltbot onboard --install-daemon
```

**마법사 단계**:
1. **게이트웨이 모드 선택**
   - [ ] Local (로컬 실행) 또는 Remote (원격 게이트웨이) 선택

2. **AI 모델 인증 설정**
   - [ ] Anthropic API 키 입력 (권장)
   - [ ] OpenAI API 키 입력 (대체용)
   - [ ] OAuth 인증 선택 (선택사항)

3. **채널 설정**
   - [ ] WhatsApp QR 로그인 (Baileys)
   - [ ] Telegram 봇 토큰 입력
   - [ ] Discord 봇 토큰 입력
   - [ ] Slack 앱 토큰 입력 (선택사항)
   - [ ] 기타 채널 설정 (Signal, iMessage, Matrix 등)

4. **데몬 설치**
   - [ ] 백그라운드 서비스 설치 (launchd/systemd)
   - [ ] 런타임 선택: Node.js (권장) - Bun은 비권장
   - [ ] 게이트웨이 토큰 자동 생성 확인

5. **워크스페이스 설정**
   - [ ] 기본 워크스페이스 경로 설정 (기본값: `~/clawd`)
   - [ ] 스킬 부트스트랩 (선택사항)
   - [ ] 보안 설정 (DM 페어링 기본값)

### 3.2 설정 파일 확인

**주요 설정 파일 위치**:
- [ ] `~/.clawdbot/moltbot.json` - 메인 설정
- [ ] `~/.clawdbot/agents/<agentId>/agent/auth-profiles.json` - 인증 프로필
- [ ] `~/.clawdbot/credentials/oauth.json` - OAuth 자격증명 (레거시)

**설정 확인**:
```bash
moltbot config --list
```

- [ ] 게이트웨이 포트 확인 (기본값: 18789)
- [ ] 인증 토큰 설정 확인
- [ ] AI 모델 설정 확인

### 3.3 웹 검색 API 설정 (선택사항)
```bash
moltbot configure --section web
```

- [ ] Brave Search API 키 입력
- [ ] `tools.web.search.apiKey` 설정 저장
- [ ] 웹 검색 기능 활성화 확인

---

## Phase 4: 게이트웨이 실행 및 검증

### 4.1 게이트웨이 시작
```bash
# 포그라운드 실행 (개발/디버깅)
moltbot gateway --port 18789 --verbose

# 또는 데몬으로 실행 (백그라운드)
# 온보딩 시 --install-daemon으로 이미 설치됨
```

- [ ] 게이트웨이 실행 확인
- [ ] 로그에서 오류 메시지 확인
- [ ] 포트 18789 리스닝 확인: `ss -ltnp | grep 18789` (Linux) 또는 `lsof -i :18789` (macOS)

### 4.2 상태 점검
```bash
moltbot doctor
moltbot status
moltbot health
moltbot channels status --probe
```

- [ ] `moltbot doctor` 통과 (설정 및 의존성 검증)
- [ ] 게이트웨이 상태 정상 (`moltbot status`)
- [ ] 헬스 체크 통과 (`moltbot health`)
- [ ] 채널 상태 확인 (`moltbot channels status`)

### 4.3 대시보드 접속
```bash
moltbot dashboard
```

- [ ] 브라우저에서 `http://127.0.0.1:18789/` 접속
- [ ] Control UI 로딩 확인
- [ ] 채팅 인터페이스 작동 확인

### 4.4 첫 메시지 테스트
```bash
# CLI에서 직접 에이전트 실행
moltbot agent --message "안녕하세요, 테스트입니다" --thinking high

# 또는 특정 채널로 메시지 전송
moltbot message send --to +821012345678 --message "테스트 메시지"
```

- [ ] CLI 에이전트 응답 확인
- [ ] 채널 메시지 전송 성공 확인
- [ ] 양방향 대화 작동 확인

---

## Phase 5: 채널별 설정

### 5.1 WhatsApp (Baileys)
```bash
moltbot channels setup whatsapp
```

- [ ] QR 코드 스캔 (WhatsApp 앱에서)
- [ ] 연결 성공 메시지 확인
- [ ] 세션 저장 확인
- [ ] 테스트 메시지 송수신

### 5.2 Telegram
```bash
moltbot channels setup telegram
```

- [ ] BotFather에서 봇 생성
- [ ] 봇 토큰 입력
- [ ] 봇에게 `/start` 메시지 전송
- [ ] 봇 응답 확인

### 5.3 Discord
```bash
moltbot channels setup discord
```

- [ ] Discord Developer Portal에서 앱 생성
- [ ] 봇 토큰 복사
- [ ] 토큰 입력 및 저장
- [ ] 서버에 봇 초대
- [ ] 봇 온라인 상태 확인

### 5.4 기타 채널
- [ ] Slack: 앱 토큰 설정
- [ ] Signal: 전화번호 등록
- [ ] iMessage: macOS 연동 설정
- [ ] Matrix: 홈서버 연결
- [ ] Zalo: 개인/비즈니스 계정 연동

---

## Phase 6: 고급 설정

### 6.1 AI 모델 페일오버 설정
```bash
moltbot configure --section models
```

- [ ] 주 모델 설정: Anthropic Claude (권장)
- [ ] 백업 모델 설정: OpenAI GPT
- [ ] 페일오버 순서 정의
- [ ] auth-profiles.json 확인

**페일오버 예시 설정**:
```json
{
  "routing": {
    "models": {
      "primary": "anthropic/claude-opus-4.5",
      "fallback": ["openai/gpt-4o", "openai/gpt-4"]
    }
  }
}
```

### 6.2 샌드박스 설정
```bash
moltbot configure --section agents
```

- [ ] 샌드박스 모드 선택: `non-main` (권장)
- [ ] 메인 에이전트 예외 설정 (필요 시)
- [ ] 워크스페이스 격리 확인

**샌드박스 설정 예시**:
```json
{
  "agents": {
    "defaults": {
      "sandbox": { "mode": "non-main" }
    }
  },
  "routing": {
    "agents": {
      "main": {
        "workspace": "~/clawd",
        "sandbox": { "mode": "off" }
      }
    }
  }
}
```

### 6.3 메모리 및 컨텍스트 관리
```bash
moltbot memory --help
```

- [ ] 메모리 프루닝 설정 (세션 정리)
- [ ] 컨텍스트 압축 활성화
- [ ] 세션 타임아웃 설정

### 6.4 Cron 작업 설정 (자동화)
```bash
moltbot cron add --name daily-summary --schedule "0 18 * * *" --action "Send daily summary"
```

- [ ] 주기적 작업 정의
- [ ] Cron 표현식 검증
- [ ] 작업 실행 로그 확인

### 6.5 웹훅 설정 (외부 통합)
```bash
moltbot webhooks add --url https://api.example.com/webhook --event message.received
```

- [ ] 웹훅 URL 등록
- [ ] 이벤트 타입 선택
- [ ] 웹훅 시크릿 설정
- [ ] 테스트 요청 전송

---

## Phase 7: 운영 및 유지보수

### 7.1 로그 모니터링
```bash
# 게이트웨이 로그 (production 환경)
tail -f /tmp/moltbot-gateway.log

# 또는 systemd 로그 (Linux)
journalctl -u moltbot-gateway -f

# 또는 launchd 로그 (macOS)
tail -f ~/Library/Logs/moltbot-gateway.log
```

- [ ] 로그 파일 위치 확인
- [ ] 오류 메시지 모니터링
- [ ] 로그 로테이션 설정

### 7.2 정기 점검 작업

**매주 월요일: 테스트 커버리지 점검**
```bash
pnpm test:coverage
```
- [ ] 커버리지 ≥70% 유지 확인
- [ ] 65% 이하 파일 식별

**매주 수요일: 의존성 보안 점검**
```bash
pnpm audit
pnpm outdated
```
- [ ] 보안 취약점 확인
- [ ] 중요 업데이트 적용

**매주 금요일: 문서 동기화**
- [ ] docs/ 변경사항 확인
- [ ] 링크 오류 점검
- [ ] CHANGELOG.md 업데이트

**매월 첫째 월요일: 전체 테스트**
```bash
pnpm test:all
```
- [ ] 전체 테스트 스위트 실행
- [ ] 700 LOC 초과 파일 식별
- [ ] 미사용 의존성 제거

### 7.3 업데이트
```bash
# 최신 안정 버전으로 업데이트
moltbot update --channel stable

# 또는 베타 채널
moltbot update --channel beta

# 또는 개발 채널
moltbot update --channel dev
```

- [ ] 업데이트 전 백업 (설정 파일, 세션 데이터)
- [ ] 업데이트 실행
- [ ] `moltbot doctor` 재검증
- [ ] 채널 재연결 확인

### 7.4 데이터 백업
```bash
# 설정 백업
cp -r ~/.clawdbot ~/.clawdbot.backup-$(date +%Y%m%d)

# 또는 특정 파일만
cp ~/.clawdbot/moltbot.json ~/backups/moltbot-config-$(date +%Y%m%d).json
```

- [ ] 주기적 설정 백업 (주 1회 권장)
- [ ] 세션 데이터 백업 (WhatsApp 세션 등)
- [ ] 백업 복구 테스트

### 7.5 게이트웨이 재시작 (필요 시)
```bash
# SSH를 통한 원격 재시작 (production)
pkill -9 -f moltbot-gateway || true
nohup moltbot gateway run --bind loopback --port 18789 --force \
> /tmp/moltbot-gateway.log 2>&1 &

# 상태 확인
ss -ltnp | grep 18789
tail -n 120 /tmp/moltbot-gateway.log
```

- [ ] 게이트웨이 프로세스 종료 확인
- [ ] 새 프로세스 시작 확인
- [ ] 포트 리스닝 확인
- [ ] 로그에서 초기화 성공 확인

---

## Phase 8: 개발 환경 설정 (선택사항)

### 8.1 소스 개발 환경
```bash
cd MAIBOT
pnpm install
pnpm ui:build
pnpm build
```

- [ ] Git 저장소 클론
- [ ] 의존성 설치
- [ ] UI 빌드
- [ ] TypeScript 빌드
- [ ] 빌드 아티팩트 확인

### 8.2 개발 모드 실행
```bash
# 게이트웨이 개발 모드 (채널 스킵)
pnpm gateway:dev

# 또는 자동 재로드
pnpm gateway:watch

# 또는 TUI 모드
pnpm tui
```

- [ ] Hot-reload 작동 확인
- [ ] 채널 스킵 설정 확인 (`CLAWDBOT_SKIP_CHANNELS=1`)
- [ ] TypeScript 변경사항 자동 컴파일

### 8.3 테스트 실행
```bash
# 빠른 테스트
pnpm test

# 커버리지 포함
pnpm test:coverage

# 라이브 테스트 (자격증명 필요)
CLAWDBOT_LIVE_TEST=1 pnpm test:live

# Docker E2E 테스트
pnpm test:docker:all
```

- [ ] 유닛 테스트 통과
- [ ] 커버리지 ≥70% 확인
- [ ] 라이브 테스트 성공 (채널 연동 테스트)

### 8.4 코드 품질 도구
```bash
# Pre-commit 훅 설치
prek install

# 빌드 + 테스트
pnpm build && pnpm test

# Lint (Oxlint)
pnpm lint

# Format (Oxfmt)
pnpm format
```

- [ ] Pre-commit 훅 설치
- [ ] Lint 오류 없음
- [ ] 포맷팅 규칙 준수
- [ ] `.secrets.baseline` 확인 (detect-secrets)

---

## 문제 해결

### 일반적인 문제

**1. `moltbot` 명령어를 찾을 수 없음**
- 원인: PATH 설정 누락
- 해결: Phase 2.2 "PATH 문제 해결" 참조

**2. WhatsApp QR 코드가 표시되지 않음**
- 원인: 터미널 호환성 문제
- 해결: `moltbot channels setup whatsapp --qr-terminal` 시도

**3. 게이트웨이가 시작되지 않음**
- 원인: 포트 충돌
- 해결: `ss -ltnp | grep 18789`로 포트 사용 확인 → 다른 포트 사용 또는 프로세스 종료

**4. AI 모델 응답 없음**
- 원인: API 키 누락 또는 잘못됨
- 해결: `moltbot configure --section models` 재실행 → API 키 확인

**5. 채널 연결 실패**
- 원인: 토큰 만료 또는 네트워크 문제
- 해결: 채널 재설정 (`moltbot channels setup <channel>`) → 토큰 재발급

**6. 메모리 부족 오류**
- 원인: 세션 데이터 축적
- 해결: `moltbot memory prune` 실행 → 오래된 세션 정리

**7. `sharp` 빌드 실패 (npm install 시)**
- 원인: 시스템 libvips와 충돌
- 해결: `SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g moltbot@latest`

---

## 추가 리소스

**공식 문서**:
- 웹사이트: https://molt.bot
- 문서: https://docs.molt.bot
- GitHub: https://github.com/moltbot/moltbot
- Discord: https://discord.gg/clawd

**주요 가이드**:
- [Getting Started](https://docs.molt.bot/start/getting-started)
- [Onboarding Wizard](https://docs.molt.bot/start/wizard)
- [Channel Setup](https://docs.molt.bot/channels/)
- [Model Configuration](https://docs.molt.bot/concepts/models)
- [Security Guide](https://docs.molt.bot/gateway/security)

**개발자 리소스**:
- PI Agent Core: https://github.com/mariozechner/pi
- Plugin SDK: src/plugin-sdk/
- API Reference: docs/api/

---

*Last updated: 2026-01-30*
*EXFOLIATE! — 사용하지 않는 항목은 제거하고 실제로 필요한 작업만 유지하세요.*
