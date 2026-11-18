---
summary: "Set up one Linux agent, resume an interrupted setup, and check what actually works"
read_when:
  - You are setting up OpenClaw on a small Linux host
  - You have an API key in a password manager or an existing Ollama server
  - Setup stopped and you want the next step without starting over
title: "Small-host setup"
---

Use this path for one person running one agent on a Linux host. Start with the
normal installer and guided setup, not a provisioning script. You do not need
a channel, a plugin suite, or a deployment profile to reach your first chat.

This guide composes existing commands; it is not a new installer or an automatic
acceptance report. Use the documentation matching your installed release.

## Install once, then choose your AI connection

Follow [Install](/install), then run:

```bash
openclaw --version
openclaw onboard
```

Choose **Quick start**, or **Custom setup** to review the agent name, access
mode, and optional settings. Quick start uses full access by default; read the
[security guide](/gateway/security) before granting an agent access to this host.
Choose the connection you want before its real verification request. Hosted
providers may charge for that request. You can skip optional setup.

### An API key saved in a password manager

Choose your provider and its **API key** sign-in method. Enter the saved key
only into the masked credential prompt, never into chat. An OpenAI API key and
a ChatGPT subscription are different connections; choose the one you have.

If you already use the 1Password CLI and want to avoid clipboard handling,
run the following **in a terminal on the Gateway host**, not in agent chat.
The example assumes the default agent is named `main`; use
`openclaw agents list` to check an existing installation. Replace the
`op://` reference with the one selected field you have permission to read.
Baseline setup writes local setup state and can create the default proactive
automation; it is not a read-only credential check.

```bash
openclaw setup --baseline
op read 'op://Private/OpenAI/credential' | \
  openclaw models auth paste-api-key --provider openai \
    --profile-id openai:setup --agent main
openclaw onboard
```

The pipeline sends the key directly to OpenClaw
without placing its value in command arguments or a temporary plaintext file.
Keep shell tracing and command-output recording off. The import copies the key
into OpenClaw credential storage under a named profile; it does not leave the
key only in 1Password. Saving it does not prove usable inference: select the
saved connection in onboarding and let verification finish. Repeating the import replaces
`openai:setup`; do not repeat it just because a later setup step failed.

