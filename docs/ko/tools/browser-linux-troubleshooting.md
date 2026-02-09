---
summary: "Linux 에서 OpenClaw 브라우저 제어를 위한 Chrome/Brave/Edge/Chromium CDP 시작 문제 해결"
read_when: "Linux 에서 브라우저 제어가 실패할 때, 특히 snap Chromium 사용 시"
title: "브라우저 문제 해결"
---

# 브라우저 문제 해결 (Linux)

## 문제: "Failed to start Chrome CDP on port 18800"

OpenClaw 의 브라우저 제어 서버가 다음 오류와 함께 Chrome/Brave/Edge/Chromium 실행에 실패합니다:

```
{"error":"Error: Failed to start Chrome CDP on port 18800 for profile \"openclaw\"."}
```

### 근본 원인

Ubuntu (및 많은 Linux 배포판)에서는 기본 Chromium 설치가 **snap 패키지**입니다. Snap 의 AppArmor 격리는 OpenClaw 가 브라우저 프로세스를 생성하고 모니터링하는 방식과 충돌합니다.

`apt install chromium` 명령은 snap 으로 리디렉션되는 스텁 패키지를 설치합니다:

```
Note, selecting 'chromium-browser' instead of 'chromium'
chromium-browser is already the newest version (2:1snap1-0ubuntu2).
```

이는 실제 브라우저가 아니며, 단순한 래퍼에 불과합니다.

### 해결 방법 1: Google Chrome 설치 (권장)

snap 으로 샌드박스화되지 않은 공식 Google Chrome `.deb` 패키지를 설치합니다:

```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb
sudo apt --fix-broken install -y  # if there are dependency errors
```

그런 다음 OpenClaw 설정 (`~/.openclaw/openclaw.json`)을 업데이트합니다:

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

### 해결 방법 2: Attach-Only 모드로 Snap Chromium 사용

snap Chromium 을 반드시 사용해야 하는 경우, 수동으로 시작한 브라우저에 연결하도록 OpenClaw 를 구성합니다:

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

3. 선택 사항으로 Chrome 을 자동 시작하기 위한 systemd 사용자 서비스를 생성합니다:

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

다음으로 활성화합니다: `systemctl --user enable --now openclaw-browser.service`

### 브라우저 동작 확인

상태 확인:

```bash
curl -s http://127.0.0.1:18791/ | jq '{running, pid, chosenBrowser}'
```

브라우징 테스트:

```bash
curl -s -X POST http://127.0.0.1:18791/start
curl -s http://127.0.0.1:18791/tabs
```

### 설정 참조

| 옵션                       | 설명                                                                       | 기본값                                                   |
| ------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------- |
| `browser.enabled`        | 브라우저 제어 활성화                                                              | `true`                                                |
| `browser.executablePath` | Chromium 기반 브라우저 바이너리 경로 (Chrome/Brave/Edge/Chromium) | 자동 감지 (Chromium 기반일 경우 기본 브라우저 우선) |
| `browser.headless`       | GUI 없이 실행                                                                | `false`                                               |
| `browser.noSandbox`      | `--no-sandbox` 플래그 추가 (일부 Linux 설정에 필요)               | `false`                                               |
| `browser.attachOnly`     | 브라우저를 실행하지 않고 기존 인스턴스에만 연결                                               | `false`                                               |
| `browser.cdpPort`        | Chrome DevTools Protocol 포트                                              | `18800`                                               |

### 문제: "Chrome extension relay is running, but no tab is connected"

`chrome` 프로필 (extension relay)을 사용하고 있습니다. 이 프로필은 OpenClaw
브라우저 확장이 활성 탭에 연결되어 있을 것을 기대합니다.

해결 옵션:

1. **관리형 브라우저 사용:** `openclaw browser start --browser-profile openclaw`
   (또는 `browser.defaultProfile: "openclaw"` 설정).
2. **extension relay 사용:** 확장을 설치하고 탭을 연 뒤,
   OpenClaw 확장 아이콘을 클릭하여 연결합니다.

참고 사항:

- `chrome` 프로필은 가능할 경우 **시스템 기본 Chromium 브라우저**를 사용합니다.
- 로컬 `openclaw` 프로필은 `cdpPort`/`cdpUrl` 을 자동 할당합니다. 원격 CDP 인 경우에만 해당 값을 설정하십시오.
