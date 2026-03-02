---
summary: "카메라 캡처(iOS 노드 + macOS 앱) 에이전트 사용: 사진(jpg) 및 짧은 비디오 클립(mp4)"
read_when:
  - iOS 노드 또는 macOS에서 카메라 캡처를 추가하거나 수정할 때
  - 에이전트 액세스 가능 MEDIA temp-파일 워크플로우를 확장할 때
title: "카메라 캡처"
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: nodes/camera.md
workflow: 15
---

# 카메라 캡처(에이전트)

OpenClaw는 **에이전트 워크플로우**를 위한 **카메라 캡처**를 지원합니다:

- **iOS 노드**(Gateway를 통해 쌍을 이룸): `node.invoke`를 통해 **사진**(`jpg`) 또는 **짧은 비디오 클립**(`mp4`, 선택적 오디오) 캡처.
- **Android 노드**(Gateway를 통해 쌍을 이룸): `node.invoke`를 통해 **사진**(`jpg`) 또는 **짧은 비디오 클립**(`mp4`, 선택적 오디오) 캡처.
- **macOS 앱**(Gateway를 통한 노드): `node.invoke`를 통해 **사진**(`jpg`) 또는 **짧은 비디오 클립**(`mp4`, 선택적 오디오) 캡처.

모든 카메라 액세스는 **사용자 제어 설정** 뒤에 제어됩니다.

## iOS 노드

### 사용자 설정(기본값 켜짐)

- iOS Settings 탭 → **Camera** → **Allow Camera**(`camera.enabled`)
  - 기본값: **켜짐**(누락 키는 활성화됨으로 처리).
  - 꺼져 있으면: `camera.*` 커맨드는 `CAMERA_DISABLED`를 반환합니다.

### 커맨드(Gateway `node.invoke`를 통해)

- `camera.list`
  - 응답 페이로드:
    - `devices`: `{ id, name, position, deviceType }`의 배열

- `camera.snap`
  - 파라미터:
    - `facing`: `front|back`(기본값: `front`)
    - `maxWidth`: 숫자(선택 사항; 기본값 iOS 노드에서 `1600`)
    - `quality`: `0..1`(선택 사항; 기본값 `0.9`)
    - `format`: 현재 `jpg`
    - `delayMs`: 숫자(선택 사항; 기본값 `0`)
    - `deviceId`: 문자열(선택 사항; `camera.list`에서)
  - 응답 페이로드:
    - `format: "jpg"`
    - `base64: "<...>"`
    - `width`, `height`
  - 페이로드 가드: 사진은 base64 페이로드를 5MB 아래로 유지하도록 재압축됩니다.

- `camera.clip`
  - 파라미터:
    - `facing`: `front|back`(기본값: `front`)
    - `durationMs`: 숫자(기본값 `3000`, 최대 `60000`으로 제한)
    - `includeAudio`: boolean(기본값 `true`)
    - `format`: 현재 `mp4`
    - `deviceId`: 문자열(선택 사항; `camera.list`에서)
  - 응답 페이로드:
    - `format: "mp4"`
    - `base64: "<...>"`
    - `durationMs`
    - `hasAudio`

### 포그라운드 요구 사항

`canvas.*`와 같이 iOS 노드는 **포그라운드**에서만 `camera.*` 커맨드를 허용합니다. 백그라운드 호출은 `NODE_BACKGROUND_UNAVAILABLE`을 반환합니다.

### CLI 헬퍼(temp 파일 + MEDIA)

첨부를 얻는 가장 쉬운 방법은 디코딩된 미디어를 temp 파일에 쓰고 `MEDIA:<path>`를 인쇄하는 CLI 헬퍼입니다.

예:

```bash
openclaw nodes camera snap --node <id>               # 기본값: 앞면과 뒷면(2 MEDIA 줄)
openclaw nodes camera snap --node <id> --facing front
openclaw nodes camera clip --node <id> --duration 3000
openclaw nodes camera clip --node <id> --no-audio
```

참고:

- `nodes camera snap`은 기본값으로 **둘 다** 면을 설정하여 에이전트 둘 다 뷰를 제공합니다.
- 출력 파일은 임시입니다(OS temp 디렉터리 내) 자신의 래퍼를 만들지 않는 한.

## macOS 앱

### 사용자 설정(기본값 꺼짐)

macOS 컴패니언 앱은 체크박스를 노출합니다:

- **Settings → General → Allow Camera**(`openclaw.cameraEnabled`)
  - 기본값: **꺼짐**
  - 꺼져 있으면: 카메라 요청은 "Camera disabled by user"를 반환합니다.

### CLI 헬퍼(노드 호출)

주요 `openclaw` CLI를 사용하여 macOS 노드에서 카메라 커맨드를 호출합니다.

예:

```bash
openclaw nodes camera list --node <id>            # 카메라 ID 나열
openclaw nodes camera snap --node <id>            # prints MEDIA:<path>
openclaw nodes camera snap --node <id> --max-width 1280
openclaw nodes camera snap --node <id> --delay-ms 2000
openclaw nodes camera snap --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --duration 10s          # prints MEDIA:<path>
openclaw nodes camera clip --node <id> --duration-ms 3000      # prints MEDIA:<path>(레거시 플래그)
openclaw nodes camera clip --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --no-audio
```

참고:

- `openclaw nodes camera snap`은 오버라이드되지 않으면 기본값 `maxWidth=1600`.
- macOS에서 `camera.snap`은 워밍업/노출 정착 후 캡처하기 전에 `delayMs`(기본값 2000ms)를 기다립니다.
- 사진 페이로드는 base64를 5MB 아래로 유지하도록 재압축됩니다.

## 안전 + 실제 한계

- 카메라 및 마이크 액세스는 일반적인 OS 권한 프롬프트를 트리거합니다(및 Info.plist의 사용 문자열이 필요).
- 비디오 클립은 제한됩니다(현재 `<= 60s`) 과도한 노드 페이로드를 피하기 위해(base64 오버헤드 + 메시지 한계).

## macOS 화면 비디오(OS 레벨)

_화면_ 비디오(카메라 아님)의 경우 macOS 컴패니언을 사용합니다:

```bash
openclaw nodes screen record --node <id> --duration 10s --fps 15   # prints MEDIA:<path>
```

참고:

- macOS **Screen Recording** 권한(TCC)이 필요합니다.
