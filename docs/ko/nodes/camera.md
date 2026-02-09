---
summary: "에이전트 사용을 위한 카메라 캡처(iOS 노드 + macOS 앱): 사진(jpg) 및 짧은 동영상 클립(mp4)"
read_when:
  - iOS 노드 또는 macOS에서 카메라 캡처를 추가하거나 수정할 때
  - 에이전트가 접근 가능한 MEDIA 임시 파일 워크플로를 확장할 때
title: "카메라 캡처"
---

# 카메라 캡처(에이전트)

OpenClaw 는 에이전트 워크플로를 위한 **카메라 캡처**를 지원합니다:

- **iOS 노드**(Gateway(게이트웨이) 를 통해 페어링): `node.invoke` 를 통해 **사진**(`jpg`) 또는 **짧은 동영상 클립**(`mp4`, 선택적 오디오 포함)을 캡처합니다.
- **Android 노드**(Gateway(게이트웨이) 를 통해 페어링): `node.invoke` 를 통해 **사진**(`jpg`) 또는 **짧은 동영상 클립**(`mp4`, 선택적 오디오 포함)을 캡처합니다.
- **macOS 앱**(Gateway(게이트웨이) 를 통한 노드): `node.invoke` 을 통해 **사진**(`jpg`) 또는 **짧은 동영상 클립**(`mp4`, 선택적 오디오 포함)을 캡처합니다.

모든 카메라 접근은 **사용자 제어 설정** 뒤에서 제한됩니다.

## iOS 노드

### 사용자 설정(기본값 켜짐)

- iOS 설정 탭 → **Camera** → **Allow Camera** (`camera.enabled`)
  - 기본값: **켜짐**(키가 없으면 활성화된 것으로 처리).
  - 꺼짐일 때: `camera.*` 명령은 `CAMERA_DISABLED` 를 반환합니다.

### 명령(Gateway(게이트웨이) 경유 `node.invoke`)

- `camera.list`
  - 응답 페이로드:
    - `devices`: `{ id, name, position, deviceType }` 의 배열

- `camera.snap`
  - 파라미터:
    - `facing`: `front|back` (기본값: `front`)
    - `maxWidth`: number (선택 사항; iOS 노드에서 기본값 `1600`)
    - `quality`: `0..1` (선택 사항; 기본값 `0.9`)
    - `format`: 현재 `jpg`
    - `delayMs`: number (선택 사항; 기본값 `0`)
    - `deviceId`: string (선택 사항; `camera.list` 에서 가져옴)
  - 응답 페이로드:
    - `format: "jpg"`
    - `base64: "<...>"`
    - `width`, `height`
  - 페이로드 가드: 사진은 base64 페이로드를 5 MB 미만으로 유지하기 위해 재압축됩니다.

- `camera.clip`
  - 파라미터:
    - `facing`: `front|back` (기본값: `front`)
    - `durationMs`: number (기본값 `3000`, 최대 `60000` 로 제한)
    - `includeAudio`: boolean (기본값 `true`)
    - `format`: 현재 `mp4`
    - `deviceId`: string (선택 사항; `camera.list` 에서 가져옴)
  - 응답 페이로드:
    - `format: "mp4"`
    - `base64: "<...>"`
    - `durationMs`
    - `hasAudio`

### 포그라운드 요구 사항

`canvas.*` 와 마찬가지로, iOS 노드는 **포그라운드**에서만 `camera.*` 명령을 허용합니다. 백그라운드 호출은 `NODE_BACKGROUND_UNAVAILABLE` 를 반환합니다.

### CLI 헬퍼(임시 파일 + MEDIA)

첨부 파일을 얻는 가장 쉬운 방법은 CLI 헬퍼를 사용하는 것으로, 디코딩된 미디어를 임시 파일에 기록하고 `MEDIA:<path>` 를 출력합니다.

예시:

```bash
openclaw nodes camera snap --node <id>               # default: both front + back (2 MEDIA lines)
openclaw nodes camera snap --node <id> --facing front
openclaw nodes camera clip --node <id> --duration 3000
openclaw nodes camera clip --node <id> --no-audio
```

참고:

- `nodes camera snap` 는 에이전트에게 두 가지 뷰를 모두 제공하기 위해 기본적으로 **양쪽** 페이싱을 사용합니다.
- 출력 파일은 자체 래퍼를 빌드하지 않는 한 OS 임시 디렉토리에 있는 임시 파일입니다.

## Android 노드

### Android 사용자 설정(기본값 켜짐)

- Android 설정 시트 → **Camera** → **Allow Camera** (`camera.enabled`)
  - 기본값: **켜짐**(키가 없으면 활성화된 것으로 처리).
  - 꺼짐일 때: `camera.*` 명령은 `CAMERA_DISABLED` 를 반환합니다.

### 권한

- Android 는 런타임 권한이 필요합니다:
  - `CAMERA`: `camera.snap` 및 `camera.clip` 모두에 필요.
  - `RECORD_AUDIO`: `includeAudio=true` 일 때 `camera.clip` 에 필요.

권한이 없는 경우 앱은 가능한 경우 프롬프트를 표시합니다. 거부되면 `camera.*` 요청은
`*_PERMISSION_REQUIRED` 오류로 실패합니다.

### Android 포그라운드 요구 사항

`canvas.*` 와 마찬가지로, Android 노드는 **포그라운드**에서만 `camera.*` 명령을 허용합니다. 백그라운드 호출은 `NODE_BACKGROUND_UNAVAILABLE` 를 반환합니다.

### 10. 페이로드 가드

사진은 base64 페이로드를 5 MB 미만으로 유지하기 위해 재압축됩니다.

## macOS 앱

### 사용자 설정(기본값 꺼짐)

macOS 컴패니언 앱은 체크박스를 제공합니다:

- **Settings → General → Allow Camera** (`openclaw.cameraEnabled`)
  - 기본값: **꺼짐**
  - 꺼짐일 때: 카메라 요청은 “Camera disabled by user” 를 반환합니다.

### CLI 헬퍼(노드 호출)

주요 `openclaw` CLI 를 사용하여 macOS 노드에서 카메라 명령을 호출합니다.

예시:

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

- `openclaw nodes camera snap` 는 재정의되지 않는 한 기본값이 `maxWidth=1600` 입니다.
- macOS 에서 `camera.snap` 는 워밍업/노출 안정화 이후 캡처 전에 `delayMs` (기본값 2000ms) 를 대기합니다.
- 사진 페이로드는 base64 를 5 MB 미만으로 유지하기 위해 재압축됩니다.

## 안전성 + 실용적 한계

- 카메라 및 마이크 접근은 일반적인 OS 권한 프롬프트를 트리거하며 Info.plist 에 사용 문자열이 필요합니다.
- 동영상 클립은 과도한 노드 페이로드(base64 오버헤드 + 메시지 제한)를 피하기 위해(현재 `<= 60s`)로 제한됩니다.

## macOS 화면 동영상(OS 수준)

_화면_ 동영상(카메라 아님)의 경우 macOS 컴패니언을 사용하십시오:

```bash
openclaw nodes screen record --node <id> --duration 10s --fps 15   # prints MEDIA:<path>
```

참고:

- macOS **Screen Recording** 권한(TCC)이 필요합니다.
