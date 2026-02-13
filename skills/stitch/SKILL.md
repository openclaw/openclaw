---
name: stitch
description: Use when setting up or using Google Stitch via the Gemini CLI extension to generate UI screens from prompts, list Stitch projects/screens, and download Stitch assets (images/HTML). Includes safe auth setup with API key or Google ADC.
homepage: https://stitch.withgoogle.com/
metadata:
  {
    "openclaw":
      {
        "emoji": "🧵",
        "requires": { "bins": ["gemini"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "gemini-cli",
              "bins": ["gemini"],
              "label": "Install Gemini CLI (brew)",
            },
          ],
      },
  }
---

# Stitch (Gemini CLI extension)

Use Stitch from Gemini CLI for UI generation and project/screen asset workflows.

## Setup

1. Install extension:

```bash
gemini extensions install https://github.com/gemini-cli-extensions/stitch --auto-update
```

2. Create local config (`~/.gemini/extensions/Stitch/gemini-extension.json`):

```bash
# API key auth (recommended for quick setup)
export STITCH_API_KEY="<paste-key-from-Stitch-settings>"
bash {baseDir}/scripts/configure_stitch_extension.sh --auth apikey

# OR ADC auth (for GCP-managed credentials)
export STITCH_PROJECT_ID="your-gcp-project-id"
bash {baseDir}/scripts/configure_stitch_extension.sh --auth adc
```

3. Start Gemini and verify Stitch MCP is available:

```text
gemini
/mcp list
/mcp desc
```

## API key auth flow (Stitch settings)

1. Open `https://stitch.withgoogle.com/`.
2. Click profile (top-right) → **Stitch Settings**.
3. Go to **API Keys** → **Create Key**.
4. Copy key, export as `STITCH_API_KEY`, run setup script with `--auth apikey`.

## ADC auth alternative

```bash
gcloud auth login
export STITCH_PROJECT_ID="your-project-id"
gcloud config set project "$STITCH_PROJECT_ID"
gcloud auth application-default set-quota-project "$STITCH_PROJECT_ID"
gcloud beta services mcp enable stitch.googleapis.com --project="$STITCH_PROJECT_ID"
# Ensure your account has roles/serviceusage.serviceUsageConsumer
gcloud auth application-default login
bash {baseDir}/scripts/configure_stitch_extension.sh --auth adc
```

## Practical usage

Inside Gemini CLI:

```text
/stitch What Stitch projects do I have?
/stitch Tell me details about my project 3677573127824787033
/stitch Give me all the screens of project 3677573127824787033
/stitch Download the image of screen 6393b8177be0490f89eb8f2c1e4cfb37
/stitch Download the HTML of screen 6393b8177be0490f89eb8f2c1e4cfb37
/stitch Design a mobile app onboarding flow for skiers in the Alps using Gemini 3 Pro.
/stitch Enhance this prompt: "Design a landing page for an AI podcast."
```

## Safety notes

- Never hardcode or commit API keys.
- Prefer environment variables + OS keychain/secret manager.
- Avoid passing secrets directly as CLI args when possible (shell history).
- Keep `~/.gemini/extensions/Stitch/gemini-extension.json` local and private.
