---
summary: "Matrix 지원 상태, 기능 및 구성"
read_when:
  - Matrix 채널 기능을 작업할 때
title: "Matrix"
---

# Matrix (플러그인)

Matrix 는 개방형 분산 메시징 프로토콜입니다. OpenClaw 는 어떤 홈서버에서든 Matrix **사용자**로 연결되므로, 봇을 위한 Matrix 계정이 필요합니다. 로그인되면 봇과 직접 다이렉트 메시지(DM)를 주고받거나 방(Matrix '그룹')에 초대할 수 있습니다. Beeper 도 유효한 클라이언트 옵션이지만, E2EE 활성화가 필요합니다.

상태: 플러그인(@vector-im/matrix-bot-sdk)을 통해 지원됩니다. 다이렉트 메시지, 방, 스레드, 미디어, 반응, 설문(전송 + poll-start 를 텍스트로 처리), 위치, E2EE(암호화 지원 포함).

## 필요한 플러그인

Matrix 는 플러그인으로 제공되며 코어 설치에 포함되어 있지 않습니다.

CLI 로 설치(npm 레지스트리):

```bash
openclaw plugins install @openclaw/matrix
```

로컬 체크아웃(git 리포지토리에서 실행하는 경우):

```bash
openclaw plugins install ./extensions/matrix
```

구성/온보딩 중에 Matrix 를 선택하고 git 체크아웃이 감지되면, OpenClaw 는 로컬 설치 경로를 자동으로 제안합니다.

자세한 내용은 다음을 참고하십시오: [Plugins](/tools/plugin)

## 설정

1. Matrix 플러그인을 설치합니다:
   - npm 에서: `openclaw plugins install @openclaw/matrix`
   - 로컬 체크아웃에서: `openclaw plugins install ./extensions/matrix`

2. 홈서버에서 Matrix 계정을 생성합니다:
   - 호스팅 옵션은 [https://matrix.org/ecosystem/hosting/](https://matrix.org/ecosystem/hosting/) 를 참고하십시오
   - 또는 직접 호스팅합니다.

3. 봇 계정의 액세스 토큰을 가져옵니다:

   - 홈 서버에서 `curl` 를 사용해 Matrix 로그인 API 를 호출합니다:

   ```bash
   curl --request POST \
     --url https://matrix.example.org/_matrix/client/v3/login \
     --header 'Content-Type: application/json' \
     --data '{
     "type": "m.login.password",
     "identifier": {
       "type": "m.id.user",
       "user": "your-user-name"
     },
     "password": "your-password"
   }'
   ```

   - `matrix.example.org` 을 홈서버 URL 로 교체하십시오.
   - 또는 `channels.matrix.userId` + `channels.matrix.password` 를 설정하십시오. OpenClaw 는 동일한 로그인 엔드포인트를 호출하고, 액세스 토큰을 `~/.openclaw/credentials/matrix/credentials.json` 에 저장한 뒤 다음 시작 시 재사용합니다.

4. 자격 증명을 구성합니다:
   - 환경 변수: `MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN` (또는 `MATRIX_USER_ID` + `MATRIX_PASSWORD`)
   - 또는 설정: `channels.matrix.*`
   - 둘 다 설정된 경우 설정이 우선합니다.
   - 액세스 토큰을 사용하는 경우 사용자 ID 는 `/whoami` 를 통해 자동으로 가져옵니다.
   - 설정 시 `channels.matrix.userId` 은 전체 Matrix ID 여야 합니다(예: `@bot:example.org`).

5. Gateway(게이트웨이)를 재시작합니다(또는 온보딩을 완료합니다).

6. 어떤 Matrix 클라이언트에서든(Element, Beeper 등; [https://matrix.org/ecosystem/clients/](https://matrix.org/ecosystem/clients/) 참고) 봇과 다이렉트 메시지를 시작하거나 방에 초대합니다. Beeper 는 E2EE 가 필요하므로 `channels.matrix.encryption: true` 을 설정하고 장치를 검증하십시오.

최소 설정(액세스 토큰, 사용자 ID 자동 조회):

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      dm: { policy: "pairing" },
    },
  },
}
```

E2EE 설정(종단 간 암호화 활성화):

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      encryption: true,
      dm: { policy: "pairing" },
    },
  },
}
```

## 암호화(E2EE)

종단 간 암호화는 Rust 암호화 SDK 를 통해 **지원**됩니다.

`channels.matrix.encryption: true` 로 활성화하십시오:

