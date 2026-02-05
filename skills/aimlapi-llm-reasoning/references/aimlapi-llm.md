# AIMLAPI LLM notes

## Defaults

- Base URL default: `https://api.aimlapi.com/v1`
- API key env var: `AIMLAPI_API_KEY`

## Mandatory request header

Always send `User-Agent` on LLM requests. The script does this by default and allows override via `--user-agent`.

## Payload guidance

- Endpoint: `/chat/completions`
- Core fields: `model`, `messages`
- Use `--extra-json` for provider-specific settings (`reasoning`, `tools`, `response_format`, etc.)

## Troubleshooting

- 401/403: verify API key and model entitlement.
- 404: verify model and endpoint.
- 422: verify field names/types against provider schema.
