---
summary: "전송, 게이트웨이 및 에이전트 응답을 위한 이미지 및 미디어 처리 규칙"
read_when:
  - 미디어 파이프라인 또는 첨부 파일 수정
title: "이미지 및 미디어 지원"
---

# 이미지 및 미디어 지원 — 2025-12-05

WhatsApp 채널은 **Baileys Web**을 통해 운영됩니다. 이 문서는 전송, 게이트웨이 및 에이전트 응답을 위한 현재 미디어 처리 규칙을 설명합니다.

## 목표

- `openclaw message send --media`를 통해 선택적으로 캡션과 함께 미디어 전송.
- 웹 인박스에서 자동 응답을 통해 텍스트와 함께 미디어 포함 허용.
- 유형별 제한을 합리적이고 예측 가능하게 유지.

## CLI 인터페이스

- `openclaw message send --media <path-or-url> [--message <caption>]`
  - `--media`는 선택 사항이며, 미디어만 전송 시 캡션은 비워둘 수 있습니다.
  - `--dry-run`은 해결된 페이로드를 출력하며, `--json`은 `{ channel, to, messageId, mediaUrl, caption }`을 출력합니다.

## WhatsApp Web 채널 동작

- 입력: 로컬 파일 경로 **또는** HTTP(S) URL.
- 흐름: Buffer에 로드, 미디어 종류 감지, 올바른 페이로드 작성:
  - **이미지:** JPEG로 리사이즈 및 재압축(최대 한 변 2048px)하여 `agents.defaults.mediaMaxMb` (기본 5 MB)로 목표, 최대 6 MB로 제한.
  - **오디오/음성/비디오:** 최대 16 MB로 패스스루; 오디오는 음성 노트로 전송됨 (`ptt: true`).
  - **문서:** 가능한 경우 파일 이름을 유지하며, 최대 100 MB.
- WhatsApp GIF 스타일 재생: 모바일 클라이언트가 inline으로 반복하도록 `gifPlayback: true` (CLI: `--gif-playback`)와 함께 MP4를 전송.
- MIME 감지는 매직 바이트, 헤더, 파일 확장자 순으로 선호.
- 캡션은 `--message` 또는 `reply.text`에서 가져옴; 빈 캡션도 허용.
- 로깅: 비-verbose는 `↩️`/`✅`를 표시하고, verbose는 크기 및 소스 경로/URL을 포함.

## 자동응답 파이프라인

- `getReplyFromConfig`는 `{ text?, mediaUrl?, mediaUrls? }`를 반환.
- 미디어가 있는 경우 웹 송신자가 로컬 경로나 URL을 `openclaw message send`와 동일한 파이프라인을 사용하여 해결.
- 여러 미디어 항목 제공 시 순차적으로 전송됨.

## 명령어로의 수신 미디어 (Pi)

- 수신 웹 메시지에 미디어가 포함된 경우, OpenClaw가 임시 파일에 다운로드하고 템플릿 변수 제공:
  - `{{MediaUrl}}` 수신 미디어의 의사 URL.
  - `{{MediaPath}}` 명령어 실행 전에 기록된 로컬 임시 경로.
- 세션별 Docker 샌드박스가 활성화된 경우, 수신 미디어는 샌드박스 작업 공간에 복사되고 `MediaPath`/`MediaUrl`은 `media/inbound/<filename>`와 같은 상대 경로로 수정됨.
- 미디어 이해(구성된 경우 `tools.media.*` 또는 공유 `tools.media.models` 통해)는 템플릿 전에 실행되며 `[Image]`, `[Audio]`, `[Video]` 블록을 `Body`에 삽입할 수 있음.
  - 오디오는 `{{Transcript}}`를 설정하고 명령어 구문 분석에 트랜스크립트를 사용하여 슬래시 명령어도 여전히 작동.
  - 비디오 및 이미지 설명은 명령어 구문 분석을 위한 캡션 텍스트를 유지.
- 기본적으로 첫 번째 일치하는 이미지/오디오/비디오 첨부 파일만 처리되며, `tools.media.<cap>.attachments`를 설정하여 여러 첨부 파일을 처리 가능.

## 한계 및 오류

**발신 전송 제한 (WhatsApp 웹 전송)**

- 이미지: 재압축 후 ~6 MB 한도.
- 오디오/음성/비디오: 16 MB 한도; 문서: 100 MB 한도.
- 크기가 너무 크거나 읽을 수 없는 미디어 → 로그에 명확한 오류가 기록되고 응답이 생략됨.

**미디어 이해 제한 (전사/설명)**

- 이미지 기본: 10 MB (`tools.media.image.maxBytes`).
- 오디오 기본: 20 MB (`tools.media.audio.maxBytes`).
- 비디오 기본: 50 MB (`tools.media.video.maxBytes`).
- 크기가 너무 큰 미디어는 이해를 생략하지만, 여전히 본래의 본문으로 응답 전송.

## 테스트 참고 사항

- 이미지/오디오/문서 사례에 대한 전송 + 응답 흐름 다루기.
- 이미지(크기 제한) 재압축 및 오디오의 음성 노트 플래그 유효성 검사.
- 다중 미디어 응답이 순차적 송신으로 확산되는지 확인.
