---
title: "Showcase"
description: "커뮤니티에서 만든 OpenClaw 프로젝트"
summary: "OpenClaw로 구동하는 커뮤니티 기반 프로젝트 및 통합"
read_when:
  - OpenClaw 실제 사용 예시를 찾고 있을 때
  - 커뮤니티 프로젝트 하이라이트를 업데이트할 때
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: docs/start/showcase.md
  workflow: 15
---

# Showcase

커뮤니티에서 만든 실제 프로젝트들입니다. OpenClaw로 무엇을 만들 수 있는지 확인해보세요.

<Info>
**추천되고 싶으신가요?** [Discord의 #showcase](https://discord.gg/clawd) 채널에서 프로젝트를 공유하거나 [X에서 @openclaw를 태그](https://x.com/openclaw)해주세요.
</Info>

## 🎥 실행 중인 OpenClaw

VelvetShark가 제작한 전체 설정 안내 영상 (28분).

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

## 🆕 Discord에서 최근 소식

<CardGroup cols={2}>

<Card title="PR Review → Telegram Feedback" icon="code-pull-request" href="https://x.com/i/status/2010878524543131691">
  **@bangnokia** • `review` `github` `telegram`

OpenCode가 변경을 완료 → PR 오픈 → OpenClaw가 diff 검토 후 Telegram에서 "minor suggestions" 및 명확한 merge 판단을 회신합니다 (먼저 적용해야 할 중요한 수정 포함).

  <img src="/assets/showcase/pr-review-telegram.jpg" alt="Telegram에서 전달되는 OpenClaw PR 검토 피드백" />
</Card>

<Card title="Wine Cellar Skill in Minutes" icon="wine-glass" href="https://x.com/i/status/2010916352454791216">
  **@prades_maxime** • `skills` `local` `csv`

로컬 wine cellar skill을 요청 → sample CSV export 및 저장 위치 제공 → 빠르게 skill 빌드/테스트 (예제는 962개 병).

  <img src="/assets/showcase/wine-cellar-skill.jpg" alt="CSV에서 로컬 wine cellar skill을 구축하는 OpenClaw" />
</Card>

<Card title="Tesco Shop Autopilot" icon="cart-shopping" href="https://x.com/i/status/2009724862470689131">
  **@marchattonhere** • `automation` `browser` `shopping`

주간 식사 계획 → 정기 손님 → 배송 슬롯 예약 → 주문 확인. API 없이 브라우저 제어만 사용합니다.

  <img src="/assets/showcase/tesco-shop.jpg" alt="채팅을 통한 Tesco 쇼핑 자동화" />
</Card>

<Card title="SNAG Screenshot-to-Markdown" icon="scissors" href="https://github.com/am-will/snag">
  **@am-will** • `devtools` `screenshots` `markdown`

화면 영역에 단축키 → Gemini vision → 클립보드에 즉시 Markdown.

  <img src="/assets/showcase/snag.png" alt="SNAG screenshot-to-markdown 도구" />
</Card>

<Card title="Agents UI" icon="window-maximize" href="https://releaseflow.net/kitze/agents-ui">
  **@kitze** • `ui` `skills` `sync`

Desktop 앱으로 Agents, Claude, Codex 및 OpenClaw 전반에 걸쳐 skills/commands를 관리합니다.

  <img src="/assets/showcase/agents-ui.jpg" alt="Agents UI 앱" />
</Card>

<Card title="Telegram Voice Notes (papla.media)" icon="microphone" href="https://papla.media/docs">
  **Community** • `voice` `tts` `telegram`

papla.media TTS를 래핑하고 결과를 Telegram voice note로 전송합니다 (성가신 자동 재생 없음).

  <img src="/assets/showcase/papla-tts.jpg" alt="TTS에서 나온 Telegram voice note 출력" />
</Card>

<Card title="CodexMonitor" icon="eye" href="https://clawhub.com/odrobnik/codexmonitor">
  **@odrobnik** • `devtools` `codex` `brew`

Homebrew 설치 helper로 로컬 OpenAI Codex 세션을 나열/검사/감시합니다 (CLI + VS Code).

  <img src="/assets/showcase/codexmonitor.png" alt="ClawHub의 CodexMonitor" />
</Card>

<Card title="Bambu 3D Printer Control" icon="print" href="https://clawhub.com/tobiasbischoff/bambu-cli">
  **@tobiasbischoff** • `hardware` `3d-printing` `skill`

BambuLab 프린터 제어 및 트러블슈팅: 상태, 작업, 카메라, AMS, 캘리브레이션 등.

  <img src="/assets/showcase/bambu-cli.png" alt="ClawHub의 Bambu CLI skill" />
</Card>

<Card title="Vienna Transport (Wiener Linien)" icon="train" href="https://clawhub.com/hjanuschka/wienerlinien">
  **@hjanuschka** • `travel` `transport` `skill`

빈의 대중교통에 대한 실시간 출발, 중단, 엘리베이터 상태 및 경로 안내.

  <img src="/assets/showcase/wienerlinien.png" alt="ClawHub의 Wiener Linien skill" />
</Card>

<Card title="ParentPay School Meals" icon="utensils" href="#">
  **@George5562** • `automation` `browser` `parenting`

ParentPay를 통한 자동화된 영국 학교 급식 예약. 안정적인 테이블 셀 클릭을 위해 마우스 좌표를 사용합니다.
</Card>

<Card title="R2 Upload (Send Me My Files)" icon="cloud-arrow-up" href="https://clawhub.com/skills/r2-upload">
  **@julianengel** • `files` `r2` `presigned-urls`

Cloudflare R2/S3에 업로드하고 보안 사전 서명 다운로드 링크를 생성합니다. 원격 OpenClaw 인스턴스에 완벽합니다.
</Card>

<Card title="iOS App via Telegram" icon="mobile" href="#">
  **@coard** • `ios` `xcode` `testflight`

지도 및 음성 녹음을 포함한 완전한 iOS 앱을 Telegram 채팅을 통해 TestFlight에 배포합니다.

  <img src="/assets/showcase/ios-testflight.jpg" alt="TestFlight의 iOS 앱" />
</Card>

<Card title="Oura Ring Health Assistant" icon="heart-pulse" href="#">
  **@AS** • `health` `oura` `calendar`

Oura ring 데이터를 달력, 약속 및 헬스장 일정과 통합하는 개인 AI 건강 보조원.

  <img src="/assets/showcase/oura-health.png" alt="Oura ring 건강 보조원" />
</Card>
<Card title="Kev's Dream Team (14+ Agents)" icon="robot" href="https://github.com/adam91holt/orchestrated-ai-articles">
  **@adam91holt** • `multi-agent` `orchestration` `architecture` `manifesto`

하나의 gateway 아래 14개 이상의 agents, Opus 4.5 orchestrator가 Codex workers에게 위임. 종합적인 [기술 자료](https://github.com/adam91holt/orchestrated-ai-articles)에서 Dream Team roster, 모델 선택, sandboxing, webhooks, heartbeats 및 위임 흐름을 다룹니다. Agent sandboxing을 위한 [Clawdspace](https://github.com/adam91holt/clawdspace). [블로그 포스트](https://adams-ai-journey.ghost.io/2026-the-year-of-the-orchestrator/).
</Card>

<Card title="Linear CLI" icon="terminal" href="https://github.com/Finesssee/linear-cli">
  **@NessZerra** • `devtools` `linear` `cli` `issues`

agentic 워크플로우 (Claude Code, OpenClaw)와 통합하는 Linear CLI. 터미널에서 이슈, 프로젝트 및 워크플로우 관리. 첫 외부 PR이 merge되었습니다!
</Card>

<Card title="Beeper CLI" icon="message" href="https://github.com/blqke/beepcli">
  **@jules** • `messaging` `beeper` `cli` `automation`

Beeper Desktop을 통해 메시지를 읽고, 전송하고, 아카이브합니다. Beeper 로컬 MCP API를 사용하여 agents가 모든 채팅 (iMessage, WhatsApp 등)을 한 곳에서 관리할 수 있습니다.
</Card>

</CardGroup>

## 🤖 자동화 및 워크플로우

<CardGroup cols={2}>

<Card title="Winix Air Purifier Control" icon="wind" href="https://x.com/antonplex/status/2010518442471006253">
  **@antonplex** • `automation` `hardware` `air-quality`

Claude Code가 공기청정기 제어를 발견 및 확인 → OpenClaw가 실내 공기 질 관리.

  <img src="/assets/showcase/winix-air-purifier.jpg" alt="OpenClaw를 통한 Winix 공기청정기 제어" />
</Card>

<Card title="Pretty Sky Camera Shots" icon="camera" href="https://x.com/signalgaining/status/2010523120604746151">
  **@signalgaining** • `automation` `camera` `skill` `images`

지붕 카메라로 트리거됨: 하늘이 예쁠 때마다 sky 사진을 찍도록 OpenClaw에 요청 — skill을 설계하고 찍습니다.

  <img src="/assets/showcase/roof-camera-sky.jpg" alt="OpenClaw가 캡처한 지붕 카메라 sky 스냅샷" />
</Card>

<Card title="Visual Morning Briefing Scene" icon="robot" href="https://x.com/buddyhadry/status/2010005331925954739">
  **@buddyhadry** • `automation` `briefing` `images` `telegram`

예약된 프롬프트가 매일 아침 단일 "scene" 이미지를 생성합니다 (날씨, 작업, 날짜, 좋아하는 포스트/인용 포함) OpenClaw persona를 통해.
</Card>

<Card title="Padel Court Booking" icon="calendar-check" href="https://github.com/joshp123/padel-cli">
  **@joshp123** • `automation` `booking` `cli`

Playtomic 가용성 체커 + 예약 CLI. 열린 코트를 놓치지 마세요.

  <img src="/assets/showcase/padel-screenshot.jpg" alt="padel-cli 스크린샷" />
</Card>

<Card title="Accounting Intake" icon="file-invoice-dollar">
  **Community** • `automation` `email` `pdf`

이메일에서 PDF 수집, 세무 컨설턴트를 위해 문서 준비. 월간 회계 자동화.
</Card>

<Card title="Couch Potato Dev Mode" icon="couch" href="https://davekiss.com">
  **@davekiss** • `telegram` `website` `migration` `astro`

Netflix를 보면서 Telegram을 통해 전체 개인 사이트 재구축 — Notion → Astro, 18개 포스트 마이그레이션, DNS를 Cloudflare로. 노트북을 한 번도 열지 않았습니다.
</Card>

<Card title="Job Search Agent" icon="briefcase">
  **@attol8** • `automation` `api` `skill`

구인 공고 검색, CV 키워드와 매치, 관련 기회를 링크와 함께 반환. JSearch API를 사용하여 30분 만에 구축.
</Card>

<Card title="Jira Skill Builder" icon="diagram-project" href="https://x.com/jdrhyne/status/2008336434827002232">
  **@jdrhyne** • `automation` `jira` `skill` `devtools`

OpenClaw가 Jira에 연결 → 즉시 새로운 skill 생성 (ClawHub에 존재하기 전).
</Card>

<Card title="Todoist Skill via Telegram" icon="list-check" href="https://x.com/iamsubhrajyoti/status/2009949389884920153">
  **@iamsubhrajyoti** • `automation` `todoist` `skill` `telegram`

Todoist 작업 자동화 및 OpenClaw가 Telegram 채팅에서 직접 skill을 생성.
</Card>

<Card title="TradingView Analysis" icon="chart-line">
  **@bheem1798** • `finance` `browser` `automation`

TradingView에 로그인 → 차트를 스크린샷 → 요청 시 기술적 분석 수행. API는 필요 없음 — 브라우저 제어만.
</Card>

<Card title="Slack Auto-Support" icon="slack">
  **@henrymascot** • `slack` `automation` `support`

회사 Slack 채널을 감시, 도움이 되는 회신, Telegram으로 알림 전달. 자율적으로 배포된 앱에서 프로덕션 버그 수정.
</Card>

</CardGroup>

## 🧠 지식 및 메모리

<CardGroup cols={2}>

<Card title="xuezh Chinese Learning" icon="language" href="https://github.com/joshp123/xuezh">
  **@joshp123** • `learning` `voice` `skill`

발음 피드백 및 OpenClaw를 통한 학습 흐름과 함께 중국어 학습 엔진.

  <img src="/assets/showcase/xuezh-pronunciation.jpeg" alt="xuezh 발음 피드백" />
</Card>

<Card title="WhatsApp Memory Vault" icon="vault">
  **Community** • `memory` `transcription` `indexing`

전체 WhatsApp 내보내기 수집, 1k개 이상의 voice note 전사, git logs와 교차 확인, linked markdown 보고서 출력.
</Card>

<Card title="Karakeep Semantic Search" icon="magnifying-glass" href="https://github.com/jamesbrooksco/karakeep-semantic-search">
  **@jamesbrooksco** • `search` `vector` `bookmarks`

Qdrant + OpenAI/Ollama embeddings를 사용하여 Karakeep 북마크에 vector search 추가.
</Card>

<Card title="Inside-Out-2 Memory" icon="brain">
  **Community** • `memory` `beliefs` `self-model`

세션 파일을 memories → beliefs → 진화하는 self model로 변환하는 별도의 memory manager.
</Card>

</CardGroup>

## 🎙️ 음성 및 전화

<CardGroup cols={2}>

<Card title="Clawdia Phone Bridge" icon="phone" href="https://github.com/alejandroOPI/clawdia-bridge">
  **@alejandroOPI** • `voice` `vapi` `bridge`

Vapi voice assistant ↔ OpenClaw HTTP bridge. agent와의 거의 실시간 전화 통화.
</Card>

<Card title="OpenRouter Transcription" icon="microphone" href="https://clawhub.com/obviyus/openrouter-transcribe">
  **@obviyus** • `transcription` `multilingual` `skill`

OpenRouter를 통한 다국어 오디오 전사 (Gemini 등). ClawHub에서 사용 가능.
</Card>

</CardGroup>

## 🏗️ 인프라 및 배포

<CardGroup cols={2}>

<Card title="Home Assistant Add-on" icon="home" href="https://github.com/ngutman/openclaw-ha-addon">
  **@ngutman** • `homeassistant` `docker` `raspberry-pi`

SSH tunnel 지원 및 지속적인 상태와 함께 Home Assistant OS에서 실행되는 OpenClaw gateway.
</Card>

<Card title="Home Assistant Skill" icon="toggle-on" href="https://clawhub.com/skills/homeassistant">
  **ClawHub** • `homeassistant` `skill` `automation`

자연언어를 통해 Home Assistant 디바이스를 제어 및 자동화.
</Card>

<Card title="Nix Packaging" icon="snowflake" href="https://github.com/openclaw/nix-openclaw">
  **@openclaw** • `nix` `packaging` `deployment`

재현 가능한 배포를 위한 배터리 포함 nixified OpenClaw 구성.
</Card>

<Card title="CalDAV Calendar" icon="calendar" href="https://clawhub.com/skills/caldav-calendar">
  **ClawHub** • `calendar` `caldav` `skill`

khal/vdirsyncer를 사용한 calendar skill. 자체 호스팅 calendar 통합.
</Card>

</CardGroup>

## 🏠 홈 및 하드웨어

<CardGroup cols={2}>

<Card title="GoHome Automation" icon="house-signal" href="https://github.com/joshp123/gohome">
  **@joshp123** • `home` `nix` `grafana`

OpenClaw를 인터페이스로 하는 Nix 네이티브 홈 자동화, 아름다운 Grafana 대시보드 포함.

  <img src="/assets/showcase/gohome-grafana.png" alt="GoHome Grafana 대시보드" />
</Card>

<Card title="Roborock Vacuum" icon="robot" href="https://github.com/joshp123/gohome/tree/main/plugins/roborock">
  **@joshp123** • `vacuum` `iot` `plugin`

자연스러운 대화를 통해 Roborock robot vacuum을 제어합니다.

  <img src="/assets/showcase/roborock-screenshot.jpg" alt="Roborock 상태" />
</Card>

</CardGroup>

## 🌟 커뮤니티 프로젝트

<CardGroup cols={2}>

<Card title="StarSwap Marketplace" icon="star" href="https://star-swap.com/">
  **Community** • `marketplace` `astronomy` `webapp`

완벽한 천문 장비 마켓플레이스. OpenClaw 생태계와 함께/주변에 구축.
</Card>

</CardGroup>

---

## 프로젝트 제출

공유할 것이 있으신가요? 꼭 보여주고 싶습니다!

<Steps>
  <Step title="공유하기">
    [Discord의 #showcase](https://discord.gg/clawd) 또는 [@openclaw를 트윗](https://x.com/openclaw)에 게시합니다.
  </Step>
  <Step title="세부 사항 포함">
    수행하는 작업, 저장소/데모 링크, 스크린샷을 공유합니다.
  </Step>
  <Step title="추천받기">
    우리는 뛰어난 프로젝트를 이 페이지에 추가합니다.
  </Step>
</Steps>
