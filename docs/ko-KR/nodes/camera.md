---
summary: "Camera capture (iOS node + macOS app) for agent use: photos (jpg) and short video clips (mp4)"
read_when:
  - iOS 노드 또는 macOS에서 카메라 캡처 추가 또는 수정
  - 에이전트가 접근 가능한 MEDIA 임시 파일 워크플로우 확장
title: "카메라 캡처"
---

# 카메라 캡처 (에이전트)

OpenClaw는 에이전트 워크플로우를 위한 **카메라 캡처**를 지원합니다:

- **iOS 노드** (게이트웨이를 통해 페어링됨): `node.invoke`를 통해 **사진** (`jpg`) 또는 **짧은 비디오 클립** (`mp4`, 선택적 오디오 포함)을 캡처합니다.
- **Android 노드** (게이트웨이를 통해 페어링됨): `node.invoke`를 통해 **사진** (`jpg`) 또는 **짧은 비디오 클립** (`mp4`, 선택적 오디오 포함)을 캡처합니다.
- **macOS 앱** (게이트웨이를 통해 노드): `node.invoke`를 통해 **사진** (`jpg`) 또는 **짧은 비디오 클립** (`mp4`, 선택적 오디오 포함)을 캡처합니다.

모든 카메라 액세스는 **사용자 제어 설정** 뒤에 위치합니다.

## iOS 노드

### 사용자 설정 (기본값: 활성화)

- iOS 설정 탭 → **카메라** → **카메라 허용** (`camera.enabled`)
  - 기본값: **활성화** (키가 없을 경우 활성화로 간주).
  - 비활성화 시: `camera.*` 명령어가 `CAMERA_DISABLED`를 반환합니다.

### 명령어 (게이트웨이 `node.invoke` 통해)

- `camera.list`
  - 응답 페이로드:
    - `devices`: `{ id, name, position, deviceType }`의 배열

- `camera.snap`
  - 파라미터:
    - `facing`: `front|back` (기본값: `front`)
    - `maxWidth`: 숫자 (선택사항; iOS 노드에서 기본값 `1600`)
    - `quality`: `0..1` (선택사항; 기본값 `0.9`)
    - `format`: 현재 `jpg`
    - `delayMs`: 숫자 (선택사항; 기본값 `0`)
    - `deviceId`: 문자열 (선택사항; `camera.list`에서 가져옴)
  - 응답 페이로드:
    - `format: "jpg"`
    - `base64: "<...>"`
    - `width`, `height`
  - 페이로드 보호: 사진은 base64 페이로드를 5 MB 이하로 유지하기 위해 재압축됩니다.

- `camera.clip`
  - 파라미터:
    - `facing`: `front|back` (기본값: `front`)
    - `durationMs`: 숫자 (기본값 `3000`, 최대 `60000`으로 고정)
    - `includeAudio`: 불리언 (기본값 `true`)
    - `format`: 현재 `mp4`
    - `deviceId`: 문자열 (선택사항; `camera.list`에서 가져옴)
  - 응답 페이로드:
    - `format: "mp4"`
    - `base64: "<...>"`
    - `durationMs`
    - `hasAudio`

### 포어그라운드 요구사항

`canvas.*`와 유사하게, iOS 노드는 **포어그라운드**에서만 `camera.*` 명령어를 허용합니다. 백그라운드 호출은 `NODE_BACKGROUND_UNAVAILABLE`를 반환합니다.

### CLI 도우미 (임시 파일 + MEDIA)

가장 쉬운 첨부 파일 가져오는 방법은 CLI 도우미를 통해 디코딩된 미디어를 임시 파일에 쓰고 `MEDIA:<path>`를 출력하는 것입니다.

예제:

```bash
openclaw nodes camera snap --node <id>               # 기본값: 전면 + 후면 (2개의 MEDIA 줄)
openclaw nodes camera snap --node <id> --facing front
openclaw nodes camera clip --node <id> --duration 3000
openclaw nodes camera clip --node <id> --no-audio
```

