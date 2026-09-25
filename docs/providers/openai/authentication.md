---
summary: "Choose Codex login, Sign in with ChatGPT, or an API key for the OpenAI capabilities you need"
read_when:
  - You are choosing between Codex login, an API key, and Sign in with ChatGPT
  - You want to use OpenAI-hosted plugins with OpenClaw
  - You are connecting an OpenAI account for an agent or a person
title: "OpenAI authentication"
sidebarTitle: "Authentication"
---

Choose your OpenAI authentication method based on the access you need:

- **Codex login:** use your ChatGPT account for Codex models and OpenAI-hosted
  plugins. Choose browser OAuth locally or device code on a remote machine.
- **Sign in with ChatGPT (SIWC):** use your ChatGPT allowance with OpenAI-native
  usage monitoring and app-specific permissions. Model calls use the Responses
  API; OpenAI-hosted plugins are not supported yet.
- **API key:** use OpenAI Platform models with your project's permissions and
  API billing.

## Compare capabilities

|                                                        | Codex login (browser OAuth or device code)                 | Sign in with ChatGPT (SIWC preview)                     | OpenAI Platform API key                                    |
| ------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------- |
| Identity                                               | Your ChatGPT account and workspace using the Codex product | Your ChatGPT account and workspace authorizing OpenClaw | The API key's Platform project and permissions             |
| Model access                                           | Models available to your Codex account                     | Eligible Responses models when token sharing is granted | Models permitted for your Platform project                 |
| Usage allowance                                        | Your Codex allowance                                       | Your eligible ChatGPT allowance                         | Platform API billing                                       |
| OpenAI-hosted plugins and connected apps through Codex | Supported; plugin setup and workspace policy apply         | Not supported yet                                       | Not provided by API-key authentication                     |
| OpenClaw tools and locally configured plugins          | Supported                                                  | Supported                                               | Supported                                                  |
| Web search                                             | Supported where enabled                                    | Supported                                               | Supported where enabled                                    |
| Monitoring and analytics                               | Codex usage and quota reporting                            | OpenAI usage tracking across connected apps             | Platform project usage and billing                         |
| Permission control                                     | Codex product permissions and workspace policy             | App-specific OAuth grants and workspace policy          | API-key and project permissions                            |
| Default model endpoint                                 | `https://chatgpt.com/backend-api/codex/responses`          | `https://api.openai.com/v1/responses`                   | `https://api.openai.com/v1/responses` for Responses models |

**Choose SIWC for a connection with its own permissions and OpenAI usage tracking.**
You authorize OpenClaw as its own application, with consent for basic identity
and eligible model use. Monitor subscription usage across connected applications
in [ChatGPT Settings → Usage](https://chatgpt.com/#settings/Usage), and manage the
connection in [ChatGPT login connections](https://chatgpt.com/#settings/Security/linked-apps).
OpenClaw does not yet display SIWC quota in its own usage panel.

**Choose Codex login if OpenAI-hosted plugins are part of your workflow.**
It supplies the Codex account authentication that those services require. You may
still need to install or enable a plugin, connect its external account, and get
workspace permission. SIWC model access does not grant access to those services.

OpenClaw tools and locally configured plugins have their own permissions and
external-service credentials. They can work with any of these model-auth methods.
For example, a Slack integration configured in OpenClaw is separate from a
Slack connected app hosted by OpenAI.

### Choose model access and harness separately

The **harness**, or [agent runtime](/concepts/agent-runtimes), runs the agent loop
and tools. The login method determines which OpenAI service and account it uses.

OpenClaw's own runtime supports all three methods. Choosing Codex login does not
require the native Codex harness; model calls still use the Codex service. If you
choose the native Codex harness, all three methods are supported, but SIWC
requires a managed local process.
See [runtime selection](/providers/openai/runtimes#implicit-agent-runtime) and
[SIWC setup](/providers/openai/setup#sign-in-with-chatgpt-preview) for configuration
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
then choose a sign-in method. For SIWC, choose **Sign in with ChatGPT** and approve
token sharing in your browser. When the account is connected, choose a model and
use **Test & use** to verify a reply and select it.

Run the command on the machine running the OpenClaw installation you want to
configure:

```bash
# Codex login through a browser
openclaw models auth login --provider openai --method oauth

# Codex login on a remote or headless machine
openclaw models auth login --provider openai --method device-code

# Sign in with ChatGPT
openclaw models auth login --provider openai --method siwc

# OpenAI Platform API key
openclaw models auth login --provider openai --method api-key
```

Browser OAuth and device code provide the same type of Codex access. Device code
lets you approve the login in a browser on another machine; it does not create a
separate kind of permanent credential. Without `--method`, OpenAI login defaults
to Codex browser OAuth.

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
