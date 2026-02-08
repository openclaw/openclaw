---
title: "Showcase"
description: "Real-world OpenClaw projects from the community"
summary: "Community-byggda projekt och integrationer drivna av OpenClaw"
x-i18n:
  source_path: start/showcase.md
  source_hash: b3460f6a7b994879
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:19:00Z
---

# Showcase

Riktiga projekt från communityn. Se vad folk bygger med OpenClaw.

<Info>
**Vill du bli presenterad?** Dela ditt projekt i [#showcase på Discord](https://discord.gg/clawd) eller [tagga @openclaw på X](https://x.com/openclaw).
</Info>

## 🎥 OpenClaw i praktiken

Fullständig genomgång av installationen (28 min) av VelvetShark.

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

[Se på YouTube](https://www.youtube.com/watch?v=SaWSPZoPX34)

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

[Se på YouTube](https://www.youtube.com/watch?v=mMSKQvlmFuQ)

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

[Se på YouTube](https://www.youtube.com/watch?v=5kkIJNUGFho)

## 🆕 Färskt från Discord

<CardGroup cols={2}>

<Card title="PR-granskning → Telegram-feedback" icon="code-pull-request" href="https://x.com/i/status/2010878524543131691">
  **@bangnokia** • `review` `github` `telegram`

OpenCode slutför ändringen → öppnar en PR → OpenClaw granskar diffen och svarar i Telegram med ”mindre förslag” samt ett tydligt beslut om sammanslagning (inklusive kritiska korrigeringar som ska göras först).

  <img src="/assets/showcase/pr-review-telegram.jpg" alt="OpenClaw PR-granskningsfeedback levererad i Telegram" />
</Card>

<Card title="Vinkällar‑Skill på minuter" icon="wine-glass" href="https://x.com/i/status/2010916352454791216">
  **@prades_maxime** • `skills` `local` `csv`

Bad ”Robby” (@openclaw) om en lokal vinkällar‑Skill. Den begär ett exempel på CSV‑export + var den ska lagras, och bygger/testar sedan skillen snabbt (962 flaskor i exemplet).

  <img src="/assets/showcase/wine-cellar-skill.jpg" alt="OpenClaw bygger en lokal vinkällar‑Skill från CSV" />
</Card>

<Card title="Tesco‑shopping på autopilot" icon="cart-shopping" href="https://x.com/i/status/2009724862470689131">
  **@marchattonhere** • `automation` `browser` `shopping`

Veckomeny → favoriter → boka leveranstid → bekräfta order. Inga API:er, bara webbläsarkontroll.

  <img src="/assets/showcase/tesco-shop.jpg" alt="Tesco‑shoppingautomation via chatt" />
</Card>

<Card title="SNAG: skärmdump‑till‑Markdown" icon="scissors" href="https://github.com/am-will/snag">
  **@am-will** • `devtools` `screenshots` `markdown`

Snabbtangent för ett skärmområde → Gemini Vision → omedelbar Markdown i urklipp.

  <img src="/assets/showcase/snag.png" alt="SNAG verktyg för skärmdump‑till‑Markdown" />
</Card>

<Card title="Agents UI" icon="window-maximize" href="https://releaseflow.net/kitze/agents-ui">
  **@kitze** • `ui` `skills` `sync`

Skrivbordsapp för att hantera skills/kommandon över Agents, Claude, Codex och OpenClaw.

  <img src="/assets/showcase/agents-ui.jpg" alt="Agents UI‑app" />
</Card>

<Card title="Telegram‑röstmeddelanden (papla.media)" icon="microphone" href="https://papla.media/docs">
  **Community** • `voice` `tts` `telegram`

Omsluter papla.media TTS och skickar resultatet som Telegram‑röstmeddelanden (ingen irriterande autoplay).

  <img src="/assets/showcase/papla-tts.jpg" alt="Telegram‑röstmeddelande från TTS" />
</Card>

<Card title="CodexMonitor" icon="eye" href="https://clawhub.com/odrobnik/codexmonitor">
  **@odrobnik** • `devtools` `codex` `brew`

Homebrew‑installerad hjälpare för att lista/inspektera/övervaka lokala OpenAI Codex‑sessioner (CLI + VS Code).

  <img src="/assets/showcase/codexmonitor.png" alt="CodexMonitor på ClawHub" />
</Card>

<Card title="Styrning av Bambu‑3D‑skrivare" icon="print" href="https://clawhub.com/tobiasbischoff/bambu-cli">
  **@tobiasbischoff** • `hardware` `3d-printing` `skill`

Styr och felsök BambuLab‑skrivare: status, jobb, kamera, AMS, kalibrering och mer.

  <img src="/assets/showcase/bambu-cli.png" alt="Bambu CLI‑Skill på ClawHub" />
</Card>

<Card title="Wiener Linien (Wien‑trafik)" icon="train" href="https://clawhub.com/hjanuschka/wienerlinien">
  **@hjanuschka** • `travel` `transport` `skill`

Avgångar i realtid, störningar, hissstatus och ruttplanering för Wiens kollektivtrafik.

  <img src="/assets/showcase/wienerlinien.png" alt="Wiener Linien‑Skill på ClawHub" />
</Card>

<Card title="ParentPay skolmåltider" icon="utensils" href="#">
  **@George5562** • `automation` `browser` `parenting`

Automatiserad bokning av skolmåltider i Storbritannien via ParentPay. Använder muskoordinater för pålitliga klick i tabellceller.
</Card>

<Card title="R2‑uppladdning (Send Me My Files)" icon="cloud-arrow-up" href="https://clawhub.com/skills/r2-upload">
  **@julianengel** • `files` `r2` `presigned-urls`

Ladda upp till Cloudflare R2/S3 och generera säkra försignerade nedladdningslänkar. Perfekt för fjärrinstanser av OpenClaw.
</Card>

<Card title="iOS‑app via Telegram" icon="mobile" href="#">
  **@coard** • `ios` `xcode` `testflight`

Byggde en komplett iOS‑app med kartor och röstinspelning, distribuerad till TestFlight helt via Telegram‑chatt.

  <img src="/assets/showcase/ios-testflight.jpg" alt="iOS‑app på TestFlight" />
</Card>

<Card title="Oura Ring‑hälsoassistent" icon="heart-pulse" href="#">
  **@AS** • `health` `oura` `calendar`

Personlig AI‑hälsoassistent som integrerar Oura Ring‑data med kalender, möten och gymschema.

  <img src="/assets/showcase/oura-health.png" alt="Oura Ring‑hälsoassistent" />
</Card>
<Card title="Kevs Dream Team (14+ Agents)" icon="robot" href="https://github.com/adam91holt/orchestrated-ai-articles">
  **@adam91holt** • `multi-agent` `orchestration` `architecture` `manifesto`

14+ agents under en gateway med Opus 4.5‑orkestrator som delegerar till Codex‑arbetare. Omfattande [teknisk genomgång](https://github.com/adam91holt/orchestrated-ai-articles) som täcker Dream Team‑uppställningen, modellval, sandboxing, webhooks, heartbeats och delegeringsflöden. [Clawdspace](https://github.com/adam91holt/clawdspace) för agent‑sandboxing. [Blogginlägg](https://adams-ai-journey.ghost.io/2026-the-year-of-the-orchestrator/).
</Card>

<Card title="Linear CLI" icon="terminal" href="https://github.com/Finesssee/linear-cli">
  **@NessZerra** • `devtools` `linear` `cli` `issues`

CLI för Linear som integreras med agentiska arbetsflöden (Claude Code, OpenClaw). Hantera ärenden, projekt och arbetsflöden från terminalen. Första externa PR:en sammanslagen!
</Card>

<Card title="Beeper CLI" icon="message" href="https://github.com/blqke/beepcli">
  **@jules** • `messaging` `beeper` `cli` `automation`

Läs, skicka och arkivera meddelanden via Beeper Desktop. Använder Beepers lokala MCP‑API så att agents kan hantera alla dina chattar (iMessage, WhatsApp m.fl.) på ett ställe.
</Card>

</CardGroup>

## 🤖 Automation och arbetsflöden

<CardGroup cols={2}>

<Card title="Styrning av Winix luftrenare" icon="wind" href="https://x.com/antonplex/status/2010518442471006253">
  **@antonplex** • `automation` `hardware` `air-quality`

Claude Code upptäckte och bekräftade renarens kontroller, sedan tar OpenClaw över för att hantera rummets luftkvalitet.

  <img src="/assets/showcase/winix-air-purifier.jpg" alt="Styrning av Winix luftrenare via OpenClaw" />
</Card>

<Card title="Snygga himmelsbilder" icon="camera" href="https://x.com/signalgaining/status/2010523120604746151">
  **@signalgaining** • `automation` `camera` `skill` `images`

Triggat av en takkamera: be OpenClaw ta ett himmelfoto när det ser fint ut — den designade en skill och tog bilden.

  <img src="/assets/showcase/roof-camera-sky.jpg" alt="Himmelsbild från takkamera tagen av OpenClaw" />
</Card>

<Card title="Visuell morgonbrief‑scen" icon="robot" href="https://x.com/buddyhadry/status/2010005331925954739">
  **@buddyhadry** • `automation` `briefing` `images` `telegram`

En schemalagd prompt genererar varje morgon en enda ”scen”‑bild (väder, uppgifter, datum, favoritpost/citat) via en OpenClaw‑persona.
</Card>

<Card title="Bokning av padelbana" icon="calendar-check" href="https://github.com/joshp123/padel-cli">
  **@joshp123** • `automation` `booking` `cli`
  
  Playtomic‑tillgänglighetskontroll + boknings‑CLI. Missa aldrig en ledig bana igen.
  
  <img src="/assets/showcase/padel-screenshot.jpg" alt="padel-cli skärmdump" />
</Card>

<Card title="Redovisningsintag" icon="file-invoice-dollar">
  **Community** • `automation` `email` `pdf`
  
  Samlar in PDF:er från e‑post och förbereder dokument för skatterådgivare. Månatlig bokföring på autopilot.
</Card>

<Card title="Soffpotatis‑utvecklarläge" icon="couch" href="https://davekiss.com">
  **@davekiss** • `telegram` `website` `migration` `astro`

Byggde om hela personliga webbplatsen via Telegram medan Netflix rullade — Notion → Astro, 18 inlägg migrerade, DNS till Cloudflare. Öppnade aldrig en laptop.
</Card>

<Card title="Jobbsökningsagent" icon="briefcase">
  **@attol8** • `automation` `api` `skill`

Söker jobbannonser, matchar mot CV‑nyckelord och returnerar relevanta möjligheter med länkar. Byggd på 30 minuter med JSearch API.
</Card>

<Card title="Jira Skill Builder" icon="diagram-project" href="https://x.com/jdrhyne/status/2008336434827002232">
  **@jdrhyne** • `automation` `jira` `skill` `devtools`

OpenClaw kopplades till Jira och genererade sedan en ny skill i realtid (innan den fanns på ClawHub).
</Card>

<Card title="Todoist‑Skill via Telegram" icon="list-check" href="https://x.com/iamsubhrajyoti/status/2009949389884920153">
  **@iamsubhrajyoti** • `automation` `todoist` `skill` `telegram`

Automatiserade Todoist‑uppgifter och lät OpenClaw generera skillen direkt i Telegram‑chatten.
</Card>

<Card title="TradingView‑analys" icon="chart-line">
  **@bheem1798** • `finance` `browser` `automation`

Loggar in på TradingView via webbläsarautomation, tar skärmdumpar av diagram och utför teknisk analys på begäran. Inget API behövs — bara webbläsarkontroll.
</Card>

<Card title="Slack auto‑support" icon="slack">
  **@henrymascot** • `slack` `automation` `support`

Bevakar företagets Slack‑kanal, svarar hjälpsamt och vidarebefordrar aviseringar till Telegram. Fixade autonomt en produktionsbugg i en driftsatt app utan att bli ombedd.
</Card>

</CardGroup>

## 🧠 Kunskap och minne

<CardGroup cols={2}>

<Card title="xuezh kinesisk inlärning" icon="language" href="https://github.com/joshp123/xuezh">
  **@joshp123** • `learning` `voice` `skill`
  
  Motor för kinesisk språkinlärning med uttalsfeedback och studieflöden via OpenClaw.
  
  <img src="/assets/showcase/xuezh-pronunciation.jpeg" alt="xuezh uttalsfeedback" />
</Card>

<Card title="WhatsApp Memory Vault" icon="vault">
  **Community** • `memory` `transcription` `indexing`
  
  Importerar fullständiga WhatsApp‑exporter, transkriberar 1k+ röstmeddelanden, korskontrollerar med git‑loggar och producerar länkade Markdown‑rapporter.
</Card>

<Card title="Karakeep semantisk sökning" icon="magnifying-glass" href="https://github.com/jamesbrooksco/karakeep-semantic-search">
  **@jamesbrooksco** • `search` `vector` `bookmarks`
  
  Lägger till vektorsökning i Karakeep‑bokmärken med Qdrant + OpenAI/Ollama‑embeddingar.
</Card>

<Card title="Inside‑Out‑2‑minne" icon="brain">
  **Community** • `memory` `beliefs` `self-model`
  
  Separat minneshanterare som omvandlar sessionsfiler till minnen → övertygelser → en utvecklande självmodell.
</Card>

</CardGroup>

## 🎙️ Röst och telefoni

<CardGroup cols={2}>

<Card title="Clawdia telefonbrygga" icon="phone" href="https://github.com/alejandroOPI/clawdia-bridge">
  **@alejandroOPI** • `voice` `vapi` `bridge`
  
  Vapi‑röstassistent ↔ OpenClaw HTTP‑brygga. Telefonsamtal i nära realtid med din agent.
</Card>

<Card title="OpenRouter‑transkribering" icon="microphone" href="https://clawhub.com/obviyus/openrouter-transcribe">
  **@obviyus** • `transcription` `multilingual` `skill`

Flerspråkig ljudtranskribering via OpenRouter (Gemini m.fl.). Tillgänglig på ClawHub.
</Card>

</CardGroup>

## 🏗️ Infrastruktur och driftsättning

<CardGroup cols={2}>

<Card title="Home Assistant‑tillägg" icon="home" href="https://github.com/ngutman/openclaw-ha-addon">
  **@ngutman** • `homeassistant` `docker` `raspberry-pi`
  
  OpenClaw‑gateway som körs på Home Assistant OS med stöd för SSH‑tunnel och persistent tillstånd.
</Card>

<Card title="Home Assistant‑Skill" icon="toggle-on" href="https://clawhub.com/skills/homeassistant">
  **ClawHub** • `homeassistant` `skill` `automation`
  
  Styr och automatisera Home Assistant‑enheter via naturligt språk.
</Card>

<Card title="Nix‑paketering" icon="snowflake" href="https://github.com/openclaw/nix-openclaw">
  **@openclaw** • `nix` `packaging` `deployment`
  
  Batterier‑ingår‑nixifierad OpenClaw‑konfiguration för reproducerbara driftsättningar.
</Card>

<Card title="CalDAV‑kalender" icon="calendar" href="https://clawhub.com/skills/caldav-calendar">
  **ClawHub** • `calendar` `caldav` `skill`
  
  Kalender‑Skill som använder khal/vdirsyncer. Självhostad kalenderintegration.
</Card>

</CardGroup>

## 🏠 Hem och hårdvara

<CardGroup cols={2}>

<Card title="GoHome‑automation" icon="house-signal" href="https://github.com/joshp123/gohome">
  **@joshp123** • `home` `nix` `grafana`
  
  Nix‑native hemautomation med OpenClaw som gränssnitt, plus snygga Grafana‑dashboards.
  
  <img src="/assets/showcase/gohome-grafana.png" alt="GoHome Grafana‑dashboard" />
</Card>

<Card title="Roborock‑dammsugare" icon="robot" href="https://github.com/joshp123/gohome/tree/main/plugins/roborock">
  **@joshp123** • `vacuum` `iot` `plugin`
  
  Styr din Roborock‑robotdammsugare via naturlig konversation.
  
  <img src="/assets/showcase/roborock-screenshot.jpg" alt="Roborock‑status" />
</Card>

</CardGroup>

## 🌟 Community‑projekt

<CardGroup cols={2}>

<Card title="StarSwap‑marknadsplats" icon="star" href="https://star-swap.com/">
  **Community** • `marketplace` `astronomy` `webapp`
  
  Fullständig marknadsplats för astronomiutrustning. Byggd med/kring OpenClaw‑ekosystemet.
</Card>

</CardGroup>

---

## Skicka in ditt projekt

Har du något att dela? Vi vill gärna presentera det!

<Steps>
  <Step title="Dela det">
    Posta i [#showcase på Discord](https://discord.gg/clawd) eller [twittra @openclaw](https://x.com/openclaw)
  </Step>
  <Step title="Inkludera detaljer">
    Berätta vad det gör, länka till repo/demo och dela en skärmdump om du har en
  </Step>
  <Step title="Bli presenterad">
    Vi lägger till utmärkande projekt på den här sidan
  </Step>
</Steps>
