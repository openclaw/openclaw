---
title: "쇼케이스"
summary: "OpenClaw 로 구동되는 커뮤니티 프로젝트 및 통합"
read_when:
  - 실제 OpenClaw 사용 사례를 찾고 있을 때
  - 커뮤니티 프로젝트 하이라이트를 업데이트할 때
x-i18n:
  source_path: docs/start/showcase.md
---

# 쇼케이스

커뮤니티의 실제 프로젝트들입니다. 사람들이 OpenClaw 로 무엇을 만들고 있는지 살펴보세요.

<Info>
**소개되고 싶으신가요?** [Discord 의 #showcase](https://discord.gg/clawd) 에서 프로젝트를 공유하거나 [X 에서 @openclaw 태그](https://x.com/openclaw)를 해주세요.
</Info>

## 🎥 OpenClaw 실제 사용

VelvetShark 의 전체 설정 워크스루 (28 분).

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

[YouTube 에서 보기](https://www.youtube.com/watch?v=SaWSPZoPX34)

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

[YouTube 에서 보기](https://www.youtube.com/watch?v=mMSKQvlmFuQ)

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

[YouTube 에서 보기](https://www.youtube.com/watch?v=5kkIJNUGFho)

## 🆕 Discord 에서 새로 올라온 프로젝트

<CardGroup cols={2}>

<Card title="PR 리뷰 → Telegram 피드백" icon="code-pull-request" href="https://x.com/i/status/2010878524543131691">
  **@bangnokia** • `review` `github` `telegram`

OpenCode 가 변경을 완료하고 → PR 을 열고 → OpenClaw 가 diff 를 리뷰하고 "사소한 제안"과 함께 명확한 머지 판정(먼저 적용할 중요 수정 사항 포함)을 Telegram 으로 응답합니다.

  <img src="/assets/showcase/pr-review-telegram.jpg" alt="OpenClaw PR review feedback delivered in Telegram" />
</Card>

<Card title="몇 분 만에 와인 셀러 Skill" icon="wine-glass" href="https://x.com/i/status/2010916352454791216">
  **@prades_maxime** • `skills` `local` `csv`

"Robby"(@openclaw)에게 로컬 와인 셀러 Skill 을 요청했습니다. 샘플 CSV 내보내기와 저장 위치를 요청한 후, 빠르게 Skill 을 빌드/테스트합니다(예시에서 962 병).

  <img src="/assets/showcase/wine-cellar-skill.jpg" alt="OpenClaw building a local wine cellar skill from CSV" />
</Card>

<Card title="Tesco 장보기 자동화" icon="cart-shopping" href="https://x.com/i/status/2009724862470689131">
  **@marchattonhere** • `automation` `browser` `shopping`

주간 식단 계획 → 정기 구매 → 배송 슬롯 예약 → 주문 확인. API 없이 브라우저 제어만으로 가능합니다.

  <img src="/assets/showcase/tesco-shop.jpg" alt="Tesco shop automation via chat" />
</Card>

<Card title="SNAG 스크린샷-to-Markdown" icon="scissors" href="https://github.com/am-will/snag">
  **@am-will** • `devtools` `screenshots` `markdown`

화면 영역을 단축키로 캡처 → Gemini 비전 → 즉시 Markdown 으로 클립보드에 복사.

  <img src="/assets/showcase/snag.png" alt="SNAG screenshot-to-markdown tool" />
</Card>

<Card title="Agents UI" icon="window-maximize" href="https://releaseflow.net/kitze/agents-ui">
  **@kitze** • `ui` `skills` `sync`

Agents, Claude, Codex, OpenClaw 전반에서 Skills/명령을 관리하는 데스크톱 앱.

  <img src="/assets/showcase/agents-ui.jpg" alt="Agents UI app" />
</Card>

<Card title="Telegram 음성 노트 (papla.media)" icon="microphone" href="https://papla.media/docs">
  **커뮤니티** • `voice` `tts` `telegram`

papla.media TTS 를 래핑하여 결과를 Telegram 음성 노트로 전송합니다(성가신 자동 재생 없음).

  <img src="/assets/showcase/papla-tts.jpg" alt="Telegram voice note output from TTS" />
</Card>

<Card title="CodexMonitor" icon="eye" href="https://clawhub.com/odrobnik/codexmonitor">
  **@odrobnik** • `devtools` `codex` `brew`

로컬 OpenAI Codex 세션을 목록/검사/감시하는 Homebrew 설치 헬퍼 (CLI + VS Code).

  <img src="/assets/showcase/codexmonitor.png" alt="CodexMonitor on ClawHub" />
</Card>

<Card title="Bambu 3D 프린터 제어" icon="print" href="https://clawhub.com/tobiasbischoff/bambu-cli">
  **@tobiasbischoff** • `hardware` `3d-printing` `skill`

BambuLab 프린터 제어 및 문제 해결: 상태, 작업, 카메라, AMS, 캘리브레이션 등.

  <img src="/assets/showcase/bambu-cli.png" alt="Bambu CLI skill on ClawHub" />
</Card>

<Card title="비엔나 교통 (Wiener Linien)" icon="train" href="https://clawhub.com/hjanuschka/wienerlinien">
  **@hjanuschka** • `travel` `transport` `skill`

비엔나 대중교통의 실시간 출발, 장애 정보, 엘리베이터 상태, 경로 안내.

  <img src="/assets/showcase/wienerlinien.png" alt="Wiener Linien skill on ClawHub" />
</Card>

<Card title="ParentPay 학교 급식" icon="utensils" href="#">
  **@George5562** • `automation` `browser` `parenting`

ParentPay 를 통한 영국 학교 급식 자동 예약. 안정적인 테이블 셀 클릭을 위해 마우스 좌표를 사용합니다.
</Card>

<Card title="R2 업로드 (Send Me My Files)" icon="cloud-arrow-up" href="https://clawhub.com/skills/r2-upload">
  **@julianengel** • `files` `r2` `presigned-urls`

Cloudflare R2/S3 에 업로드하고 안전한 사전 서명 다운로드 링크를 생성합니다. 원격 OpenClaw 인스턴스에 최적입니다.
</Card>

<Card title="Telegram 을 통한 iOS 앱" icon="mobile" href="#">
  **@coard** • `ios` `xcode` `testflight`

지도와 음성 녹음이 포함된 완전한 iOS 앱을 만들고, Telegram 채팅만으로 TestFlight 에 배포했습니다.

  <img src="/assets/showcase/ios-testflight.jpg" alt="iOS app on TestFlight" />
</Card>

<Card title="Oura Ring 건강 어시스턴트" icon="heart-pulse" href="#">
  **@AS** • `health` `oura` `calendar`

Oura 링 데이터를 캘린더, 예약, 헬스장 스케줄과 통합하는 개인 AI 건강 어시스턴트.

  <img src="/assets/showcase/oura-health.png" alt="Oura ring health assistant" />
</Card>
<Card title="Kev 의 드림 팀 (14+ 에이전트)" icon="robot" href="https://github.com/adam91holt/orchestrated-ai-articles">
  **@adam91holt** • `multi-agent` `orchestration` `architecture` `manifesto`

하나의 Gateway 아래 14 개 이상의 에이전트, Opus 4.5 오케스트레이터가 Codex 워커에게 위임. 드림 팀 구성, 모델 선택, 샌드박싱, 웹훅, 하트비트, 위임 흐름을 다루는 종합 [기술 문서](https://github.com/adam91holt/orchestrated-ai-articles). 에이전트 샌드박싱을 위한 [Clawdspace](https://github.com/adam91holt/clawdspace). [블로그 포스트](https://adams-ai-journey.ghost.io/2026-the-year-of-the-orchestrator/).
</Card>

<Card title="Linear CLI" icon="terminal" href="https://github.com/Finesssee/linear-cli">
  **@NessZerra** • `devtools` `linear` `cli` `issues`

에이전트 워크플로(Claude Code, OpenClaw)와 통합되는 Linear 용 CLI. 터미널에서 이슈, 프로젝트, 워크플로를 관리합니다. 첫 외부 PR 이 머지되었습니다!
</Card>

<Card title="Beeper CLI" icon="message" href="https://github.com/blqke/beepcli">
  **@jules** • `messaging` `beeper` `cli` `automation`

Beeper Desktop 을 통해 메시지를 읽고, 보내고, 보관합니다. Beeper 로컬 MCP API 를 사용하여 에이전트가 모든 채팅(iMessage, WhatsApp 등)을 한 곳에서 관리할 수 있습니다.
</Card>

</CardGroup>

## 🤖 자동화 및 워크플로

<CardGroup cols={2}>

<Card title="Winix 공기청정기 제어" icon="wind" href="https://x.com/antonplex/status/2010518442471006253">
  **@antonplex** • `automation` `hardware` `air-quality`

Claude Code 가 공기청정기 제어를 발견하고 확인한 후, OpenClaw 가 실내 공기질을 관리합니다.

  <img src="/assets/showcase/winix-air-purifier.jpg" alt="Winix air purifier control via OpenClaw" />
</Card>

<Card title="예쁜 하늘 카메라 촬영" icon="camera" href="https://x.com/signalgaining/status/2010523120604746151">
  **@signalgaining** • `automation` `camera` `skill` `images`

옥상 카메라로 트리거: 하늘이 예쁠 때마다 OpenClaw 에게 사진을 찍어달라고 요청 — Skill 을 설계하고 촬영했습니다.

  <img src="/assets/showcase/roof-camera-sky.jpg" alt="Roof camera sky snapshot captured by OpenClaw" />
</Card>

<Card title="시각적 모닝 브리핑 씬" icon="robot" href="https://x.com/buddyhadry/status/2010005331925954739">
  **@buddyhadry** • `automation` `briefing` `images` `telegram`

예약된 프롬프트가 매일 아침 하나의 "씬" 이미지(날씨, 할 일, 날짜, 좋아하는 게시물/인용문)를 OpenClaw 페르소나를 통해 생성합니다.
</Card>

<Card title="파델 코트 예약" icon="calendar-check" href="https://github.com/joshp123/padel-cli">
  **@joshp123** • `automation` `booking` `cli`

Playtomic 가용성 확인 + 예약 CLI. 빈 코트를 다시는 놓치지 마세요.

  <img src="/assets/showcase/padel-screenshot.jpg" alt="padel-cli screenshot" />
</Card>

<Card title="회계 접수" icon="file-invoice-dollar">
  **커뮤니티** • `automation` `email` `pdf`

이메일에서 PDF 를 수집하고 세무사를 위한 문서를 준비합니다. 자동 월간 회계 처리.
</Card>

<Card title="소파 감자 개발 모드" icon="couch" href="https://davekiss.com">
  **@davekiss** • `telegram` `website` `migration` `astro`

Netflix 를 보면서 Telegram 으로 전체 개인 사이트를 재구축 — Notion → Astro, 18 개 포스트 마이그레이션, DNS 를 Cloudflare 로. 노트북을 열지도 않았습니다.
</Card>

<Card title="구직 에이전트" icon="briefcase">
  **@attol8** • `automation` `api` `skill`

구인 목록을 검색하고, CV 키워드와 매칭하여, 링크와 함께 관련 기회를 반환합니다. JSearch API 를 사용하여 30 분 만에 구축했습니다.
</Card>

<Card title="Jira Skill 빌더" icon="diagram-project" href="https://x.com/jdrhyne/status/2008336434827002232">
  **@jdrhyne** • `automation` `jira` `skill` `devtools`

OpenClaw 가 Jira 에 연결한 후, 즉석에서 새로운 Skill 을 생성했습니다(ClawHub 에 존재하기 전에).
</Card>

<Card title="Telegram 을 통한 Todoist Skill" icon="list-check" href="https://x.com/iamsubhrajyoti/status/2009949389884920153">
  **@iamsubhrajyoti** • `automation` `todoist` `skill` `telegram`

Todoist 작업을 자동화하고 OpenClaw 가 Telegram 채팅에서 직접 Skill 을 생성하도록 했습니다.
</Card>

<Card title="TradingView 분석" icon="chart-line">
  **@bheem1798** • `finance` `browser` `automation`

브라우저 자동화를 통해 TradingView 에 로그인하고, 차트를 스크린샷으로 캡처하고, 요청 시 기술적 분석을 수행합니다. API 불필요 — 브라우저 제어만으로 가능합니다.
</Card>

<Card title="Slack 자동 지원" icon="slack">
  **@henrymascot** • `slack` `automation` `support`

회사 Slack 채널을 감시하고, 도움이 되는 응답을 하며, Telegram 으로 알림을 전달합니다. 요청 없이 배포된 앱의 프로덕션 버그를 자율적으로 수정했습니다.
</Card>

</CardGroup>

## 🧠 지식 및 메모리

<CardGroup cols={2}>

<Card title="xuezh 중국어 학습" icon="language" href="https://github.com/joshp123/xuezh">
  **@joshp123** • `learning` `voice` `skill`

OpenClaw 를 통한 발음 피드백 및 학습 흐름이 포함된 중국어 학습 엔진.

  <img src="/assets/showcase/xuezh-pronunciation.jpeg" alt="xuezh pronunciation feedback" />
</Card>

<Card title="WhatsApp 메모리 볼트" icon="vault">
  **커뮤니티** • `memory` `transcription` `indexing`

전체 WhatsApp 내보내기를 수집하고, 1,000 개 이상의 음성 노트를 전사하고, git 로그와 교차 확인하여 링크된 마크다운 보고서를 출력합니다.
</Card>

<Card title="Karakeep 시맨틱 검색" icon="magnifying-glass" href="https://github.com/jamesbrooksco/karakeep-semantic-search">
  **@jamesbrooksco** • `search` `vector` `bookmarks`

Qdrant + OpenAI/Ollama 임베딩을 사용하여 Karakeep 북마크에 벡터 검색을 추가합니다.
</Card>

<Card title="Inside-Out-2 메모리" icon="brain">
  **커뮤니티** • `memory` `beliefs` `self-model`

세션 파일을 메모리 → 신념 → 진화하는 자기 모델로 변환하는 별도의 메모리 매니저.
</Card>

</CardGroup>

## 🎙️ 음성 및 전화

<CardGroup cols={2}>

<Card title="Clawdia Phone Bridge" icon="phone" href="https://github.com/alejandroOPI/clawdia-bridge">
  **@alejandroOPI** • `voice` `vapi` `bridge`

Vapi 음성 어시스턴트 ↔ OpenClaw HTTP 브릿지. 에이전트와 거의 실시간 전화 통화.
</Card>

<Card title="OpenRouter 전사" icon="microphone" href="https://clawhub.com/obviyus/openrouter-transcribe">
  **@obviyus** • `transcription` `multilingual` `skill`

OpenRouter(Gemini 등)를 통한 다국어 오디오 전사. ClawHub 에서 사용 가능합니다.
</Card>

</CardGroup>

## 🏗️ 인프라 및 배포

<CardGroup cols={2}>

<Card title="Home Assistant 애드온" icon="home" href="https://github.com/ngutman/openclaw-ha-addon">
  **@ngutman** • `homeassistant` `docker` `raspberry-pi`

SSH 터널 지원과 영구 상태를 갖춘 Home Assistant OS 에서 실행되는 OpenClaw Gateway.
</Card>

<Card title="Home Assistant Skill" icon="toggle-on" href="https://clawhub.com/skills/homeassistant">
  **ClawHub** • `homeassistant` `skill` `automation`

자연어를 통해 Home Assistant 디바이스를 제어하고 자동화합니다.
</Card>

<Card title="Nix 패키징" icon="snowflake" href="https://github.com/openclaw/nix-openclaw">
  **@openclaw** • `nix` `packaging` `deployment`

재현 가능한 배포를 위한 배터리 포함 nixified OpenClaw 구성.
</Card>

<Card title="CalDAV 캘린더" icon="calendar" href="https://clawhub.com/skills/caldav-calendar">
  **ClawHub** • `calendar` `caldav` `skill`

khal/vdirsyncer 를 사용하는 캘린더 Skill. 셀프 호스팅 캘린더 통합.
</Card>

</CardGroup>

## 🏠 홈 및 하드웨어

<CardGroup cols={2}>

<Card title="GoHome 자동화" icon="house-signal" href="https://github.com/joshp123/gohome">
  **@joshp123** • `home` `nix` `grafana`

OpenClaw 를 인터페이스로 사용하는 Nix 네이티브 홈 자동화와 아름다운 Grafana 대시보드.

  <img src="/assets/showcase/gohome-grafana.png" alt="GoHome Grafana dashboard" />
</Card>

<Card title="Roborock 로봇청소기" icon="robot" href="https://github.com/joshp123/gohome/tree/main/plugins/roborock">
  **@joshp123** • `vacuum` `iot` `plugin`

자연스러운 대화를 통해 Roborock 로봇청소기를 제어합니다.

  <img src="/assets/showcase/roborock-screenshot.jpg" alt="Roborock status" />
</Card>

</CardGroup>

## 🌟 커뮤니티 프로젝트

<CardGroup cols={2}>

<Card title="StarSwap 마켓플레이스" icon="star" href="https://star-swap.com/">
  **커뮤니티** • `marketplace` `astronomy` `webapp`

완전한 천문 장비 마켓플레이스. OpenClaw 생태계를 기반으로 구축되었습니다.
</Card>

</CardGroup>

---

## 프로젝트 제출

공유할 것이 있으신가요? 소개해 드리고 싶습니다!

<Steps>
  <Step title="공유하기">
    [Discord 의 #showcase](https://discord.gg/clawd) 에 게시하거나 [@openclaw 트윗](https://x.com/openclaw)하세요
  </Step>
  <Step title="세부 정보 포함">
    무엇을 하는지 알려주고, 레포/데모 링크를 첨부하고, 스크린샷이 있으면 공유해 주세요
  </Step>
  <Step title="소개되기">
    눈에 띄는 프로젝트를 이 페이지에 추가해 드리겠습니다
  </Step>
</Steps>
