---
summary: "Use Qianfan's unified API to access many models in OpenClaw"
read_when:
  - You want a single API key for many LLMs
  - You need Baidu Qianfan setup guidance
title: "Qianfan"
x-i18n:
  source_hash: 2ca710b422f190b65d23db51a3219f0abd67074fb385251efeca6eae095d02e0
---

# Qianfan 공급자 가이드

Qianfan은 Baidu의 MaaS 플랫폼으로, 요청을 단일 모델 뒤의 여러 모델로 라우팅하는 **통합 API**를 제공합니다.
엔드포인트 및 API 키. OpenAI와 호환되므로 대부분의 OpenAI SDK는 기본 URL을 전환하여 작동합니다.

## 전제조건

1. Qianfan API 액세스 권한이 있는 Baidu Cloud 계정
2. Qianfan 콘솔의 API 키
3. 시스템에 OpenClaw가 설치되어 있습니다.

## API 키 받기

1. [Qianfan 콘솔](https://console.bce.baidu.com/qianfan/ais/console/apiKey)에 접속합니다.
2. 새 애플리케이션을 만들거나 기존 애플리케이션을 선택하세요.
3. API 키 생성(형식: `bce-v3/ALTAK-...`)
4. OpenClaw에서 사용할 API 키를 복사하세요.

## CLI 설정

```bash
openclaw onboard --auth-choice qianfan-api-key
```

## 관련 문서

- [OpenClaw 구성](/gateway/configuration)
- [모델 제공자](/concepts/model-providers)
- [에이전트 설정](/concepts/agent)
- [Qianfan API 문서](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)
