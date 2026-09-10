---
summary: "Index of the deep gateway troubleshooting runbook, grouped by symptom area"
read_when:
  - The troubleshooting hub pointed you here for deeper diagnosis
  - You need stable symptom based runbook sections with exact commands
title: "Troubleshooting"
sidebarTitle: "Troubleshooting"
---

This is the deep runbook. Start at [/help/troubleshooting](/help/troubleshooting) for the fast triage flow first.

## Command ladder

Run in this order:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Healthy signals:

- `openclaw gateway status` shows `Runtime: running`, `Connectivity probe: ok`, and a `Capability: ...` line.
- `openclaw doctor` reports no blocking config/service issues.
- `openclaw channels status --probe` shows live per-account transport status and, where supported, `works` or `audit ok`.

## Symptom index

This page is an index. The runbook sections are documented on six pages,
grouped by symptom area. Open the page that matches what you are seeing.

| Page                                                                                  | Read it when                                                                                 |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [Updates and rollbacks](/gateway/troubleshooting/updates-and-rollbacks)               | An update, downgrade, or split-brain install left the Gateway down or mismatched.            |
| [Skills and model providers](/gateway/troubleshooting/skills-and-model-providers)     | A skill root is skipped, or provider calls fail with 429, 403, or silent agent-run errors.   |
| [Agent replies and Control UI](/gateway/troubleshooting/agent-replies-and-control-ui) | A run fails with a storage error, no reply arrives, or the Control UI will not connect.      |
| [Gateway service and process](/gateway/troubleshooting/gateway-service-and-process)   | The service will not run or stay up, macOS supervision misbehaves, or memory forces an exit. |
| [Config validation and probes](/gateway/troubleshooting/config-validation-and-probes) | The Gateway rejected a config, or probe warnings appear in status and doctor output.         |
| [Channel delivery and tools](/gateway/troubleshooting/channel-delivery-and-tools)     | A channel connects but does not deliver, or a node or browser tool call fails.               |

## Where each section moved

Every anchor this page used to publish is kept here, so an existing link such
as `/gateway/troubleshooting#gateway-rejected-invalid-config` still resolves. Each entry points at
the page that now holds the content.

