---
summary: "OpenClaw에서 많은 모델에 접근할 수 있는 Qianfan의 통합 API 사용"
read_when:
  - 여러 LLM을 위한 단일 API 키가 필요한 경우
  - Baidu Qianfan 설정 가이드가 필요한 경우
title: "Qianfan"
---

# Qianfan 프로바이더 가이드

Qianfan은 Baidu의 MaaS 플랫폼으로, 단일 엔드포인트와 API 키로 요청을 여러 모델로 라우팅하는 **통합 API**를 제공합니다. OpenAI와 호환되므로 대부분의 OpenAI SDK는 기본 URL을 변경하여 작동합니다.

## 전제 조건

1. Qianfan API 접근 권한이 있는 Baidu Cloud 계정
2. Qianfan 콘솔에서 발급받은 API 키
3. 시스템에 설치된 OpenClaw

## API 키 획득 방법

1. [Qianfan 콘솔](https://console.bce.baidu.com/qianfan/ais/console/apiKey)을 방문합니다.
2. 새 애플리케이션을 생성하거나 기존 애플리케이션을 선택합니다.
3. API 키를 생성합니다 (형식: `bce-v3/ALTAK-...`)
4. OpenClaw에서 사용할 API 키를 복사합니다.

## CLI 설정

```bash
openclaw onboard --auth-choice qianfan-api-key
```

## 관련 문서

- [OpenClaw 설정](/ko-KR/gateway/configuration)
- [모델 프로바이더](/ko-KR/concepts/model-providers)
- [에이전트 설정](/ko-KR/concepts/agent)
- [Qianfan API 문서](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)
