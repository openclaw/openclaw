# Activity icon sources

Each plugin owns `assets/activity.svg` for compact chat activity. Optional `assets/activity/<tool-name>.svg` files describe individual actions. Package branding remains in `assets/icon.png`.

Activity assets use a transparent background and monochrome geometry. They contain no scripts, stylesheets, fonts, external references, or embedded images. Metadata and redundant wrappers are removed; shapes with identical presentation attributes are combined into paths to fit the existing four-element SVG limit. The marks remain the property of their respective owners.

## Existing provider marks

The following defaults reuse the corresponding files in [`ui/public/provider-icons`](../ui/public/provider-icons). Original sources and license notices are retained in [provider icon attribution](../ui/public/provider-icons/ATTRIBUTION.md). The mappings match the existing compact provider picker. Colors are normalized to `currentColor`; geometry and view boxes are retained.

| Plugin                  | Source file                    |
| ----------------------- | ------------------------------ |
| `alibaba`               | `ProviderIcon-alibaba.svg`     |
| `amazon-bedrock`        | `ProviderIcon-bedrock.svg`     |
| `amazon-bedrock-mantle` | `ProviderIcon-bedrock.svg`     |
| `anthropic`             | `ProviderIcon-claude.svg`      |
| `anthropic-vertex`      | `ProviderIcon-claude.svg`      |
| `arcee`                 | `ProviderIcon-arcee.svg`       |
| `azure-speech`          | `ProviderIcon-microsoft.svg`   |
| `baseten`               | `ProviderIcon-baseten.svg`     |
| `byteplus`              | `ProviderIcon-byteplus.svg`    |
| `cerebras`              | `ProviderIcon-cerebras.svg`    |
| `chutes`                | `ProviderIcon-chutes.svg`      |
| `clawrouter`            | `ProviderIcon-clawrouter.svg`  |
| `cloudflare-ai-gateway` | `ProviderIcon-cloudflare.svg`  |
| `codex`                 | `ProviderIcon-codex.svg`       |
| `cohere`                | `ProviderIcon-cohere.svg`      |
| `comfy`                 | `ProviderIcon-comfy.svg`       |
| `copilot`               | `ProviderIcon-copilot.svg`     |
| `copilot-proxy`         | `ProviderIcon-copilot.svg`     |
| `deepgram`              | `ProviderIcon-deepgram.svg`    |
| `deepinfra`             | `ProviderIcon-deepinfra.svg`   |
| `deepseek`              | `ProviderIcon-deepseek.svg`    |
| `elevenlabs`            | `ProviderIcon-elevenlabs.svg`  |
| `fal`                   | `ProviderIcon-fal.svg`         |
| `featherless`           | `ProviderIcon-featherless.svg` |
| `fireworks`             | `ProviderIcon-fireworks.svg`   |
| `github-copilot`        | `ProviderIcon-copilot.svg`     |
| `google`                | `ProviderIcon-gemini.svg`      |
| `groq`                  | `ProviderIcon-groq.svg`        |
| `huggingface`           | `ProviderIcon-huggingface.svg` |
| `kilocode`              | `ProviderIcon-kilo.svg`        |
| `kimi-coding`           | `ProviderIcon-kimi.svg`        |
| `litellm`               | `ProviderIcon-litellm.svg`     |
| `llama-cpp`             | `ProviderIcon-llamacpp.svg`    |
| `lmstudio`              | `ProviderIcon-lmstudio.svg`    |
| `longcat`               | `ProviderIcon-longcat.svg`     |
| `meta`                  | `ProviderIcon-meta.svg`        |
| `microsoft`             | `ProviderIcon-microsoft.svg`   |
| `microsoft-foundry`     | `ProviderIcon-microsoft.svg`   |
| `minimax`               | `ProviderIcon-minimax.svg`     |
| `mistral`               | `ProviderIcon-mistral.svg`     |
| `moonshot`              | `ProviderIcon-kimi.svg`        |
| `novita`                | `ProviderIcon-novita.svg`      |
| `nvidia`                | `ProviderIcon-nvidia.svg`      |
| `ollama`                | `ProviderIcon-ollama.svg`      |
| `openai`                | `ProviderIcon-codex.svg`       |
| `opencode`              | `ProviderIcon-opencode.svg`    |
| `opencode-go`           | `ProviderIcon-opencodego.svg`  |
| `openrouter`            | `ProviderIcon-openrouter.svg`  |
| `perplexity`            | `ProviderIcon-perplexity.svg`  |
| `pixverse`              | `ProviderIcon-pixverse.svg`    |
| `qianfan`               | `ProviderIcon-qianfan.svg`     |
| `qwen`                  | `ProviderIcon-alibaba.svg`     |
| `runway`                | `ProviderIcon-runway.svg`      |
| `stepfun`               | `ProviderIcon-stepfun.svg`     |
| `synthetic`             | `ProviderIcon-synthetic.svg`   |
| `tencent`               | `ProviderIcon-tencent.svg`     |
| `together`              | `ProviderIcon-together.svg`    |
| `venice`                | `ProviderIcon-venice.svg`      |
| `vercel-ai-gateway`     | `ProviderIcon-vercel.svg`      |
| `vllm`                  | `ProviderIcon-vllm.svg`        |
| `volcengine`            | `ProviderIcon-volcengine.svg`  |
| `xai`                   | `ProviderIcon-grok.svg`        |
| `xiaomi`                | `ProviderIcon-mimo.svg`        |
| `zai`                   | `ProviderIcon-zai.svg`         |