참고:

- `nodes camera snap`은 에이전트에게 두 보기 모두를 제공하기 위해 **둘 다** 방향을 기본값으로 합니다.
- 출력 파일은 임시 (OS 임시 디렉토리에 저장)이며, 직접 래퍼를 작성하지 않는 한 임시 파일로 남습니다.

## Android 노드

### Android 사용자 설정 (기본값: 활성화)

- Android 설정 시트 → **카메라** → **카메라 허용** (`camera.enabled`)
  - 기본값: **활성화** (키가 없을 경우 활성화로 간주).
  - 비활성화 시: `camera.*` 명령어가 `CAMERA_DISABLED`를 반환합니다.

### 권한

- Android는 런타임 권한을 필요로 합니다:
  - `CAMERA`는 `camera.snap`과 `camera.clip` 모두에 필요합니다.
  - `RECORD_AUDIO`는 `camera.clip`에서 `includeAudio=true`일 경우 필요합니다.

권한이 누락된 경우, 가능할 때 앱에서 프롬프트를 표시합니다. 거부된 경우, `camera.*` 요청은 `*_PERMISSION_REQUIRED` 오류와 함께 실패합니다.

### Android 포어그라운드 요구사항

`canvas.*`와 유사하게, Android 노드는 **포어그라운드**에서만 `camera.*` 명령어를 허용합니다. 백그라운드 호출은 `NODE_BACKGROUND_UNAVAILABLE`를 반환합니다.

### 페이로드 보호

사진은 base64 페이로드를 5 MB 이하로 유지하기 위해 재압축됩니다.

## macOS 앱

### 사용자 설정 (기본값: 비활성화)

macOS 동반 앱은 체크박스를 제공합니다:

- **설정 → 일반 → 카메라 허용** (`openclaw.cameraEnabled`)
  - 기본값: **비활성화**
  - 비활성화 시: 카메라 요청은 "사용자에 의해 카메라 비활성화됨"을 반환합니다.

### CLI 도우미 (노드 호출)

주요 `openclaw` CLI를 사용하여 macOS 노드에서 카메라 명령어를 실행합니다.

예제:

```bash
openclaw nodes camera list --node <id>            # 카메라 id 목록
openclaw nodes camera snap --node <id>            # MEDIA:<path> 출력
openclaw nodes camera snap --node <id> --max-width 1280
openclaw nodes camera snap --node <id> --delay-ms 2000
openclaw nodes camera snap --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --duration 10s          # MEDIA:<path> 출력
openclaw nodes camera clip --node <id> --duration-ms 3000      # MEDIA:<path> 출력 (레거시 플래그)
openclaw nodes camera clip --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --no-audio
```

참고:

- `openclaw nodes camera snap`은 `maxWidth=1600`을 기본값으로 사용합니다.
- macOS에서는 `camera.snap`이 캡처하기 전에 워밍업/노출 안정화 후 `delayMs`(기본값 2000ms)를 기다립니다.
- 사진 페이로드는 base64를 5 MB 이하로 유지하기 위해 재압축됩니다.

## 안전성 + 실용적 한계

- 카메라 및 마이크 접근은 일반적인 OS 권한 프롬프트를 트리거하며, Info.plist에 사용 문자열이 필요합니다.
- 비디오 클립은 너무 큰 노드 페이로드를 피하기 위해 (현재 `<= 60s`) 제한됩니다 (base64 오버헤드 + 메시지 한계).

## macOS 화면 비디오 (OS 수준)

_화면_ 비디오(카메라 아님)의 경우, macOS 동반 앱을 사용합니다:

```bash
openclaw nodes screen record --node <id> --duration 10s --fps 15   # MEDIA:<path> 출력
```

참고:

- macOS **화면 녹화** 권한 (TCC)이 필요합니다.