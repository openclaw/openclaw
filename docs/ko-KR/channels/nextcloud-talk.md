---
summary: "Nextcloud Talk 지원 상태, 기능, 구성"
read_when:
  - Nextcloud Talk 채널 기능을 작업하는 경우
title: "Nextcloud Talk"
x-i18n:
  source_path: docs/channels/nextcloud-talk.md
---

# Nextcloud Talk (플러그인)

상태: 플러그인을 통해 지원됨 (웹훅 봇). 다이렉트 메시지, 룸, 리액션, 마크다운 메시지가 지원됩니다.

## 플러그인 필요

Nextcloud Talk 은 플러그인으로 제공되며 코어 설치에 번들되지 않습니다.

CLI 를 통한 설치 (npm 레지스트리):

```bash
openclaw plugins install @openclaw/nextcloud-talk
```

로컬 checkout (git 저장소에서 실행할 때):

```bash
openclaw plugins install ./extensions/nextcloud-talk
```

설정 중 Nextcloud Talk 을 선택하고 git checkout 이 감지되면, OpenClaw 가 자동으로 로컬 설치 경로를 제공합니다.

자세한 내용: [Plugins](/tools/plugin)

## 빠른 설정 (초보자)

1. Nextcloud Talk 플러그인을 설치합니다.
2. Nextcloud 서버에서 봇을 생성합니다:

   ```bash
   ./occ talk:bot:install "OpenClaw" "<shared-secret>" "<webhook-url>" --feature reaction
   ```

3. 대상 룸 설정에서 봇을 활성화합니다.
4. OpenClaw 를 구성합니다:
   - 구성: `channels.nextcloud-talk.baseUrl` + `channels.nextcloud-talk.botSecret`
   - 또는 환경: `NEXTCLOUD_TALK_BOT_SECRET` (기본 계정만)
5. Gateway 를 재시작합니다 (또는 설정을 완료합니다).

최소 구성:

```json5
{
  channels: {
    "nextcloud-talk": {
      enabled: true,
      baseUrl: "https://cloud.example.com",
      botSecret: "shared-secret",
      dmPolicy: "pairing",
    },
  },
}
```

## 참고 사항

- 봇은 DM 을 시작할 수 없습니다. 사용자가 먼저 봇에게 메시지를 보내야 합니다.
- 웹훅 URL 은 Gateway 에서 도달 가능해야 합니다. 프록시 뒤에 있는 경우 `webhookPublicUrl` 을 설정하세요.
- 봇 API 에서 미디어 업로드가 지원되지 않습니다. 미디어는 URL 로 전송됩니다.
- 웹훅 페이로드는 DM 과 룸을 구분하지 않습니다. 룸 유형 조회를 활성화하려면 `apiUser` + `apiPassword` 를 설정하세요 (그렇지 않으면 DM 이 룸으로 처리됩니다).

## 접근 제어 (DM)

- 기본값: `channels.nextcloud-talk.dmPolicy = "pairing"`. 알 수 없는 발신자에게 페어링 코드가 제공됩니다.
- 승인:
  - `openclaw pairing list nextcloud-talk`
  - `openclaw pairing approve nextcloud-talk <CODE>`
- 공개 DM: `channels.nextcloud-talk.dmPolicy="open"` + `channels.nextcloud-talk.allowFrom=["*"]`.
- `allowFrom` 은 Nextcloud 사용자 ID 만 매칭합니다. 표시 이름은 무시됩니다.

## 룸 (그룹)

- 기본값: `channels.nextcloud-talk.groupPolicy = "allowlist"` (멘션 게이팅).
- `channels.nextcloud-talk.rooms` 로 룸을 허용합니다:

```json5
{
  channels: {
    "nextcloud-talk": {
      rooms: {
        "room-token": { requireMention: true },
      },
    },
  },
}
```

- 룸을 허용하지 않으려면 허용 목록을 비워두거나 `channels.nextcloud-talk.groupPolicy="disabled"` 를 설정합니다.

## 기능

| 기능            | 상태     |
| --------------- | -------- |
| 다이렉트 메시지 | 지원됨   |
| 룸              | 지원됨   |
| 스레드          | 미지원   |
| 미디어          | URL 전용 |
| 리액션          | 지원됨   |
| 네이티브 명령   | 미지원   |

## 구성 참조 (Nextcloud Talk)

전체 구성: [Configuration](/gateway/configuration)

프로바이더 옵션:

- `channels.nextcloud-talk.enabled`: 채널 시작 활성화/비활성화.
- `channels.nextcloud-talk.baseUrl`: Nextcloud 인스턴스 URL.
- `channels.nextcloud-talk.botSecret`: 봇 공유 시크릿.
- `channels.nextcloud-talk.botSecretFile`: 일반 파일 시크릿 경로. 심볼릭 링크는 거부됩니다.
- `channels.nextcloud-talk.apiUser`: 룸 조회용 API 사용자 (DM 감지).
- `channels.nextcloud-talk.apiPassword`: 룸 조회용 API/앱 비밀번호.
- `channels.nextcloud-talk.apiPasswordFile`: API 비밀번호 파일 경로.
- `channels.nextcloud-talk.webhookPort`: 웹훅 리스너 포트 (기본값: 8788).
- `channels.nextcloud-talk.webhookHost`: 웹훅 호스트 (기본값: 0.0.0.0).
- `channels.nextcloud-talk.webhookPath`: 웹훅 경로 (기본값: /nextcloud-talk-webhook).
- `channels.nextcloud-talk.webhookPublicUrl`: 외부에서 도달 가능한 웹훅 URL.
- `channels.nextcloud-talk.dmPolicy`: `pairing | allowlist | open | disabled`.
- `channels.nextcloud-talk.allowFrom`: DM 허용 목록 (사용자 ID). `open` 은 `"*"` 필요.
- `channels.nextcloud-talk.groupPolicy`: `allowlist | open | disabled`.
- `channels.nextcloud-talk.groupAllowFrom`: 그룹 허용 목록 (사용자 ID).
- `channels.nextcloud-talk.rooms`: 룸별 설정 및 허용 목록.
- `channels.nextcloud-talk.historyLimit`: 그룹 기록 제한 (0 은 비활성화).
- `channels.nextcloud-talk.dmHistoryLimit`: DM 기록 제한 (0 은 비활성화).
- `channels.nextcloud-talk.dms`: DM 별 재정의 (historyLimit).
- `channels.nextcloud-talk.textChunkLimit`: 아웃바운드 텍스트 청크 크기 (문자).
- `channels.nextcloud-talk.chunkMode`: `length` (기본값) 또는 `newline` (길이 청킹 전에 빈 줄 (단락 경계) 에서 분할).
- `channels.nextcloud-talk.blockStreaming`: 이 채널의 블록 스트리밍 비활성화.
- `channels.nextcloud-talk.blockStreamingCoalesce`: 블록 스트리밍 병합 조정.
- `channels.nextcloud-talk.mediaMaxMb`: 인바운드 미디어 제한 (MB).
