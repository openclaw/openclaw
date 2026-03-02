# TOOLS.md - Local Notes

Skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup.

## What Goes Here

Things like:

- Camera names and locations
- SSH hosts and aliases
- Preferred voices for TTS
- Speaker/room names
- Device nicknames
- Anything environment-specific

## Examples

```markdown
### Cameras

- living-room → Main area, 180° wide angle
- front-door → Entrance, motion-triggered

### SSH

- home-server → 192.168.1.100, user: admin

### TTS

- Preferred voice: "Nova" (warm, slightly British)
- Default speaker: Kitchen HomePod
```

## Why Separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.

---

Add whatever helps you do your job. This is your cheat sheet.

---

## ⚠️ 파일 쓰기 경로 제한 (중요!)

**`write`/`edit` 도구는 워크스페이스(`C:\MAIBOT`) 내부에만 쓸 수 있다.**

- `C:\Users\...\JINI_SYNC\...` (Obsidian 볼트) → ❌ write 도구 실패
- `C:\TEST\...` (프로젝트 폴더) → ❌ write 도구 실패
- `C:\MAIBOT\...` → ✅ write 도구 정상

**외부 경로에 파일을 쓸 때는 반드시 `exec` (PowerShell)를 사용:**

```powershell
# Obsidian 노트 쓰기
$content = @"
# 제목
내용...
"@
$content | Out-File -FilePath "C:\Users\jini9\OneDrive\Documents\JINI_SYNC\00.DAILY\파일명.md" -Encoding utf8

# 프로젝트 파일 쓰기
Set-Content -Path "C:\TEST\프로젝트\파일.md" -Value $content -Encoding utf8
```

**규칙:**

