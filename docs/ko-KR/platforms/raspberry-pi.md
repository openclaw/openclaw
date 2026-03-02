---
summary: "Raspberry Pi 에서 OpenClaw 실행"
read_when:
  - Raspberry Pi 에 OpenClaw 를 설치할 때
  - 에지 디바이스에서 로컬 Gateway 를 실행할 때
title: "Raspberry Pi"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: platforms/raspberry-pi.md
  workflow: 15
---

# Raspberry Pi 에서 OpenClaw

## 지원 여부

Gateway 는 Raspberry Pi 4/5 (2GB RAM 최소, 4GB+ 권장) 에서 Node 22+ 및 Linux 지원을 통해 완전히 지원됩니다.

## 빠른 시작

1. Raspberry Pi OS (Ubuntu 24.04 LTS 권장) 설치
2. Node 22+ 설치: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -`
3. `npm i -g openclaw@latest`
4. `openclaw onboard --install-daemon`

## 관련 문서

- [Gateway 실행 가이드](/ko-KR/gateway)
- [Linux 앱](/ko-KR/platforms/linux)
- [구성](/ko-KR/gateway/configuration)
