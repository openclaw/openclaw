---
summary: "TinyFish plugin: hosted browser automation for public multi-step workflows"
read_when:
  - You want hosted browser automation from OpenClaw
  - You are configuring or developing the TinyFish plugin
title: "TinyFish"
---

# TinyFish

TinyFish adds a hosted browser automation tool to OpenClaw for complex public
web workflows: multi-step navigation, forms, JS-heavy pages, geo-aware proxy
routing, and structured extraction.

Quick mental model:

- Enable the bundled plugin
- Configure `plugins.entries.tinyfish.config`
- Use the `tinyfish_automation` tool for public browser workflows
- Get back `run_id`, `status`, `result`, and a live `streaming_url` when TinyFish provides one

## Where it runs

The TinyFish plugin runs inside the Gateway process, but the browser automation
it triggers runs on TinyFish's hosted infrastructure.

If you use a remote Gateway, enable and configure the plugin on the machine
running the Gateway.

## Enable

TinyFish ships as a bundled plugin and is disabled by default.

```json5
{
  plugins: {
    entries: {
      tinyfish: {
        enabled: true,
      },
    },
  },
}
```

Restart the Gateway after enabling it.

## Config

Set config under `plugins.entries.tinyfish.config`:

```json5
{
  plugins: {
    entries: {
      tinyfish: {
        enabled: true,
        config: {
          apiKey: "tf_live_...",
          // Optional; defaults to https://agent.tinyfish.ai
          baseUrl: "https://agent.tinyfish.ai",
        },
      },
    },
  },
}
```

You can also supply the API key through `TINYFISH_API_KEY`.

## Tool

The plugin registers one tool:

### tinyfish_automation

Run hosted browser automation against a public website.

| Parameter         | Required | Description                                                       |
| ----------------- | -------- | ----------------------------------------------------------------- |
| `url`             | Yes      | Target public website URL                                         |
| `goal`            | Yes      | Natural-language description of what to accomplish                |
| `browser_profile` | No       | `lite` (default) or `stealth` (anti-bot mode)                     |
| `proxy_config`    | No       | Object with `enabled` (boolean) and `country_code` (2-letter ISO) |

Return shape:

| Field           | Description                                           |
| --------------- | ----------------------------------------------------- |
| `run_id`        | TinyFish run identifier                               |
| `status`        | `COMPLETED`, `FAILED`, or other terminal status       |
| `result`        | Structured extraction result (when successful)        |
| `error`         | Error details (when failed)                           |
| `streaming_url` | Live browser session URL (when TinyFish provides one) |
| `help_url`      | Link to relevant TinyFish docs (on error)             |
| `help_message`  | Human-readable help hint (on error)                   |

## Good fits

Use TinyFish when the built-in browser is not the best surface:

- Complex public forms with multiple steps
- JS-heavy pages that need real browser rendering
- Multi-step workflows with many clicks and navigation
- Region-sensitive browsing that benefits from proxy routing
- Structured extraction from live browser sessions

Prefer other tools when:

- A simple HTTP fetch or search is enough (`web_fetch`, `web_search`)
- You want direct local or remote CDP control with the built-in [Browser](/tools/browser)
- You need persistent authenticated browser sessions

## Limitations

- TinyFish targets public web workflows; persistent authenticated sessions are out of scope
- CAPTCHA solving is not supported
- Browser session state does not persist across runs
- Batch and parallel runs are out of scope for the initial bundled plugin

## Example prompts

- "Open example.com/pricing and extract every plan name and price as JSON."
- "Go to example.com/contact, fill the public inquiry form, and summarize what happened."
- "Visit example.com/search, switch the region to Canada, and extract the top five public listings."