This one-time copy does not require enabling an agent password-manager tool.
For ongoing resolution without copying the API key into OpenClaw storage, use
[1Password SecretRefs](/plugins/onepassword#configure-secretrefs). Other
password-manager integrations are in
[Secrets integration examples](/gateway/secrets/integration-examples).
OpenClaw's local [shared secret store](/gateway/secrets/secret-store-and-egress#shared-secret-store)
is not encrypted at rest; protected/write-only access is not disk encryption.

### Ollama is already installed

Choose the detected connection. If your model is not offered, choose
**Ollama → Local only** and use the existing server's address. Do not reinstall
Ollama just because automatic detection did not list a model. Detection only
considers eligible models already loaded in memory; explicit Ollama setup can
inspect installed models. Use the native address, such as
`http://127.0.0.1:11434`, without `/v1`.

Keep these results separate: a reachable endpoint, an available model, a
selected model, and a verified reply. Onboarding still needs the verified reply.
If setup offers a model download, review it before accepting; it is not part
of read-only detection. See [Ollama setup](/providers/ollama/setup).

## Keep it running and open chat

Accept **Keep OpenClaw running in the background?** if you want a service. If
you chose foreground operation, **Ctrl+C** stops the Gateway but keeps config.
To switch to a service later:

```bash
openclaw gateway install
openclaw gateway start
```

Installation installs and starts the service but returns before readiness;
`gateway start` waits for health and readiness.
If start reports `still-starting` (exit code `2`), the service remains running.
Check `openclaw gateway status --deep` before restarting or reinstalling.

```bash
openclaw dashboard
```

On a headless host, use the dashboard through an
[SSH tunnel](/gateway/remote), not a public unauthenticated listener. Send a
short message and check that you receive a reply. Opening the dashboard alone
does not test the model or tools.

## Check what has actually passed

Run the checks below on the Gateway host. Keep their output private until
reviewed: paths, account names, and service diagnostics can identify your host.

| Check                          | How to check                                                                                      | What it does not prove                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Installed identity             | `openclaw --version`; `node --version` for a Node install                                         | A running service or a model reply                       |
| Valid configuration            | `openclaw config validate`                                                                        | Working credentials or inference                         |
| Gateway and service            | `openclaw gateway status --deep --require-rpc`                                                    | A model reply, a tool call, or survival after reboot     |
| Loopback listener              | On Linux, `ss -ltnp`; match the Gateway port/process reported by status                           | Config alone does not prove the actual listening address |
| Configured model/auth          | `openclaw models status --agent main`                                                             | Status without a live check does not prove a reply       |
| Inference                      | The selected connection passes onboarding verification, or a fresh chat receives a real reply     | Tools, every fallback, or every plugin                   |
| Linux persistence prerequisite | `loginctl show-user "$USER" -p Linger` and `systemctl --user is-enabled openclaw-gateway.service` | An actual logout or reboot test                          |

Read the reported readiness and warnings, not just the status command's exit
code. `--require-rpc` makes a failed RPC check nonzero; it is not a model test.
Onboarding verification is tool-free; also send a real message through the
running Gateway to exercise its chat path. To claim the primary model passed,
inspect the reply's actual provider/model: an agent turn may use a fallback.

For this loopback-only baseline, investigate any non-loopback Gateway listener,
including `0.0.0.0` or `::`, before exposing the host. Use the actual port if it
is not `18789`, and the unit reported by status for a named profile. Missing
listener/process visibility or an unavailable systemd user bus means the
corresponding check is unverified, not passed.
If lingering is off and you want the user service to run without a login,
follow [Linux service setup](/start/setup#linux-systemd-user-service); enabling
it may need administrator permission.

**Optional tool check:** only on a test agent, ask it to call `session_status`
with no arguments exactly once and summarize the result. Prohibit model or
settings changes, file changes, shell commands, and external messages. Inspect the actual tool result in the transcript, not just the model's
claim. A missing or denied tool is an incomplete check, not a reason to broaden
permissions. A timeout or failed turn is not a pass. This uses model requests;
it is not a strict token/spend cap or a guarantee of exactly one tool call.

Do not use broad credential probes as a substitute for this first chat.
[`models status --probe`](/cli/models#status) sends real provider requests and
requires the Gateway to be stopped.

## Resume at the incomplete step

Do not use reset, delete state, or import credentials again to retry a later
phase. Keep the same host user, state directory, and agent.

| Where setup stopped                   | Next action                                                                                               |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| CLI not found                         | Finish the installer's PATH instructions; reopen the terminal                                             |
| Baseline only / **Skip for now**      | Run `openclaw onboard` and choose a connection                                                            |
| Saved sign-in, verification failed    | Choose the saved connection and retry after fixing the reported cause; do not sign in again unnecessarily |
| Service registered but still starting | Read `openclaw gateway status --deep`; preserve the running service while it warms up                     |
| Service running, no model reply       | Inspect `openclaw models status --agent main`, then the provider error in chat                            |
| Invalid config or an unclear failure  | Run `openclaw doctor --lint` for read-only findings; review repairs before authorizing `--fix`            |

If a credential or config write has an unknown outcome, inspect the Models page
or the specific non-secret setting before retrying. A restart may require
re-entering unsaved custom-endpoint details, but does not justify resetting
completed setup. If a chat request times out or disconnects, inspect its
session transcript before resending; the Gateway may already have accepted it.

For a handoff, record the installed version, agent name, each check as
**passed**, **failed**, **pending**, or **not tested**, and one exact remaining
action. This is a private checklist, not a versioned CLI receipt. Leave reboot
persistence, real outage failover, and optional plugin hooks **not tested**
unless you actually exercised them. Do not paste credentials, tokens, full
config, or raw logs into the checklist.

To repeat selected non-secret settings on another host, continue with
[Repeatable setup](/start/repeatable-setup).
