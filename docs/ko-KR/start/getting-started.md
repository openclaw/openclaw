---
summary: "OpenClaw를 설치하고 몇 분 안에 첫 채팅을 실행하세요."
read_when:
  - 처음부터 설정하는 경우
  - 가장 빠른 경로로 작동하는 채팅을 원하는 경우
title: "시작하기"
---

# 시작하기

목표: 최소한의 설정으로 처음부터 첫 번째 작동하는 채팅까지

<Info>
가장 빠른 채팅: Control UI를 엽니다 (채널 설정 필요 없음). `openclaw dashboard`를 실행하고 브라우저에서 채팅하거나, Gateway 호스트에서 `http://127.0.0.1:18789/`에 접속하세요.
문서: [대시보드](/ko-KR/web/dashboard) 및 [Control UI](/ko-KR/web/control-ui).
</Info>

## 사전 요구사항

- **Node 22 이상**

<Tip>
설치된 Node 버전이 확실하지 않으면 `node --version`으로 확인하세요.
</Tip>

## 빠른 설정 (CLI)

### 1단계: OpenClaw 설치 (권장)

**macOS / Linux:**

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

**Windows (PowerShell):**

```powershell
iwr -useb https://openclaw.ai/install.ps1 | iex
```

**npm / pnpm 사용자:**

```bash
npm install -g openclaw@latest
# 또는
pnpm add -g openclaw@latest
```

<Note>
다른 설치 방법과 요구사항: [설치 가이드](/ko-KR/install).
</Note>

### 2단계: 온보딩 마법사 실행

```bash
openclaw onboard --install-daemon
```

마법사가 인증, 게이트웨이 설정, 선택적 채널을 구성합니다.
자세한 내용은 [온보딩 마법사](/ko-KR/start/wizard)를 참조하세요.

### 3단계: Gateway 상태 확인

서비스를 설치했다면 이미 실행 중이어야 합니다:

```bash
openclaw gateway status
```

### 4단계: Control UI 열기

```bash
openclaw dashboard
```

<Check>
Control UI가 로드되면 Gateway가 사용 준비가 된 것입니다.
</Check>

## 선택적 확인 및 추가 기능

### Gateway를 포그라운드에서 실행

빠른 테스트나 문제 해결에 유용합니다.

```bash
openclaw gateway --port 18789
```

### 테스트 메시지 보내기

설정된 채널이 필요합니다.

```bash
openclaw message send --target +821012345678 --message "OpenClaw에서 보낸 메시지입니다"
```

## 완료 후 상태

- 실행 중인 Gateway
- 인증 구성 완료
- Control UI 접근 또는 연결된 채널

## 다음 단계

- DM 안전 및 승인: [페어링](/ko-KR/channels/pairing)
- 더 많은 채널 연결: [채널](/ko-KR/channels)
- 고급 워크플로우 및 소스에서 빌드: [설정](/ko-KR/start/setup)

---

## 상세 설치 방법

### npm을 통한 글로벌 설치

```bash
npm install -g openclaw@latest
```

### pnpm을 통한 글로벌 설치

```bash
pnpm add -g openclaw@latest
```

### 소스에서 빌드 (개발용)

```bash
# 저장소 클론
git clone https://github.com/openclaw/openclaw.git
cd openclaw

# 의존성 설치
pnpm install

# UI 빌드
pnpm ui:build

# 빌드
pnpm build

# 온보딩 실행
pnpm openclaw onboard --install-daemon
```

## 개발 채널

| 채널       | 설명                                               | npm 태그 |
| ---------- | -------------------------------------------------- | -------- |
| **stable** | 정식 릴리스 (`vYYYY.M.D` 또는 `vYYYY.M.D-<patch>`) | `latest` |
| **beta**   | 프리릴리스 (`vYYYY.M.D-beta.N`)                    | `beta`   |
| **dev**    | main 브랜치 최신                                   | `dev`    |

채널 전환:

```bash
openclaw update --channel stable|beta|dev
```

## 시스템 요구사항

| 항목              | 요구사항                               |
| ----------------- | -------------------------------------- |
| **Node.js**       | v22.12.0 이상                          |
| **패키지 매니저** | npm, pnpm, 또는 bun                    |
| **OS**            | macOS, Linux, Windows (WSL2 강력 권장) |

### 권장 사항

- **Windows 사용자**: WSL2 환경을 강력히 권장합니다
- **AI 모델**: Anthropic Pro/Max + Opus 4.6 권장 (긴 컨텍스트, 프롬프트 인젝션 방어)
