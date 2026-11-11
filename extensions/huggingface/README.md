# Hugging Face

Use hosted models through Hugging Face Inference Providers. OpenClaw connects to
Hugging Face's router and discovers available models; it does not download or run
the model weights locally.

## Get started

Create a Hugging Face token with permission to call Inference Providers, then run:

```bash
openclaw onboard --auth-choice huggingface-api-key
```

The Gateway also accepts `HUGGINGFACE_HUB_TOKEN` or `HF_TOKEN`. Browse the catalog
with `openclaw models list --provider huggingface`, then choose a model your
account can access.

Model availability and supported inputs depend on the selected inference
provider. See the [Hugging Face guide](https://docs.openclaw.ai/providers/huggingface)
for token setup, routing, and model configuration.

## Optional Hub tools

This plugin also declares Hugging Face's remote MCP service for models, datasets,
Spaces, and papers. Inference and Hub access use separate authentication:
Inference Providers use your HF token; Hub tools use an OAuth connection.
Enabling inference does not activate Hub tools or send that token to MCP.

Open this plugin’s settings and enable **Hub tools**, then connect your Hugging
Face account. Review the consent screen: Hugging Face operates the remote service
and determines its tools. Disable **Hub tools** to stop the plugin’s Hub connection
without disabling inference or deleting the saved sign-in.

The configuration equivalent is:

```json5
{
  plugins: {
    entries: {
      huggingface: { config: { hub: { enabled: true } } },
    },
  },
}
```

Operator-level `mcp.servers["hugging-face"]` overrides remain authoritative.

Existing installations of `@openclaw/hugging-face` remain supported and retain their
connection and enablement. Both integrations use the same `hugging-face` MCP server
name and endpoint, so the optional declaration does not create a second connection.
The legacy package is not automatically removed and its saved credentials are not
rewritten. To manage Hub access with this plugin’s toggle, enable Hub tools here,
then disable the legacy wrapper. Leaving that wrapper enabled keeps its Hub access
active independently of this toggle. Disable rather than uninstall the wrapper
to preserve its saved sign-in during the switch.
