---
summary: "Matrix support status, capabilities, and configuration"
read_when:
  - Working on Matrix channel features
title: "Matrix"
x-i18n:
  source_hash: 199b954b901cbb178f608c1f41eaee2292aa48ca304d94c6231be0c405998344
---

# 매트릭스(플러그인)

Matrix는 개방형 분산 메시징 프로토콜입니다. OpenClaw는 Matrix **사용자**로 연결됩니다.
모든 홈서버에서 실행되므로 봇용 Matrix 계정이 필요합니다. 로그인 후 DM주시면 됩니다
봇을 직접 채팅방에 초대하거나(매트릭스 "그룹") Beeper도 유효한 클라이언트 옵션입니다.
하지만 활성화하려면 E2EE가 필요합니다.

상태: 플러그인(@Vector-im/matrix-bot-sdk)을 통해 지원됩니다. 다이렉트 메시지, 채팅방, 스레드, 미디어, 반응,
폴링(텍스트로 보내기 + 폴링 시작), 위치 및 E2EE(암호화 지원 포함).

## 플러그인이 필요합니다

Matrix는 플러그인으로 제공되며 코어 설치와 함께 번들로 제공되지 않습니다.

CLI(npm 레지스트리)를 통해 설치:

```bash
openclaw plugins install @openclaw/matrix
```

로컬 체크아웃(git repo에서 실행하는 경우):

```bash
openclaw plugins install ./extensions/matrix
```

구성/온보딩 중에 Matrix를 선택하고 git 체크아웃이 감지되면,
OpenClaw는 로컬 설치 경로를 자동으로 제공합니다.

세부정보: [플러그인](/tools/plugin)

## 설정

1. Matrix 플러그인을 설치합니다:
   - npm에서: `openclaw plugins install @openclaw/matrix`
   - 현지 결제에서: `openclaw plugins install ./extensions/matrix`
