---
title: "쇼케이스"
description: "커뮤니티의 실제 OpenClaw 프로젝트"
summary: "OpenClaw 기반의 커뮤니티 제작 프로젝트 및 통합 사례"
---

# 쇼케이스

커뮤니티의 실제 프로젝트들입니다. OpenClaw로 사람들이 무엇을 만들고 있는지 확인해보세요.

<Info>
**소개되고 싶으신가요?** [Discord의 #showcase](https://discord.gg/clawd)에서 프로젝트를 공유하거나 [X에서 @openclaw를 태그](https://x.com/openclaw)해 주세요.
</Info>

## 🎥 OpenClaw 실전 영상

VelvetShark의 전체 설정 안내 영상 (28분).

<div
  style={{
    position: "relative",
    paddingBottom: "56.25%",
    height: 0,
    overflow: "hidden",
    borderRadius: 16,
  }}
>
  <iframe
    src="https://www.youtube-nocookie.com/embed/SaWSPZoPX34"
    title="OpenClaw: The self-hosted AI that Siri should have been (Full setup)"
    style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" }}
    frameBorder="0"
    loading="lazy"
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
    allowFullScreen
  />
</div>

[YouTube에서 보기](https://www.youtube.com/watch?v=SaWSPZoPX34)

<div
  style={{
    position: "relative",
    paddingBottom: "56.25%",
    height: 0,
    overflow: "hidden",
    borderRadius: 16,
  }}
>
  <iframe
    src="https://www.youtube-nocookie.com/embed/mMSKQvlmFuQ"
    title="OpenClaw showcase video"
    style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" }}
    frameBorder="0"
    loading="lazy"
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
    allowFullScreen
  />
</div>

[YouTube에서 보기](https://www.youtube.com/watch?v=mMSKQvlmFuQ)

<div
  style={{
    position: "relative",
    paddingBottom: "56.25%",
    height: 0,
    overflow: "hidden",
    borderRadius: 16,
  }}
>
  <iframe
    src="https://www.youtube-nocookie.com/embed/5kkIJNUGFho"
    title="OpenClaw community showcase"
    style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" }}
    frameBorder="0"
    loading="lazy"
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
    allowFullScreen
  />
</div>

[YouTube에서 보기](https://www.youtube.com/watch?v=5kkIJNUGFho)

## 🆕 Discord 최신 소식

<CardGroup cols={2}>

<Card title="PR 리뷰 → Telegram 피드백" icon="code-pull-request" href="https://x.com/i/status/2010878524543131691">
  **@bangnokia** • `review` `github` `telegram`

OpenCode가 변경 완료 → PR 생성 → OpenClaw가 diff를 검토하고 Telegram으로 "소소한 제안"과 명확한 병합 판정(먼저 적용해야 할 중요 수정 사항 포함)을 답장합니다.

  <img src="/assets/showcase/pr-review-telegram.jpg" alt="Telegram으로 전달된 OpenClaw PR 리뷰 피드백" />
</Card>

<Card title="몇 분 만에 와인 셀러 스킬 완성" icon="wine-glass" href="https://x.com/i/status/2010916352454791216">
  **@prades_maxime** • `skills` `local` `csv`

"Robby"(@openclaw)에게 로컬 와인 셀러 스킬을 요청했습니다. 샘플 CSV 내보내기와 저장 위치를 요청한 뒤 스킬을 빠르게 빌드·테스트합니다(예시에서는 962병).

  <img src="/assets/showcase/wine-cellar-skill.jpg" alt="CSV로 로컬 와인 셀러 스킬을 만드는 OpenClaw" />
</Card>

<Card title="Tesco 쇼핑 자동화" icon="cart-shopping" href="https://x.com/i/status/2009724862470689131">
  **@marchattonhere** • `automation` `browser` `shopping`

주간 식단 계획 → 정기 품목 → 배송 슬롯 예약 → 주문 확인. API 없이 브라우저 제어만 사용합니다.

  <img src="/assets/showcase/tesco-shop.jpg" alt="채팅을 통한 Tesco 쇼핑 자동화" />
</Card>

<Card title="SNAG 스크린샷 → 마크다운 변환" icon="scissors" href="https://github.com/am-will/snag">
  **@am-will** • `devtools` `screenshots` `markdown`

화면 영역 단축키 → Gemini 비전 → 클립보드에 즉시 Markdown 저장.

  <img src="/assets/showcase/snag.png" alt="SNAG 스크린샷-마크다운 변환 도구" />
</Card>

<Card title="Agents UI" icon="window-maximize" href="https://releaseflow.net/kitze/agents-ui">
  **@kitze** • `ui` `skills` `sync`

Agents, Claude, Codex, OpenClaw 전반의 스킬과 명령을 관리하는 데스크탑 앱.

  <img src="/assets/showcase/agents-ui.jpg" alt="Agents UI 앱" />
</Card>

<Card title="Telegram 음성 메모 (papla.media)" icon="microphone" href="https://papla.media/docs">
  **Community** • `voice` `tts` `telegram`

papla.media TTS를 감싸 결과를 Telegram 음성 메모로 전송합니다 (귀찮은 자동재생 없음).

  <img src="/assets/showcase/papla-tts.jpg" alt="TTS에서 출력된 Telegram 음성 메모" />
</Card>

<Card title="CodexMonitor" icon="eye" href="https://clawhub.com/odrobnik/codexmonitor">
  **@odrobnik** • `devtools` `codex` `brew`

로컬 OpenAI Codex 세션을 나열·검사·감시하는 Homebrew 설치 가능 도구 (CLI + VS Code).

  <img src="/assets/showcase/codexmonitor.png" alt="ClawHub의 CodexMonitor" />
</Card>

<Card title="Bambu 3D 프린터 제어" icon="print" href="https://clawhub.com/tobiasbischoff/bambu-cli">
  **@tobiasbischoff** • `hardware` `3d-printing` `skill`

BambuLab 프린터 제어 및 문제 해결: 상태, 작업, 카메라, AMS, 캘리브레이션 등.

  <img src="/assets/showcase/bambu-cli.png" alt="ClawHub의 Bambu CLI 스킬" />
</Card>

<Card title="빈 대중교통 (Wiener Linien)" icon="train" href="https://clawhub.com/hjanuschka/wienerlinien">
  **@hjanuschka** • `travel` `transport` `skill`

빈 대중교통의 실시간 출발 정보, 운행 장애, 엘리베이터 상태, 경로 안내.

  <img src="/assets/showcase/wienerlinien.png" alt="ClawHub의 Wiener Linien 스킬" />
</Card>

<Card title="ParentPay 학교 급식 예약" icon="utensils" href="#">
  **@George5562** • `automation` `browser` `parenting`

ParentPay를 통한 영국 학교 급식 자동 예약. 안정적인 표 셀 클릭을 위해 마우스 좌표를 활용합니다.
</Card>

<Card title="R2 업로드 (파일 보내기)" icon="cloud-arrow-up" href="https://clawhub.com/skills/r2-upload">
  **@julianengel** • `files` `r2` `presigned-urls`

Cloudflare R2/S3에 업로드하고 안전한 프리사인드 다운로드 링크를 생성합니다. 원격 OpenClaw 인스턴스에 적합합니다.
</Card>

<Card title="Telegram을 통한 iOS 앱 개발" icon="mobile" href="#">
  **@coard** • `ios` `xcode` `testflight`

지도와 음성 녹음 기능을 포함한 완전한 iOS 앱을 Telegram 채팅만으로 TestFlight에 배포했습니다.

  <img src="/assets/showcase/ios-testflight.jpg" alt="TestFlight의 iOS 앱" />
</Card>

<Card title="Oura 링 건강 어시스턴트" icon="heart-pulse" href="#">
  **@AS** • `health` `oura` `calendar`

Oura 링 데이터와 캘린더, 예약, 헬스장 일정을 연동하는 개인 AI 건강 어시스턴트.

  <img src="/assets/showcase/oura-health.png" alt="Oura 링 건강 어시스턴트" />
</Card>
<Card title="Kev의 드림팀 (14개+ 에이전트)" icon="robot" href="https://github.com/adam91holt/orchestrated-ai-articles">
  **@adam91holt** • `multi-agent` `orchestration` `architecture` `manifesto`

하나의 게이트웨이 아래 14개+ 에이전트가 Opus 4.5 오케스트레이터의 지휘를 받아 Codex 워커에게 작업을 위임합니다. 드림팀 구성, 모델 선택, 샌드박싱, 웹훅, 하트비트, 위임 흐름을 다루는 포괄적인 [기술 문서](https://github.com/adam91holt/orchestrated-ai-articles) 포함. 에이전트 샌드박싱을 위한 [Clawdspace](https://github.com/adam91holt/clawdspace). [블로그 포스트](https://adams-ai-journey.ghost.io/2026-the-year-of-the-orchestrator/).
</Card>

<Card title="Linear CLI" icon="terminal" href="https://github.com/Finesssee/linear-cli">
  **@NessZerra** • `devtools` `linear` `cli` `issues`

에이전트 워크플로우(Claude Code, OpenClaw)와 통합되는 Linear용 CLI. 터미널에서 이슈, 프로젝트, 워크플로우를 관리합니다. 첫 번째 외부 PR 병합!
</Card>

<Card title="Beeper CLI" icon="message" href="https://github.com/blqke/beepcli">
  **@jules** • `messaging` `beeper` `cli` `automation`

Beeper Desktop을 통해 메시지를 읽고, 보내고, 보관합니다. Beeper 로컬 MCP API를 사용해 에이전트가 모든 채팅(iMessage, WhatsApp 등)을 한 곳에서 관리할 수 있습니다.
</Card>

</CardGroup>

## 🤖 자동화 및 워크플로우

<CardGroup cols={2}>

<Card title="Winix 공기청정기 제어" icon="wind" href="https://x.com/antonplex/status/2010518442471006253">
  **@antonplex** • `automation` `hardware` `air-quality`

Claude Code가 공기청정기 제어 방법을 발견·확인한 뒤, OpenClaw가 이어받아 실내 공기질을 관리합니다.

  <img src="/assets/showcase/winix-air-purifier.jpg" alt="OpenClaw를 통한 Winix 공기청정기 제어" />
</Card>

<Card title="하늘 카메라 자동 촬영" icon="camera" href="https://x.com/signalgaining/status/2010523120604746151">
  **@signalgaining** • `automation` `camera` `skill` `images`

지붕 카메라 트리거: 하늘이 예쁠 때 OpenClaw에게 사진을 찍어달라고 요청 — 스킬을 직접 설계하고 촬영했습니다.

  <img src="/assets/showcase/roof-camera-sky.jpg" alt="OpenClaw가 촬영한 지붕 카메라 하늘 사진" />
</Card>

<Card title="비주얼 모닝 브리핑 장면" icon="robot" href="https://x.com/buddyhadry/status/2010005331925954739">
  **@buddyhadry** • `automation` `briefing` `images` `telegram`

예약된 프롬프트가 매일 아침 날씨, 할 일, 날짜, 좋아하는 게시물/인용문을 담은 단일 "장면" 이미지를 OpenClaw 페르소나를 통해 생성합니다.
</Card>

<Card title="파델 코트 예약" icon="calendar-check" href="https://github.com/joshp123/padel-cli">
  **@joshp123** • `automation` `booking` `cli`

Playtomic 가용성 확인 + 예약 CLI. 빈 코트를 절대 놓치지 마세요.

  <img src="/assets/showcase/padel-screenshot.jpg" alt="padel-cli 스크린샷" />
</Card>

<Card title="회계 접수 자동화" icon="file-invoice-dollar">
  **Community** • `automation` `email` `pdf`

이메일에서 PDF를 수집하고 세무사를 위한 문서를 준비합니다. 월간 회계를 자동으로 처리합니다.
</Card>

<Card title="카우치 포테이토 개발 모드" icon="couch" href="https://davekiss.com">
  **@davekiss** • `telegram` `website` `migration` `astro`

넷플릭스를 보면서 Telegram으로 개인 사이트 전체를 재구축했습니다 — Notion → Astro, 18개 게시물 마이그레이션, DNS를 Cloudflare로 이전. 노트북을 한 번도 열지 않았습니다.
</Card>

<Card title="구직 에이전트" icon="briefcase">
  **@attol8** • `automation` `api` `skill`

채용 공고를 검색하고 이력서 키워드와 매칭한 뒤 관련 기회와 링크를 반환합니다. JSearch API를 사용해 30분 만에 구축했습니다.
</Card>

<Card title="Jira 스킬 빌더" icon="diagram-project" href="https://x.com/jdrhyne/status/2008336434827002232">
  **@jdrhyne** • `automation` `jira` `skill` `devtools`

OpenClaw를 Jira에 연결한 뒤, ClawHub에 존재하기 전에 즉석에서 새 스킬을 생성했습니다.
</Card>

<Card title="Telegram으로 Todoist 스킬" icon="list-check" href="https://x.com/iamsubhrajyoti/status/2009949389884920153">
  **@iamsubhrajyoti** • `automation` `todoist` `skill` `telegram`

Todoist 작업을 자동화하고 OpenClaw에서 Telegram 채팅으로 직접 스킬을 생성했습니다.
</Card>

<Card title="TradingView 분석" icon="chart-line">
  **@bheem1798** • `finance` `browser` `automation`

브라우저 자동화로 TradingView에 로그인하고 차트를 스크린샷하여 요청 시 기술적 분석을 수행합니다. API 불필요 — 브라우저 제어만 사용합니다.
</Card>

<Card title="Slack 자동 고객지원" icon="slack">
  **@henrymascot** • `slack` `automation` `support`

회사 Slack 채널을 모니터링하고 유용하게 답변하며 Telegram으로 알림을 전달합니다. 요청 없이도 배포된 앱의 프로덕션 버그를 자율적으로 수정했습니다.
</Card>

</CardGroup>

## 🧠 지식 및 메모리

<CardGroup cols={2}>

<Card title="xuezh 중국어 학습" icon="language" href="https://github.com/joshp123/xuezh">
  **@joshp123** • `learning` `voice` `skill`

OpenClaw를 통한 발음 피드백 및 학습 흐름을 갖춘 중국어 학습 엔진.

  <img src="/assets/showcase/xuezh-pronunciation.jpeg" alt="xuezh 발음 피드백" />
</Card>

<Card title="WhatsApp 메모리 볼트" icon="vault">
  **Community** • `memory` `transcription` `indexing`

전체 WhatsApp 내보내기를 수집하고, 1000개+ 음성 메모를 전사하며, git 로그와 교차 확인하여 링크된 마크다운 보고서를 출력합니다.
</Card>

<Card title="Karakeep 시맨틱 검색" icon="magnifying-glass" href="https://github.com/jamesbrooksco/karakeep-semantic-search">
  **@jamesbrooksco** • `search` `vector` `bookmarks`

Qdrant + OpenAI/Ollama 임베딩을 사용해 Karakeep 북마크에 벡터 검색을 추가합니다.
</Card>

<Card title="인사이드 아웃 2 메모리" icon="brain">
  **Community** • `memory` `beliefs` `self-model`

세션 파일을 메모리 → 믿음 → 진화하는 자아 모델로 변환하는 별도 메모리 관리자.
</Card>

</CardGroup>

## 🎙️ 음성 및 전화

<CardGroup cols={2}>

<Card title="Clawdia 전화 브릿지" icon="phone" href="https://github.com/alejandroOPI/clawdia-bridge">
  **@alejandroOPI** • `voice` `vapi` `bridge`

Vapi 음성 어시스턴트 ↔ OpenClaw HTTP 브릿지. 에이전트와 거의 실시간 전화 통화.
</Card>

<Card title="OpenRouter 전사" icon="microphone" href="https://clawhub.com/obviyus/openrouter-transcribe">
  **@obviyus** • `transcription` `multilingual` `skill`

OpenRouter(Gemini 등)를 통한 다국어 오디오 전사. ClawHub에서 이용 가능합니다.
</Card>

</CardGroup>

## 🏗️ 인프라 및 배포

<CardGroup cols={2}>

<Card title="Home Assistant 애드온" icon="home" href="https://github.com/ngutman/openclaw-ha-addon">
  **@ngutman** • `homeassistant` `docker` `raspberry-pi`

SSH 터널 지원 및 영속 상태를 갖춘 Home Assistant OS 기반 OpenClaw 게이트웨이.
</Card>

<Card title="Home Assistant 스킬" icon="toggle-on" href="https://clawhub.com/skills/homeassistant">
  **ClawHub** • `homeassistant` `skill` `automation`

자연어로 Home Assistant 기기를 제어하고 자동화합니다.
</Card>

<Card title="Nix 패키징" icon="snowflake" href="https://github.com/openclaw/nix-openclaw">
  **@openclaw** • `nix` `packaging` `deployment`

재현 가능한 배포를 위한 배터리 포함 nixified OpenClaw 설정.
</Card>

<Card title="CalDAV 캘린더" icon="calendar" href="https://clawhub.com/skills/caldav-calendar">
  **ClawHub** • `calendar` `caldav` `skill`

khal/vdirsyncer를 사용하는 캘린더 스킬. 셀프 호스팅 캘린더 통합.
</Card>

</CardGroup>

## 🏠 홈 & 하드웨어

<CardGroup cols={2}>

<Card title="GoHome 자동화" icon="house-signal" href="https://github.com/joshp123/gohome">
  **@joshp123** • `home` `nix` `grafana`

OpenClaw를 인터페이스로 활용하는 Nix 네이티브 홈 자동화와 아름다운 Grafana 대시보드.

  <img src="/assets/showcase/gohome-grafana.png" alt="GoHome Grafana 대시보드" />
</Card>

<Card title="Roborock 로봇청소기" icon="robot" href="https://github.com/joshp123/gohome/tree/main/plugins/roborock">
  **@joshp123** • `vacuum` `iot` `plugin`

자연스러운 대화로 Roborock 로봇청소기를 제어합니다.

  <img src="/assets/showcase/roborock-screenshot.jpg" alt="Roborock 상태" />
</Card>

</CardGroup>

## 🌟 커뮤니티 프로젝트

<CardGroup cols={2}>

<Card title="StarSwap 마켓플레이스" icon="star" href="https://star-swap.com/">
  **Community** • `marketplace` `astronomy` `webapp`

천문 장비 마켓플레이스. OpenClaw 생태계를 기반으로 구축됩니다.
</Card>

</CardGroup>

---

## 프로젝트 제출하기

공유하고 싶은 것이 있으신가요? 소개해드리고 싶습니다!

<Steps>
  <Step title="공유하기">
    [Discord의 #showcase](https://discord.gg/clawd)에 게시하거나 [X에서 @openclaw를 멘션](https://x.com/openclaw)하세요
  </Step>
  <Step title="상세 정보 포함하기">
    무엇을 하는지 설명하고, 저장소/데모 링크를 첨부하고, 스크린샷이 있다면 공유해 주세요
  </Step>
  <Step title="소개되기">
    눈에 띄는 프로젝트는 이 페이지에 추가됩니다
  </Step>
</Steps>
