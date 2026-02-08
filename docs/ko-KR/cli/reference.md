---
summary: "CLI 명령어 레퍼런스"
read_when:
  - CLI 명령어를 찾을 때
title: "CLI 레퍼런스"
---

# CLI 레퍼런스

OpenClaw CLI의 모든 명령어와 옵션을 설명합니다.

## 기본 명령어

### `openclaw onboard`

초기 설정 마법사를 실행합니다.

```bash
openclaw onboard [옵션]
```

| 옵션               | 설명                 |
| ------------------ | -------------------- |
| `--install-daemon` | 시스템 서비스로 설치 |
| `--skip-api-key`   | API 키 설정 건너뛰기 |
| `--skip-channels`  | 채널 설정 건너뛰기   |

### `openclaw gateway`

Gateway를 시작합니다.

```bash
openclaw gateway [옵션]
```

| 옵션            | 설명           | 기본값  |
| --------------- | -------------- | ------- |
| `--port <port>` | 포트 번호      | `18789` |
| `--verbose`     | 상세 로그 출력 | -       |

**서브커맨드:**

```bash
# 상태 확인
openclaw gateway status

# 재시작
openclaw gateway restart

# 중지
openclaw gateway stop
```

### `openclaw dashboard`

Control UI를 브라우저에서 엽니다.

```bash
openclaw dashboard
```

## 채널 관리

### `openclaw channels`

채널 상태 및 관리.

```bash
# 상태 확인
openclaw channels status

# 상세 상태 (프로브 포함)
openclaw channels status --probe

# 로그인 (WhatsApp QR 등)
openclaw channels login

# 특정 계정 로그인
openclaw channels login --account <id>

# 로그아웃
openclaw channels logout

# 특정 채널 로그아웃
openclaw channels logout --channel telegram
```

## 페어링 관리

### `openclaw pairing`

DM 페어링 요청 관리.

```bash
# 대기 중인 요청 목록
openclaw pairing list <channel>

# 요청 승인
openclaw pairing approve <channel> <code>

# 요청 거부
openclaw pairing reject <channel> <code>
```

**예시:**

```bash
openclaw pairing list telegram
openclaw pairing approve telegram ABC123
```

## 세션 관리

### `openclaw sessions`

세션 조회 및 관리.

```bash
# 세션 목록
openclaw sessions list

# 세션 히스토리
openclaw sessions history <session-key>

# 세션 초기화
openclaw sessions reset <session-key>

# 오래된 세션 정리
openclaw sessions prune
```

## 메시지 전송

### `openclaw message`

메시지 전송 (테스트 또는 자동화용).

```bash
openclaw message send [옵션]
```

| 옵션                  | 설명                             |
| --------------------- | -------------------------------- |
| `--channel <channel>` | 채널 (telegram, whatsapp 등)     |
| `--target <id>`       | 대상 ID (전화번호, 사용자 ID 등) |
| `--message <text>`    | 메시지 내용                      |
| `--media <path>`      | 미디어 파일 경로                 |

**예시:**

```bash
openclaw message send --channel telegram --target 123456789 --message "안녕하세요"
openclaw message send --channel whatsapp --target +821012345678 --message "테스트"
```

## 진단 및 로그

### `openclaw doctor`

시스템 상태를 진단합니다.

```bash
openclaw doctor
```

확인 항목:

- Gateway 상태
- 채널 연결
- 설정 문제
- 보안 경고

### `openclaw logs`

로그를 확인합니다.

```bash
# 최근 로그 보기
openclaw logs

# 실시간 로그 보기
openclaw logs --follow

# 특정 서브시스템 필터
openclaw logs --filter telegram
```

## 업데이트

### `openclaw update`

OpenClaw를 업데이트합니다.

```bash
# 최신 stable로 업데이트
openclaw update

# 특정 채널로 업데이트
openclaw update --channel <stable|beta|dev>

# 버전 확인
openclaw version
```

## 설정 관리

### `openclaw config`

설정 조회 및 편집.

```bash
# 설정 보기
openclaw config show

# 설정 편집 (에디터 열기)
openclaw config edit

# 특정 키 값 보기
openclaw config get channels.telegram.enabled

# 특정 키 값 설정
openclaw config set channels.telegram.enabled true
```

## 워크스페이스

### `openclaw workspace`

워크스페이스 관리.

```bash
# 워크스페이스 경로 보기
openclaw workspace path

# 워크스페이스 열기 (파일 탐색기)
openclaw workspace open
```

## 고급 명령어

### `openclaw sandbox`

샌드박스 관리.

```bash
# 샌드박스 상태
openclaw sandbox status

# 샌드박스 정리
openclaw sandbox cleanup
```

### `openclaw cron`

크론 작업 관리.

```bash
# 크론 작업 목록
openclaw cron list

# 크론 작업 실행
openclaw cron run <id>
```

## 환경변수

CLI 동작을 환경변수로 제어할 수 있습니다:

| 변수                 | 설명                                 |
| -------------------- | ------------------------------------ |
| `OPENCLAW_CONFIG`    | 설정 파일 경로                       |
| `OPENCLAW_HOME`      | OpenClaw 홈 디렉토리                 |
| `OPENCLAW_LOG_LEVEL` | 로그 레벨 (debug, info, warn, error) |

## 글로벌 옵션

모든 명령어에 적용 가능한 옵션:

| 옵션              | 설명                |
| ----------------- | ------------------- |
| `--help`          | 도움말 표시         |
| `--version`       | 버전 표시           |
| `--config <path>` | 설정 파일 경로 지정 |
| `--verbose`       | 상세 출력           |
