---
summary: "send, gateway 및 에이전트 회신을 위한 이미지 및 미디어 처리 규칙"
read_when:
  - 미디어 파이프라인 또는 첨부를 수정할 때
title: "이미지 및 미디어 지원"
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: nodes/images.md
workflow: 15
---

# 이미지 & 미디어 지원 — 2025-12-05

WhatsApp 채널은 **Baileys Web**를 통해 실행됩니다. 이 문서는 send, gateway 및 에이전트 회신을 위한 현재 미디어 처리 규칙을 캡처합니다.

## 목표

- 선택적 캡션을 통해 미디어 보내기(`openclaw message send --media`).
- 웹 받은 편지함으로부터 자동 회신이 텍스트와 함께 미디어를 포함하도록 합니다.
- 유형별 한계를 이성적이고 예측 가능하게 유지합니다.

## CLI 표면

- `openclaw message send --media <path-or-url> [--message <caption>]`
  - `--media` 선택 사항; 캡션은 미디어 전용 전송을 위해 비워질 수 있습니다.
  - `--dry-run`은 해결된 페이로드를 인쇄합니다; `--json`은 `{ channel, to, messageId, mediaUrl, caption }`을 내보냅니다.

## WhatsApp Web 채널 동작

- 입력: 로컬 파일 경로 **또는** HTTP(S) URL.
- 흐름: Buffer로 로드, 미디어 종류 감지, 올바른 페이로드 구축:
  - **이미지:** JPEG로 크기 조정 & 재압축(최대 면 2048px) 타겟팅 `agents.defaults.mediaMaxMb`(기본값 5MB), 최대 6MB로 제한.
  - **오디오/음성/비디오:** 16MB까지 통과; 오디오는 음성 노트로 전송됨(`ptt: true`).
  - **문서:** 기타, 최대 100MB, 사용 가능한 경우 파일명 유지.
- WhatsApp GIF 스타일 재생: `gifPlayback: true`(CLI: `--gif-playback`)로 MP4를 보내 모바일 클라이언트가 인라인으로 루프합니다.
- MIME 감지는 매직 바이트를 선호, 그 다음 헤더, 그 다음 파일 확장.
- 캡션은 `--message` 또는 `reply.text`에서 나옵니다; 빈 캡션이 허용됩니다.
- 로깅: 비 자세는 `↩️`/`✅` 표시; 자세는 크기 및 소스 경로/URL을 포함합니다.

## 자동 회신 파이프라인

- `getReplyFromConfig`는 `{ text?, mediaUrl?, mediaUrls? }`를 반환합니다.
- 미디어가 있으면 웹 발신자는 `openclaw message send`와 동일한 파이프라인을 사용하여 로컬 경로 또는 URL을 해결합니다.
- 여러 미디어 항목이 제공되면 순차적으로 전송됩니다.

## 인바운드 미디어를 커맨드로(Pi)

- 인바운드 웹 메시지에 미디어가 포함되면 OpenClaw가 temp 파일로 다운로드하고 템플릿 변수를 노출합니다:
  - `{{MediaUrl}}` 인바운드 미디어에 대한 의사 URL.
  - `{{MediaPath}}` 커맨드를 실행하기 전에 작성된 로컬 temp 경로.
- 세션별 Docker 샌드박스가 활성화되면 인바운드 미디어가 샌드박스 작업 공간으로 복사되고 `MediaPath`/`MediaUrl`이 `media/inbound/<filename>`과 같은 상대 경로로 다시 쓰입니다.
- 미디어 이해(`tools.media.*` 또는 공유 `tools.media.models`를 통해 구성)는 템플릿 전에 실행되고 `[Image]`, `[Audio]` 및 `[Video]` 블록을 `Body`에 삽입할 수 있습니다.
  - 오디오가 `{{Transcript}}`을 설정하고 slash 커맨드가 여전히 작동하도록 트랜스크립트를 커맨드 파싱에 사용합니다.
  - 비디오 및 이미지 설명은 커맨드 파싱을 위해 모든 캡션 텍스트를 유지합니다.
- 기본적으로 첫 일치 이미지/오디오/비디오 첨부만 처리됨; `tools.media.<cap>.attachments`를 설정하여 여러 첨부를 처리합니다.

## 한계 & 오류

**아웃바운드 send 상한(WhatsApp web send)**

- 이미지: 재압축 후 ~6MB 제한.
- 오디오/음성/비디오: 16MB 제한; 문서: 100MB 제한.
- 과도하거나 읽을 수 없는 미디어 → 로그의 명확한 오류 및 회신을 건너뜁니다.

**미디어 이해 상한(트랜스크라이브/설명)**

- 이미지 기본값: 10MB(`tools.media.image.maxBytes`).
- 오디오 기본값: 20MB(`tools.media.audio.maxBytes`).
- 비디오 기본값: 50MB(`tools.media.video.maxBytes`).
- 과도한 미디어는 이해를 건너뛰지만 회신은 여전히 원본 본문과 함께 진행됩니다.

## 테스트용 참고

- send + 회신 흐름을 이미지/오디오/문서 경우에 대해 다룹니다.
- 이미지 재압축(크기 제한) 및 오디오용 음성 노트 플래그를 검증합니다.
- 다중 미디어 회신이 순차 전송으로 확산되는지 확인합니다.
