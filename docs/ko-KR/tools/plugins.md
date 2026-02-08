---
summary: "플러그인 설치, 개발, 배포"
read_when:
  - 플러그인을 사용하거나 개발할 때
title: "플러그인"
---

# 플러그인

플러그인은 OpenClaw 기능을 확장하는 외부 패키지입니다.

## 플러그인 vs 스킬

| 특성   | 플러그인    | 스킬          |
| ------ | ----------- | ------------- |
| 형식   | npm 패키지  | 마크다운 파일 |
| 기능   | 코드 실행   | 프롬프트 주입 |
| 설치   | npm install | 파일 복사     |
| 복잡도 | 높음        | 낮음          |

## 플러그인 설치

### npm에서

```bash
npm install -g @openclaw/plugin-example
```

### 설정에서 활성화

```json5
{
  plugins: {
    "@openclaw/plugin-example": {
      enabled: true,
    },
  },
}
```

## 인기 플러그인

| 플러그인                      | 설명             |
| ----------------------------- | ---------------- |
| `@openclaw/plugin-mattermost` | Mattermost 채널  |
| `@openclaw/plugin-notion`     | Notion 통합      |
| `@openclaw/plugin-linear`     | Linear 이슈 관리 |
| `@openclaw/plugin-github`     | GitHub 액션      |

## 플러그인 설정

### 기본 설정

```json5
{
  plugins: {
    "@openclaw/plugin-example": {
      enabled: true,
      config: {
        apiKey: "...",
        option: "value",
      },
    },
  },
}
```

### 환경변수

```json5
{
  plugins: {
    "@openclaw/plugin-example": {
      config: {
        apiKey: "${EXAMPLE_API_KEY}",
      },
    },
  },
}
```

## 플러그인 개발

### 기본 구조

```
my-plugin/
├── package.json
├── src/
│   └── index.ts
├── README.md
└── tsconfig.json
```

### package.json

```json
{
  "name": "@openclaw/plugin-myfeature",
  "version": "1.0.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "openclaw": {
    "type": "plugin",
    "minVersion": "2024.1.0"
  },
  "peerDependencies": {
    "openclaw": "^2024.1.0"
  }
}
```

### 플러그인 코드

```typescript
import { Plugin, PluginContext } from "openclaw/plugin-sdk";

export default class MyPlugin implements Plugin {
  name = "my-plugin";

  async onLoad(ctx: PluginContext) {
    // 초기화
  }

  async onUnload() {
    // 정리
  }

  // 커스텀 도구 등록
  tools = [
    {
      name: "my_tool",
      description: "커스텀 도구",
      parameters: {
        input: { type: "string", description: "입력" },
      },
      execute: async (params) => {
        return { result: `처리됨: ${params.input}` };
      },
    },
  ];
}
```

## 채널 플러그인

### 채널 등록

```typescript
import { ChannelPlugin } from "openclaw/plugin-sdk";

export default class MyChannelPlugin implements ChannelPlugin {
  channelId = "mychannel";

  async connect(config: any) {
    // 연결
  }

  async disconnect() {
    // 연결 해제
  }

  async send(message: OutboundMessage) {
    // 메시지 전송
  }

  onMessage(handler: MessageHandler) {
    // 메시지 수신 핸들러 등록
  }
}
```

## 도구 플러그인

### 도구 등록

```typescript
export const tools = [
  {
    name: "search_database",
    description: "데이터베이스 검색",
    parameters: {
      query: { type: "string", required: true },
      limit: { type: "number", default: 10 },
    },
    execute: async ({ query, limit }) => {
      const results = await searchDB(query, limit);
      return { results };
    },
  },
];
```

## 훅 플러그인

### 이벤트 훅

```typescript
export const hooks = {
  onMessage: async (msg, ctx) => {
    // 메시지 수신 시
  },

  onResponse: async (response, ctx) => {
    // 응답 생성 후
  },

  onStartup: async (ctx) => {
    // Gateway 시작 시
  },
};
```

## 플러그인 배포

### npm 게시

```bash
npm publish --access public
```

### 문서화

README.md에 포함할 내용:

- 설치 방법
- 설정 옵션
- 사용 예시
- 호환성 정보

## 플러그인 관리

### CLI 명령어

```bash
# 설치된 플러그인 목록
openclaw plugins list

# 플러그인 정보
openclaw plugins info @openclaw/plugin-example

# 플러그인 비활성화
openclaw plugins disable @openclaw/plugin-example
```

## 문제 해결

### 플러그인 로드 실패

1. 버전 호환성 확인
2. 의존성 설치 확인
3. 로그에서 오류 확인

### 플러그인 충돌

- 같은 이름의 도구가 있으면 충돌
- 플러그인 우선순위 설정으로 해결