- 암호화 모듈이 로드되면 암호화된 방이 자동으로 복호화됩니다.
- 암호화된 방으로 전송할 때 아웃바운드 미디어가 암호화됩니다.
- 최초 연결 시 OpenClaw 는 다른 세션에서 장치 검증을 요청합니다.
- 다른 Matrix 클라이언트(Element 등)에서 장치를 검증하여 키 공유를 활성화하십시오. to enable key sharing.
- 암호화 모듈을 로드할 수 없는 경우 E2EE 가 비활성화되며 암호화된 방은 복호화되지 않습니다. OpenClaw 는 경고를 기록합니다.
- 누락된 암호화 모듈 오류가 보이면(예: `@matrix-org/matrix-sdk-crypto-nodejs-*`), `@matrix-org/matrix-sdk-crypto-nodejs` 에 대한 빌드 스크립트를 허용하고
  `pnpm rebuild @matrix-org/matrix-sdk-crypto-nodejs` 를 실행하거나
  `node node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js` 로 바이너리를 가져오십시오.

암호화 상태는 계정 + 액세스 토큰별로
`~/.openclaw/matrix/accounts/<account>/<homeserver>__<user>/<token-hash>/crypto/`
(SQLite 데이터베이스)에 저장됩니다. 동기화 상태는 `bot-storage.json` 에 함께 저장됩니다.
액세스 토큰(장치)이 변경되면 새 저장소가 생성되며, 암호화된 방을 위해 봇을 다시 검증해야 합니다.

**장치 검증:**
E2EE 가 활성화되면 시작 시 봇이 다른 세션으로부터 검증을 요청합니다.
Element(또는 다른 클라이언트)를 열고 검증 요청을 승인하여 신뢰를 설정하십시오.
검증이 완료되면 봇이 암호화된 방의 메시지를 복호화할 수 있습니다.

## 라우팅 모델

- 응답은 항상 Matrix 로 돌아갑니다.
- 다이렉트 메시지는 에이전트의 메인 세션을 공유하며, 방은 그룹 세션으로 매핑됩니다.

## 접근 제어(다이렉트 메시지)

- 기본값: `channels.matrix.dm.policy = "pairing"`. 알 수 없는 발신자는 페어링 코드를 받습니다.
- 승인 방법:
  - `openclaw pairing list matrix`
  - `openclaw pairing approve matrix <CODE>`
- 공개 다이렉트 메시지: `channels.matrix.dm.policy="open"` + `channels.matrix.dm.allowFrom=["*"]`.
- `channels.matrix.dm.allowFrom` 은 전체 Matrix 사용자 ID 를 허용합니다(예: `@user:server`). 마법사는 디렉터리 검색에서 단일 정확 일치가 발견되면 표시 이름을 사용자 ID 로 해석합니다.

## 방(그룹)

- 기본값: `channels.matrix.groupPolicy = "allowlist"` (멘션 게이트). 설정되지 않은 경우 `channels.defaults.groupPolicy` 로 기본값을 재정의할 수 있습니다.
- `channels.matrix.groups` 로 방을 허용 목록에 추가합니다(방 ID 또는 별칭; 디렉터리 검색에서 단일 정확 일치가 발견되면 이름이 ID 로 해석됩니다):

```json5
{
  channels: {
    matrix: {
      groupPolicy: "allowlist",
      groups: {
        "!roomId:example.org": { allow: true },
        "#alias:example.org": { allow: true },
      },
      groupAllowFrom: ["@owner:example.org"],
    },
  },
}
```

- `requireMention: false` 은 해당 방에서 자동 응답을 활성화합니다.
- `groups."*"` 는 방 전반에 대한 멘션 게이트 기본값을 설정할 수 있습니다.
- `groupAllowFrom` 은 방에서 봇을 트리거할 수 있는 발신자를 제한합니다(전체 Matrix 사용자 ID).
- 방별 `users` 허용 목록은 특정 방 내 발신자를 추가로 제한할 수 있습니다(전체 Matrix 사용자 ID 사용).
- 구성 마법사는 방 허용 목록(방 ID, 별칭 또는 이름)을 요청하며, 이름은 정확하고 유일하게 일치할 때만 해석됩니다.
- 시작 시 OpenClaw 는 허용 목록의 방/사용자 이름을 ID 로 해석하고 매핑을 기록합니다. 해석되지 않은 항목은 허용 목록 매칭에서 무시됩니다.
- 초대는 기본적으로 자동 참가됩니다. `channels.matrix.autoJoin` 및 `channels.matrix.autoJoinAllowlist` 로 제어하십시오.
- **방을 전혀 허용하지 않으려면**, `channels.matrix.groupPolicy: "disabled"` 을 설정하십시오(또는 빈 허용 목록을 유지).
- 레거시 키: `channels.matrix.rooms` (`groups` 와 동일한 형태).

