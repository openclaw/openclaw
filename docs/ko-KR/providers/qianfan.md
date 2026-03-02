---
summary: "OpenClaw에서 많은 모델에 액세스하기 위해 Qianfan의 통합 API를 사용합니다"
read_when:
  - 많은 LLM을 위해 단일 API 키를 원할 때
  - Baidu Qianfan 설정 지침이 필요할 때
title: "Qianfan"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
  source_path: "docs/providers/qianfan.md"
  workflow: 15
---

# Qianfan 제공자 가이드

Qianfan은 Baidu의 MaaS 플랫폼이며 단일 엔드포인트 및 API 키 뒤의 많은 모델로 요청을 라우팅하는 **통합 API**를 제공합니다. OpenAI 호환이므로 대부분의 OpenAI SDK는 기본 URL을 전환하여 작동합니다.

## 전제 조건

1. Qianfan API 액세스가 있는 Baidu Cloud 계정
2. Qianfan 콘솔의 API 키
3. 시스템에 설치된 OpenClaw

## API 키 가져오기

1. [Qianfan 콘솔](https://console.bce.baidu.com/qianfan/ais/console/apiKey) 방문
2. 새 애플리케이션을 만들거나 기존 애플리케이션을 선택합니다
3. API 키 생성 (형식: `bce-v3/ALTAK-...`)
4. OpenClaw에서 사용할 API 키 복사

## CLI 설정

```bash
openclaw onboard --auth-choice qianfan-api-key
```

## 관련 문서

- [OpenClaw 구성](/gateway/configuration)
- [모델 제공자](/concepts/model-providers)
- [에이전트 설정](/concepts/agent)
- [Qianfan API 문서](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)
