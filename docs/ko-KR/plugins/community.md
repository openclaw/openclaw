---
summary: "커뮤니티 유지 OpenClaw 플러그인: 찾아보기, 설치 및 직접 제출하기"
read_when:
  - 서드파티 OpenClaw 플러그인을 찾고 싶을 때
  - 자체 플러그인을 게시하거나 등록하고 싶을 때
title: "커뮤니티 플러그인"
x-i18n:
  source_path: docs/plugins/community.md
---

# 커뮤니티 플러그인

커뮤니티 플러그인은 새로운 채널, 도구, 프로바이더 또는 기타 기능으로 OpenClaw 를 확장하는 서드파티 패키지입니다. 커뮤니티에서 빌드 및 유지관리하고, npm 에 게시되며, 단일 명령으로 설치할 수 있습니다.

```bash
openclaw plugins install <npm-spec>
```

## 등록된 플러그인

### Codex App Server Bridge

Codex App Server 대화를 위한 독립적인 OpenClaw 브리지입니다. 채팅을 Codex 스레드에 바인딩하고, 일반 텍스트로 대화하고, 재개, 계획, 리뷰, 모델 선택, 압축 등을 위한 채팅 네이티브 명령으로 제어합니다.

- **npm:** `openclaw-codex-app-server`
- **repo:** [github.com/pwrdrvr/openclaw-codex-app-server](https://github.com/pwrdrvr/openclaw-codex-app-server)

```bash
openclaw plugins install openclaw-codex-app-server
```

### DingTalk

Stream 모드를 사용하는 엔터프라이즈 로봇 통합입니다. DingTalk 클라이언트를 통해 텍스트, 이미지 및 파일 메시지를 지원합니다.

- **npm:** `@largezhou/ddingtalk`
- **repo:** [github.com/largezhou/openclaw-dingtalk](https://github.com/largezhou/openclaw-dingtalk)

```bash
openclaw plugins install @largezhou/ddingtalk
```

### Lossless Claw (LCM)

OpenClaw 를 위한 무손실 컨텍스트 관리 플러그인입니다. 점진적 압축을 사용한 DAG 기반 대화 요약 - 토큰 사용을 줄이면서 전체 컨텍스트 충실도를 유지합니다.

- **npm:** `@martian-engineering/lossless-claw`
- **repo:** [github.com/Martian-Engineering/lossless-claw](https://github.com/Martian-Engineering/lossless-claw)

```bash
openclaw plugins install @martian-engineering/lossless-claw
```

### Opik

에이전트 트레이스를 Opik 으로 내보내는 공식 플러그인입니다. 에이전트 동작, 비용, 토큰, 오류 등을 모니터링합니다.

- **npm:** `@opik/opik-openclaw`
- **repo:** [github.com/comet-ml/opik-openclaw](https://github.com/comet-ml/opik-openclaw)

```bash
openclaw plugins install @opik/opik-openclaw
```

### QQbot

QQ Bot API 를 통해 OpenClaw 를 QQ 에 연결합니다. 개인 채팅, 그룹 멘션, 채널 메시지 및 음성, 이미지, 비디오, 파일을 포함한 리치 미디어를 지원합니다.

- **npm:** `@sliverp/qqbot`
- **repo:** [github.com/sliverp/qqbot](https://github.com/sliverp/qqbot)

```bash
openclaw plugins install @sliverp/qqbot
```

### wecom

OpenClaw 엔터프라이즈 WeCom 채널 플러그인입니다.
WeCom AI Bot WebSocket 영구 연결로 구동되는 봇 플러그인으로, 다이렉트 메시지 및 그룹 채팅, 스트리밍 답변, 선제적 메시징을 지원합니다.

- **npm:** `@wecom/wecom-openclaw-plugin`
- **repo:** [github.com/WecomTeam/wecom-openclaw-plugin](https://github.com/WecomTeam/wecom-openclaw-plugin)

```bash
openclaw plugins install @wecom/wecom-openclaw-plugin
```

## 플러그인 제출

유용하고, 문서화되어 있으며, 안전하게 운영할 수 있는 커뮤니티 플러그인을 환영합니다.

<Steps>
  <Step title="npm 에 게시">
    플러그인은 `openclaw plugins install \<npm-spec\>`으로 설치 가능해야 합니다.
    전체 가이드는 [플러그인 만들기](/plugins/building-plugins)를 참조하세요.

  </Step>

  <Step title="GitHub 에 호스팅">
    소스 코드는 설정 문서와 이슈 트래커가 있는 공개 리포지토리에 있어야 합니다.

  </Step>

  <Step title="PR 열기">
    다음 정보와 함께 이 페이지에 플러그인을 추가합니다:

    - 플러그인 이름
    - npm 패키지 이름
    - GitHub 리포지토리 URL
    - 한 줄 설명
    - 설치 명령

  </Step>
</Steps>

## 품질 기준

| 요구 사항         | 이유                                              |
| ----------------- | ------------------------------------------------- |
| npm 에 게시됨     | 사용자가 `openclaw plugins install`로 작동해야 함 |
| 공개 GitHub 리포  | 소스 리뷰, 이슈 추적, 투명성                      |
| 설정 및 사용 문서 | 사용자가 구성 방법을 알아야 함                    |
| 활발한 유지보수   | 최근 업데이트 또는 반응적 이슈 처리               |

저노력 래퍼, 불명확한 소유권 또는 유지되지 않는 패키지는 거부될 수 있습니다.

## 관련 문서

- [플러그인 설치 및 구성](/tools/plugin) — 모든 플러그인 설치 방법
- [플러그인 만들기](/plugins/building-plugins) — 자체 플러그인 만들기
- [플러그인 매니페스트](/plugins/manifest) — 매니페스트 스키마
