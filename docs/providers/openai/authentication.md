---
summary: "Choose Codex login, Sign in with ChatGPT (Beta), or an API key for the OpenAI capabilities you need"
read_when:
  - You are choosing between Codex login, an API key, and Sign in with ChatGPT (Beta)
  - You want to use OpenAI-hosted plugins with OpenClaw
  - You are connecting an OpenAI account for an agent or a person
title: "OpenAI authentication"
sidebarTitle: "Authentication"
---

Choose your OpenAI authentication method based on the access you need:

- **Codex login:** use your ChatGPT account for Codex models. Choose browser
  OAuth locally or device code on a remote machine. OpenAI-hosted plugins require
  a grant with connector scopes.
- **Sign in with ChatGPT (Beta)** (SIWC): authorize OpenClaw as an app to use your Codex
  allowance for eligible Responses API calls. Check shared allowance usage in
  ChatGPT. OpenAI-hosted plugins are not supported yet.
- **API key:** use OpenAI Platform models with your project's permissions and
  API billing.

## Compare capabilities

|                                                        | Sign in with ChatGPT (Beta)                               | Codex login (browser OAuth or device code)                  | OpenAI Platform API key                                    |
| ------------------------------------------------------ | --------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------- |
| Identity                                               | Your ChatGPT account and workspace authorizing OpenClaw   | Your ChatGPT account and workspace using the Codex product  | The API key's Platform project and permissions             |
| Credential refresh                                     | OpenClaw refreshes its SIWC profile for this app          | OpenClaw refreshes its Codex OAuth profile                  | No OAuth refresh; rotate the key with its owner            |
| Model access                                           | Eligible Responses models when token sharing is granted   | Models available to your Codex account                      | Models permitted for your Platform project                 |
| Usage allowance                                        | Your Codex allowance                                      | Your Codex allowance                                        | Platform API billing                                       |
| Usage limits                                           | No per-app setting in OpenClaw; ChatGPT controls may vary | —                                                           | —                                                          |
| OpenAI-hosted plugins and connected apps through Codex | Not supported yet                                         | Requires a connector-scoped grant outside OpenClaw login    | Not provided by API-key authentication                     |
| OpenClaw tools and locally configured plugins          | Supported                                                 | Supported                                                   | Supported                                                  |
| Web search                                             | Supported when the model and account allow it             | Supported where enabled                                     | Supported where enabled                                    |
| Image and file inputs                                  | Model-dependent; does not grant Files API access          | Model-dependent                                             | Model/project-dependent                                    |
| OpenClaw `image_generate`                              | Not supported by this credential                          | Requires an OpenClaw Codex OAuth profile and account access | Images API, subject to project access                      |
| Audio transcription                                    | Not supported by this credential                          | Subscription transcription route, subject to account access | Audio API, subject to project access                       |
| Realtime voice                                         | Not supported by this credential                          | Selected browser and GPT-Live relay routes                  | Supported routes, subject to project access                |
| Memory embeddings                                      | Requires a separate compatible credential                 | Supported when the account grants embedding access          | Supported API, subject to project access                   |
| Text-to-speech                                         | Requires a separate compatible credential                 | Requires a separate compatible credential                   | Supported API, subject to project access                   |
| Monitoring and analytics                               | Shared ChatGPT Usage page; no per-app OpenClaw metrics    | Codex usage and quota reporting                             | Platform project usage and billing                         |
| Permission control                                     | App-specific OAuth grants and workspace policy            | Codex product permissions and workspace policy              | API-key and project permissions                            |
| Default model endpoint                                 | `https://api.openai.com/v1/responses`                     | `https://chatgpt.com/backend-api/codex/responses`           | `https://api.openai.com/v1/responses` for Responses models |

Credential refresh above refers to OpenClaw-stored profiles. Codex owns a
separate native user-home login and its refresh.

OpenClaw does not set per-app SIWC limits or show per-app usage. If ChatGPT
offers app-specific controls for your account, manage them there. The Usage
limits row does not compare limit settings for Codex login or API keys.

