---
read_when:
    - iOS 노드 또는 macOS에서 카메라 캡처 추가 또는 수정
    - 에이전트가 액세스할 수 있는 MEDIA 임시 파일 워크플로 확장
summary: '에이전트 사용을 위한 카메라 캡처(iOS 노드 + macOS 앱): 사진(jpg) 및 짧은 비디오 클립(mp4)'
title: 카메라 캡처
x-i18n:
    generated_at: "2026-02-08T16:07:33Z"
    model: gtx
    provider: google-translate
    source_hash: cd6e2edd05a6575d76475dc91fc742ca6128c88e36ff24c3a12e727f5efd9939
    source_path: nodes/camera.md
    workflow: 15
---

# 카메라 캡처(에이전트)

OpenClaw 지원 **카메라 캡처** 상담사 워크플로의 경우:

- **iOS 노드** (게이트웨이를 통해 페어링됨): 캡처 **사진** (`jpg`) 또는 **짧은 비디오 클립** (`mp4`, 선택적 오디오 포함)을 통해 `node.invoke`.
- **안드로이드 노드** (게이트웨이를 통해 페어링됨): 캡처 **사진** (`jpg`) 또는 **짧은 비디오 클립** (`mp4`, 선택적 오디오 포함)을 통해 `node.invoke`.
- **macOS 앱** (게이트웨이를 통한 노드): 캡처 **사진** (`jpg`) 또는 **짧은 비디오 클립** (`mp4`, 선택적 오디오 포함)을 통해 `node.invoke`.

모든 카메라 접근은 뒤에서 차단됩니다 **사용자 제어 설정**.

## iOS 노드

### 사용자 설정(기본값은 켜짐)

- iOS 설정 탭 → **카메라** → **카메라 허용** (`camera.enabled`)
  - 기본: **~에** (누락된 키는 활성화된 것으로 처리됩니다).
  - 꺼져 있을 때: `camera.*` 명령 반환 `CAMERA_DISABLED`.

### 명령(게이트웨이를 통해) `node.invoke`)

- `camera.list`
  - 응답 페이로드:
    - `devices`: 배열 `{ id, name, position, deviceType }`

- `camera.snap`
  - 매개변수:
    - `facing`: `front|back` (기본: `front`)
    - `maxWidth`: 숫자(선택사항, 기본값 `1600` iOS 노드에서)
    - `quality`: `0..1` (선택사항, 기본값 `0.9`)
    - `format`: 현재 `jpg`
    - `delayMs`: 숫자(선택사항, 기본값 `0`)
    - `deviceId`: 문자열(선택 사항; from `camera.list`)
  - 응답 페이로드:
    - `format: "jpg"`
    - `base64: "<...>"`
    - `width`, `height`
  - 페이로드 가드: base64 페이로드를 5MB 미만으로 유지하기 위해 사진이 다시 압축됩니다.

- `camera.clip`
  - 매개변수:
    - `facing`: `front|back` (기본: `front`)
    - `durationMs`: 숫자(기본값 `3000`, 최대값으로 고정됨 `60000`)
    - `includeAudio`: 부울(기본값 `true`)
    - `format`: 현재 `mp4`
    - `deviceId`: 문자열(선택 사항; from `camera.list`)
  - 응답 페이로드:
    - `format: "mp4"`
    - `base64: "<...>"`
    - `durationMs`
    - `hasAudio`

### 전경 요구 사항

좋다 `canvas.*`, iOS 노드는 다음만 허용합니다. `camera.*` 의 명령 **전경**. 백그라운드 호출 반환 `NODE_BACKGROUND_UNAVAILABLE`.

### CLI 도우미(임시 파일 + MEDIA)

첨부 파일을 얻는 가장 쉬운 방법은 디코딩된 미디어를 임시 파일에 쓰고 인쇄하는 CLI 도우미를 사용하는 것입니다. `MEDIA:<path>`.

예:

```bash
openclaw nodes camera snap --node <id>               # default: both front + back (2 MEDIA lines)
openclaw nodes camera snap --node <id> --facing front
openclaw nodes camera clip --node <id> --duration 3000
openclaw nodes camera clip --node <id> --no-audio
```

참고:

- `nodes camera snap` 기본값은 **둘 다** 상담원에게 두 가지 보기를 모두 제공합니다.
- 자체 래퍼를 빌드하지 않는 한 출력 파일은 임시 파일입니다(OS 임시 디렉터리에 있음).

## 안드로이드 노드

### Android 사용자 설정(기본값은 켜짐)

- Android 설정 시트 → **카메라** → **카메라 허용** (`camera.enabled`)
  - 기본: **~에** (누락된 키는 활성화된 것으로 처리됩니다).
  - 꺼져 있을 때: `camera.*` 명령 반환 `CAMERA_DISABLED`.

### 권한

- Android에는 런타임 권한이 필요합니다.
  - `CAMERA` 둘 다 `camera.snap` 그리고 `camera.clip`.
  - `RECORD_AUDIO` ~을 위한 `camera.clip` 언제 `includeAudio=true`.

권한이 누락된 경우 가능한 경우 앱에서 메시지를 표시합니다. 거부된 경우, `camera.*` 요청이 다음과 같이 실패합니다.
`*_PERMISSION_REQUIRED` 오류.

### Android 포그라운드 요구사항

좋다 `canvas.*`, Android 노드에서는 다음만 허용합니다. `camera.*` 의 명령 **전경**. 백그라운드 호출 반환 `NODE_BACKGROUND_UNAVAILABLE`.

### 페이로드 가드

base64 페이로드를 5MB 미만으로 유지하기 위해 사진이 다시 압축됩니다.

## macOS 앱

### 사용자 설정(기본값은 꺼짐)

macOS 컴패니언 앱은 체크박스를 노출합니다.

- **설정 → 일반 → 카메라 허용** (`openclaw.cameraEnabled`)
  - 기본: **끄다**
  - 꺼진 경우: 카메라 요청은 "사용자가 카메라를 비활성화했습니다"를 반환합니다.

### CLI 도우미(노드 호출)

메인을 이용하세요 `openclaw` macOS 노드에서 카메라 명령을 호출하는 CLI입니다.

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

- `openclaw nodes camera snap` 기본값은 `maxWidth=1600` 재정의되지 않는 한.
- macOS에서는 `camera.snap` 기다립니다 `delayMs` (기본값 2000ms) 준비/노출 후 캡처 전 안정화됩니다.
- base64를 5MB 미만으로 유지하기 위해 사진 페이로드가 다시 압축됩니다.

## 안전 + 실제 한계

- 카메라 및 마이크 액세스는 일반적인 OS 권한 프롬프트를 트리거합니다(Info.plist에 사용 문자열이 필요함).
- 비디오 클립은 제한되어 있습니다(현재 `<= 60s`) 과도한 노드 페이로드(base64 오버헤드 + 메시지 제한)를 방지합니다.

## macOS 화면 비디오(OS 수준)

을 위한 _화면_ 비디오(카메라 아님)의 경우 macOS 컴패니언을 사용하세요.

```bash
openclaw nodes screen record --node <id> --duration 10s --fps 15   # prints MEDIA:<path>
```

참고:

- macOS 필요 **화면 녹화** 허가 (TCC).
