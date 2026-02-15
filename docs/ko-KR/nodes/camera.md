---
summary: "Camera capture (iOS node + macOS app) for agent use: photos (jpg) and short video clips (mp4)"
read_when:
  - Adding or modifying camera capture on iOS nodes or macOS
  - Extending agent-accessible MEDIA temp-file workflows
title: "Camera Capture"
x-i18n:
  source_hash: cd6e2edd05a6575d76475dc91fc742ca6128c88e36ff24c3a12e727f5efd9939
---

# 카메라 캡쳐(에이전트)

OpenClaw는 에이전트 워크플로에 대한 **카메라 캡처**를 지원합니다.

- **iOS 노드**(게이트웨이를 통해 페어링됨): `node.invoke`를 통해 **사진**(`jpg`) 또는 **짧은 비디오 클립**(`mp4`, 선택적 오디오 포함)을 캡처합니다.
- **Android 노드**(게이트웨이를 통해 페어링됨): `node.invoke`를 통해 **사진**(`jpg`) 또는 **짧은 비디오 클립**(`mp4`, 선택적 오디오 포함)을 캡처합니다.
- **macOS 앱**(게이트웨이를 통한 노드): `node.invoke`를 통해 **사진**(`jpg`) 또는 **짧은 비디오 클립**(`mp4`, 선택적 오디오 포함)을 캡처합니다.

모든 카메라 액세스는 **사용자 제어 설정**을 통해 통제됩니다.

## iOS 노드

### 사용자 설정(기본값은 켜짐)

- iOS 설정 탭 → **카메라** → **카메라 허용** (`camera.enabled`)
  - 기본값: **on**(누락된 키는 활성화된 것으로 처리됩니다).
  - 꺼진 경우: `camera.*` 명령은 `CAMERA_DISABLED`를 반환합니다.

### 명령(게이트웨이 `node.invoke`를 통해)

- `camera.list`
  - 응답 페이로드:
    - `devices`: `{ id, name, position, deviceType }`의 배열

- `camera.snap`
  - 매개변수:
    - `facing`: `front|back` (기본값: `front`)
    - `maxWidth`: 숫자(선택 사항, iOS 노드에서는 기본값 `1600`)
    - `quality`: `0..1` (선택 사항, 기본값 `0.9`)
    - `format`: 현재 `jpg`
    - `delayMs`: 숫자(선택사항, 기본값 `0`)
    - `deviceId`: 문자열(선택 사항; `camera.list`에서)
  - 응답 페이로드:
    - `format: "jpg"`
    - `base64: "<...>"`
    - `width`, `height`
  - 페이로드 가드: base64 페이로드를 5MB 미만으로 유지하기 위해 사진이 다시 압축됩니다.

- `camera.clip`
  - 매개변수:
    - `facing`: `front|back` (기본값: `front`)
    - `durationMs`: 숫자(기본값 `3000`, 최대 `60000`로 고정됨)
    - `includeAudio`: 부울(기본값 `true`)
    - `format`: 현재 `mp4`
    - `deviceId`: 문자열(선택 사항; `camera.list`에서)
  - 응답 페이로드:
    - `format: "mp4"`
    - `base64: "<...>"`
    - `durationMs`
    - `hasAudio`

### 전경 요구 사항

`canvas.*`와 마찬가지로 iOS 노드는 **포그라운드**에서 `camera.*` 명령만 허용합니다. 백그라운드 호출은 `NODE_BACKGROUND_UNAVAILABLE`를 반환합니다.

### CLI 도우미(임시 파일 + 미디어)

첨부 파일을 얻는 가장 쉬운 방법은 디코딩된 미디어를 임시 파일에 쓰고 `MEDIA:<path>`를 인쇄하는 CLI 도우미를 사용합니다.

예:

```bash
openclaw nodes camera snap --node <id>               # default: both front + back (2 MEDIA lines)
openclaw nodes camera snap --node <id> --facing front
openclaw nodes camera clip --node <id> --duration 3000
openclaw nodes camera clip --node <id> --no-audio
```