Image and file input support depends on the selected model and is separate from
image generation and Files API permissions. Realtime voice varies by route; see
[OpenAI coverage and cost](/providers/openai/coverage-and-cost#openclaw-feature-coverage).

**Choose SIWC for app-specific authorization.** You authorize OpenClaw as its
own application, with consent for basic identity and eligible model use. Check
your shared allowance in
[ChatGPT Settings → Usage](https://chatgpt.com/settings/usage), and manage the
connection in [ChatGPT login connections](https://chatgpt.com/#settings/Security/linked-apps).
OpenClaw does not display SIWC quota or per-app usage.

**OpenAI-hosted plugins through Codex require a grant with connector scopes.**
Neither OpenClaw Codex login method grants plugin invocation: device-code login
lacks `api.connectors.invoke`, and OpenClaw's browser OAuth flow does not
request that scope. For the native Codex harness, use a
[native Codex browser sign-in or imported credential](/plugins/codex-harness-reference/auth#auth-and-environment-isolation)
whose grant includes `api.connectors.invoke`, then follow
[native plugin setup](/plugins/codex-native-plugins). You may still need to
connect the external account and get workspace permission. SIWC model access
does not grant access to those services.

OpenClaw tools and locally configured plugins have their own permissions and
external-service credentials. They can work with any of these model-auth methods.
For example, a Slack integration configured in OpenClaw is separate from a
Slack connected app hosted by OpenAI. Native Codex plugins also require the
Codex harness and its [plugin setup](/plugins/codex-native-plugins); they do not
appear in OpenClaw just because a model uses Codex login.

SIWC model access does not make every OpenAI tool available. Image generation,
audio transcription, speech synthesis, and memory embeddings need credentials
that support those capabilities. You can keep SIWC for chat and configure another
account or provider for those tools. OpenClaw `image_generate` uses an OpenClaw
auth profile; a separate `codex login` in a native Codex user home does not
provide that credential to the tool. See [image generation](/providers/openai/image-and-video).

A native Codex turn using a qualifying Codex login may also return a generated
image when Codex offers that feature to the account. OpenClaw delivers that
image as an attachment. That path is separate from OpenClaw `image_generate`.

During [agent bootstrapping](/start/bootstrapping), OpenClaw generates avatar
choices only when image generation is available. With only SIWC connected, it
continues with the agent's emoji; no generated avatar is required to finish.
A separately configured image provider can still generate the avatar.

### Choose model access and harness separately

The **harness**, or [agent runtime](/concepts/agent-runtimes), runs the agent loop
and tools. The login method determines which OpenAI service and account it uses.

OpenClaw's own runtime supports all three methods. Choosing Codex login does not
require the native Codex harness; model calls still use the Codex service. If you
choose the native Codex harness, all three methods are supported, but SIWC
requires a managed local process.

With the native Codex harness, SIWC supports automatic in-turn compaction, but
manual `/compact` is unavailable. Codex login and API-key turns can use native
`/compact` when the thread is eligible. OpenClaw's own runtime uses its own
[compaction](/concepts/compaction) behavior.

See [runtime selection](/providers/openai/runtimes#implicit-agent-runtime) and
[SIWC setup](/providers/openai/setup#sign-in-with-chatgpt-beta) for configuration
and current limits.

## Shared agent credential or personal account?

| You want to…                                                                | Use                                                                    |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Configure the credential an agent uses for its conversations                | **Settings → Models → Connect provider** or `models auth login`        |
| Connect an account to your person on a Gateway and select it for your chats | **Settings → Profile → Connected accounts** or `models accounts login` |

These are model credentials. The Gateway access token used to connect the
dashboard or Mac app is separate.

For example, to connect SIWC as a personal account:

```bash
openclaw models accounts login openai --method siwc
```

Check the **Gateway**, **Person**, and **Scope** shown before signing in. A personal
connection does not replace the agent's shared credential. Its default applies
to new chats; existing chats keep their account selection. Collaborators
continuing a chat use that chat's selected account, and Gateway fallback rules
still apply. See [per-person model accounts](/concepts/multi-user#per-person-model-accounts).

## Set up an agent's credential

In **Settings → Models**, select the agent, choose **Connect provider → OpenAI**,
then choose a sign-in method. For SIWC, choose **Sign in with ChatGPT (Beta)** and approve
token sharing in your browser. When the account is connected, choose a model and
use **Test & use** to verify a reply and select it.

Run the command on the machine running the OpenClaw installation you want to
configure:

```bash
# Codex login through a browser
openclaw models auth login --provider openai --method oauth

# Codex login on a remote or headless machine
openclaw models auth login --provider openai --method device-code

# Sign in with ChatGPT (Beta)
openclaw models auth login --provider openai --method siwc

# OpenAI Platform API key
openclaw models auth login --provider openai --method api-key
```

Browser OAuth and device code both provide Codex model access, but their grants
can differ. Device code lets you approve the login in a browser on another
machine; it does not create a separate kind of permanent credential. Without
`--method`, OpenAI login defaults to Codex browser OAuth.

Use `--agent <agentId>` to target a configured agent and `--profile-id <profileId>`
to name the saved credential. Login saves and prioritizes that credential for the
agent. Add `--set-default` to select the provider's recommended model; otherwise
the existing default model is preserved.

For guided setup, use `openclaw onboard`. An existing compatible login may be
offered for reuse.
See [model setup](/providers/openai/setup) and the [models CLI](/cli/models).

## Check the selected account

In a conversation, use the model/account selector to choose an account and
`/status` to inspect its authentication and endpoint. Send a message to verify
that the selected setup can run a model request.

For SIWC, approve token sharing during sign-in to enable model calls. If you
complete sign-in with identity permissions alone, the account can be saved but
cannot authorize inference. Your account and workspace must also allow SIWC and
the requested model access.
