# Ollama GPU 인식 실패 — Lessons Learned

**날짜:** 2026-03-11
**환경:** Windows 10 (22631), RTX 4070 SUPER 12GB, Ollama 0.17.6 → 0.17.7

---

## 증상

- qwen3:8b 모델이 **100% CPU**에서 실행 (5.5 tokens/s)
- GPU VRAM 여유 있음 (12GB 중 2.7GB만 사용)
- `ollama ps`에서 Processor = CPU

## 진단 과정

### 1단계: VRAM 경합 의심 (오진)

- `ollama ps` → qwen2.5:3b(GPU) + qwen3:8b(CPU) 동시 로드 확인
- VRAM 부족으로 CPU 폴백된 것으로 판단
- **조치:** `ollama stop qwen2.5:3b`로 VRAM 확보
- **결과:** ❌ 여전히 CPU에서 실행 — VRAM 경합이 근본 원인 아니었음

### 2단계: Ollama 서버 크래시 발견

- `server.log` → 포트 충돌 에러 반복 (`bind: Only one usage of each socket address`)
- Ollama 프로세스 4개 동시 실행 중
- **조치:** 전체 프로세스 kill 후 재시작
- **결과:** ❌ `"Failed to start: Unable to init instance: Unspecified error"` — 더 근본적인 문제

### 3단계: 근본 원인 발견 — 자동 업그레이드 실패

- `upgrade.log` 분석:
  ```
  2026-03-11 04:24 Ollama 0.17.7 자동 업그레이드 시도
  → ollama.exe 파일 잠금 (Access Denied, code 5)
  → 5회 재시도 실패
  → 롤백... 그러나 불완전
  ```
- **실제 상태:**
  | 파일 | 버전 | 날짜 |
  |------|------|------|
  | `ollama app.exe` | 0.17.7 | 2026-03-06 |
  | `ollama.exe` | 0.17.6 | 2026-03-04 |
- app.exe(0.17.7)가 ollama.exe(0.17.6) 서버를 시작 → GPU 초기화 프로토콜 불일치 → CPU 폴백

### 4단계: 해결

- `winget install Ollama.Ollama --force`로 클린 재설치
- 모든 exe가 0.17.7로 통일
- **결과:** ✅ GPU 정상 인식, 83.9 tokens/s (15배 개선)

## 근본 원인

**Ollama Windows 자동 업데이트의 불완전한 롤백.**
Inno Setup 인스톨러가 `ollama.exe` 교체에 실패하면서 `ollama app.exe`만 새 버전으로 교체됨.
두 바이너리 간 버전 불일치로 GPU 초기화 코드가 호환되지 않아 CPU 폴백 발생.

## 교훈

### 1. 증상이 아닌 근본 원인을 찾아라

- VRAM 경합은 증상의 일부였을 뿐, 근본 원인은 바이너리 버전 불일치
- `ollama ps`의 CPU 표시만 보고 VRAM 문제로 단정하면 안 됨

### 2. 로그를 먼저 확인하라

- `%LOCALAPPDATA%\Ollama\upgrade.log`에 실패 원인이 명확히 기록됨
- `app.log`의 `"Unable to init instance"` 에러가 GPU 문제가 아닌 바이너리 문제 시사

### 3. Windows에서 Ollama 자동 업데이트는 불안정

- 실행 중 프로세스를 교체하려다 실패하는 패턴
- **권장:** Ollama 자동 업데이트 비활성화 → 수동 업데이트 (`winget upgrade Ollama.Ollama`)
- 설정: Ollama 트레이 아이콘 → Settings → 자동 업데이트 OFF

### 4. 바이너리 버전 확인 체크리스트

```powershell
# Ollama 바이너리 버전 일관성 확인
Get-ChildItem "$env:LOCALAPPDATA\Programs\Ollama\*.exe" |
  Select-Object Name, LastWriteTime, Length |
  Format-Table -AutoSize
```

- `ollama.exe`와 `ollama app.exe`의 날짜/크기가 다르면 버전 불일치 의심

### 5. GPU 인식 빠른 진단법

```powershell
# 1. GPU 상태 확인
nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv,noheader

# 2. Ollama 프로세서 확인
ollama ps

# 3. 속도 테스트 (GPU면 80+ tokens/s, CPU면 5~10)
ollama run qwen2.5:3b "hi" --verbose 2>&1 | Select-String "eval rate"

# 4. 로그 확인
Get-Content "$env:LOCALAPPDATA\Ollama\app.log" -Tail 10
Get-Content "$env:LOCALAPPDATA\Ollama\upgrade.log" -Tail 20
```

## 예방 조치

- [ ] Ollama 자동 업데이트 비활성화
- [ ] HEARTBEAT에 Ollama GPU 상태 체크 추가 고려 (`ollama ps` → CPU면 알림)

---

_Source: 2026-03-11 MAIBOT 세션에서 진단_
