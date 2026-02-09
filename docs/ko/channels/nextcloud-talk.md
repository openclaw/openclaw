---
summary: "Nextcloud Talk 지원 상태, 기능, 및 구성"
read_when:
  - Nextcloud Talk 채널 기능 작업 중
title: "Nextcloud Talk"
---

# Nextcloud Talk (플러그인)

상태: 플러그인 (웹훅 봇)을 통해 지원됩니다. 다이렉트 메시지, 방, 반응, 마크다운 메시지가 지원됩니다.

## 플러그인 필요

Nextcloud Talk 는 플러그인으로 제공되며 코어 설치에 번들로 포함되지 않습니다.

CLI 로 설치 (npm 레지스트리):

```bash
openclaw plugins install @openclaw/nextcloud-talk
```

로컬 체크아웃 (git 리포지토리에서 실행하는 경우):

```bash
openclaw plugins install ./extensions/nextcloud-talk
```

구성/온보딩 중에 Nextcloud Talk 를 선택하고 git 체크아웃이 감지되면,
OpenClaw 는 로컬 설치 경로를 자동으로 제안합니다.

자세한 내용: [Plugins](/tools/plugin)

## 빠른 설정 (초보자)

1. Nextcloud Talk 플러그인을 설치합니다.

2. Nextcloud 서버에서 봇을 생성합니다:

   ```bash
   ./occ talk:bot:install "OpenClaw" "<shared-secret>" "<webhook-url>" --feature reaction
   ```

3. 대상 방 설정에서 봇을 활성화합니다.

4. OpenClaw 를 구성합니다:
   - 설정: `channels.nextcloud-talk.baseUrl` + `channels.nextcloud-talk.botSecret`
   - 또는 환경 변수: `NEXTCLOUD_TALK_BOT_SECRET` (기본 계정만 해당)

5. Gateway(게이트웨이)를 재시작합니다 (또는 온보딩을 완료합니다).

최소 설정:

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

- 봇은 다이렉트 메시지를 먼저 시작할 수 없습니다. 사용자가 먼저 봇에게 메시지를 보내야 합니다.
- 웹훅 URL 은 Gateway(게이트웨이)에서 접근 가능해야 합니다. 프록시 뒤에 있는 경우 `webhookPublicUrl` 을 설정하십시오.
- 미디어 업로드는 봇 API 에서 지원되지 않으며, 미디어는 URL 로 전송됩니다.
- 웹훅 페이로드는 다이렉트 메시지와 방을 구분하지 않습니다. 방 유형 조회를 활성화하려면 `apiUser` + `apiPassword` 을 설정하십시오 (그렇지 않으면 다이렉트 메시지가 방으로 처리됩니다).

## 접근 제어 (다이렉트 메시지)

- 기본값: `channels.nextcloud-talk.dmPolicy = "pairing"`. 알 수 없는 발신자는 페어링 코드를 받습니다.
- 승인 방법:
  - `openclaw pairing list nextcloud-talk`
  - `openclaw pairing approve nextcloud-talk <CODE>`
- 공개 다이렉트 메시지: `channels.nextcloud-talk.dmPolicy="open"` 와 `channels.nextcloud-talk.allowFrom=["*"]`.
- `allowFrom` 은 Nextcloud 사용자 ID 만 일치시키며 표시 이름은 무시됩니다.

## 방 (그룹)

- 기본값: `channels.nextcloud-talk.groupPolicy = "allowlist"` (멘션 기반 제한).
- `channels.nextcloud-talk.rooms` 로 방 허용 목록을 설정합니다:

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

- 방을 전혀 허용하지 않으려면 허용 목록을 비워 두거나 `channels.nextcloud-talk.groupPolicy="disabled"` 를 설정하십시오.

## 기능

| 기능       | 상태      |
| -------- | ------- |
| 다이렉트 메시지 | 지원됨     |
| 방        | 지원됨     |
| 스레드      | 지원되지 않음 |
| 미디어      | URL 전용  |
| 반응       | 지원됨     |
| 네이티브 명령  | 지원되지 않음 |

## 구성 참조 (Nextcloud Talk)

전체 구성: [구성](/gateway/configuration)

프로바이더 옵션:

- `channels.nextcloud-talk.enabled`: 채널 시작 시 활성화/비활성화.
- `channels.nextcloud-talk.baseUrl`: Nextcloud 인스턴스 URL.
- `channels.nextcloud-talk.botSecret`: 봇 공유 시크릿.
- `channels.nextcloud-talk.botSecretFile`: 시크릿 파일 경로.
- `channels.nextcloud-talk.apiUser`: 방 조회용 API 사용자 (다이렉트 메시지 감지).
- `channels.nextcloud-talk.apiPassword`: 방 조회용 API/앱 비밀번호.
- `channels.nextcloud-talk.apiPasswordFile`: API 비밀번호 파일 경로.
- `channels.nextcloud-talk.webhookPort`: 웹훅 리스너 포트 (기본값: 8788).
- `channels.nextcloud-talk.webhookHost`: 웹훅 호스트 (기본값: 0.0.0.0).
- `channels.nextcloud-talk.webhookPath`: 웹훅 경로 (기본값: /nextcloud-talk-webhook).
- `channels.nextcloud-talk.webhookPublicUrl`: 외부에서 접근 가능한 웹훅 URL.
- `channels.nextcloud-talk.dmPolicy`: `pairing | allowlist | open | disabled`.
- `channels.nextcloud-talk.allowFrom`: 다이렉트 메시지 허용 목록 (사용자 ID). `open` 는 `"*"` 를 필요로 합니다.
- `channels.nextcloud-talk.groupPolicy`: `allowlist | open | disabled`.
- `channels.nextcloud-talk.groupAllowFrom`: 그룹 허용 목록 (사용자 ID).
- `channels.nextcloud-talk.rooms`: 방별 설정 및 허용 목록.
- `channels.nextcloud-talk.historyLimit`: 그룹 히스토리 제한 (0 은 비활성화).
- `channels.nextcloud-talk.dmHistoryLimit`: 다이렉트 메시지 히스토리 제한 (0 은 비활성화).
- `channels.nextcloud-talk.dms`: 다이렉트 메시지별 재정의 (historyLimit).
- `channels.nextcloud-talk.textChunkLimit`: 발신 텍스트 청크 크기 (문자 수).
- `channels.nextcloud-talk.chunkMode`: 길이 기준 청킹 전에 빈 줄 (문단 경계)에서 분할하려면 `length` (기본값) 또는 `newline`.
- `channels.nextcloud-talk.blockStreaming`: 이 채널에 대해 블록 스트리밍 비활성화.
- `channels.nextcloud-talk.blockStreamingCoalesce`: 블록 스트리밍 병합 튜닝.
- `channels.nextcloud-talk.mediaMaxMb`: 수신 미디어 상한 (MB).