For LiteLLM, the small source stroke widths are unified at 1.35 source units before combining paths. Stepfun retains its base cutout mark and omits the duplicate gradient overlay. OpenRouter omits the redundant view-box clipping wrapper. Synthetic’s circle rotation around its own center is omitted; its position, radius, and parent transform are unchanged.

## Additional service marks

[Simple Icons](https://github.com/simple-icons/simple-icons) assets are copied from the pinned npm packages below and distributed under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). The original single-path geometry is unchanged except for iMessage: its rounded-square app plate is removed, leaving the original speech-bubble contour. Slack, Microsoft Teams, and Zalo use the most recent pinned package in this table that contains the required mark.

| Plugin                   | Source package                                                                 | Icon                 |
| ------------------------ | ------------------------------------------------------------------------------ | -------------------- |
| `brave`                  | [`simple-icons@16.31.0`](https://www.npmjs.com/package/simple-icons/v/16.31.0) | `brave.svg`          |
| `diagnostics-otel`       | [`simple-icons@16.31.0`](https://www.npmjs.com/package/simple-icons/v/16.31.0) | `opentelemetry.svg`  |
| `diagnostics-prometheus` | [`simple-icons@16.31.0`](https://www.npmjs.com/package/simple-icons/v/16.31.0) | `prometheus.svg`     |
| `discord`                | [`simple-icons@16.31.0`](https://www.npmjs.com/package/simple-icons/v/16.31.0) | `discord.svg`        |
| `duckduckgo`             | [`simple-icons@16.31.0`](https://www.npmjs.com/package/simple-icons/v/16.31.0) | `duckduckgo.svg`     |
| `fish-audio-speech`      | [`simple-icons@16.31.0`](https://www.npmjs.com/package/simple-icons/v/16.31.0) | `fishaudio.svg`      |
| `google-meet`            | [`simple-icons@16.31.0`](https://www.npmjs.com/package/simple-icons/v/16.31.0) | `googlemeet.svg`     |
| `googlechat`             | [`simple-icons@16.31.0`](https://www.npmjs.com/package/simple-icons/v/16.31.0) | `googlechat.svg`     |
| `imessage`               | [`simple-icons@16.31.0`](https://www.npmjs.com/package/simple-icons/v/16.31.0) | `imessage.svg`       |
| `line`                   | [`simple-icons@16.31.0`](https://www.npmjs.com/package/simple-icons/v/16.31.0) | `line.svg`           |
| `matrix`                 | [`simple-icons@16.31.0`](https://www.npmjs.com/package/simple-icons/v/16.31.0) | `matrix.svg`         |
| `mattermost`             | [`simple-icons@16.31.0`](https://www.npmjs.com/package/simple-icons/v/16.31.0) | `mattermost.svg`     |
| `msteams`                | [`simple-icons@11.15.0`](https://www.npmjs.com/package/simple-icons/v/11.15.0) | `microsoftteams.svg` |
| `nextcloud-talk`         | [`simple-icons@16.31.0`](https://www.npmjs.com/package/simple-icons/v/16.31.0) | `nextcloud.svg`      |
| `onepassword`            | [`simple-icons@16.31.0`](https://www.npmjs.com/package/simple-icons/v/16.31.0) | `1password.svg`      |
| `searxng`                | [`simple-icons@16.31.0`](https://www.npmjs.com/package/simple-icons/v/16.31.0) | `searxng.svg`        |
| `signal`                 | [`simple-icons@16.31.0`](https://www.npmjs.com/package/simple-icons/v/16.31.0) | `signal.svg`         |
| `slack`                  | [`simple-icons@13.21.0`](https://www.npmjs.com/package/simple-icons/v/13.21.0) | `slack.svg`          |
| `teams-meetings`         | [`simple-icons@11.15.0`](https://www.npmjs.com/package/simple-icons/v/11.15.0) | `microsoftteams.svg` |
| `telegram`               | [`simple-icons@16.31.0`](https://www.npmjs.com/package/simple-icons/v/16.31.0) | `telegram.svg`       |
| `twitch`                 | [`simple-icons@16.31.0`](https://www.npmjs.com/package/simple-icons/v/16.31.0) | `twitch.svg`         |
| `vault`                  | [`simple-icons@16.31.0`](https://www.npmjs.com/package/simple-icons/v/16.31.0) | `vault.svg`          |
| `whatsapp`               | [`simple-icons@16.31.0`](https://www.npmjs.com/package/simple-icons/v/16.31.0) | `whatsapp.svg`       |
| `zalo`                   | [`simple-icons@13.21.0`](https://www.npmjs.com/package/simple-icons/v/13.21.0) | `zalo.svg`           |
| `zalouser`               | [`simple-icons@13.21.0`](https://www.npmjs.com/package/simple-icons/v/13.21.0) | `zalo.svg`           |

Exa, Firecrawl, Tavily, and Voyage use the corresponding monochrome `exa.svg`, `firecrawl.svg`, `tavily.svg`, and `voyage.svg` files from [`@lobehub/icons-static-svg@1.95.0`](https://www.npmjs.com/package/@lobehub/icons-static-svg/v/1.95.0). Their geometry is unchanged. Source: [Lobe Icons](https://github.com/lobehub/lobe-icons), MIT license.

## OpenClaw action glyphs

Browser, Canvas, Diffs, and the memory family preserve the approved shapes from [`icons-tools.ts`](../ui/src/components/icons-tools.ts). The optional overrides preserve Intent, memory store/forget, file fetch/write, and directory list/fetch geometry. Lobster preserves both progress-claw paths, with a solid fill and the jaw’s resting `rotate(-10 8.6 11)` transform from [`working-indicator.css`](../ui/src/styles/chat/working-indicator.css). Linux Node reuses the existing platform silhouette from [`brand-icons.ts`](../ui/src/pages/apps/brand-icons.ts).

Other defaults are OpenClaw functional glyphs drawn for the 24-unit activity grid. They indicate the capability rather than reproducing a service’s larger app tile. Related actions deliberately share a visual family:

| Capability              | Plugins                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Agent or task flow      | `a2a`, `acpx`, `llm-task`, `raft`, `reef`                                                                        |
| Connections and sharing | `admin-http-rpc`, `beam`, `bonjour`, `device-pair`, `session-share`, `webhooks`                                  |
| Chat and meetings       | `buzz`, `clickclack`, `feishu`, `irc`, `nostr`, `sms`, `synology-chat`, `tlon`, `zoom-meetings`                  |
| Files and knowledge     | `document-extract`, `file-transfer`, `imap`, `logbook`, `memory-wiki`, `oc-path`, `web-readability`, `workboard` |
| Compute and location    | `crabbox`, `cua-computer`, `geolocation`, `gmi`, `radius`, `sglang`                                              |
| Security and migration  | `migrate-claude`, `migrate-hermes`, `mxc`, `openshell`, `policy`, `visitor-access`                               |
| Audio and media         | `gradium`, `inworld`, `senseaudio`, `talk-voice`, `tts-local-cli`, `voice-call`, `vydra`                         |
| Utilities and reports   | `parallel`, `qa-channel`, `qa-lab`, `team-reports`, `tokenjuice`                                                 |

## License notices

Imported SVGs carry their source references and applicable license notices in XML comments, so the notices remain present when a plugin is packaged independently. Existing provider assets carry their source-specific CodexBar, Lobe Icons, llama.cpp, or official-brand notices; Simple Icons assets carry CC0 1.0. These comments do not add SVG elements or alter the rendered geometry. The following MIT notice also applies to the additional Lobe Icons copies.

MIT License

Copyright (c) 2023 LobeHub

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
