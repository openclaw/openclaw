---
read_when:
    - Nextcloud Talk 채널 기능 작업 중
summary: Nextcloud Talk 지원 상태, 기능 및 구성
title: 넥스트클라우드톡
x-i18n:
    generated_at: "2026-02-08T15:50:47Z"
    model: gtx
    provider: google-translate
    source_hash: 2769144221e41391fc903a8a9289165fb9ffcc795dd54615e5009f1d6f48df3f
    source_path: channels/nextcloud-talk.md
    workflow: 15
---

# Nextcloud Talk(플러그인)

상태: 플러그인(웹훅 봇)을 통해 지원됩니다. 다이렉트 메시지, 회의실, 반응, 마크다운 메시지가 지원됩니다.

## 플러그인 필요

Nextcloud Talk는 플러그인으로 제공되며 핵심 설치와 함께 번들로 제공되지 않습니다.

CLI(npm 레지스트리)를 통해 설치:

```bash
openclaw plugins install @openclaw/nextcloud-talk
```

로컬 체크아웃(git repo에서 실행하는 경우):

```bash
openclaw plugins install ./extensions/nextcloud-talk
```

구성/온보딩 중에 Nextcloud Talk를 선택했는데 git 체크아웃이 감지되면,
OpenClaw는 로컬 설치 경로를 자동으로 제공합니다.

세부: [플러그인](/tools/plugin)

## 빠른 설정(초보자)

1. Nextcloud Talk 플러그인을 설치하세요.
2. Nextcloud 서버에서 봇을 만듭니다.

   ```bash
   ./occ talk:bot:install "OpenClaw" "<shared-secret>" "<webhook-url>" --feature reaction
   ```

3. 대상 방 설정에서 봇을 활성화합니다.
4. OpenClaw 구성:
   - 구성: `channels.nextcloud-talk.baseUrl` + `channels.nextcloud-talk.botSecret`
   - 또는 환경: `NEXTCLOUD_TALK_BOT_SECRET` (기본 계정만 해당)
5. 게이트웨이를 다시 시작합니다(또는 온보딩을 완료합니다).

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

## 메모

- 봇은 DM을 시작할 수 없습니다. 사용자는 먼저 봇에게 메시지를 보내야 합니다.
- 웹훅 URL은 게이트웨이에서 연결할 수 있어야 합니다. 세트 `webhookPublicUrl` 프록시 뒤에 있는 경우.
- 봇 API는 미디어 업로드를 지원하지 않습니다. 미디어는 URL로 전송됩니다.
- 웹훅 페이로드는 DM과 룸을 구분하지 않습니다. 세트 `apiUser` + `apiPassword` 방 유형 조회를 활성화합니다(그렇지 않으면 DM이 방으로 처리됩니다).

## 액세스 제어(DM)

- 기본: `channels.nextcloud-talk.dmPolicy = "pairing"`. 알 수 없는 발신자가 페어링 코드를 받습니다.
- 승인 방법:
  - `openclaw pairing list nextcloud-talk`
  - `openclaw pairing approve nextcloud-talk <CODE>`
- 공개 DM: `channels.nextcloud-talk.dmPolicy="open"` ...을 더한 `channels.nextcloud-talk.allowFrom=["*"]`.
- `allowFrom` Nextcloud 사용자 ID만 일치합니다. 표시 이름은 무시됩니다.

## 객실(그룹)

- 기본: `channels.nextcloud-talk.groupPolicy = "allowlist"` (언급 게이트).
- 다음이 포함된 채팅방 허용 목록 `channels.nextcloud-talk.rooms`:

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

- 회의실을 허용하지 않으려면 허용 목록을 비워두거나 설정하세요. `channels.nextcloud-talk.groupPolicy="disabled"`.

## 기능

| Feature         | Status        |
| --------------- | ------------- |
| Direct messages | Supported     |
| Rooms           | Supported     |
| Threads         | Not supported |
| Media           | URL-only      |
| Reactions       | Supported     |
| Native commands | Not supported |

## 구성 참조(Nextcloud Talk)

전체 구성: [구성](/gateway/configuration)

제공업체 옵션:

- `channels.nextcloud-talk.enabled`: 채널 시작을 활성화/비활성화합니다.
- `channels.nextcloud-talk.baseUrl`: Nextcloud 인스턴스 URL입니다.
- `channels.nextcloud-talk.botSecret`: 봇 공유 비밀입니다.
- `channels.nextcloud-talk.botSecretFile`: 비밀 파일 경로.
- `channels.nextcloud-talk.apiUser`: 회의실 조회(DM 감지)를 위한 API 사용자입니다.
- `channels.nextcloud-talk.apiPassword`: 회의실 조회를 위한 API/앱 비밀번호입니다.
- `channels.nextcloud-talk.apiPasswordFile`: API 비밀번호 파일 경로입니다.
- `channels.nextcloud-talk.webhookPort`: 웹훅 리스너 포트(기본값: 8788).
- `channels.nextcloud-talk.webhookHost`: 웹훅 호스트(기본값: 0.0.0.0).
- `channels.nextcloud-talk.webhookPath`: 웹훅 경로(기본값: /nextcloud-talk-webhook).
- `channels.nextcloud-talk.webhookPublicUrl`: 외부에서 접근 가능한 웹훅 URL입니다.
- `channels.nextcloud-talk.dmPolicy`:`pairing | allowlist | open | disabled`.
- `channels.nextcloud-talk.allowFrom`: DM 허용 목록(사용자 ID)입니다. `open` 필요하다 `"*"`.
- `channels.nextcloud-talk.groupPolicy`:`allowlist | open | disabled`.
- `channels.nextcloud-talk.groupAllowFrom`: 그룹 허용 목록(사용자 ID).
- `channels.nextcloud-talk.rooms`: 객실별 설정 및 허용 목록입니다.
- `channels.nextcloud-talk.historyLimit`: 그룹 기록 제한(0은 비활성화).
- `channels.nextcloud-talk.dmHistoryLimit`: DM 기록 제한(0은 비활성화).
- `channels.nextcloud-talk.dms`: DM당 재정의(historyLimit).
- `channels.nextcloud-talk.textChunkLimit`: 아웃바운드 텍스트 청크 크기(문자)입니다.
- `channels.nextcloud-talk.chunkMode`:`length` (기본값) 또는 `newline` 길이 청크 전에 빈 줄(단락 경계)로 분할합니다.
- `channels.nextcloud-talk.blockStreaming`: 이 채널에 대한 블록 스트리밍을 비활성화합니다.
- `channels.nextcloud-talk.blockStreamingCoalesce`: 스트리밍 통합 튜닝을 차단합니다.
- `channels.nextcloud-talk.mediaMaxMb`: 인바운드 미디어 한도(MB)입니다.
