---
summary: "Nextcloud Talk support status, capabilities, and configuration"
read_when:
  - Working on Nextcloud Talk channel features
title: "Nextcloud Talk"
x-i18n:
  source_hash: 2769144221e41391fc903a8a9289165fb9ffcc795dd54615e5009f1d6f48df3f
---

# Nextcloud Talk(플러그인)

상태: 플러그인(웹훅 봇)을 통해 지원됩니다. 다이렉트 메시지, 회의실, 반응, 마크다운 메시지가 지원됩니다.

## 플러그인이 필요합니다

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

세부정보: [플러그인](/tools/plugin)

## 빠른 설정(초보자)

1. Nextcloud Talk 플러그인을 설치하세요.
2. Nextcloud 서버에서 봇을 생성합니다.

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
- 게이트웨이에서 웹훅 URL에 연결할 수 있어야 합니다. 프록시 뒤에 있는 경우 `webhookPublicUrl`를 설정합니다.
- 봇 API는 미디어 업로드를 지원하지 않습니다. 미디어는 URL로 전송됩니다.
- 웹훅 페이로드는 DM과 룸을 구분하지 않습니다. 방 유형 조회를 활성화하려면 `apiUser` + `apiPassword`를 설정하세요(그렇지 않으면 DM이 방으로 처리됩니다).

## 액세스 제어(DM)

- 기본값 : `channels.nextcloud-talk.dmPolicy = "pairing"`. 알 수 없는 발신자가 페어링 코드를 받습니다.
- 승인 방법:
  - `openclaw pairing list nextcloud-talk`
  - `openclaw pairing approve nextcloud-talk <CODE>`
- 공개 DM: `channels.nextcloud-talk.dmPolicy="open"` + `channels.nextcloud-talk.allowFrom=["*"]`.
- `allowFrom`는 Nextcloud 사용자 ID에만 일치합니다. 표시 이름은 무시됩니다.

## 객실(그룹)

- 기본값: `channels.nextcloud-talk.groupPolicy = "allowlist"` (언급 제한).
- `channels.nextcloud-talk.rooms`가 포함된 허용 목록 방:

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

- 회의실을 허용하지 않으려면 허용 목록을 비워 두거나 `channels.nextcloud-talk.groupPolicy="disabled"`를 설정하세요.

## 기능

| 기능            | 상태          |
| --------------- | ------------- |
| 다이렉트 메시지 | 지원됨        |
| 객실            | 지원됨        |
| 스레드          | 지원되지 않음 |
| 미디어          | URL 전용      |
| 반응            | 지원됨        |
| 기본 명령       | 지원되지 않음 |

## 구성 참고자료 (Nextcloud Talk)

전체 구성: [구성](/gateway/configuration)

제공업체 옵션:

- `channels.nextcloud-talk.enabled`: 채널 시작을 활성화/비활성화합니다.
- `channels.nextcloud-talk.baseUrl`: Nextcloud 인스턴스 URL입니다.
- `channels.nextcloud-talk.botSecret`: 봇 공유 비밀.
- `channels.nextcloud-talk.botSecretFile` : 비밀 파일 경로.
- `channels.nextcloud-talk.apiUser` : 방 조회(DM 감지)를 위한 API 사용자입니다.
- `channels.nextcloud-talk.apiPassword` : 방 조회를 위한 API/앱 비밀번호입니다.
- `channels.nextcloud-talk.apiPasswordFile` : API 비밀번호 파일 경로입니다.
- `channels.nextcloud-talk.webhookPort` : 웹훅 리스너 포트 (기본값: 8788).
- `channels.nextcloud-talk.webhookHost`: 웹훅 호스트 (기본값: 0.0.0.0).
- `channels.nextcloud-talk.webhookPath`: 웹훅 경로(기본값: /nextcloud-talk-webhook).
- `channels.nextcloud-talk.webhookPublicUrl`: 외부에서 접근 가능한 웹훅 URL입니다.
- `channels.nextcloud-talk.dmPolicy`: `pairing | allowlist | open | disabled`.
- `channels.nextcloud-talk.allowFrom`: DM 허용 목록(사용자 ID)입니다. `open`에는 `"*"`가 필요합니다.
- `channels.nextcloud-talk.groupPolicy`: `allowlist | open | disabled`.
- `channels.nextcloud-talk.groupAllowFrom`: 그룹 허용 목록(사용자 ID).
- `channels.nextcloud-talk.rooms` : 방별 설정 및 허용 목록입니다.
- `channels.nextcloud-talk.historyLimit`: 그룹 기록 제한(0은 비활성화).
- `channels.nextcloud-talk.dmHistoryLimit`: DM 기록 제한(0은 비활성화).
- `channels.nextcloud-talk.dms`: DM당 재정의(historyLimit).
- `channels.nextcloud-talk.textChunkLimit`: 아웃바운드 텍스트 청크 크기(문자)입니다.
- `channels.nextcloud-talk.chunkMode`: `length` (기본값) 또는 `newline` 길이 청크 전에 빈 줄(단락 경계)로 분할합니다.
- `channels.nextcloud-talk.blockStreaming`: 이 채널에 대한 블록 스트리밍을 비활성화합니다.
- `channels.nextcloud-talk.blockStreamingCoalesce`: 블록 스트리밍 병합 튜닝.
- `channels.nextcloud-talk.mediaMaxMb`: 인바운드 미디어 캡(MB)입니다.
