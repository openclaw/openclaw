---
summary: "macOS 전용 설치 및 기능"
read_when:
  - macOS에서 설치할 때
title: "macOS"
---

# macOS

macOS에서 OpenClaw를 설치하고 사용하는 가이드입니다.

## 설치

### 원클릭 설치 (권장)

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

### Homebrew

```bash
brew install openclaw
```

### npm

```bash
npm install -g openclaw
```

## 초기 설정

```bash
openclaw onboard
```

## macOS 전용 기능

### iMessage 통합

macOS에서 iMessage 직접 지원:

```json5
{
  channels: {
    imessage: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

### 메뉴 바 앱

시스템 트레이에서 빠른 접근:

- 상태 확인
- 빠른 채팅
- Gateway 시작/중지

```bash
openclaw menubar
```

## 서비스 설정

### launchd

```bash
openclaw onboard --install-daemon
```

### 수동 설정

```bash
cat << EOF > ~/Library/LaunchAgents/com.openclaw.gateway.plist
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.openclaw.gateway</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/openclaw</string>
        <string>gateway</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/com.openclaw.gateway.plist
```

### 서비스 관리

```bash
# 시작
launchctl start com.openclaw.gateway

# 중지
launchctl stop com.openclaw.gateway

# 상태
launchctl list | grep openclaw
```

## Bonjour 검색

로컬 네트워크에서 Gateway 자동 검색:

```json5
{
  gateway: {
    bonjour: {
      enabled: true,
      name: "My OpenClaw",
    },
  },
}
```

iOS/Android 노드 앱이 자동으로 Gateway를 찾습니다.

## Keychain 통합

API 키를 macOS Keychain에 안전하게 저장:

```bash
# Keychain에 저장
security add-generic-password -s openclaw -a ANTHROPIC_API_KEY -w "sk-ant-..."

# 설정에서 참조
export ANTHROPIC_API_KEY=$(security find-generic-password -s openclaw -a ANTHROPIC_API_KEY -w)
```

## Apple Silicon 최적화

M1/M2/M3 칩에서 최적화된 성능:

### 로컬 모델

```json5
{
  agents: {
    defaults: {
      model: "ollama/llama3.2",
      ollamaBaseUrl: "http://localhost:11434",
    },
  },
}
```

### MLX 지원

Apple MLX 프레임워크로 로컬 모델 실행 (실험적)

## 문제 해결

### 권한 오류

시스템 환경설정 → 보안 및 개인 정보 보호:

- 전체 디스크 접근 권한 (iMessage용)
- 자동화 권한

### Node.js 오류

```bash
# nvm 사용 권장
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 22
nvm use 22
```

### Homebrew 충돌

```bash
brew update
brew upgrade openclaw
```