- 워크스페이스 내부 (`C:\MAIBOT\memory\`, `C:\MAIBOT\skills\` 등) → `write`/`edit` 도구 사용
- 워크스페이스 외부 (Obsidian, `C:\TEST\*` 프로젝트) → `exec` + PowerShell `Out-File`/`Set-Content` 사용
- 크론 작업에서 Obsidian 노트/리포트 저장 시 이 규칙 반드시 따를 것

---

## MAIBOT-Specific Tools

### Development Commands

**Full Build**:

```bash
pnpm build  # TypeScript compile + canvas bundle + metadata copy
```

**Development Run**:

```bash
pnpm dev  # or: pnpm moltbot
```

**Gateway Development**:

```bash
pnpm gateway:dev  # with CLAWDBOT_SKIP_CHANNELS=1
```

### Testing

**Quick Test**:

```bash
pnpm test
```

**Coverage Check**:

```bash
pnpm test:coverage  # 70% threshold enforced
```

**Live Tests** (requires credentials):

```bash
CLAWDBOT_LIVE_TEST=1 pnpm test:live
```

**Docker E2E**:

```bash
pnpm test:docker:all
```

### Useful Shortcuts

**Pre-commit Validation**:

```bash
prek install && pnpm build && pnpm test
```

**Gateway Restart** (production via SSH):

```bash
pkill -9 -f moltbot-gateway || true; \
nohup moltbot gateway run --bind loopback --port 18789 --force \
> /tmp/moltbot-gateway.log 2>&1 &
```

**Gateway Status Check**:

```bash
moltbot channels status --probe
ss -ltnp | rg 18789
tail -n 120 /tmp/moltbot-gateway.log
```

### MCP Servers (from .mcp.json)

- **Playwright**: Browser automation for testing
- **Fetcher**: Web content retrieval (Readability algorithm)
- **Context7**: Real-time library documentation
- **Magic**: UI component generation (Magic UI design system)

### Environment

- **Node Version**: ≥22.12.0 (required)
- **Package Manager**: pnpm@10.23.0 (primary)
- **Alternative Runtime**: bun (for TypeScript execution)
- **Timezone**: Asia/Seoul (GMT+9) — matches 지니's timezone

---

### 🏗️ 개발 방식: 3-Layer 멀티에이전트 (2026-02-24 도입)

**모든 프로젝트에 적용** — 지니님 지시

```
지니님 (Discord)
    ↓
Layer 1: MAIBOT (OpenClaw, Opus 4.6) ← 오케스트레이터
    ├── 단순 작업 → MAIBOT 직접 처리 (Read/Write/Edit/exec)
    │
    ├── 중간 작업 → Sub-agent + Claude Code Sonnet 4.6
    │     claude -p --model sonnet --agent {에이전트명} 'task'
    │
    └── 복잡한 작업 → Sub-agent + Claude Code Opus 4.6
          claude -p --model opus --agent {에이전트명} 'task'
```

**태스크 라우팅:**
| 작업 유형 | 실행 위치 | 모델 | 동시 실행 |
|---|---|---|---|
| 단순 (설정, 문서, 편집) | MAIBOT 직접 | Opus (기존) | 무제한 |
| 중간 (구현, 버그수정, 테스트) | Claude Code CLI | Sonnet 4.6 | 2~3개 |
| 복잡 (설계, 리팩토링) | Claude Code CLI | Opus 4.6 | 1개 |

**Claude Code CLI 상태:**

- Version: 2.1.50
- Auth: Claude Max ($200/월), jini92.lee@gmail.com
- 에이전트: 69개 (User 17 + Plugin 47 + Built-in 5)

**MCP 충돌 해결:** `--strict-mcp-config` 또는 `-p` (print 모드)로 hang 방지

**이력:**

- 2026-02-06: 하이브리드 v1 도입
- 2026-02-07: v1 폐기 (MCP 충돌)
- 2026-02-24: **v2 도입** — 3-Layer 멀티에이전트 (모델 혼합 + 슬롯 시스템)

---

### MAIBEAUTY 개발 환경

**프로젝트:** 베트남 화장품 사업 (BnF AI Sales Automation)

```
- 로컬: C:\TEST\MAIBEAUTY
- GitHub: https://github.com/jini92/MAIBEAUTY
- 개발 도구: Claude Code
- 플로우: Claude Code (워크스페이스: C:\TEST\MAIBEAUTY) → 커밋 → git push
```

**Claude Code 실행:**

```bash
# 단발 작업
claude 'task description' (workdir: C:\TEST\MAIBEAUTY)

# 백그라운드 장기 작업
claude 'task' (background + pty)
```

**개발 후 push:**

```bash
cd C:\TEST\MAIBEAUTY
git add -A
git commit -m "feat: description"
git push origin main
```

---

### Google Cloud SDK

**Path**: `C:\Users\jini9\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd`
**Version**: 554.0.0
**On User PATH**: Yes

```bash
# Refresh PATH in current session
$env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')

# Verify
gcloud --version

# Auth login (opens browser)
gcloud auth login

# Set project
gcloud config set project <PROJECT_ID>

# Enable Sheets API
gcloud services enable sheets.googleapis.com

# Create service account
gcloud iam service-accounts create maibeauty-crm --display-name="MAIBEAUTY CRM"
```

---

### MAIBEAUTY 서비스 접근 정보

모든 키/토큰은 `C:\TEST\MAIBEAUTY\.env`에 저장 (git 무시됨).

| 서비스             | 접근 방법               | .env 키                                                                                     |
| ------------------ | ----------------------- | ------------------------------------------------------------------------------------------- |
| **MAIBEAUTY API**  | REST API (JWT 인증)     | `MAIBEAUTY_API_URL`, `MAIBEAUTY_ADMIN_EMAIL`, `MAIBEAUTY_ADMIN_PASSWORD`                    |
| **Cloudflare R2**  | boto3 S3 호환           | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_PUBLIC_URL` |
| **Cloudflare API** | REST API (Bearer Token) | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`                                             |
| **Video Worker**   | Worker key 인증         | `VIDEO_WORKER_KEY`                                                                          |
| **Railway**        | CLI 로그인 상태         | `railway variables` (MAIBEAUTY 프로젝트)                                                    |
| **GitHub**         | git credential 저장     | `jini92/MAIBEAUTY`, `jini92/MAIBOT`                                                         |
| **Ollama**         | 로컬 LLM                | `OLLAMA_BASE_URL` (localhost:11434)                                                         |
| **Google Sheets**  | Service Account JSON    | `GOOGLE_SERVICE_ACCOUNT_JSON`, `CRM_SPREADSHEET_ID`                                         |

**자주 쓰는 명령:**

```powershell
# API 로그인 (토큰 발급)
$login = Invoke-RestMethod -Uri "$env:MAIBEAUTY_API_URL/api/v1/auth/login" -Method POST -ContentType "application/json" -Body '{"email":"jini@maibeauty.vn","password":"BnF@2026!Admin"}'
$token = $login.access_token

# 영상 생성 Job 제출
Invoke-RestMethod -Uri "$env:MAIBEAUTY_API_URL/api/v1/products/{product_id}/ai/generate-video" -Method POST -Headers @{"Authorization"="Bearer $token";"Content-Type"="application/json"} -Body '{"language":"vi","style":"tiktok_short","duration_target":60}'

# Worker 시작
cd C:\TEST\MAIBEAUTY; python src/workers/video_worker.py --api-url https://maibeauty-api-production.up.railway.app --worker-key 0aP87uilc4OH93kTwjYbXpNnhBgrQx6e

# Cloudflare R2 버킷 조회
$headers = @{ "Authorization" = "Bearer $env:CLOUDFLARE_API_TOKEN" }
Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/accounts/$env:CLOUDFLARE_ACCOUNT_ID/r2/buckets/maibeauty-media" -Headers $headers
```

### M.AI.UPbit (암호화폐 분석 엔진)

**경로:** `C:\TEST\M.AI.UPbit`
**패키지:** `maiupbit` v0.1.0 (Apache-2.0)

**스크립트 (OpenClaw 직접 호출용):**

```powershell
# 코인 분석 (인증 불필요)
cd C:\TEST\M.AI.UPbit; python scripts/analyze.py KRW-BTC
# → JSON: indicators, signals, score, recommendation, current_price

# 시장 모니터링 (인증 불필요)
cd C:\TEST\M.AI.UPbit; python scripts/monitor.py
# → JSON: status(5코인), alerts(급등/급락/RSI이상), has_alerts

# 일일 리포트 (인증 불필요, 포트폴리오는 키 필요)
cd C:\TEST\M.AI.UPbit; python scripts/daily_report.py
# → JSON: date, portfolio, analysis[], recommendations[]

# 포트폴리오 조회 (API 키 필요)
cd C:\TEST\M.AI.UPbit; python scripts/portfolio.py
# → JSON: assets[], total_value

# 매매 실행 (API 키 필요 + --confirm 필수)
cd C:\TEST\M.AI.UPbit; python scripts/trade.py buy KRW-BTC 50000
# → 미리보기만 (--confirm 없으면 실행 안 됨)
cd C:\TEST\M.AI.UPbit; python scripts/trade.py buy KRW-BTC 50000 --confirm
# → 실제 매수 실행

# LSTM 모델 학습 (GPU 권장)
cd C:\TEST\M.AI.UPbit; python scripts/train_model.py KRW-BTC
```

**CLI (패키지 설치 후):**

```powershell
maiupbit analyze KRW-BTC --format json
maiupbit portfolio --format json
maiupbit trade buy KRW-BTC 50000 --confirm
maiupbit recommend --method performance --top 5 --format json
```

**지니님 요청 패턴 → 실행 매핑:**

| 지니님 말              | 실행                                                                |
| ---------------------- | ------------------------------------------------------------------- |
| "비트코인 분석해줘"    | `scripts/analyze.py KRW-BTC`                                        |
| "이더리움 지금 어때?"  | `scripts/analyze.py KRW-ETH`                                        |
| "시장 상황 알려줘"     | `scripts/monitor.py`                                                |
| "내 포트폴리오 보여줘" | `scripts/portfolio.py`                                              |
| "비트코인 5만원 사줘"  | `scripts/trade.py buy KRW-BTC 50000` (미리보기) → 확인 후 --confirm |
| "리포트 만들어줘"      | `scripts/daily_report.py`                                           |
| "추천 종목 알려줘"     | `maiupbit recommend --method performance --top 5 --format json`     |

**퀀트 전략 요청 패턴 → 실행 매핑 (Phase 7, 강환국 전략):**

| 지니님 말                 | 실행                                                                              |
| ------------------------- | --------------------------------------------------------------------------------- |
| "지금 시즌 어때?"         | `$env:PYTHONPATH="C:\TEST\M.AI.UPbit"; python scripts/quant.py season`            |
| "모멘텀 좋은 코인 알려줘" | `$env:PYTHONPATH="C:\TEST\M.AI.UPbit"; python scripts/quant.py momentum --top 5`  |
| "돌파 전략 BTC"           | `$env:PYTHONPATH="C:\TEST\M.AI.UPbit"; python scripts/quant.py breakout KRW-BTC`  |
| "팩터 분석해줘"           | `$env:PYTHONPATH="C:\TEST\M.AI.UPbit"; python scripts/quant.py factor --top 5`    |
| "GTAA 자산배분 알려줘"    | `$env:PYTHONPATH="C:\TEST\M.AI.UPbit"; python scripts/quant.py allocate`          |
| "퀀트 백테스트 해줘"      | `$env:PYTHONPATH="C:\TEST\M.AI.UPbit"; python scripts/quant.py backtest momentum` |
| "퀀트 전략 전체 분석"     | `python -m maiupbit quant momentum --top 5` (PYTHONPATH 불필요)                   |

> ⚠️ **주의**: `scripts/quant.py` 직접 실행 시 반드시 `$env:PYTHONPATH="C:\TEST\M.AI.UPbit"` 설정 필요
> (maiupbit 패키지가 pip install -e .로 전역 설치 안 됨)
> **대안**: `python -m maiupbit quant <서브커맨드>` — PYTHONPATH 불필요, 권장

**quant.py 서브커맨드 (Phase 7):**

```powershell
$env:PYTHONPATH = "C:\TEST\M.AI.UPbit"

# 시즌 정보 (할빙 사이클 기반 강세/약세장 판단)
python scripts/quant.py season
# → {"command":"season","season":"bullish","multiplier":1.2,"halving_phase":"mid_cycle",...}

# 듀얼 모멘텀 랭킹
python scripts/quant.py momentum [--symbols KRW-BTC,KRW-ETH,...] [--top 5] [--days 400]

# 래리 윌리엄스 변동성 돌파
python scripts/quant.py breakout KRW-BTC [--k 0.5] [--days 60]

# 멀티팩터 랭킹 (모멘텀+변동성+거래량)
python scripts/quant.py factor [--symbols KRW-BTC,KRW-ETH,...] [--top 5]

# GTAA 자산배분 (강환국 스타일)
python scripts/quant.py allocate [--symbols KRW-BTC,KRW-ETH,...]

# 전략 백테스트
python scripts/quant.py backtest momentum [--symbols KRW-BTC,...] [--days 365]
```

**⚠️ 매매 안전 규칙:**

- `trade.py`는 **절대 --confirm 없이 실행 금지** (미리보기만 보여주고 지니님 확인 대기)
- 지니님이 명시적으로 "실행해", "사줘", "팔아줘" + 금액 확인 후에만 --confirm
- API 키: `.env`에 `UPBIT_ACCESS_KEY`, `UPBIT_SECRET_KEY` (현재 미설정)

---

### Discord 노티 규칙

- **절대 금지**: `#일반` 채널(1466615738512179394)에 메시지 전송 금지 (보안 위험)
- **DM 전용**: 지니님 DM 채널(1466624220632059934)으로만 전송
- **민감 정보 제거**: 규정 문서 번호, 내부 시스템명, 제어기 정보 등 비공개 정보 포함 금지

### Obsidian 볼트

- **경로:** `C:\Users\jini9\OneDrive\Documents\JINI_SYNC`
- **구조:** PARA 기반
- **CLI:** obsidian-cli 미지원 (Windows) → 직접 파일 읽기/쓰기로 연동
- **동기화:** OneDrive → 아이패드 Obsidian (풀 기능) 실시간 반영
- **아이패드:** Obsidian 풀 기능 사용 중 (편집/확인 가능)

**폴더 구조:**

```
JINI_SYNC/
├── 00.DAILY/          ← 데일리 노트, 브리핑
├── 01.PROJECT/        ← 프로젝트별 폴더 (★ 프로젝트 문서는 여기)
│   ├── 00.MAIBOT
│   ├── 01.MAITCAD
│   ├── 02.MAIPnID
│   ├── 03.MAIAX
│   ├── 04.MAIOSS
│   ├── 05.MAITB
│   ├── 06.MAITHINK
│   ├── 07.MAIBEAUTY
│   ├── 08.MAISTAR7
│   ├── 09.MAICON     ← docs/ 심볼릭 링크 → C:\TEST\MAICON\docs
│   ├── 10.MAITUTOR
│   └── 11.MAIBOTALKS
├── 02.AREA/           ← 영역별 (지속적 관심사)
├── 03.RESOURCES/      ← 리소스/참고자료
├── 04.ARCHIVE/        ← 아카이브
├── 05.DEBUGGING/      ← 디버깅 노트
├── AI/
├── chatGPT/
├── DAILY/
├── TEMPLATES/
└── skills/
```

**규칙:** 새 프로젝트 → `01.PROJECT/XX.프로젝트명/` 에 생성 (루트 X)

_Last updated: 2026-02-09_
