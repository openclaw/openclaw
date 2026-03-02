---
summary: "네트워크 허브: Gateway 표면, 페어링, 발견 및 보안"
read_when:
  - 네트워크 아키텍처 + 보안 개요가 필요할 때
  - 로컬 대 Tailnet 액세스 또는 페어링을 디버깅할 때
  - 네트워킹 문서의 표준 목록을 원할 때
title: "네트워크"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: network.md
  workflow: 15
---

# 네트워크 허브

이 허브는 OpenClaw 가 로컬호스트, LAN 및 Tailnet 전체에서 연결, 페어링 및 보안 방법에 대한 핵심 문서를 링크합니다.

## 핵심 모델

- [Gateway 아키텍처](/concepts/architecture)
- [Gateway 프로토콜](/ko-KR/gateway/protocol)
- [Gateway 실행 가이드](/ko-KR/gateway)
- [웹 표면 + 바인드 모드](/web)

## 페어링 + 아이디 세계

- [페어링 개요 (DM + 노드)](/channels/pairing)
- [Gateway 소유 노드 페어링](/ko-KR/gateway/pairing)
- [디바이스 CLI (페어링 + 토큰 회전)](/cli/devices)
- [페어링 CLI (DM 승인)](/cli/pairing)

로컬 신뢰:

- 로컬 연결 (로컬호스트 또는 Gateway 호스트의 자체 Tailnet 주소) 페어링에 대해 자동 승인될 수 있습니다.
  동일 호스트 UX 를 부드럽게 유지합니다.
- 비로컬 Tailnet/LAN 클라이언트는 여전히 명시적 페어링 승인이 필요합니다.

## 발견 + 전송

- [발견 & 전송](/ko-KR/gateway/discovery)
- [Bonjour / mDNS](/ko-KR/gateway/bonjour)
- [원격 액세스 (SSH)](/ko-KR/gateway/remote)
- [Tailscale](/ko-KR/gateway/tailscale)

## 노드 + 전송

- [노드 개요](/ko-KR/nodes)
- [브리지 프로토콜 (레거시 노드)](/ko-KR/gateway/bridge-protocol)
- [노드 실행 가이드: iOS](/ko-KR/platforms/ios)
- [노드 실행 가이드: Android](/ko-KR/platforms/android)

## 보안

- [보안 개요](/ko-KR/gateway/security)
- [Gateway 구성 참고](/ko-KR/gateway/configuration)
- [문제 해결](/ko-KR/gateway/troubleshooting)
- [Doctor](/ko-KR/gateway/doctor)
