---
title: "Northflank"
summary: "원클릭 템플릿으로 Northflank 에 OpenClaw 배포"
read_when:
  - Northflank 에 OpenClaw 를 배포할 때
  - 브라우저 기반 설정으로 원클릭 클라우드 배포를 원할 때
x-i18n:
  source_path: docs/install/northflank.mdx
---

원클릭 템플릿으로 Northflank 에 OpenClaw 를 배포하고 브라우저에서 설정을 완료합니다.
이것은 가장 쉬운 "서버에 터미널 없이" 경로입니다: Northflank 가 Gateway 를 실행하고,
`/setup` 웹 마법사를 통해 모든 것을 구성합니다.

## 시작하는 방법

1. [Deploy OpenClaw](https://northflank.com/stacks/deploy-openclaw) 를 클릭하여 템플릿을 엽니다.
2. 아직 계정이 없다면 [Northflank 에서 계정](https://app.northflank.com/signup)을 생성합니다.
3. **Deploy OpenClaw now** 를 클릭합니다.
4. 필수 환경 변수를 설정합니다: `SETUP_PASSWORD`.
5. **Deploy stack** 을 클릭하여 OpenClaw 템플릿을 빌드하고 실행합니다.
6. 배포가 완료될 때까지 기다린 다음 **View resources** 를 클릭합니다.
7. OpenClaw 서비스를 엽니다.
8. 공용 OpenClaw URL 을 열고 `/setup` 에서 설정을 완료합니다.
9. `/openclaw` 에서 Control UI 를 엽니다.

## 제공되는 것

- 호스팅된 OpenClaw Gateway + Control UI
- `/setup` 에서 웹 설정 (터미널 명령 불필요)
- Northflank Volume (`/data`) 을 통한 영속 스토리지로 설정/자격 증명/작업 공간이 재배포 후에도 유지

## 설정 플로우

1. `https://<your-northflank-domain>/setup` 를 방문하고 `SETUP_PASSWORD` 를 입력합니다.
2. 모델/인증 프로바이더를 선택하고 키를 붙여넣습니다.
3. (선택 사항) Telegram/Discord/Slack 토큰을 추가합니다.
4. **Run setup** 을 클릭합니다.
5. `https://<your-northflank-domain>/openclaw` 에서 Control UI 를 엽니다

Telegram DM 이 페어링으로 설정된 경우 웹 설정에서 페어링 코드를 승인할 수 있습니다.

## 채널 연결

Telegram 또는 Discord 토큰을 `/setup` 마법사에 붙여넣습니다. 설정
지침은 채널 문서를 참고하세요:

- [Telegram](/channels/telegram) (가장 빠름 -- 봇 토큰만 필요)
- [Discord](/channels/discord)
- [모든 채널](/channels)

## 다음 단계

- 메시징 채널 설정: [채널](/channels)
- Gateway 구성: [Gateway 구성](/gateway/configuration)
- OpenClaw 최신 상태 유지: [업데이트](/install/updating)