2. 홈서버에 Matrix 계정을 생성합니다:
   - [https://matrix.org/ecosystem/hosting/](https://matrix.org/ecosystem/hosting/)에서 호스팅 옵션을 찾아보세요.
   - 아니면 직접 호스팅하세요.
3. 봇 계정에 대한 액세스 토큰을 가져옵니다.
   - 홈 서버에서 `curl`과 함께 Matrix 로그인 API를 사용하십시오.

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

   - `matrix.example.org`를 홈서버 URL로 바꾸세요.
   - 또는 `channels.matrix.userId` + `channels.matrix.password`로 설정: OpenClaw는 동일하게 호출합니다.
     로그인 엔드포인트, `~/.openclaw/credentials/matrix/credentials.json`에 액세스 토큰을 저장합니다.
     다음 시작 시 다시 사용합니다.

4. 자격 증명을 구성합니다.
   - 환경: `MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN` (또는 `MATRIX_USER_ID` + `MATRIX_PASSWORD`)
   - 또는 구성: `channels.matrix.*`
   - 둘 다 설정된 경우 구성이 우선 적용됩니다.
   - 액세스 토큰 사용: `/whoami`을 통해 자동으로 사용자 ID를 가져옵니다.
   - 설정 시 `channels.matrix.userId`는 전체 매트릭스 ID여야 합니다(예: `@bot:example.org`).
5. 게이트웨이를 다시 시작합니다(또는 온보딩을 완료합니다).
6. 봇으로 DM을 시작하거나 Matrix 클라이언트에서 룸으로 초대하세요.
   (요소, 비퍼 등; [https://matrix.org/ecosystem/clients/](https://matrix.org/ecosystem/clients/) 참조). 비퍼에는 E2EE가 필요합니다.
   따라서 `channels.matrix.encryption: true`를 설정하고 장치를 확인하십시오.

최소 구성(액세스 토큰, 사용자 ID 자동 가져오기):

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

E2EE 구성(종단 간 암호화 활성화):

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

Rust 암호화 SDK를 통해 엔드투엔드 암호화가 **지원**됩니다.

`channels.matrix.encryption: true`로 활성화:

- 암호화 모듈이 로드되면 암호화된 방의 암호가 자동으로 해독됩니다.
- 아웃바운드 미디어는 암호화된 방으로 전송 시 암호화됩니다.
- 처음 연결 시 OpenClaw는 다른 세션에서 장치 확인을 요청합니다.
- 키 공유를 활성화하려면 다른 Matrix 클라이언트(Element 등)에서 장치를 확인하세요.
- 암호화 모듈을 로드할 수 없는 경우 E2EE가 비활성화되고 암호화된 방은 암호가 해독되지 않습니다.
  OpenClaw는 경고를 기록합니다.
- 암호화 모듈 누락 오류(예: `@matrix-org/matrix-sdk-crypto-nodejs-*`)가 표시되는 경우
  `@matrix-org/matrix-sdk-crypto-nodejs`에 대한 빌드 스크립트를 허용하고 실행합니다.
  `pnpm rebuild @matrix-org/matrix-sdk-crypto-nodejs` 또는 다음을 사용하여 바이너리를 가져옵니다.
  `node node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js`.

암호화 상태는 계정 + 액세스 토큰별로 저장됩니다.
`~/.openclaw/matrix/accounts/<account>/<homeserver>__<user>/<token-hash>/crypto/`
(SQLite 데이터베이스). 동기화 상태는 `bot-storage.json`에 함께 존재합니다.
액세스 토큰(디바이스)이 변경되면 새로운 스토어가 생성되고 봇은 반드시
암호화된 방에 대해 다시 확인되었습니다.

**기기 확인:**
E2EE가 활성화되면 봇은 시작 시 다른 세션에서 확인을 요청합니다.
Element(또는 다른 클라이언트)를 열고 확인 요청을 승인하여 신뢰를 구축합니다.
확인되면 봇은 암호화된 방의 메시지를 해독할 수 있습니다.

## 라우팅 모델

- 응답은 항상 Matrix로 돌아갑니다.
- DM은 상담원의 기본 세션을 공유합니다. 회의실은 그룹 세션에 매핑됩니다.

## 액세스 제어(DM)

- 기본값 : `channels.matrix.dm.policy = "pairing"`. 알 수 없는 발신자가 페어링 코드를 받습니다.
- 승인 방법:
  - `openclaw pairing list matrix`
  - `openclaw pairing approve matrix <CODE>`
- 공개 DM: `channels.matrix.dm.policy="open"` + `channels.matrix.dm.allowFrom=["*"]`.
- `channels.matrix.dm.allowFrom`는 전체 Matrix 사용자 ID를 허용합니다(예: `@user:server`). 마법사는 디렉터리 검색에서 정확히 일치하는 단일 항목을 찾으면 표시 이름을 사용자 ID로 확인합니다.

## 객실(그룹)

- 기본값: `channels.matrix.groupPolicy = "allowlist"` (언급 제한). 설정되지 않은 경우 기본값을 무시하려면 `channels.defaults.groupPolicy`를 사용하세요.
- `channels.matrix.groups`가 포함된 허용 목록 방(방 ID 또는 별칭, 디렉터리 검색에서 정확히 일치하는 단일 항목을 찾으면 이름이 ID로 확인됨):

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

- `requireMention: false`는 해당 방에서 자동 응답을 활성화합니다.
- `groups."*"`는 룸 전체에 걸쳐 멘션 게이팅에 대한 기본값을 설정할 수 있습니다.
- `groupAllowFrom` 방에서 봇을 실행할 수 있는 발신자를 제한합니다(전체 Matrix 사용자 ID).
- 방별 `users` 허용 목록은 특정 방 내부의 발신자를 추가로 제한할 수 있습니다(전체 Matrix 사용자 ID 사용).
- 구성 마법사는 회의실 허용 목록(방 ID, 별칭 또는 이름)을 묻는 메시지를 표시하고 정확하고 고유하게 일치하는 이름만 확인합니다.
- 시작 시 OpenClaw는 허용 목록의 방/사용자 이름을 ID로 확인하고 매핑을 기록합니다. 해결되지 않은 항목은 허용 목록 일치 시 무시됩니다.
- 초대는 기본적으로 자동으로 참여됩니다. `channels.matrix.autoJoin` 및 `channels.matrix.autoJoinAllowlist`로 제어합니다.
- **방 없음**을 허용하려면 `channels.matrix.groupPolicy: "disabled"`을 설정하세요(또는 빈 허용 목록을 유지하세요).
- 레거시 키: `channels.matrix.rooms` (`groups`와 같은 모양).

## 스레드

- 회신 스레딩이 지원됩니다.
- `channels.matrix.threadReplies` 답변이 스레드에 유지되는지 여부를 제어합니다.
  - `off`, `inbound` (기본값), `always`
- `channels.matrix.replyToMode` 스레드에서 응답하지 않을 때 응답 메타데이터를 제어합니다.
  - `off` (기본값), `first`, `all`

## 기능

| 기능            | 상태                                                                             |
| --------------- | -------------------------------------------------------------------------------- |
| 다이렉트 메시지 | ✅ 지원됨                                                                        |
| 객실            | ✅ 지원됨                                                                        |
| 스레드          | ✅ 지원됨                                                                        |
| 미디어          | ✅ 지원됨                                                                        |
| E2EE            | ✅ 지원됨(암호화 모듈 필요)                                                      |
| 반응            | ✅ 지원됨(도구를 통해 보내기/읽기)                                               |
| 여론조사        | ✅ 지원되는 보내기; 인바운드 폴링 시작은 텍스트로 변환됩니다(응답/종료는 무시됨) |
| 위치            | ✅ 지원됨(지리적 URI, 고도는 무시됨)                                             |
| 기본 명령       | ✅ 지원됨                                                                        |

## 문제 해결

먼저 이 사다리를 실행하세요:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

그런 다음 필요한 경우 DM 페어링 상태를 확인하세요.

```bash
openclaw pairing list matrix
```

일반적인 오류:

- 로그인했지만 방 메시지가 무시되었습니다. 방은 `groupPolicy` 또는 방 허용 목록에 의해 차단되었습니다.
- DM 무시됨: `channels.matrix.dm.policy="pairing"`일 때 보낸 사람이 승인 대기 중입니다.
- 암호화된 방 실패: 암호화 지원 또는 암호화 설정이 일치하지 않습니다.

분류 흐름의 경우: [/channels/troubleshooting](/channels/troubleshooting).

## 구성 참조(매트릭스)

전체 구성: [구성](/gateway/configuration)

제공업체 옵션:

- `channels.matrix.enabled`: 채널 시작을 활성화/비활성화합니다.
- `channels.matrix.homeserver`: 홈서버 URL.
- `channels.matrix.userId`: 매트릭스 사용자 ID(액세스 토큰이 있는 경우 선택 사항).
- `channels.matrix.accessToken`: 접근 토큰.
- `channels.matrix.password` : 로그인 비밀번호(토큰이 저장됨)
- `channels.matrix.deviceName` : 장치 표시 이름입니다.
- `channels.matrix.encryption`: E2EE를 활성화합니다(기본값: false).
- `channels.matrix.initialSyncLimit`: 초기 동기화 제한.
- `channels.matrix.threadReplies`: `off | inbound | always` (기본값: 인바운드).
- `channels.matrix.textChunkLimit`: 아웃바운드 텍스트 청크 크기(문자)입니다.
- `channels.matrix.chunkMode`: `length` (기본값) 또는 `newline` 길이 청크 전에 빈 줄(단락 경계)로 분할합니다.
- `channels.matrix.dm.policy`: `pairing | allowlist | open | disabled` (기본값: 페어링).
- `channels.matrix.dm.allowFrom`: DM 허용 목록(전체 Matrix 사용자 ID). `open`에는 `"*"`이 필요합니다. 마법사는 가능한 경우 이름을 ID로 확인합니다.
- `channels.matrix.groupPolicy`: `allowlist | open | disabled` (기본값: 허용 목록).
- `channels.matrix.groupAllowFrom`: 그룹 메시지에 대해 허용된 발신자(전체 Matrix 사용자 ID).
- `channels.matrix.allowlistOnly`: DM + 방에 대한 허용 목록 규칙을 강제합니다.
- `channels.matrix.groups` : 그룹 허용 목록 + 방별 설정 맵입니다.
- `channels.matrix.rooms`: 레거시 그룹 허용 목록/구성.
- `channels.matrix.replyToMode`: 스레드/태그에 대한 응답 모드입니다.
- `channels.matrix.mediaMaxMb`: 인바운드/아웃바운드 미디어 캡(MB)입니다.
- `channels.matrix.autoJoin`: 초대 처리(`always | allowlist | off`, 기본값: 항상).
- `channels.matrix.autoJoinAllowlist`: 자동 참여를 위해 방 ID/별칭을 허용합니다.
- `channels.matrix.actions`: 작업별 도구 게이팅(반응/메시지/핀/memberInfo/channelInfo).