- <a id="after-an-update" />[After an update](/gateway/troubleshooting/updates-and-rollbacks#after-an-update)
- <a id="prepared-model-runtime-publication-timeout" />[Prepared model runtime publication timeout](/gateway/troubleshooting/updates-and-rollbacks#prepared-model-runtime-publication-timeout)
- <a id="split-brain-installs-and-newer-config-guard" />[Split brain installs and newer config guard](/gateway/troubleshooting/updates-and-rollbacks#split-brain-installs-and-newer-config-guard)
- <a id="fix-path" />[Fix PATH](/gateway/troubleshooting/updates-and-rollbacks#fix-path)
- <a id="reinstall-the-gateway-service" />[Reinstall the gateway service](/gateway/troubleshooting/updates-and-rollbacks#reinstall-the-gateway-service)
- <a id="remove-stale-wrappers" />[Remove stale wrappers](/gateway/troubleshooting/updates-and-rollbacks#remove-stale-wrappers)
- <a id="protocol-mismatch-after-rollback" />[Protocol mismatch after rollback](/gateway/troubleshooting/updates-and-rollbacks#protocol-mismatch-after-rollback)
- <a id="skill-symlink-skipped-as-path-escape" />[Skill symlink skipped as path escape](/gateway/troubleshooting/skills-and-model-providers#skill-symlink-skipped-as-path-escape)
- <a id="anthropic-429-extra-usage-required-for-long-context" />[Anthropic 429 extra usage required for long context](/gateway/troubleshooting/skills-and-model-providers#anthropic-429-extra-usage-required-for-long-context)
- <a id="use-a-standard-context-window" />[Use a standard context window](/gateway/troubleshooting/skills-and-model-providers#use-a-standard-context-window)
- <a id="use-an-eligible-credential" />[Use an eligible credential](/gateway/troubleshooting/skills-and-model-providers#use-an-eligible-credential)
- <a id="configure-fallback-models" />[Configure fallback models](/gateway/troubleshooting/skills-and-model-providers#configure-fallback-models)
- <a id="upstream-403-blocked-responses" />[Upstream 403 blocked responses](/gateway/troubleshooting/skills-and-model-providers#upstream-403-blocked-responses)
- <a id="local-openai-compatible-backend-passes-direct-probes-but-agent-runs-fail" />[Local OpenAI-compatible backend passes direct probes but agent runs fail](/gateway/troubleshooting/skills-and-model-providers#local-openai-compatible-backend-passes-direct-probes-but-agent-runs-fail)
- <a id="common-signatures" />[Common signatures (local backend)](/gateway/troubleshooting/skills-and-model-providers#common-signatures)
- <a id="fix-options" />[Fix options (local backend)](/gateway/troubleshooting/skills-and-model-providers#fix-options)
- <a id="agent-run-failed-with-a-storage-error" />[Agent run failed with a storage error](/gateway/troubleshooting/agent-replies-and-control-ui#agent-run-failed-with-a-storage-error)
- <a id="no-replies" />[No replies](/gateway/troubleshooting/agent-replies-and-control-ui#no-replies)
- <a id="dashboard-control-ui-connectivity" />[Dashboard control UI connectivity](/gateway/troubleshooting/agent-replies-and-control-ui#dashboard-control-ui-connectivity)
- <a id="connect-auth-signatures" />[Connect / auth signatures](/gateway/troubleshooting/agent-replies-and-control-ui#connect-auth-signatures)
- <a id="auth-detail-codes-quick-map" />[Auth detail codes quick map](/gateway/troubleshooting/agent-replies-and-control-ui#auth-detail-codes-quick-map)
- <a id="wait-for-connect-challenge" />[Wait for connect.challenge](/gateway/troubleshooting/agent-replies-and-control-ui#wait-for-connect-challenge)
- <a id="sign-the-payload" />[Sign the payload](/gateway/troubleshooting/agent-replies-and-control-ui#sign-the-payload)
- <a id="send-the-device-nonce" />[Send the device nonce](/gateway/troubleshooting/agent-replies-and-control-ui#send-the-device-nonce)
- <a id="gateway-service-not-running" />[Gateway service not running](/gateway/troubleshooting/gateway-service-and-process#gateway-service-not-running)
- <a id="common-signatures-1" />[Common signatures (gateway service)](/gateway/troubleshooting/gateway-service-and-process#common-signatures)
- <a id="macos-gateway-silently-stops-responding%2C-then-resumes-when-you-touch-the-dashboard" /><a id="macos-gateway-silently-stops-responding-then-resumes-when-you-touch-the-dashboard" />[macOS gateway silently stops responding, then resumes when you touch the dashboard](/gateway/troubleshooting/gateway-service-and-process#macos-gateway-silently-stops-responding-then-resumes-when-you-touch-the-dashboard)
- <a id="macos-launchd-supervisor-loop-with-duplicate-gateway%2Fnode-launchagents" /><a id="macos-launchd-supervisor-loop-with-duplicate-gateway/node-launchagents" />[macOS launchd supervisor loop with duplicate gateway/node LaunchAgents](/gateway/troubleshooting/gateway-service-and-process#macos-launchd-supervisor-loop-with-duplicate-gateway%2Fnode-launchagents)
- <a id="gateway-exits-during-high-memory-use" />[Gateway exits during high memory use](/gateway/troubleshooting/gateway-service-and-process#gateway-exits-during-high-memory-use)
- <a id="gateway-rejected-invalid-config" />[Gateway rejected invalid config](/gateway/troubleshooting/config-validation-and-probes#gateway-rejected-invalid-config)
- <a id="what-happened" />[What happened](/gateway/troubleshooting/config-validation-and-probes#what-happened)
- <a id="inspect-and-repair" />[Inspect and repair](/gateway/troubleshooting/config-validation-and-probes#inspect-and-repair)
- <a id="common-signatures-2" />[Common signatures (invalid config)](/gateway/troubleshooting/config-validation-and-probes#common-signatures)
- <a id="fix-options-1" />[Fix options (invalid config)](/gateway/troubleshooting/config-validation-and-probes#fix-options)
- <a id="gateway-probe-warnings" />[Gateway probe warnings](/gateway/troubleshooting/config-validation-and-probes#gateway-probe-warnings)
- <a id="channel-connected%2C-messages-not-flowing" /><a id="channel-connected-messages-not-flowing" />[Channel connected, messages not flowing](/gateway/troubleshooting/channel-delivery-and-tools#channel-connected-messages-not-flowing)
- <a id="cron-and-heartbeat-delivery" />[Cron and heartbeat delivery](/gateway/troubleshooting/channel-delivery-and-tools#cron-and-heartbeat-delivery)
- <a id="common-signatures-3" />[Common signatures (cron and heartbeat)](/gateway/troubleshooting/channel-delivery-and-tools#common-signatures)
- <a id="node-paired%2C-tool-fails" /><a id="node-paired-tool-fails" />[Node paired, tool fails](/gateway/troubleshooting/channel-delivery-and-tools#node-paired-tool-fails)
- <a id="browser-tool-fails" />[Browser tool fails](/gateway/troubleshooting/channel-delivery-and-tools#browser-tool-fails)
- <a id="plugin-executable-signatures" />[Plugin / executable signatures](/gateway/troubleshooting/channel-delivery-and-tools#plugin-executable-signatures)
- <a id="chrome-mcp-existing-session-signatures" />[Chrome MCP / existing-session signatures](/gateway/troubleshooting/channel-delivery-and-tools#chrome-mcp-existing-session-signatures)
- <a id="element-screenshot-upload-signatures" />[Element / screenshot / upload signatures](/gateway/troubleshooting/channel-delivery-and-tools#element-screenshot-upload-signatures)

## If you upgraded and something suddenly broke

Most post-upgrade breakage is config drift or stricter defaults now being enforced.

<AccordionGroup>
  <Accordion title="1. Auth and URL override behavior changed">
    ```bash
    openclaw gateway status
    openclaw config get gateway.mode
    openclaw config get gateway.remote.url
    openclaw config get gateway.auth.mode
    ```

    What to check:

    - If `gateway.mode=remote`, CLI calls may be targeting remote while your local service is fine.
    - Explicit `--url` calls do not fall back to stored credentials.

    Common signatures:

    - `gateway connect failed:` → wrong URL target.
    - `unauthorized` → endpoint reachable but wrong auth.

  </Accordion>
  <Accordion title="2. Bind and auth guardrails are stricter">
    ```bash
    openclaw config get gateway.bind
    openclaw config get gateway.auth.mode
    openclaw config get gateway.auth.token
    openclaw gateway status
    openclaw logs --follow
    ```

    What to check:

    - Non-loopback binds (`lan`, `tailnet`, `custom`) need a valid gateway auth path: shared token/password auth, or a correctly configured non-loopback `trusted-proxy` deployment.
    - Old keys like `gateway.token` do not replace `gateway.auth.token`.

    Common signatures:

    - `refusing to bind gateway ... without auth` → non-loopback bind without a valid gateway auth path.
    - `Connectivity probe: failed` while runtime is running → gateway alive but inaccessible with current auth/url.

  </Accordion>
  <Accordion title="3. Pairing and device identity state changed">
    ```bash
    openclaw devices list
    openclaw pairing list --channel <channel> [--account <id>]
    openclaw logs --follow
    openclaw doctor
    ```

    What to check:

    - Pending device approvals for dashboard/nodes.
    - Pending DM pairing approvals after policy or identity changes.

    Common signatures:

    - `device identity required` → device auth not satisfied.
    - `pairing required` → sender/device must be approved.

  </Accordion>
</AccordionGroup>

If the service config and runtime still disagree after checks, reinstall service metadata from the same profile/state directory:

```bash
openclaw gateway install --force
openclaw gateway restart
```

Related:

- [Authentication](/gateway/authentication)
- [Background exec and process tool](/gateway/background-process)
- [Node pairing](/gateway/pairing)

## Related

- [Doctor](/gateway/doctor)
- [FAQ](/help/faq)
- [Gateway runbook](/gateway)
