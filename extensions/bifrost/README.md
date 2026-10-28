# Bifrost

Connect OpenClaw to an existing [Bifrost](https://getbifrost.ai) gateway:

```bash
openclaw onboard --auth-choice bifrost-api-key
```

Setup asks for the OpenAI-compatible base URL (default
`http://localhost:8080/openai/v1`), an optional virtual key, and a discovered or
manually entered model. Anonymous setup records `auth: "none"`.

The gateway owns upstream credentials and model availability. This plugin does
not install or start Bifrost. See the [Bifrost guide](https://docs.openclaw.ai/providers/bifrost)
for non-interactive setup and authentication details.
