---
summary: "형식 검증 및 보안 분석"
read_when:
  - OpenClaw 의 형식 검증 접근 방식을 이해할 때
  - 보안 속성을 검토할 때
title: "형식 검증"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: security/formal-verification.md
  workflow: 15
---

# 형식 검증

## 개요

OpenClaw 는 Gateway 프로토콜, 인증 및 권한 부여 메커니즘에 대해 형식 검증 기술을 적용합니다.

## 보안 모델

- **인증**: Gateway 인증 토큰 및 Tailscale 아이덴티티
- **권한 부여**: 채널별 DM 정책, 그룹 정책, 노드 페어링
- **암호화**: TLS (원격 연결), WebSocket 보안

## 감사

OpenClaw 는 정기적으로 보안 감사 및 커뮤니티 코드 검토를 받습니다.

보안 문제는 <security@openclaw.ai> 로 보고해 주세요.

## 관련 문서

- [Gateway 보안](/ko-KR/gateway/security)
- [Authentication](/ko-KR/gateway/authentication)
- [Configuration](/ko-KR/gateway/configuration)
