# MAIBOT 설치 및 설정 체크리스트

## 개요

MAIBOT(OpenClaw) 설치부터 운영까지 필요한 작업 목록을 단계별로 정리한 문서입니다.

**용어 정리**:
- **OpenClaw**: 설치하는 오픈소스 엔진 (GitHub 리포, CLI 명령어 `openclaw`)
- **MAIBOT**: 사용자가 지정한 봇 이름/프로젝트명 (워크스페이스/디스코드 봇 이름)
- **Origin**: 사용자의 개인 포크 (jini92/MAIBOT)
- **Upstream**: 공식 원본 저장소 (openclaw/openclaw)

**대상 환경**:
- Windows (WSL2 강력 권장) / macOS / Linux
- Antigravity 격리 워크스페이스 환경 지원

**필수 요구사항**: Node.js ≥22, pnpm (소스 빌드 시)

---

## 📋 실제 설치 기준 선택값 (레퍼런스)

> 실제 Antigravity 환경 설치 로그 기준

- **Onboarding mode**: Manual
- **Gateway**: Local gateway (this machine)
- **Workspace directory**: `C:/MAIBOT`
- **Model/auth provider**: Anthropic
- **Anthropic auth method**: Anthropic token (paste setup-token)
- **Default model**: `anthropic/claude-opus-4-5`
- **Gateway port/bind/auth**: `18789` / `127.0.0.1` / Token
- **Tailscale exposure**: Off
- **Channel**: Discord (Bot API)
- **Discord channels access**: Open (allow all channels)
- **DM access policies**: No (default: pairing)
- **Gateway service install**: No (수동 실행)

---

## ⚠️ 중요 보안 경고

> **토큰 노출 시 즉시 회전(재발급) 필수**

**Discord Bot Token** 또는 **Claude setup-token**이 채팅/문서/스크린샷 등에 한번이라도 노출되면 **바로 폐기(Reset/재발급)**가 안전합니다.

- **Discord Bot Token**: Developer Portal → Bot → **Reset Token** → 새 토큰으로 교체
- **Claude setup-token**: 로컬 PC에서 `claude setup-token` 재실행 → 새 토큰으로 교체

---

## Phase 0: Antigravity 환경 설정 (선택사항)

> 로컬 PC 대신 **Antigravity 격리 워크스페이스**에서 설치하는 경우

### 0.1 Antigravity 워크스페이스 생성

- [ ] Antigravity 앱 실행 및 로그인
- [ ] **Agent Manager** 열기 (Ctrl+E / Cmd+E)
- [ ] **Workspaces → New Workspace** 클릭
- [ ] 워크스페이스 이름: `MAIBOT`로 지정
- [ ] 저장 위치 확인 (Antigravity 격리 관리)

### 0.2 OpenClaw GitHub 리포지토리 클론

**방법 A: Clone Repository 버튼 (권장)**
- [ ] 시작 화면에서 **Clone Repository** 선택
- [ ] URL 입력: `https://github.com/jini92/MAIBOT` (Fork된 주소 권장)
- [ ] Clone/Import 실행
- [ ] **Upstream 연결**:
  ```bash
  git remote add upstream https://github.com/openclaw/openclaw
  git fetch upstream
  ```

**방법 B: Agent 채팅 요청**
- [ ] Agent 입력창에 입력: `이 리포지토리를 워크스페이스로 클론해줘: https://github.com/openclaw/openclaw`

✅ **완료 기준**: 파일 트리에 OpenClaw 프로젝트 구조 (README, src 등) 표시

### 0.3 Node.js 버전 확인 (Antigravity 환경)

- [ ] Terminal 열기
- [ ] `node -v` 실행 → v22.x 이상 확인
- [ ] `npm -v` 실행 → 정상 확인

⚠️ **Node 버전이 낮은 경우**:
```bash
# Agent에게 요청 (가장 안전)
현재 워크스페이스에서 Node 22 이상으로 올려줘. 가능한 가장 안전한 방법(nvm 등)으로 진행해줘.
```

---

## Phase 1: 사전 준비

### 1.1 시스템 요구사항 확인

- [ ] **Node.js 버전**: `node -v` 실행 → 22.x 이상 확인
- [ ] **npm 버전**: `npm -v` 실행 → 정상 작동 확인
- [ ] **pnpm 설치** (소스 빌드 시): `corepack enable && corepack prepare pnpm@10.23.0 --activate`
- [ ] **Windows 사용자**: WSL2 설치 (Ubuntu 권장) - 네이티브 Windows는 불안정

