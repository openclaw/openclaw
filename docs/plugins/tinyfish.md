---
summary: "TinyFish plugin: hosted browser automation for public multi-step workflows"
read_when:
  - You want hosted browser automation from OpenClaw
  - You are configuring or developing the TinyFish plugin
title: "TinyFish Plugin"
---

# TinyFish (plugin)

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

- `tinyfish_automation`

Parameters:

- `url` required
- `goal` required
- `browser_profile` optional: `lite` or `stealth`
- `proxy_config` optional with `enabled` and `country_code`

Return shape:

- `run_id`
- `status`
- `result`
- `error`
- `help_url`
- `help_message`
- `streaming_url`

## Good fits

Use TinyFish when the built-in browser is not the best surface:

- complex public forms
- JS-heavy pages
- multi-step workflows with many clicks
- region-sensitive browsing that benefits from proxy routing
- structured extraction from a live browser session

Prefer other tools when:

- a simple HTTP fetch or search is enough
- you want direct local or remote CDP control with the built-in [Browser](/tools/browser)

## Limitations

Keep the PR1 scope conservative:

- TinyFish is documented here as a public web workflow tool, not a persistent authenticated browser
- TinyFish docs note that CAPTCHA solving is not supported
- TinyFish docs note that browser session state does not persist across runs
- Batch and parallel TinyFish runs are out of scope for this first bundled plugin

## Example prompts

- "Open https://example.com/pricing and extract every plan name and price."
- "Go to https://example.com/contact, fill the public inquiry form, and summarize what happened."
- "Visit https://example.com/search, switch the region to Canada, and extract the top five public listings."
