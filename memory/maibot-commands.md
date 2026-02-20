---
type: reference
project: MAIBOT
tags: [commands, gateway, operations]
related:
  - "[[preferences|사용자 선호설정]]"
  - "[[maibotalks|MAIBOTALKS - 음성대화]]"
---

# MAIBOT 명령어 레퍼런스

## 1. Gateway (핵심)

### 서비스 관리 — 백그라운드 실행 (터미널 닫아도 유지)

```bash
node moltbot.mjs gateway install    # 스케줄 태스크 등록 + 시작 (최초 1회, 관리자 PowerShell)
node moltbot.mjs gateway start      # 시작
node moltbot.mjs gateway stop       # 중지
node moltbot.mjs gateway restart    # 재시작
node moltbot.mjs gateway uninstall  # 태스크 삭제 (관리자 PowerShell)
node moltbot.mjs gateway status     # 상태 확인 (RPC probe, 포트, 런타임)
```

### 포그라운드 실행 — 디버깅용 (터미널 닫으면 종료)

```bash
node moltbot.mjs gateway --port 18789 --verbose   # 실시간 로그 출력
node moltbot.mjs gateway --port 18789 --compact    # 간결한 WebSocket 로그
node moltbot.mjs gateway --force                    # 기존 포트 점유 프로세스 kill 후 시작
```

### 현재 설정

| 항목            | 값                              |
| --------------- | ------------------------------- |
| 바인드          | `127.0.0.1` (loopback)          |
| 포트            | `18789`                         |
| 대시보드        | http://127.0.0.1:18789/         |
| 설정 파일       | `~/.clawdbot/moltbot.json`      |
| 태스크 스크립트 | `~/.clawdbot/gateway.cmd`       |
| 태스크 트리거   | 로그온 시 자동 시작 (`ONLOGON`) |

---

## 2. 진단 & 유지보수

```bash
node moltbot.mjs doctor                  # 전체 건강 체크
node moltbot.mjs doctor --repair         # 자동 복구 적용
node moltbot.mjs doctor --non-interactive  # 프롬프트 없이 안전 마이그레이션만
node moltbot.mjs status                  # 채널 건강 + 최근 세션 수신자
node moltbot.mjs health                  # 실행 중인 gateway 건강 상태
```

---

## 3. 업데이트

```bash
node moltbot.mjs update                          # 기본 업데이트 (git: fetch → rebase → build)
node moltbot.mjs update --channel stable          # stable 채널로 전환
node moltbot.mjs update --channel beta            # beta 채널로 전환
node moltbot.mjs update --yes --no-restart        # 비대화형 + 재시작 없이
node moltbot.mjs update status                    # 현재 채널 및 버전 확인
```

### 자동 업데이트 (스케줄 태스크)

| 태스크                | 스케줄            | 스크립트                    |
| --------------------- | ----------------- | --------------------------- |
| `MoltbotStableUpdate` | 매주 일요일 03:00 | `scripts/update_stable.ps1` |

등록 (관리자 PowerShell):

```powershell
powershell -ExecutionPolicy Bypass -File scripts/register_update_task.ps1
```

---

## 4. 메시지 & 에이전트

```bash
node moltbot.mjs message send --target +821012345678 --message "Hi"  # 메시지 전송
node moltbot.mjs agent --message "요약해줘" --deliver                  # 에이전트 실행 + 전달
node moltbot.mjs sessions                                              # 대화 세션 목록
```

---

## 5. 채널 관리

```bash
node moltbot.mjs channels                     # 채널 목록
node moltbot.mjs channels login --verbose      # WhatsApp Web 연결 (QR)
```

---

## 6. 설정

```bash
node moltbot.mjs setup              # 초기 설정
node moltbot.mjs onboard            # 대화형 온보딩 위자드
node moltbot.mjs configure          # 자격 증명, 기기, 에이전트 기본값 설정
node moltbot.mjs config             # 설정 get/set/unset
node moltbot.mjs dashboard          # Control UI 열기
```

---

## 7. 문제 해결

### Gateway가 꺼져있을 때

```bash
node moltbot.mjs gateway status    # 상태 확인
node moltbot.mjs gateway start     # 재시작
```

### 스케줄 태스크 재등록 (관리자 PowerShell)

```powershell
schtasks /Delete /F /TN "Moltbot Gateway"
cd C:\MAIBOT
node moltbot.mjs gateway install
```

### 로그 확인

```bash
node moltbot.mjs logs              # Gateway 로그
```

로그 파일: `\tmp\moltbot\moltbot-YYYY-MM-DD.log`

### 일반 진단

```bash
node moltbot.mjs doctor --deep     # 심층 진단 (시스템 서비스 스캔 포함)
node moltbot.mjs gateway probe     # 도달성 + 디스커버리 + 건강 종합 체크
```