### 1.2 개발 도구 설치 (선택사항)

- [ ] **macOS**: Xcode Command Line Tools (앱 빌드 시)
- [ ] **Git**: 소스 빌드나 버전 관리용
- [ ] **GitHub CLI (gh)**: GitHub 스킬 활성화용 (강력 권장)
- [ ] **Bun**: TypeScript 직접 실행용 (선택사항)

### 1.3 API 키 준비

- [ ] **Claude Code Max 플랜**: Claude Pro/Max 구독 (권장)
- [ ] **Anthropic API 키**: Claude 모델 사용 (API 키 방식 대체)
- [ ] **OpenAI API 키**: GPT 모델 사용 (페일오버용)
- [ ] **Brave Search API 키**: 웹 검색 기능용 (선택사항)

### 1.4 Discord 준비

- [ ] **Discord 서버 관리자 권한**: 봇 초대용
- [ ] **Discord Developer Portal 접속 가능**: 봇 생성용

---

## Phase 2: MAIBOT 설치

### 2.1 설치 방법 선택

**옵션 A: 자동 설치 스크립트 (권장 - 로컬 환경)**
```bash
# Linux/macOS
curl -fsSL https://openclaw.ai/install.sh | bash

# Windows (PowerShell)
iwr -useb https://openclaw.ai/install.ps1 | iex
```

- [ ] 설치 스크립트 실행
- [ ] 설치 완료 메시지 확인
- [ ] `openclaw --version` 명령어로 설치 확인

**옵션 B: npm 글로벌 설치**
```bash
npm install -g openclaw@latest
# 또는
pnpm add -g openclaw@latest
```

- [ ] npm/pnpm으로 설치
- [ ] PATH 설정 확인: `echo $PATH` → `$(npm prefix -g)/bin` 포함 여부
- [ ] `openclaw --version` 실행 확인

**⚠️ sharp 빌드 실패 시**:
```bash
SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g openclaw@latest
```

**옵션 C: ✅ Repo-local 실행 (Antigravity 권장 방식)**

> Global 패키지 오류 또는 격리 환경에서 권장

```bash
# 리포지토리 루트에서
pnpm install
pnpm ui:build  # Control UI 자동 빌드
pnpm build     # TypeScript 컴파일
```

- [ ] 저장소 클론 완료
- [ ] 의존성 설치 (`pnpm install`)
- [ ] UI 빌드 (`pnpm ui:build`) - Control UI assets 생성
- [ ] TypeScript 빌드 (`pnpm build`)
- [ ] 빌드 산출물 확인: `dist/` 디렉토리 생성

✅ **Repo-local 실행 명령어 패턴**:
```bash
# 온보딩
npm run openclaw -- onboard

# 게이트웨이 실행
npm run openclaw -- gateway --port 18789 --verbose

# 기타 명령
npm run openclaw -- <command> <args>
```

### 2.2 PATH 문제 해결 (글로벌 설치 시)

**증상**: `openclaw` 명령어를 찾을 수 없음

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
- [ ] `openclaw --version` 재확인

---

## Phase 3: 온보딩 및 초기 설정

### 3.1 온보딩 마법사 실행

**글로벌 설치 시**:
```bash
openclaw onboard
```

**Repo-local 실행 시** (✅ 실제 설치 방식):
```bash
npm run openclaw -- onboard
```

**마법사 단계별 가이드**:

#### 1) 온보딩 모드 선택
- [ ] **Manual** 선택 (권장 - 세부 설정 가능)
- [ ] Quickstart (빠른 설치 - 최소 프롬프트)

#### 2) 게이트웨이 모드 선택

> 📱 **중요**: 스마트폰 디스코드 사용은 게이트웨이 선택과 무관합니다. 봇은 디스코드 서버를 통해 메시지를 받으므로 PC/모바일 어디서든 `@MAIBOT`으로 대화 가능합니다.

- [ ] **Local gateway (this machine)** 선택 (✅ 권장)
  - 현재 머신에서 게이트웨이 실행
  - 24/7 운영이 필요 없는 경우 적합

- [ ] Remote gateway (별도 서버에서 게이트웨이 실행 중인 경우)
  - 항상 켜져 있는 서버에서 운영 시 선택
  - Remote URL 입력 필요

