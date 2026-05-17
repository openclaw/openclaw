---
summary: "Use Sber GigaChat models in OpenClaw"
read_when:
  - You need to configure GigaChat API access
  - You need Sber OAuth scope, endpoint, or certificate setup guidance
title: "GigaChat"
---

GigaChat is Sber's hosted model API. OpenClaw uses the GigaChat REST chat completions endpoint through the OpenAI-compatible chat transport, but authentication is provider-specific: you store the GigaChat Authorization key, and OpenClaw exchanges it for a short-lived access token before each runtime session needs one.

| Property          | Value                                         |
| ----------------- | --------------------------------------------- |
| Provider          | `gigachat`                                    |
| Auth env          | `GIGACHAT_AUTHORIZATION_KEY`                  |
| Default scope     | `GIGACHAT_API_PERS`                           |
| Default endpoint  | `https://gigachat.devices.sberbank.ru/api/v1` |
| Business endpoint | `https://api.giga.chat/v1`                    |

## Before you begin

Create a GigaChat API project in the Sber developer cabinet and copy the **Authorization key**. This is the Basic authorization key used to request access tokens; it is not the 30-minute access token returned by the OAuth endpoint.

GigaChat REST requests require the Russian Ministry of Digital Development root certificate on hosts that do not already trust it. Install the certificate at the OS level, set `NODE_EXTRA_CA_CERTS`, or configure a provider-specific CA bundle with `models.providers.gigachat.request.tls.ca`.

## Set up GigaChat

<Steps>
  <Step title="Store the Authorization key">
    ```bash
    export GIGACHAT_AUTHORIZATION_KEY="<authorization-key>" # pragma: allowlist secret
    ```

    You can include or omit the `Basic ` prefix. OpenClaw normalizes the header before it calls the Sber OAuth endpoint.

  </Step>
  <Step title="Run onboarding">
    ```bash
    openclaw onboard --auth-choice gigachat-authorization-key
    ```
  </Step>
  <Step title="Verify the catalog">
    ```bash
    openclaw models list --provider gigachat
    ```
  </Step>
  <Step title="Select a model">
    ```bash
    openclaw models set gigachat/GigaChat-2
    ```
  </Step>
</Steps>

## Configure scope and endpoint

GigaChat access tokens are scoped. The scope must match the API version enabled for the Authorization key in the Sber cabinet:

- `GIGACHAT_API_PERS` for individuals.
- `GIGACHAT_API_B2B` for entrepreneurs and legal entities using prepaid packages.
- `GIGACHAT_API_CORP` for entrepreneurs and legal entities using pay-as-you-go.

The default endpoint is the standard GigaChat API endpoint. Use `endpoint: "business"` only for the Sber business endpoint.

```json5
{
  plugins: {
    entries: {
      gigachat: {
        config: {
          scope: "GIGACHAT_API_PERS",
          endpoint: "main",
        },
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "gigachat/GigaChat-2" },
    },
  },
}
```

Business endpoint example:

```json5
{
  plugins: {
    entries: {
      gigachat: {
        config: {
          scope: "GIGACHAT_API_CORP",
          endpoint: "business",
        },
      },
    },
  },
}
```

## Configure certificates

If token exchange fails with a certificate validation error, configure trust before retrying:

```bash
export NODE_EXTRA_CA_CERTS="/path/to/russian_trusted_root_ca_pem.crt"
```

Provider-specific CA bundle:

```json5
{
  models: {
    providers: {
      gigachat: {
        request: {
          tls: {
            ca: {
              source: "file",
              provider: "default",
              id: "/path/to/russian_trusted_root_ca_pem.crt",
            },
          },
        },
        models: [],
      },
    },
  },
}
```

Avoid `request.tls.insecureSkipVerify` except in a controlled development environment.

## Built-in catalog

| Model ref                 | Input | Context | Max output | Notes                                   |
| ------------------------- | ----- | ------- | ---------- | --------------------------------------- |
| `gigachat/GigaChat-2`     | text  | 128,000 | 8,192      | Default model                           |
| `gigachat/GigaChat-2-Pro` | text  | 128,000 | 8,192      | Higher quality for complex instructions |
| `gigachat/GigaChat-2-Max` | text  | 128,000 | 8,192      | Highest quality and creativity          |

OpenClaw currently registers the GigaChat models as text-only. GigaChat supports files, images, audio, and function calling through provider-specific request fields, but those payloads do not map directly to OpenAI multimodal message parts or `tools`. OpenClaw will keep those capabilities disabled until a dedicated adapter is implemented and tested.

## Limits and troubleshooting

<AccordionGroup>
  <Accordion title="Token exchange">
    OpenClaw requests `POST https://ngw.devices.sberbank.ru:9443/api/v2/oauth` with the configured scope and a UUID `RqUID` header. Access tokens are cached until shortly before expiry. The Sber token endpoint allows up to 10 token requests per second.

    If you see `scope is empty`, `scope data format invalid`, or `scope from db not fully includes consumed scope`, verify `plugins.entries.gigachat.config.scope` matches the Authorization key in the Sber cabinet.

  </Accordion>

  <Accordion title="Concurrency and rate limits">
    Individuals get one GigaChat API stream. Entrepreneurs and legal entities get 10 streams by default. `429 Too Many Requests` is treated as a rate-limit failover reason in OpenClaw.
  </Accordion>

  <Accordion title="Context and validation errors">
    `413 Payload too large` and `422 Unprocessable Entity` can mean the prompt, attached file content, or message order is invalid for GigaChat. GigaChat requires a system message, when present, to be the first message.
  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model providers" href="/concepts/model-providers" icon="layers">
    Provider setup, model refs, and failover behavior.
  </Card>
  <Card title="Provider plugins" href="/plugins/sdk-provider-plugins" icon="puzzle-piece">
    How provider plugins register auth, catalogs, and runtime hooks.
  </Card>
  <Card title="GigaChat API authorization" href="https://developers.sber.ru/docs/ru/gigachat/api/authorization" icon="arrow-up-right-from-square">
    Official Sber authorization docs.
  </Card>
  <Card title="GigaChat certificates" href="https://developers.sber.ru/docs/ru/gigachat/certificates" icon="arrow-up-right-from-square">
    Certificate setup for GigaChat API requests.
  </Card>
</CardGroup>
