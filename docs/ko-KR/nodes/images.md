---
summary: "Image and media handling rules for send, gateway, and agent replies"
read_when:
  - Modifying media pipeline or attachments
title: "Image and Media Support"
x-i18n:
  source_hash: 971aed398ea01078efbad7a8a4bca17f2a975222a2c4db557565e4334c9450e0
---

# 이미지 및 미디어 지원 — 2025-12-05

WhatsApp 채널은 **Baileys Web**을 통해 운영됩니다. 이 문서는 전송, 게이트웨이 및 상담원 응답에 대한 현재 미디어 처리 규칙을 캡처합니다.

## 목표

- `openclaw message send --media`을 통해 선택적 캡션이 포함된 미디어를 보냅니다.
- 텍스트와 함께 미디어를 포함하도록 웹 받은 편지함의 자동 회신을 허용합니다.
- 유형별 제한을 건전하고 예측 가능하게 유지하세요.

## CLI 표면

- `openclaw message send --media <path-or-url> [--message <caption>]`
  - `--media` 선택사항; 미디어 전용 전송의 경우 캡션이 비어 있을 수 있습니다.
  - `--dry-run` 해결된 페이로드를 인쇄합니다. `--json`는 `{ channel, to, messageId, mediaUrl, caption }`를 방출합니다.

## WhatsApp 웹 채널 동작

- 입력: 로컬 파일 경로 **또는** HTTP(S) URL.
- 흐름: 버퍼에 로드하고, 미디어 종류를 감지하고, 올바른 페이로드를 빌드합니다.
  - **이미지:** `agents.defaults.mediaMaxMb`(기본값 5MB)을 대상으로 JPEG(최대 측면 2048px)로 크기를 조정하고 다시 압축하며 최대 6MB로 제한됩니다.
  - **오디오/음성/비디오:** 최대 16MB 패스스루; 오디오는 음성 메모(`ptt: true`)로 전송됩니다.
  - **문서:** 최대 100MB까지 가능하며 가능한 경우 파일 이름이 보존됩니다.
- WhatsApp GIF 스타일 재생: 모바일 클라이언트가 인라인으로 루프할 수 있도록 `gifPlayback: true`(CLI: `--gif-playback`)를 사용하여 MP4를 보냅니다.
- MIME 감지에서는 매직 바이트, 헤더, 파일 확장자를 선호합니다.
- 캡션은 `--message` 또는 `reply.text`에서 제공됩니다. 빈 캡션이 허용됩니다.
- 로깅: 장황하지 않은 쇼 `↩️`/`✅`; verbose에는 크기와 소스 경로/URL이 포함됩니다.

## 자동 응답 파이프라인

- `getReplyFromConfig`는 `{ text?, mediaUrl?, mediaUrls? }`를 반환합니다.
- 미디어가 있는 경우 웹 송신자는 `openclaw message send`와 동일한 파이프라인을 사용하여 로컬 경로 또는 URL을 확인합니다.
- 여러 미디어 항목이 제공되면 순차적으로 전송됩니다.

## 명령에 대한 인바운드 미디어(Pi)

- 인바운드 웹 메시지에 미디어가 포함된 경우 OpenClaw는 임시 파일로 다운로드하고 템플릿 변수를 노출합니다.
  - `{{MediaUrl}}` 인바운드 미디어에 대한 의사 URL입니다.
  - `{{MediaPath}}` 명령을 실행하기 전에 작성된 로컬 임시 경로입니다.
- 세션별 Docker 샌드박스가 활성화되면 인바운드 미디어가 샌드박스 작업공간에 복사되고 `MediaPath`/`MediaUrl`가 `media/inbound/<filename>`와 같은 상대 경로에 다시 작성됩니다.
- 미디어 이해(`tools.media.*` 또는 공유 `tools.media.models`를 통해 구성된 경우)는 템플릿 작성 전에 실행되며 `[Image]`, `[Audio]` 및 `[Video]` 블록을 `Body`에 삽입할 수 있습니다.
  - 오디오는 `{{Transcript}}`를 설정하고 명령 구문 분석을 위해 기록을 사용하므로 슬래시 명령이 계속 작동합니다.
  - 비디오 및 이미지 설명은 명령 구문 분석을 위해 캡션 텍스트를 유지합니다.
- 기본적으로 일치하는 첫 번째 이미지/오디오/비디오 첨부 파일만 처리됩니다. 여러 첨부 파일을 처리하려면 `tools.media.<cap>.attachments`를 설정하세요.

## 제한 및 오류

**아웃바운드 전송 한도(WhatsApp 웹 전송)**

- 이미지: 재압축 후 최대 6MB까지.
- 오디오/음성/비디오: 최대 16MB; 문서: 100MB 제한.
- 크기가 너무 크거나 읽을 수 없는 미디어 → 로그에서 오류를 지우고 응답을 건너뜁니다.

**미디어 이해 한도(녹화/설명)**

- 이미지 기본값: 10MB (`tools.media.image.maxBytes`).
- 오디오 기본값: 20MB (`tools.media.audio.maxBytes`).
- 비디오 기본값: 50MB (`tools.media.video.maxBytes`).
- 특대형 미디어는 이해를 건너뛰지만, 답변은 여전히 ​​원본 본문으로 진행됩니다.

## 테스트 참고사항

- 이미지/오디오/문서 케이스의 표지 전송 + 답장 흐름입니다.
- 이미지(크기 제한)에 대한 재압축과 오디오에 대한 음성 메모 플래그를 확인합니다.
- 멀티미디어 응답이 순차 전송으로 팬아웃되는지 확인합니다.
