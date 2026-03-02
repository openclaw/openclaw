---
summary: "인바운드 이미지/오디오/비디오 이해(선택 사항) 제공자 + CLI 폴백"
read_when:
  - 미디어 이해를 설계하거나 리팩터할 때
  - 인바운드 오디오/비디오/이미지 사전 처리를 조정할 때
title: "미디어 이해"
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: nodes/media-understanding.md
workflow: 15
---

# 미디어 이해(인바운드) — 2026-01-17

OpenClaw는 **인바운드 미디어 요약**(이미지/오디오/비디오)을 회신 파이프라인이 실행하기 전에 할 수 있습니다. 로컬 도구 또는 제공자 키를 사용할 수 있으면 자동 감지하고 비활성화하거나 커스터마이즈할 수 있습니다. 이해가 꺼져 있으면 모델은 여전히 원본 파일/URL을 정상적으로 받습니다.

## 목표

- 선택 사항: 인바운드 미디어를 짧은 텍스트로 사전 소화하여 더 빠른 라우팅 + 더 나은 커맨드 파싱.
- 원본 미디어 전달을 모델로 유지(항상).
- **제공자 API** 및 **CLI 폴백** 지원.
- 정렬된 폴백(오류/크기/타임아웃)이 있는 여러 모델 허용.

## 높은 레벨 동작

1. 인바운드 첨부 수집(`MediaPaths`, `MediaUrls`, `MediaTypes`).
2. 각 활성화된 기능(이미지/오디오/비디오)에 대해 정책당 첨부 선택(기본값: **첫**).
3. 첫 적격 모델 항목 선택(크기 + 기능 + 인증).
4. 모델이 실패하거나 미디어가 너무 크면 **다음 항목으로 폴백**.
5. 성공 시:
   - `Body`가 `[Image]`, `[Audio]` 또는 `[Video]` 블록이 됨.
   - 오디오가 `{{Transcript}}`를 설정; 커맨드 파싱이 캡션 텍스트를 사용하고(사용 가능한 경우),
     그렇지 않으면 트랜스크립트.
   - 캡션이 블록 내 `User text:` 같이 유지됨.

이해가 실패하거나 비활성화되면 **회신 흐름은 원본 본문 + 첨부와 함께 계속됨**.

## 구성 개요

`tools.media`는 **공유 모델** 플러스 기능별 오버라이드를 지원합니다:

- `tools.media.models`: 공유 모델 목록(`capabilities`로 제어).
- `tools.media.image` / `tools.media.audio` / `tools.media.video`:
  - 기본값(`prompt`, `maxChars`, `maxBytes`, `timeoutSeconds`, `language`)
  - 제공자 오버라이드(`baseUrl`, `headers`, `providerOptions`)
  - Deepgram 오디오 옵션(`tools.media.audio.providerOptions.deepgram`을 통해)
  - 선택적 **기능별 `models` 목록**(공유 모델 전에 선호)
  - `attachments` 정책(`mode`, `maxAttachments`, `prefer`)
  - `scope`(선택적 채널/chatType/세션 키별 제어)
- `tools.media.concurrency`: 최대 동시 기능 실행(기본값 **2**).

더 자세한 정보는 공식 문서를 참고합니다.
