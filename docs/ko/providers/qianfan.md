---
summary: "Qianfan 의 통합 API 를 사용하여 OpenClaw 에서 여러 모델에 접근합니다"
read_when:
  - 여러 LLM 을 하나의 API 키로 사용하고자 할 때
  - Baidu Qianfan 설정 가이드가 필요할 때
title: "Qianfan"
---

# Qianfan 프로바이더 가이드

Qianfan 은 Baidu 의 MaaS 플랫폼으로, 단일 엔드포인트와 API 키 뒤에서 여러 모델로 요청을 라우팅하는 **통합 API** 를 제공합니다. OpenAI 와 호환되므로, 기본 URL 만 전환하면 대부분의 OpenAI SDK 가 동작합니다.

## 사전 요구 사항

1. Qianfan API 접근 권한이 있는 Baidu Cloud 계정
2. Qianfan 콘솔에서 발급한 API 키
3. 시스템에 설치된 OpenClaw

## API 키 받기

1. [Qianfan 콘솔](https://console.bce.baidu.com/qianfan/ais/console/apiKey) 을 방문합니다
2. 새 애플리케이션을 생성하거나 기존 애플리케이션을 선택합니다
3. API 키를 생성합니다 (형식: `bce-v3/ALTAK-...`)
4. OpenClaw 에서 사용하기 위해 API 키를 복사합니다

## CLI 설정

```bash
openclaw onboard --auth-choice qianfan-api-key
```

## 관련 문서

- [OpenClaw 구성](/gateway/configuration)
- [모델 프로바이더](/concepts/model-providers)
- [에이전트 설정](/concepts/agent)
- [Qianfan API 문서](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)
