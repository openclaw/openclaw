---
title: "쇼케이스"
description: "커뮤니티의 실제 OpenClaw 프로젝트"
summary: "OpenClaw 로 구동되는 커뮤니티 제작 프로젝트와 통합 사례"
---

# 쇼케이스

커뮤니티의 실제 프로젝트입니다. 사람들이 OpenClaw 로 무엇을 만들고 있는지 확인해 보세요.

<Info>
**소개되고 싶으신가요?** [Discord 의 #showcase](https://discord.gg/clawd)에 프로젝트를 공유하거나 [X 에서 @openclaw 를 태그](https://x.com/openclaw)하세요.
</Info>

## 🎥 OpenClaw 실제 동작

VelvetShark 가 제작한 전체 설정 워크스루 (28 분).

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
</div></div>

[YouTube 에서 시청](https://www.youtube.com/watch?v=SaWSPZoPX34)

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
</div></div>

[YouTube 에서 시청](https://www.youtube.com/watch?v=mMSKQvlmFuQ)

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
</div></div>

[YouTube 에서 시청](https://www.youtube.com/watch?v=5kkIJNUGFho)

## 🆕 Discord 최신 소식

<CardGroup cols={2}>

<Card title="PR Review → Telegram Feedback" icon="code-pull-request" href="https://x.com/i/status/2010878524543131691">
  **@bangnokia** • `review` `github` `telegram`

OpenCode 가 변경을 완료 → PR 을 열고 → OpenClaw 가 diff 를 검토한 뒤 Telegram 에서 '사소한 제안'과 함께 명확한 머지 판단을 회신합니다 (먼저 적용해야 할 치명적 수정 포함).

  <img src="/assets/showcase/pr-review-telegram.jpg" alt="OpenClaw PR review feedback delivered in Telegram" />
</Card>

<Card title="Wine Cellar Skill in Minutes" icon="wine-glass" href="https://x.com/i/status/2010916352454791216">
  **@prades_maxime** • `skills` `local` `csv`

로컬 와인 셀러 Skill 을 위해 'Robby' (@openclaw)에게 요청했습니다. 샘플 CSV 내보내기와 저장 위치를 요청한 뒤, Skill 을 빠르게 빌드하고 테스트합니다 (예제에서는 962 병).

  <img src="/assets/showcase/wine-cellar-skill.jpg" alt="OpenClaw building a local wine cellar skill from CSV" />
</Card>

<Card title="Tesco Shop Autopilot" icon="cart-shopping" href="https://x.com/i/status/2009724862470689131">
  **@marchattonhere** • `automation` `browser` `shopping`

주간 식단 계획 → 단골 품목 → 배송 슬롯 예약 → 주문 확인. API 없이 브라우저 제어만 사용합니다.

  <img src="/assets/showcase/tesco-shop.jpg" alt="Tesco shop automation via chat" />
</Card>

<Card title="SNAG Screenshot-to-Markdown" icon="scissors" href="https://github.com/am-will/snag">
  **@am-will** • `devtools` `screenshots` `markdown`

화면 영역을 핫키로 지정 → Gemini 비전 → 클립보드에 즉시 Markdown 생성.

  <img src="/assets/showcase/snag.png" alt="SNAG screenshot-to-markdown tool" />
</Card>

<Card title="Agents UI" icon="window-maximize" href="https://releaseflow.net/kitze/agents-ui">
  **@kitze** • `ui` `skills` `sync`

Agents, Claude, Codex, OpenClaw 전반의 Skills/명령을 관리하는 데스크톱 앱입니다.

  <img src="/assets/showcase/agents-ui.jpg" alt="Agents UI app" />
</Card>

<Card title="Telegram Voice Notes (papla.media)" icon="microphone" href="https://papla.media/docs">
  **Community** • `voice` `tts` `telegram`

papla.media TTS 를 감싸 결과를 Telegram 음성 노트로 전송합니다 (번거로운 자동 재생 없음).

  <img src="/assets/showcase/papla-tts.jpg" alt="Telegram voice note output from TTS" />
</Card>

<Card title="CodexMonitor" icon="eye" href="https://clawhub.com/odrobnik/codexmonitor">
  **@odrobnik** • `devtools` `codex` `brew`

Homebrew 로 설치되는 헬퍼로, 로컬 OpenAI Codex 세션을 나열/검사/모니터링합니다 (CLI + VS Code).

  <img src="/assets/showcase/codexmonitor.png" alt="CodexMonitor on ClawHub" />
</Card>

<Card title="Bambu 3D Printer Control" icon="print" href="https://clawhub.com/tobiasbischoff/bambu-cli">
  **@tobiasbischoff** • `hardware` `3d-printing` `skill`

BambuLab 프린터를 제어하고 문제를 해결합니다: 상태, 작업, 카메라, AMS, 캘리브레이션 등.

  <img src="/assets/showcase/bambu-cli.png" alt="Bambu CLI skill on ClawHub" />
</Card>

<Card title="Vienna Transport (Wiener Linien)" icon="train" href="https://clawhub.com/hjanuschka/wienerlinien">
  **@hjanuschka** • `travel` `transport` `skill`

비엔나 대중교통의 실시간 출발 정보, 장애, 엘리베이터 상태, 경로 안내를 제공합니다.

  <img src="/assets/showcase/wienerlinien.png" alt="Wiener Linien skill on ClawHub" />
</Card>

<Card title="ParentPay School Meals" icon="utensils" href="#">
  **@George5562** • `automation` `browser` `parenting`

ParentPay 를 통한 영국 학교 급식 예약을 자동화합니다. 안정적인 테이블 셀 클릭을 위해 마우스 좌표를 사용합니다. </Card>

<Card title="R2 Upload (Send Me My Files)" icon="cloud-arrow-up" href="https://clawhub.com/skills/r2-upload">
  **@julianengel** • `files` `r2` `presigned-urls`

Cloudflare R2/S3 로 업로드하고 안전한 사전 서명 다운로드 링크를 생성합니다. 원격 OpenClaw 인스턴스에 적합합니다. </Card>

<Card title="iOS App via Telegram" icon="mobile" href="#">
  **@coard** • `ios` `xcode` `testflight`

지도와 음성 녹음을 포함한 완전한 iOS 앱을 Telegram 채팅만으로 빌드하고 TestFlight 에 배포했습니다.

  <img src="/assets/showcase/ios-testflight.jpg" alt="iOS app on TestFlight" />
</Card>

<Card title="Oura Ring Health Assistant" icon="heart-pulse" href="#">
  **@AS** • `health` `oura` `calendar`

Oura ring 데이터를 캘린더, 일정, 헬스장 스케줄과 통합한 개인 AI 헬스 어시스턴트입니다.

  <img src="/assets/showcase/oura-health.png" alt="Oura ring health assistant" />
</Card>
<Card title="Kev's Dream Team (14+ Agents)" icon="robot" href="https://github.com/adam91holt/orchestrated-ai-articles">
  **@adam91holt** • `multi-agent` `orchestration` `architecture` `manifesto`

Opus 4.5 오케스트레이터가 Codex 워커로 위임하는 14 개 이상의 에이전트를 하나의 Gateway(게이트웨이) 아래에서 운영합니다. 드림 팀 구성, 모델 선택, 샌드박스화, 웹훅, 하트비트, 위임 흐름을 다루는 포괄적인 [기술 문서](https://github.com/adam91holt/orchestrated-ai-articles)가 포함되어 있습니다. 에이전트 샌드박스화를 위한 [Clawdspace](https://github.com/adam91holt/clawdspace). [블로그 게시글](https://adams-ai-journey.ghost.io/2026-the-year-of-the-orchestrator/). </Card>

<Card title="Linear CLI" icon="terminal" href="https://github.com/Finesssee/linear-cli">
  **@NessZerra** • `devtools` `linear` `cli` `issues`

에이전트 기반 워크플로 (Claude Code, OpenClaw)와 통합되는 Linear 용 CLI 입니다. 터미널에서 이슈, 프로젝트, 워크플로를 관리합니다. 첫 외부 PR 이 머지되었습니다! </Card>

<Card title="Beeper CLI" icon="message" href="https://github.com/blqke/beepcli">
  **@jules** • `messaging` `beeper` `cli` `automation`

Beeper Desktop 을 통해 메시지를 읽고, 보내고, 보관합니다. Beeper local MCP API 를 사용해 에이전트가 iMessage, WhatsApp 등 모든 채팅을 한곳에서 관리할 수 있습니다. 한 곳에. </Card>

</CardGroup>

## 🤖 자동화 & 워크플로

<CardGroup cols={2}>

<Card title="Winix Air Purifier Control" icon="wind" href="https://x.com/antonplex/status/2010518442471006253">
  **@antonplex** • `automation` `hardware` `air-quality`

Claude Code 가 공기청정기 제어를 발견하고 확인한 뒤, OpenClaw 가 실내 공기질 관리를 이어받습니다.

  <img src="/assets/showcase/winix-air-purifier.jpg" alt="Winix air purifier control via OpenClaw" />
</Card>

<Card title="Pretty Sky Camera Shots" icon="camera" href="https://x.com/signalgaining/status/2010523120604746151">
  **@signalgaining** • `automation` `camera` `skill` `images`

지붕 카메라에 의해 트리거되어, 하늘이 예뻐 보일 때마다 OpenClaw 에게 사진을 찍도록 요청합니다 — Skill 을 설계하고 촬영까지 수행했습니다.

  <img src="/assets/showcase/roof-camera-sky.jpg" alt="Roof camera sky snapshot captured by OpenClaw" />
</Card>

<Card title="Visual Morning Briefing Scene" icon="robot" href="https://x.com/buddyhadry/status/2010005331925954739">
  **@buddyhadry** • `automation` `briefing` `images` `telegram`

예약된 프롬프트가 매일 아침 하나의 '씬' 이미지를 생성합니다 (날씨, 작업, 날짜, 좋아하는 게시물/인용문) — OpenClaw 페르소나를 통해 생성됩니다. </Card>

<Card title="Padel Court Booking" icon="calendar-check" href="https://github.com/joshp123/padel-cli">
  **@joshp123** • `automation` `booking` `cli`

Playtomic 가용성 확인 + 예약 CLI 입니다. 더 이상 빈 코트를 놓치지 마세요.

  <img src="/assets/showcase/padel-screenshot.jpg" alt="padel-cli screenshot" />
</Card>

<Card title="Accounting Intake" icon="file-invoice-dollar">
  **Community** • `automation` `email` `pdf`

이메일에서 PDF 를 수집하고 세무사를 위한 문서를 준비합니다. 월간 회계를 오토파일럿으로 처리합니다. </Card>

<Card title="Couch Potato Dev Mode" icon="couch" href="https://davekiss.com">
  **@davekiss** • `telegram` `website` `migration` `astro`

Netflix 를 보면서 Telegram 만으로 개인 사이트 전체를 재구축했습니다 — Notion → Astro, 18 개 게시글 이전, DNS 를 Cloudflare 로 전환. 노트북을 한 번도 열지 않았습니다. </Card>

<Card title="Job Search Agent" icon="briefcase">
  **@attol8** • `automation` `api` `skill`

구인 공고를 검색하고 CV 키워드와 매칭하여 관련 기회를 링크와 함께 반환합니다. JSearch API 를 사용해 30 분 만에 구축되었습니다. </Card>

<Card title="Jira Skill Builder" icon="diagram-project" href="https://x.com/jdrhyne/status/2008336434827002232">
  **@jdrhyne** • `automation` `jira` `skill` `devtools`

OpenClaw 를 Jira 에 연결한 뒤, ClawHub 에 존재하기 전 새로운 Skill 을 즉석에서 생성했습니다. </Card>

<Card title="Todoist Skill via Telegram" icon="list-check" href="https://x.com/iamsubhrajyoti/status/2009949389884920153">
  **@iamsubhrajyoti** • `automation` `todoist` `skill` `telegram`

Todoist 작업을 자동화하고, OpenClaw 가 Telegram 채팅에서 직접 Skill 을 생성하도록 했습니다. </Card>

<Card title="TradingView Analysis" icon="chart-line">
  **@bheem1798** • `finance` `browser` `automation`

브라우저 자동화를 통해 TradingView 에 로그인하고 차트를 스크린샷으로 캡처하여 요청 시 기술적 분석을 수행합니다. API 는 필요 없고 브라우저 제어만 사용합니다. </Card>

<Card title="Slack Auto-Support" icon="slack">
  **@henrymascot** • `slack` `automation` `support`

회사 Slack 채널을 감시하고 유용한 응답을 제공하며 알림을 Telegram 으로 전달합니다. 요청 없이 배포된 앱의 프로덕션 버그를 자율적으로 수정했습니다. </Card>

</CardGroup>

## 🧠 지식 & 메모리

<CardGroup cols={2}>

<Card title="xuezh Chinese Learning" icon="language" href="https://github.com/joshp123/xuezh">
  **@joshp123** • `learning` `voice` `skill`

OpenClaw 를 통해 발음 피드백과 학습 플로우를 제공하는 중국어 학습 엔진입니다.

  <img src="/assets/showcase/xuezh-pronunciation.jpeg" alt="xuezh pronunciation feedback" />
</Card>

<Card title="WhatsApp Memory Vault" icon="vault">
  **Community** • `memory` `transcription` `indexing`

WhatsApp 전체 내보내기를 수집하고 1,000 개 이상의 음성 노트를 전사하며, git 로그와 교차 검증하여 연결된 Markdown 보고서를 출력합니다. </Card>

<Card title="Karakeep Semantic Search" icon="magnifying-glass" href="https://github.com/jamesbrooksco/karakeep-semantic-search">
  **@jamesbrooksco** • `search` `vector` `bookmarks`

Qdrant + OpenAI/Ollama 임베딩을 사용해 Karakeep 북마크에 벡터 검색을 추가합니다. </Card>

<Card title="Inside-Out-2 Memory" icon="brain">
  **Community** • `memory` `beliefs` `self-model`

세션 파일을 메모리 → 신념 → 진화하는 자기 모델로 변환하는 분리된 메모리 관리자입니다. </Card>

</CardGroup>

## 🎙️ 음성 & 전화

<CardGroup cols={2}>

<Card title="Clawdia Phone Bridge" icon="phone" href="https://github.com/alejandroOPI/clawdia-bridge">
  **@alejandroOPI** • `voice` `vapi` `bridge`

Vapi 음성 어시스턴트 ↔ OpenClaw HTTP 브리지입니다. 에이전트와 거의 실시간으로 전화 통화가 가능합니다. </Card>

<Card title="OpenRouter Transcription" icon="microphone" href="https://clawhub.com/obviyus/openrouter-transcribe">
  **@obviyus** • `transcription` `multilingual` `skill`

OpenRouter (Gemini 등)를 통한 다국어 오디오 전사입니다. ClawHub 에서 이용할 수 있습니다. </Card>

</CardGroup>

## 🏗️ 인프라 & 배포

<CardGroup cols={2}>

<Card title="Home Assistant Add-on" icon="home" href="https://github.com/ngutman/openclaw-ha-addon">
  **@ngutman** • `homeassistant` `docker` `raspberry-pi`

SSH 터널 지원과 영구 상태를 갖춘 Home Assistant OS 상에서 실행되는 OpenClaw Gateway(게이트웨이)입니다. </Card>

<Card title="Home Assistant Skill" icon="toggle-on" href="https://clawhub.com/skills/homeassistant">
  **ClawHub** • `homeassistant` `skill` `automation`

자연어를 통해 Home Assistant 디바이스를 제어하고 자동화합니다. </Card>

<Card title="Nix Packaging" icon="snowflake" href="https://github.com/openclaw/nix-openclaw">
  **@openclaw** • `nix` `packaging` `deployment`

재현 가능한 배포를 위한 배터리 포함 nix 기반 OpenClaw 구성입니다. </Card>

<Card title="CalDAV Calendar" icon="calendar" href="https://clawhub.com/skills/caldav-calendar">
  **ClawHub** • `calendar` `caldav` `skill`

khal/vdirsyncer 를 사용하는 캘린더 Skill 입니다. 셀프 호스팅 캘린더 통합을 제공합니다. </Card>

</CardGroup>

## 🏠 홈 & 하드웨어

<CardGroup cols={2}>

<Card title="GoHome Automation" icon="house-signal" href="https://github.com/joshp123/gohome">
  **@joshp123** • `home` `nix` `grafana`

OpenClaw 를 인터페이스로 사용하는 Nix 네이티브 홈 자동화와 아름다운 Grafana 대시보드를 제공합니다.

  <img src="/assets/showcase/gohome-grafana.png" alt="GoHome Grafana dashboard" />
</Card>

<Card title="Roborock Vacuum" icon="robot" href="https://github.com/joshp123/gohome/tree/main/plugins/roborock">
  **@joshp123** • `vacuum` `iot` `plugin`

자연스러운 대화를 통해 Roborock 로봇 진공청소기를 제어합니다.

  <img src="/assets/showcase/roborock-screenshot.jpg" alt="Roborock status" />
</Card>

</CardGroup>

## 🌟 커뮤니티 프로젝트

<CardGroup cols={2}>

<Card title="StarSwap Marketplace" icon="star" href="https://star-swap.com/">
  **Community** • `marketplace` `astronomy` `webapp`

천문 장비를 위한 종합 마켓플레이스입니다. OpenClaw 생태계를 기반으로 구축되었습니다. </Card>

</CardGroup>

---

## 프로젝트 제출하기

공유할 내용이 있나요? 소개하고 싶습니다!

<Steps>
  <Step title="Share It">
    [Discord 의 #showcase](https://discord.gg/clawd)에 게시하거나 [@openclaw 로 트윗](https://x.com/openclaw)하세요.
  </Step>
  <Step title="Include Details">    무엇을 하는지 설명하고, 저장소/데모 링크를 제공하며, 가능하다면 스크린샷을 공유해 주세요</Step>
  <Step title="Get Featured">
    눈에 띄는 프로젝트를 이 페이지에 추가합니다.
  </Step>
</Steps>
