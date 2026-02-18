---
summary: "Linux에서 OpenClaw 브라우저 제어를 위한 Chrome/Brave/Edge/Chromium CDP 시작 문제 해결"
read_when: "특히 snap Chromium에서 Linux에서 브라우저 제어가 실패하는 경우"
title: "브라우저 문제 해결"
---

# 브라우저 문제 해결 (Linux)

## 문제: "포트 18800에서 Chrome CDP 시작 실패"

OpenClaw의 브라우저 제어 서버가 다음 오류와 함께 Chrome/Brave/Edge/Chromium을 시작하지 못합니다:

```
{"error":"Error: Failed to start Chrome CDP on port 18800 for profile \"openclaw\"."}
```

### 근본 원인

Ubuntu (및 많은 Linux 배포판)에서는 기본 Chromium 설치가 **snap 패키지**입니다. Snap의 AppArmor 격리가 OpenClaw가 브라우저 프로세스를 생성하고 모니터링하는 방식에 간섭합니다.

`apt install chromium` 명령은 snap으로 리다이렉트되는 스텁 패키지를 설치합니다:

```
Note, selecting 'chromium-browser' instead of 'chromium'
chromium-browser is already the newest version (2:1snap1-0ubuntu2).
```

이것은 실제 브라우저가 아닙니다 — 단지 래퍼일 뿐입니다.

### 해결책 1: Google Chrome 설치 (권장)

snap 격리가 아닌 공식 Google Chrome `.deb` 패키지를 설치하십시오:

```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb
sudo apt --fix-broken install -y  # 종속성 오류가 있는 경우
```

그런 다음 OpenClaw 설정 (`~/.openclaw/openclaw.json`)을 업데이트하십시오:

```json
{
  "browser": {
    "enabled": true,
    "executablePath": "/usr/bin/google-chrome-stable",
    "headless": true,
    "noSandbox": true
  }
}
```

### 해결책 2: Snap Chromium을 첨부 전용 모드로 사용

Snap Chromium을 사용해야 하는 경우, 수동으로 시작한 브라우저에 OpenClaw를 연결하도록 설정하십시오:

1. 설정 업데이트:

```json
{
  "browser": {
    "enabled": true,
    "attachOnly": true,
    "headless": true,
    "noSandbox": true
  }
}
```

2. Chromium 수동 시작:

```bash
chromium-browser --headless --no-sandbox --disable-gpu \
  --remote-debugging-port=18800 \
  --user-data-dir=$HOME/.openclaw/browser/openclaw/user-data \
  about:blank &
```

3. Chrome을 자동으로 시작하기 위해 선택적으로 systemd 사용자 서비스를 생성:

```ini
# ~/.config/systemd/user/openclaw-browser.service
[Unit]
Description=OpenClaw Browser (Chrome CDP)
After=network.target

[Service]
ExecStart=/snap/bin/chromium --headless --no-sandbox --disable-gpu --remote-debugging-port=18800 --user-data-dir=%h/.openclaw/browser/openclaw/user-data about:blank
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

다음 명령어로 활성화: `systemctl --user enable --now openclaw-browser.service`

### 브라우저 작동 확인

상태 확인:

```bash
curl -s http://127.0.0.1:18791/ | jq '{running, pid, chosenBrowser}'
```

브라우징 테스트:

```bash
curl -s -X POST http://127.0.0.1:18791/start
curl -s http://127.0.0.1:18791/tabs
```

### 설정 참고

| 옵션                     | 설명                                                              | 기본값                                  |
| ------------------------ | ----------------------------------------------------------------- | --------------------------------------- |
| `browser.enabled`        | 브라우저 제어 활성화                                              | `true`                                  |
| `browser.executablePath` | Chromium 기반 브라우저 바이너리 경로 (Chrome/Brave/Edge/Chromium) | 자동 감지 (Chromium 기반 브라우저 선호) |
| `browser.headless`       | GUI 없이 실행                                                     | `false`                                 |
| `browser.noSandbox`      | `--no-sandbox` 플래그 추가 (일부 Linux 설정에 필요)               | `false`                                 |
| `browser.attachOnly`     | 브라우저 실행하지 않고 기존에 연결만                              | `false`                                 |
| `browser.cdpPort`        | Chrome DevTools 프로토콜 포트                                     | `18800`                                 |

### 문제: "Chrome 확장 리레이가 실행 중이지만 연결된 탭이 없음"

`chrome` 프로파일 (확장 리레이)을 사용 중입니다. 이는 OpenClaw 브라우저 확장이 활성 탭에 연결되기를 기대합니다.

수정 옵션:

1. **관리 브라우저 사용:** `openclaw browser start --browser-profile openclaw` (또는 `browser.defaultProfile: "openclaw"` 설정).
2. **확장 리레이 사용:** 확장을 설치하고, 탭을 열고, OpenClaw 확장 아이콘을 클릭하여 연결.

노트:

- `chrome` 프로파일은 가능한 경우 **시스템 기본 Chromium 브라우저**를 사용합니다.
- 로컬 `openclaw` 프로파일은 `cdpPort`/`cdpUrl`을 자동 할당합니다; 원격 CDP에 대해서만 설정하십시오.