#### 3) 워크스페이스 설정
- [ ] Workspace directory 입력: `C:/MAIBOT` (또는 원하는 경로)
- [ ] 경로 확인 및 생성

#### 4) AI 모델 인증 설정

**옵션 A: ✅ Claude Code Max → setup-token (권장 - Antigravity 환경)**

> Antigravity 같은 격리 환경에서는 브라우저 OAuth 로그인이 번거롭거나 막힐 수 있어 이 방식이 가장 안정적입니다.

**로컬 PC에서 토큰 생성**:
```bash
claude setup-token
```

- [ ] 로컬 PC에서 Claude Code 로그인 확인
- [ ] `claude setup-token` 실행
- [ ] 출력되는 토큰 복사

**온보딩에서 토큰 입력**:
- [ ] Provider: **Anthropic** 선택
- [ ] Auth method: **Anthropic token (paste setup-token)** 선택
- [ ] 토큰 붙여넣기
- [ ] Token name: `CLAUDE_CODE_OAUTH_TOKEN` (기본값 유지)

**옵션 B: Anthropic API 키**
- [ ] Anthropic Console에서 API 키 발급
- [ ] `ANTHROPIC_API_KEY` 입력
- [ ] 모델 테스트 통과 확인

**옵션 C: Claude Code OAuth 자격 재사용**
- [ ] `~/.claude/.credentials.json` 존재 확인
- [ ] 마법사가 자동 인식하면 "reuse credentials" 선택

#### 5) 기본 모델 선택
- [ ] Default model: **anthropic/claude-opus-4-5** (✅ 권장)
- [ ] Keep current / 다른 모델 선택 가능

#### 6) 게이트웨이 설정
- [ ] **Port**: `18789` (기본값)
- [ ] **Bind**: `127.0.0.1` (Loopback - 로컬 접근만)
- [ ] **Auth**: Token (권장)
- [ ] **Tailscale exposure**: Off (기본값)
- [ ] **Gateway token**: 빈칸 유지 (자동 생성) 또는 직접 입력

⚠️ **Gateway token=undefined 방지**: 빈칸에서 Enter로 자동 생성 권장

#### 7) 채널 설정

- [ ] `Configure chat channels now?` → **Yes**
- [ ] Channel 선택: **Discord** (Space로 체크 → Enter)

**Discord Bot Token 입력**:
- [ ] Discord Developer Portal에서 Bot Token 발급 (Phase 4 참조)
- [ ] Token 붙여넣기
- [ ] `Configure Discord channels access?` → **Yes**
- [ ] Access policy: **Open (allow all channels)** (✅ 실제 선택값)

#### 8) DM 정책 설정
- [ ] `Configure DM access policies now?` → **No** (✅ 기본값 유지 권장)
  - 기본 정책: **pairing** (페어링 코드 승인 방식)
  - 보안: 무단 사용/토큰 소모 방지

#### 9) Skills 설정 (선택사항)
- [ ] `Configure skills now?` → Yes (권장)
- [ ] Preferred node manager: **npm**
- [ ] API 키 프롬프트 (선택사항):
  - Google Places API Key (goplaces)
  - Gemini API Key (nano-banana-pro)
  - Notion API Key
  - OpenAI API Key (image-gen, whisper)
  - ElevenLabs API Key (sag)
  - → 필요한 것만 입력, 나머지는 **No**

⚠️ **GitHub 스킬 실패 (brew not installed)**: Phase 6.1 참조 (GitHub CLI 설치)

#### 10) Gateway Service 설치 (선택사항)
- [ ] `Install Gateway service?` → **No** (✅ 수동 실행 권장 - Antigravity 환경)
  - Yes: launchd/systemd 데몬 자동 설치 (24/7 운영 시)
  - No: 수동 실행 (터미널에서 직접 관리)

### 3.2 온보딩 완료 확인

- [ ] 설정 파일 생성 확인: `%USERPROFILE%/.clawdbot/openclaw.json`
- [ ] 세션 디렉토리 확인: `%USERPROFILE%/.clawdbot/agents/main/sessions`
- [ ] Control UI URL 표시: `http://127.0.0.1:18789/`
- [ ] Health check 상태 확인 (게이트웨이 미실행 시 1006 오류 정상)

### 3.3 웹 검색 API 설정 (선택사항)

```bash
# 글로벌
openclaw configure --section web

# Repo-local
npm run openclaw -- configure --section web
```

