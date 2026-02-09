---
summary: "send, Gateway(게이트웨이), 에이전트 응답을 위한 이미지 및 미디어 처리 규칙"
read_when:
  - 미디어 파이프라인 또는 첨부 파일을 수정할 때
title: "이미지 및 미디어 지원"
---

# Image & Media Support — 2025-12-05

WhatsApp 채널은 **Baileys Web**을 통해 실행됩니다. 이 문서는 send, Gateway(게이트웨이), 에이전트 응답에 대한 현재 미디어 처리 규칙을 정리합니다.

## 목표

- `openclaw message send --media`를 통해 선택적 캡션과 함께 미디어를 전송합니다.
- 웹 인박스의 자동 응답에 텍스트와 함께 미디어를 포함할 수 있도록 합니다.
- 유형별 제한을 합리적이고 예측 가능하게 유지합니다.

## CLI Surface

- `openclaw message send --media <path-or-url> [--message <caption>]`
  - `--media`는 선택 사항이며, 미디어 전용 전송의 경우 캡션은 비어 있을 수 있습니다.
  - `--dry-run`는 해석된 페이로드를 출력하며, `--json`는 `{ channel, to, messageId, mediaUrl, caption }`를 발생시킵니다.

## WhatsApp Web 채널 동작

- 입력: 로컬 파일 경로 **또는** HTTP(S) URL.
- 흐름: Buffer 로 로드하고 미디어 종류를 감지한 뒤 올바른 페이로드를 구성합니다.
  - **이미지:** JPEG 로 리사이즈 및 재압축(최대 변 2048px), `agents.defaults.mediaMaxMb` 목표(기본값 5 MB), 최대 6 MB로 제한됩니다.
  - **오디오/보이스/비디오:** 최대 16 MB까지 패스스루; 오디오는 보이스 노트(`ptt: true`)로 전송됩니다.
  - **문서:** 기타 모든 유형, 최대 100 MB, 가능하면 파일명을 유지합니다.
- WhatsApp GIF 스타일 재생: 모바일 클라이언트에서 인라인 루프 재생을 위해 `gifPlayback: true` (CLI: `--gif-playback`)를 설정한 MP4 를 전송합니다.
- MIME 감지는 매직 바이트를 우선하고, 그다음 헤더, 마지막으로 파일 확장자를 사용합니다.
- 캡션은 `--message` 또는 `reply.text`에서 가져오며, 빈 캡션도 허용됩니다.
- 로깅: 비상세 모드에서는 `↩️`/`✅`를 표시하고, 상세 모드에서는 크기와 소스 경로/URL 을 포함합니다.

## 자동 응답 파이프라인

- `getReplyFromConfig`는 `{ text?, mediaUrl?, mediaUrls? }`를 반환합니다.
- 미디어가 존재하는 경우, 웹 전송기는 `openclaw message send`과 동일한 파이프라인을 사용하여 로컬 경로 또는 URL 을 해석합니다.
- 여러 미디어 항목이 제공되면 순차적으로 전송됩니다.

## 인바운드 미디어를 명령으로 전달 (Pi)

- 인바운드 웹 메시지에 미디어가 포함되면 OpenClaw 는 임시 파일로 다운로드하고 템플릿 변수들을 노출합니다.
  - `{{MediaUrl}}`: 인바운드 미디어에 대한 의사 URL.
  - `{{MediaPath}}`: 명령 실행 전에 기록되는 로컬 임시 경로.
- 세션별 Docker 샌드박스가 활성화된 경우, 인바운드 미디어는 샌드박스 작업공간으로 복사되며 `MediaPath`/`MediaUrl`는 `media/inbound/<filename>`과 같은 상대 경로로 다시 작성됩니다.
- 미디어 이해( `tools.media.*` 또는 공유 `tools.media.models`로 구성된 경우)는 템플릿 적용 전에 실행되며, `Body`에 `[Image]`, `[Audio]`, `[Video]` 블록을 삽입할 수 있습니다.
  - 오디오는 `{{Transcript}}`를 설정하고, 슬래시 명령이 계속 작동하도록 명령 파싱에 전사본을 사용합니다.
  - 비디오와 이미지 설명은 명령 파싱을 위해 캡션 텍스트를 보존합니다.
- 기본적으로 첫 번째로 일치하는 이미지/오디오/비디오 첨부 파일만 처리됩니다. 여러 첨부 파일을 처리하려면 `tools.media.<cap>11. 여러 첨부 파일을 처리하기 위한 `.attachments\`.

## 제한 및 오류

**아웃바운드 전송 제한 (WhatsApp 웹 전송)**

- 이미지: 재압축 후 약 6 MB 제한.
- 오디오/보이스/비디오: 16 MB 제한; 문서: 100 MB 제한.
- 과대 크기 또는 읽을 수 없는 미디어 → 로그에 명확한 오류가 기록되며 응답은 건너뜁니다.

**미디어 이해 제한 (전사/설명)**

- 이미지 기본값: 10 MB (`tools.media.image.maxBytes`).
- 오디오 기본값: 20 MB (`tools.media.audio.maxBytes`).
- 비디오 기본값: 50 MB (`tools.media.video.maxBytes`).
- 과대 크기 미디어는 이해 단계를 건너뛰지만, 원본 본문으로 응답은 계속 진행됩니다.

## 테스트를 위한 참고 사항

- 이미지/오디오/문서 사례에 대해 전송 + 응답 흐름을 커버하십시오.
- 이미지 재압축(크기 제한)과 오디오의 보이스 노트 플래그를 검증하십시오.
- 다중 미디어 응답이 순차 전송으로 분기되는지 확인하십시오.
