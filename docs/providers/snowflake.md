---
summary: "Use Snowflake Cortex chat completions with local application OAuth or an existing token"
title: "Snowflake Cortex"
read_when:
  - You want to use Snowflake Cortex models in OpenClaw
  - You want to sign in with Snowflake local application OAuth
---

# Snowflake Cortex

Snowflake Cortex exposes an OpenAI-compatible chat-completions API. OpenClaw uses
its existing `openai-completions` transport and the `snowflake` provider plugin
for local browser sign-in and token refresh.

## Install the development plugin

The Snowflake plugin is a separate package and is not included in the core npm
package. This implementation is in development; `@openclaw/snowflake-provider`
has not been published. The sign-in commands below require the plugin first.

For source development, use a compatible OpenClaw source checkout containing
`extensions/snowflake`, then link the plugin through the existing installer:

```bash
openclaw plugins install --link ./extensions/snowflake
```

Registry installation becomes available only after a separate package release.

## Configure inference

Set your account's Cortex base URL and models in the existing provider config.
Use model IDs available in your account and region. For example:

```json5
{
  models: {
    providers: {
      snowflake: {
        baseUrl: "https://<account-identifier>.snowflakecomputing.com/api/v2/cortex/v1",
        api: "openai-completions",
        models: [
          {
            id: "claude-sonnet-4-5",
            name: "Claude Sonnet 4.5",
            reasoning: false,
            input: ["text"],
            contextWindow: 200000,
            maxTokens: 8192,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  },
}
```

The example's zero cost fields disable local cost estimates; Snowflake still
charges for inference. Model availability, limits, and pricing depend on your
account. See [Cortex REST API](https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-rest-api).

## Local browser sign-in

Run OpenClaw on the same computer as your browser:

```bash
openclaw models auth login --provider snowflake --method oauth
openclaw models set snowflake/claude-sonnet-4-5
```

The plugin uses Snowflake's built-in `SNOWFLAKE$LOCAL_APPLICATION` integration,
the public `LOCAL_APPLICATION` client, PKCE, and a loopback callback on
`127.0.0.1:8765`. No OpenClaw OAuth application registration or client secret is
required. Remove an explicit `models.providers.snowflake.apiKey` before signing
in so it does not override the OAuth profile.

Snowflake documents a gradual rollout of this integration. Your administrator
must confirm that it exists, is enabled, and permits refresh tokens. User,
integration, and account network policies can also prevent sign-in. OpenClaw
does not change these policies.

Authorization requests use the user's default role and request refresh access.
That role needs `SNOWFLAKE.CORTEX_REST_API_USER` or `SNOWFLAKE.CORTEX_USER` access.
Browser account SSO can participate in this flow; SSO alone is not an inference
credential. This plugin does not implement MCP OAuth or client credentials.

OpenClaw stores tokens in its normal auth profiles and refreshes expired access
tokens through the existing credential owner. Rotated refresh tokens replace the
previous token. If refresh expires or is revoked, sign in again. Accounts that
do not issue refresh tokens cannot use this sign-in method.

Saved OAuth credentials are bound to the account used for sign-in. Changing the
model endpoint to another account or a non-Cortex path is rejected before
inference. Sign in to the new account after changing the configuration.

Remote and hosted browser sign-in are unsupported by this local-app flow.
Hosted Snowflake OAuth uses a separate administrator-created integration and
is not configured by this plugin. The initial plugin supports public
`*.snowflakecomputing.com` endpoints.

See [Snowflake OAuth for local applications](https://docs.snowflake.com/en/user-guide/oauth-local-applications)
and [OAuth endpoints](https://docs.snowflake.com/en/user-guide/oauth-custom#call-the-oauth-endpoints).

## Existing tokens

For an existing PAT or externally managed bearer token, retain the inference
configuration above and save the token through the standard command:

```bash
openclaw models auth paste-token --provider snowflake
```

Alternatively, use the existing provider `apiKey` field with your normal secret
reference. Manually supplied tokens do not gain automatic OAuth refresh.
Snowflake accepts bearer tokens without an explicit token-type header. See
[REST API authentication](https://docs.snowflake.com/en/developer-guide/snowflake-rest-api/authentication).