- [ ] Brave Search API 키 입력
- [ ] `tools.web.search.apiKey` 설정 저장
- [ ] 웹 검색 기능 활성화 확인

---

## Phase 4: Discord 봇 생성 및 설정

### 4.1 Discord Application 생성

- [ ] [Discord Developer Portal](https://discord.com/developers/applications) 접속
- [ ] **New Application** 클릭
- [ ] Application 이름: `MAIBOT` (원하는 이름 가능)
- [ ] Create 확인

### 4.2 Bot 생성 및 Token 발급

- [ ] 좌측 메뉴: **Bot** 클릭
- [ ] **Add Bot** 클릭 (이미 있으면 생략)
- [ ] **Token** 섹션에서 **Reset Token** 클릭
- [ ] 토큰 복사 (⚠️ 한 번만 표시됨)

⚠️ **보안**: 토큰 절대 외부 공유 금지 (노출 시 즉시 Reset Token 재발급)

### 4.3 Privileged Gateway Intents 활성화 (🔴 필수)

> 이 설정이 없으면 Discord 4014 오류 발생

- [ ] Bot 설정 화면에서 **Privileged Gateway Intents** 섹션으로 스크롤
- [ ] ✅ **Message Content Intent** ON (🔴 필수)
- [ ] ✅ **Server Members Intent** ON (권장)
- [ ] Presence Intent (선택사항)
- [ ] **Save Changes** 클릭

⚠️ **반드시 저장 후 게이트웨이 재시작** 필요

### 4.4 Bot 권한 설정

**권장 최소 권한**:
- View Channels
- Send Messages
- Read Message History
- Add Reactions (선택)
- Attach Files (선택)

⚠️ **Administrator 권한은 과도** - 테스트 후 최소 권한으로 축소 권장

### 4.5 서버에 Bot 초대

#### OAuth2 URL 생성
- [ ] 좌측 메뉴: **OAuth2 → URL Generator**
- [ ] **SCOPES**:
  - ✅ `bot`
  - ✅ `applications.commands` (슬래시 커맨드용 - 권장)
- [ ] **BOT PERMISSIONS**:
  - 최소: View Channels, Send Messages, Read Message History
  - (또는) 테스트용: Administrator (나중에 축소 권장)
- [ ] **Generated URL** 복사

#### 초대 실행
- [ ] 복사한 URL을 브라우저 주소창에 붙여넣기
- [ ] '서버에 추가' 목록에서 대상 서버 선택
- [ ] **Continue** → **Authorize** 클릭
- [ ] 서버 멤버 목록에서 봇 확인 (오프라인 상태 정상)

✅ **완료 기준**: 서버 멤버 목록에 `MAIBOT` 봇 표시

---

## Phase 5: 게이트웨이 실행 및 검증

### 5.1 게이트웨이 시작

**글로벌 설치 시**:
```bash
openclaw gateway --port 18789 --verbose
```

**Repo-local 실행 시** (✅ 실제 방식):
```bash
npm run openclaw -- gateway --port 18789 --verbose
```

**설정 파일 기반 실행** (권장):
```bash
npm run openclaw -- gateway
```

- [ ] 게이트웨이 실행 확인
- [ ] 로그에서 오류 메시지 확인
- [ ] Discord 연결 메시지 확인
- [ ] 터미널 탭 유지 (프로세스 살아있어야 봇 응답)

⚠️ **터미널 종료 시 봇 중단** - 백그라운드 실행 필요 시 데몬 설치

### 5.2 포트 리스닝 확인

**Linux/WSL2**:
```bash
ss -ltnp | grep 18789
```

**macOS**:
```bash
lsof -i :18789
```

**Windows (PowerShell)**:
```powershell
netstat -ano | findstr :18789
```

- [ ] 18789 포트에서 LISTEN 확인

### 5.3 상태 점검

**글로벌 설치 시**:
```bash
openclaw doctor
openclaw status
openclaw health
openclaw channels status --probe
```

**Repo-local 실행 시**:
```bash
npm run openclaw -- doctor
npm run openclaw -- status
npm run openclaw -- health
npm run openclaw -- channels status --probe
```

- [ ] `openclaw doctor` 통과 (설정 및 의존성 검증)
- [ ] 게이트웨이 상태 정상 (`openclaw status`)
- [ ] 헬스 체크 통과 (`openclaw health`)
- [ ] Discord 채널 상태 확인 (연결됨)

⚠️ **Health check 1006 오류**: 게이트웨이 미실행 상태 - Phase 5.1 실행 필요

### 5.4 Control UI 접속

```bash
# 글로벌
openclaw dashboard

# Repo-local
npm run openclaw -- dashboard
```

- [ ] 브라우저에서 `http://127.0.0.1:18789/` 자동 접속
- [ ] Control UI 로딩 확인
- [ ] 채팅 인터페이스 표시 확인

⚠️ **token=undefined 표시 시**: Gateway token 미생성 - 온보딩 재실행 또는 수동 토큰 설정

### 5.5 첫 메시지 테스트

**Discord 서버에서**:
```
@MAIBOT 안녕
```

- [ ] 봇 멘션 메시지 전송
- [ ] 봇 응답 확인 (일반적으로 5-10초 내)
- [ ] 양방향 대화 작동 확인

**CLI에서 직접 테스트** (선택):
```bash
# 글로벌
openclaw agent --message "안녕하세요, 테스트입니다" --thinking high

# Repo-local
npm run openclaw -- agent --message "안녕하세요" --thinking high
```

✅ **완료 기준**: Discord와 CLI 모두에서 정상 응답

---

## Phase 6: 고급 설정

### 6.1 GitHub CLI 설치 (Skills 활성화)

> GitHub 스킬(`github`)은 `gh` 명령어 필요 - 온보딩 시 "brew not installed" 오류 해결

**Windows (winget 설치 - 권장)**:
```powershell
winget install -e --id GitHub.cli
```

- [ ] PowerShell에서 설치
- [ ] 터미널 완전히 닫고 새로 열기 (PATH 반영)
- [ ] `gh --version` 확인

**WSL2 (Ubuntu)**:
```bash
sudo apt update
sudo apt install -y gh
gh --version
```

**macOS (Homebrew)**:
```bash
brew install gh
gh --version
```

**GitHub 로그인** (선택/권장):
```bash
gh auth login
```

- [ ] `gh` 설치 완료
- [ ] GitHub 로그인 완료 (선택)
- [ ] Gateway 재시작으로 스킬 반영

### 6.2 AI 모델 페일오버 설정

**설정 파일**: `~/.clawdbot/openclaw.json`

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

- [ ] 주 모델: Anthropic Claude Opus 4.5 (권장)
- [ ] 백업 모델: OpenAI GPT-4o/GPT-4
- [ ] `auth-profiles.json`에 페일오버 자격증명 확인
- [ ] Gateway 재시작

**auth-profiles.json 위치**:
- `~/.clawdbot/agents/<agentId>/agent/auth-profiles.json`

### 6.3 샌드박스 설정

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

- [ ] 샌드박스 모드: `non-main` (권장)
- [ ] 메인 에이전트 예외 설정 (필요 시)
- [ ] Gateway 재시작

### 6.4 Discord DM 정책 상세 설정

> 현재 기본값: **pairing** (페어링 코드 승인 방식)

#### ① Pairing (기본값, 🔐 추천)

**동작**:
- 모르는 사람이 DM 보내면 → 짧은 페어링 코드 발급
- 승인 전까지 메시지 처리 안 됨
- 페어링 코드 1시간 후 만료
- 대기 요청 기본 3개 제한

**승인 방법**:
```bash
# Repo-local
npm run openclaw -- pairing list discord
npm run openclaw -- pairing approve discord <CODE>

# 글로벌
openclaw pairing list discord
openclaw pairing approve discord <CODE>
```

**장점**: 무단 사용/토큰 소모/침투 방지

#### ② Open (공개, 🔓 비권장)

**동작**: 누구든지 DM 즉시 가능

**설정**:
```json
{
  "channels": {
    "discord": {
      "dm": {
        "policy": "open",
        "allowFrom": ["*"]
      }
    }
  }
}
```

**단점**: 악용/스팸/토큰 소모 위험 큼

#### ③ Allowlist (허용 목록, 📋 개인용 최적)

**동작**: 등록한 사용자만 DM 가능

**내 Discord 사용자 ID 얻기**:
1. Discord → 설정 → Advanced → **Developer Mode ON**
2. 내 프로필 우클릭 → **Copy User ID**

**설정**:
```json
{
  "channels": {
    "discord": {
      "dm": {
        "policy": "allowlist",
        "allowFrom": ["987654321098765432"]
      }
    }
  }
}
```

#### ④ Disabled (DM 완전 차단)

```json
{
  "channels": {
    "discord": {
      "dm": { "enabled": false }
    }
  }
}
```

**설정 적용**:
1. `~/.clawdbot/openclaw.json` 편집
2. Gateway 재시작
3. Discord에서 DM 동작 확인

⚠️ **컨텍스트 보안**: 여러 사람 DM 사용 시 `session.dmScope="per-channel-peer"` 권장

### 6.5 메모리 및 컨텍스트 관리

```bash
# 글로벌
openclaw memory prune  # 오래된 세션 정리
openclaw memory --help

# Repo-local
npm run openclaw -- memory prune
```

- [ ] 메모리 프루닝 설정
- [ ] 컨텍스트 압축 활성화
- [ ] 세션 타임아웃 설정

---

## Phase 7: 운영 및 유지보수

### 7.1 Gateway 수동 재시작

> `Install Gateway service=No` 선택 시 - 터미널 프로세스 수동 관리

#### 1) 종료 (Stop)
- [ ] Gateway 실행 중인 터미널에서 **Ctrl + C**
- [ ] `일괄 작업을 끝내시겠습니까 (Y/N)?` → **Y** → Enter
- [ ] 프롬프트 복귀 확인 (`PS C:\MAIBOT>`)

#### 2) 시작 (Start)
```bash
# 설정 파일 기반 (권장)
npm run openclaw -- gateway

# 또는 명시적 옵션
npm run openclaw -- gateway --port 18789 --verbose
```

⚠️ **"Gateway already running" 오류**: 먼저 종료(Ctrl+C) 후 재실행

**재시작 후 확인**:
- [ ] 브라우저: `http://127.0.0.1:18789/`
- [ ] Discord: `@MAIBOT 안녕` 테스트

### 7.2 로그 모니터링

**터미널 로그** (Repo-local 실행 시):
- [ ] Gateway 실행 터미널에서 실시간 로그 확인
- [ ] 오류 메시지 모니터링 (4014, 토큰 오류 등)

**파일 로그** (데몬 실행 시):
```bash
# Linux/WSL2 (systemd)
journalctl -u openclaw-gateway -f

# macOS (launchd)
tail -f ~/Library/Logs/openclaw-gateway.log

# Windows (수동 로그)
tail -f /tmp/openclaw-gateway.log
```

### 7.3 정기 점검 작업

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
npm run openclaw -- doctor
```
- [ ] 전체 테스트 스위트 실행
- [ ] 700 LOC 초과 파일 식별
- [ ] 미사용 의존성 제거

### 7.4 업데이트

**글로벌 설치 시**:
```bash
openclaw update --channel stable  # 안정 버전
openclaw update --channel beta    # 베타 버전
openclaw update --channel dev     # 개발 버전
```

**Repo-local 실행 시**:

**옵션 A: 최신 개발 버전 (Bleeding Edge)**
```bash
git pull upstream main
pnpm install
pnpm ui:build
pnpm build
```

**옵션 B: 안정화 버전 (Stable Release) - 권장**
```bash
git fetch upstream --tags
git checkout v2026.x.x  # 예: v2026.1.29
pnpm install
pnpm ui:build
pnpm build
```

- [ ] 업데이트 전 백업 (설정 파일, 세션 데이터)
- [ ] 업데이트 실행
- [ ] `openclaw doctor` 재검증
- [ ] 채널 재연결 확인

### 7.5 데이터 백업

```bash
# 전체 설정 백업
cp -r ~/.clawdbot ~/.clawdbot.backup-$(date +%Y%m%d)

# 설정 파일만 백업
cp ~/.clawdbot/openclaw.json ~/backups/openclaw-config-$(date +%Y%m%d).json
```

- [ ] 주기적 설정 백업 (주 1회 권장)
- [ ] 세션 데이터 백업 (Discord 세션 등)
- [ ] 백업 복구 테스트

---

## Phase 8: 문제 해결 (Troubleshooting)

### 8.1 Discord 연결 오류 4014

**증상**: Gateway 로그에 `4014` 오류

**원인**: Discord Privileged Intents 미활성화

**해결**:
- [ ] Discord Developer Portal → Bot
- [ ] **Privileged Gateway Intents** 섹션
- [ ] ✅ **Message Content Intent** ON
- [ ] ✅ **Server Members Intent** ON
- [ ] **Save Changes**
- [ ] Gateway 재시작

### 8.2 Health check 실패 (1006)

**증상**: `gateway closed (1006 abnormal closure)`

**원인**: Gateway 미실행 또는 비정상 종료

**해결**:
```bash
npm run openclaw -- gateway --port 18789 --verbose
```
- [ ] Gateway 실행 확인
- [ ] 브라우저 `http://127.0.0.1:18789/` 접속
- [ ] 포트 충돌 여부 확인 (`ss -ltnp | grep 18789`)
- [ ] Windows 방화벽/보안 SW 차단 확인

### 8.3 Control UI token=undefined

**증상**: Control UI URL에 `?token=undefined`

**원인**: Gateway token 미생성

**해결**:
- [ ] 온보딩 재실행: `npm run openclaw -- onboard`
- [ ] `Gateway token (blank to generate)` → 빈칸에서 Enter (자동 생성)
- [ ] 생성된 토큰으로 접속

### 8.4 GitHub 스킬 실패 (brew not installed)

**증상**: Skills 설치 중 `brew not installed` 오류

**원인**: GitHub CLI (`gh`) 미설치

**해결**: Phase 6.1 참조 (GitHub CLI 설치)

### 8.5 봇이 응답하지 않음

**체크리스트**:
- [ ] Gateway 실행 중인지 확인 (터미널 프로세스)
- [ ] Discord에서 봇이 온라인 상태인지 확인
- [ ] Privileged Intents 활성화 확인
- [ ] Gateway 로그에서 오류 확인
- [ ] 채널 권한 확인 (View Channels, Send Messages)

**디버깅**:
```bash
npm run openclaw -- channels status --probe
npm run openclaw -- doctor
```

### 8.6 모델 호출 실패

**증상**: 응답은 오지만 모델 응답 없음

**원인**: OAuth 미완료 / API 키 누락

**해결**:
- [ ] 온보딩에서 Auth 상태 확인
- [ ] `~/.clawdbot/agents/*/agent/auth-profiles.json` 확인
- [ ] Claude setup-token 재발급 및 재설정
- [ ] 온보딩 재실행: `npm run openclaw -- onboard`

### 8.7 Node 버전 오류

**증상**: 설치 중 Node 버전 오류

**원인**: Node < 22

**해결**:
```bash
# nvm 사용 시
nvm install 22
nvm use 22

# Antigravity Agent 요청
현재 워크스페이스에서 Node 22 이상으로 올려줘
```

---

## 빠른 실행 체크리스트 (복붙용)

### Antigravity 환경
```bash
# 1. 워크스페이스 생성 → Repo 클론
# 2. Terminal:
node -v  # v22.x 이상 확인

# 3. 온보딩 (Repo-local)
npm run openclaw -- onboard

# 4. Gateway 실행
npm run openclaw -- gateway --port 18789 --verbose

# 5. Discord: @MAIBOT 안녕
```

### 로컬 환경
```bash
# 글로벌 설치
npm install -g openclaw@latest
openclaw onboard
openclaw gateway --port 18789 --verbose

# 또는 소스 빌드
git clone https://github.com/openclaw/openclaw
cd openclaw
pnpm install && pnpm ui:build && pnpm build
pnpm openclaw onboard
pnpm openclaw gateway --port 18789 --verbose
```

---

## 추가 리소스

**공식 문서**:
- 웹사이트: https://openclaw.ai
- 문서: https://docs.openclaw.ai
- GitHub: https://github.com/openclaw/openclaw
- Discord: https://discord.gg/clawd

**주요 가이드**:
- [Getting Started](https://docs.openclaw.ai/start/getting-started)
- [Onboarding Wizard](https://docs.openclaw.ai/start/wizard)
- [Channel Setup](https://docs.openclaw.ai/channels/)
- [Model Configuration](https://docs.openclaw.ai/concepts/models)
- [Security Guide](https://docs.openclaw.ai/gateway/security)

**개발자 리소스**:
- PI Agent Core: https://github.com/mariozechner/pi
- Plugin SDK: src/plugin-sdk/
- API Reference: docs/api/

---

*Last updated: 2026-01-30 (실제 Antigravity 설치 경험 반영)*
*EXFOLIATE! — 사용하지 않는 항목은 제거하고 실제로 필요한 작업만 유지하세요.*