## 스레드

- 답글 스레딩이 지원됩니다.
- `channels.matrix.threadReplies` 은 답글을 스레드에 유지할지 여부를 제어합니다:
  - `off`, `inbound` (기본값), `always`
- `channels.matrix.replyToMode` 는 스레드로 답글하지 않을 때의 reply-to 메타데이터를 제어합니다:
  - `off` (기본값), `first`, `all`

## 기능

| 기능       | 상태                                                        |
| -------- | --------------------------------------------------------- |
| 다이렉트 메시지 | ✅ 지원                                                      |
| 방        | ✅ 지원                                                      |
| 스레드      | ✅ 지원                                                      |
| 미디어      | ✅ 지원                                                      |
| E2EE     | ✅ 지원(암호화 모듈 필요)                        |
| 반응       | ✅ 지원(도구를 통해 전송/읽기)                     |
| 설문       | ✅ 전송 지원; 수신된 설문 시작은 텍스트로 변환됨(응답/종료 무시) |
| 위치       | ✅ 지원(geo URI; 고도는 무시됨)                 |
| 네이티브 명령  | ✅ 지원                                                      |

## 문제 해결

먼저 다음 절차를 실행하십시오:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

필요한 경우 다이렉트 메시지 페어링 상태를 확인하십시오:

```bash
openclaw pairing list matrix
```

일반적인 실패 사례:

- 로그인되었지만 방 메시지가 무시됨: 방이 `groupPolicy` 또는 방 허용 목록에 의해 차단됨.
- 다이렉트 메시지가 무시됨: `channels.matrix.dm.policy="pairing"` 인 경우 발신자가 승인 대기 중.
- 암호화된 방 실패: 암호화 지원 또는 암호화 설정 불일치.

트리아지 흐름은 [/channels/troubleshooting](/channels/troubleshooting) 를 참고하십시오.

## 구성 참조(Matrix)

전체 구성: [Configuration](/gateway/configuration)

프로바이더 옵션:

- `channels.matrix.enabled`: 채널 시작 활성화/비활성화.
- `channels.matrix.homeserver`: 홈서버 URL.
- `channels.matrix.userId`: Matrix 사용자 ID(액세스 토큰 사용 시 선택).
- `channels.matrix.accessToken`: 액세스 토큰.
- `channels.matrix.password`: 로그인용 비밀번호(토큰 저장).
- `channels.matrix.deviceName`: 장치 표시 이름.
- `channels.matrix.encryption`: E2EE 활성화(기본값: false).
- `channels.matrix.initialSyncLimit`: 초기 동기화 제한.
- `channels.matrix.threadReplies`: `off | inbound | always` (기본값: inbound).
- `channels.matrix.textChunkLimit`: 아웃바운드 텍스트 청크 크기(문자).
- `channels.matrix.chunkMode`: `length` (기본값) 또는 길이 기준 분할 전에 빈 줄(문단 경계)에서 분할하도록 `newline`.
- `channels.matrix.dm.policy`: `pairing | allowlist | open | disabled` (기본값: pairing).
- `channels.matrix.dm.allowFrom`: 다이렉트 메시지 허용 목록(전체 Matrix 사용자 ID). `open` 는 `"*"` 이 필요합니다. 마법사는 가능할 때 이름을 ID 로 해석합니다.
- `channels.matrix.groupPolicy`: `allowlist | open | disabled` (기본값: allowlist).
- `channels.matrix.groupAllowFrom`: 그룹 메시지에 대해 허용된 발신자(전체 Matrix 사용자 ID).
- `channels.matrix.allowlistOnly`: 다이렉트 메시지 + 방에 대해 허용 목록 규칙을 강제합니다.
- `channels.matrix.groups`: 그룹 허용 목록 + 방별 설정 맵.
- `channels.matrix.rooms`: 레거시 그룹 허용 목록/설정.
- `channels.matrix.replyToMode`: 스레드/태그에 대한 reply-to 모드.
- `channels.matrix.mediaMaxMb`: 인바운드/아웃바운드 미디어 제한(MB).
- `channels.matrix.autoJoin`: 초대 처리(`always | allowlist | off`, 기본값: always).
- `channels.matrix.autoJoinAllowlist`: 자동 참가를 허용하는 방 ID/별칭.
- `channels.matrix.actions`: 작업별 도구 게이팅(반응/메시지/핀/memberInfo/channelInfo).
