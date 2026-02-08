---
read_when:
    - 많은 LLM에 대해 단일 API 키가 필요합니다.
    - Baidu Qianfan 설정 안내가 필요합니다.
summary: Qianfan의 통합 API를 사용하여 OpenClaw의 다양한 모델에 액세스
title: 첸판
x-i18n:
    generated_at: "2026-02-08T16:01:39Z"
    model: gtx
    provider: google-translate
    source_hash: 2ca710b422f190b65d23db51a3219f0abd67074fb385251efeca6eae095d02e0
    source_path: providers/qianfan.md
    workflow: 15
---

# Qianfan 제공업체 가이드

Qianfan은 Baidu의 MaaS 플랫폼으로, **통합 API** 단일 모델 뒤에 있는 여러 모델로 요청을 라우팅하는 것입니다.
엔드포인트 및 API 키. OpenAI와 호환되므로 대부분의 OpenAI SDK는 기본 URL을 전환하여 작동합니다.

## 전제조건

1. Qianfan API 액세스 권한이 있는 Baidu Cloud 계정
2. Qianfan 콘솔의 API 키
3. 시스템에 설치된 OpenClaw

## API 키 받기

1. 방문 [Qianfan 콘솔](https://console.bce.baidu.com/qianfan/ais/console/apiKey)
2. 새 애플리케이션을 생성하거나 기존 애플리케이션을 선택하세요.
3. API 키 생성(형식: `bce-v3/ALTAK-...`)
4. OpenClaw와 함께 사용할 API 키를 복사하세요.

## CLI 설정

```bash
openclaw onboard --auth-choice qianfan-api-key
```

## 관련 문서

- [OpenClaw 구성](/gateway/configuration)
- [모델 제공자](/concepts/model-providers)
- [에이전트 설정](/concepts/agent)
- [Qianfan API 문서](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)