참고:

- `nodes camera snap`는 에이전트에게 두 가지 뷰를 모두 제공하기 위해 기본적으로 **양쪽** 방향으로 설정됩니다.
- 출력 파일은 자체 래퍼를 빌드하지 않는 한 임시 파일입니다(OS 임시 디렉터리에 있음).

## 안드로이드 노드

### Android 사용자 설정(기본값은 켜져 있음)

- Android 설정 시트 → **카메라** → **카메라 허용** (`camera.enabled`)
  - 기본값: **on**(누락된 키는 활성화된 것으로 처리됩니다).
  - 꺼진 경우: `camera.*` 명령은 `CAMERA_DISABLED`를 반환합니다.

### 권한

- Android에는 런타임 권한이 필요합니다.
  - `CAMERA`는 `camera.snap`와 `camera.clip` 모두에 대해 적용됩니다.
  - `includeAudio=true`일 때 `camera.clip`에 대해 `RECORD_AUDIO`.

권한이 누락된 경우 가능한 경우 앱에서 메시지를 표시합니다. 거부되면 `camera.*` 요청이 실패합니다.
`*_PERMISSION_REQUIRED` 오류가 발생했습니다.

### Android 포그라운드 요구사항

`canvas.*`와 마찬가지로 Android 노드는 **포그라운드**에서 `camera.*` 명령만 허용합니다. 백그라운드 호출은 `NODE_BACKGROUND_UNAVAILABLE`를 반환합니다.

### 페이로드 가드

base64 페이로드를 5MB 미만으로 유지하기 위해 사진이 다시 압축됩니다.

## macOS 앱

### 사용자 설정(기본값은 꺼짐)

macOS 컴패니언 앱은 체크박스를 노출합니다.

- **설정 → 일반 → 카메라 허용** (`openclaw.cameraEnabled`)
  - 기본값: **해제**
  - 꺼진 경우: 카메라 요청이 "사용자에 의해 카메라 비활성화됨"을 반환합니다.

### CLI 도우미(노드 호출)

기본 `openclaw` CLI를 사용하여 macOS 노드에서 카메라 명령을 호출합니다.

예:

```bash
openclaw nodes camera list --node <id>            # list camera ids
openclaw nodes camera snap --node <id>            # prints MEDIA:<path>
openclaw nodes camera snap --node <id> --max-width 1280
openclaw nodes camera snap --node <id> --delay-ms 2000
openclaw nodes camera snap --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --duration 10s          # prints MEDIA:<path>
openclaw nodes camera clip --node <id> --duration-ms 3000      # prints MEDIA:<path> (legacy flag)
openclaw nodes camera clip --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --no-audio
```

참고:

- `openclaw nodes camera snap`는 재정의되지 않는 한 기본값은 `maxWidth=1600`입니다.
- macOS에서 `camera.snap`는 워밍업/노출이 안정화된 후 캡처하기 전에 `delayMs`(기본값 2000ms)을 기다립니다.
- base64를 5MB 미만으로 유지하기 위해 사진 페이로드가 다시 압축됩니다.

## 안전 + 실제 한계

- 카메라 및 마이크 액세스는 일반적인 OS 권한 프롬프트를 트리거합니다(Info.plist에 사용 문자열이 필요함).
- 과도한 노드 페이로드(base64 오버헤드 + 메시지 제한)를 방지하기 위해 비디오 클립에 제한이 적용됩니다(현재 `<= 60s`).

## macOS 화면 비디오(OS 수준)

_screen_ 비디오(카메라 아님)의 경우 macOS 컴패니언을 사용하세요.

```bash
openclaw nodes screen record --node <id> --duration 10s --fps 15   # prints MEDIA:<path>
```

참고:

- macOS **화면 녹화** 권한(TCC)이 필요합니다.
