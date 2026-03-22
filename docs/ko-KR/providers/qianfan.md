---
summary: "OpenClaw 에서 Qianfan 의 통합 API 를 사용하여 다양한 모델에 액세스하기"
read_when:
  - 다양한 LLM 에 대한 단일 API 키를 원할 때
  - Baidu Qianfan 설정 안내가 필요할 때
title: "Qianfan"
x-i18n:
  source_path: docs/providers/qianfan.md
---

# Qianfan 프로바이더 가이드

Qianfan 은 Baidu 의 MaaS 플랫폼으로, 단일 엔드포인트와 API 키 뒤에서 많은 모델로 요청을 라우팅하는 **통합 API** 를 제공합니다. OpenAI 호환이므로 대부분의 OpenAI SDK 가 기본 URL 만 변경하면 작동합니다.

## 사전 요구 사항

1. Qianfan API 액세스가 있는 Baidu Cloud 계정
2. Qianfan 콘솔의 API 키
3. 시스템에 OpenClaw 가 설치되어 있어야 함

## API 키 받기

1. [Qianfan Console](https://console.bce.baidu.com/qianfan/ais/console/apiKey) 을 방문합니다
2. 새 애플리케이션을 생성하거나 기존 애플리케이션을 선택합니다
3. API 키를 생성합니다 (형식: `bce-v3/ALTAK-...`)
4. OpenClaw 에서 사용할 API 키를 복사합니다

## CLI 설정

```bash
openclaw onboard --auth-choice qianfan-api-key
```

## 관련 문서

- [OpenClaw Configuration](/gateway/configuration)
- [Model Providers](/concepts/model-providers)
- [Agent Setup](/concepts/agent)
- [Qianfan API Documentation](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)
