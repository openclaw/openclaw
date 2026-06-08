# Documentation coverage audit

- Groups completed: 54/54
- Total page/section items: 6123
- Unmapped or structural-gap items: 824

## Summary

- new_feature: 184
- new_category: 162
- new_surface: 165
- nav_missing_source: 313

## Recommend new surface

- `01-02-get-started-first-steps-p003-s004` | `start/wizard` | `Add another agent`
  Recommendation: `new_surface`
  Source: `start/wizard` :: `L111 Add another agent`
  Target: `Multi-agent configuration and routing` / `Agent creation, workspace isolation, and bindings` / `CLI agent creation and binding setup`
  Closest existing: `Docker / Podman hosting` / `Docker Install, Compose, and First-run Setup` / `First-run onboarding`
  Why: `openclaw agents add` plus per-agent workspace/session/auth isolation and optional bindings are a distinct user-facing operating area with dedicated docs (for example docs/cli/agents.md and docs/concepts/multi-agent.md), but no current taxonomy surface owns that capability.
- `02-03-install-containers-p001-root` | `install/ansible` | `(page)`
  Recommendation: `new_surface`
  Source: `install/ansible` :: `(page)`
  Target: `Ansible install path` / `Automated remote deployment and hardening` / `Ansible deployment overview`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: The page describes a first-party automated Debian/Ubuntu deployment path with its own security posture, install flow, and maintenance model that is not represented as a surface today.
- `02-03-install-containers-p001-s001` | `install/ansible` | `Prerequisites`
  Recommendation: `new_surface`
  Source: `install/ansible` :: `L16 Prerequisites`
  Target: `Ansible install path` / `Automated remote deployment and hardening` / `Remote host prerequisites`
  Closest existing: `Raspberry Pi / small Linux devices` / `Arm Linux Install and Runtime Prerequisites` / `Arm Linux Install and Runtime Prerequisites`
  Why: These prerequisites are specific to the Ansible-based remote-server path rather than the existing local CLI, Docker, or Podman install surfaces.
- `02-03-install-containers-p001-s002` | `install/ansible` | `What you get`
  Recommendation: `new_surface`
  Source: `install/ansible` :: `L25 What you get`
  Target: `Ansible install path` / `Automated remote deployment and hardening` / `Provisioned security and service stack`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: This section is the Ansible value proposition: firewall isolation, Tailscale, Docker for sandboxing, and hardened systemd provisioning as one packaged install method.
- `02-03-install-containers-p001-s003` | `install/ansible` | `Quick start`
  Recommendation: `new_surface`
  Source: `install/ansible` :: `L34 Quick start`
  Target: `Ansible install path` / `Automated remote deployment and hardening` / `One-command bootstrap`
  Closest existing: `CLI` / `CLI Setup` / `Installer scripts`
  Why: The curl-to-install bootstrap is specific to the Ansible deployment path and is not captured by existing Linux host or Docker install categories.
- `02-03-install-containers-p001-s004` | `install/ansible` | `What gets installed`
  Recommendation: `new_surface`
  Source: `install/ansible` :: `L42 What gets installed`
  Target: `Ansible install path` / `Automated remote deployment and hardening` / `Provisioned components`
  Closest existing: `Plugin SDK and bundled plugin architecture` / `Installing and running plugins` / `Enable and disable`
  Why: The installed stack here includes host-based gateway provisioning plus Docker-for-sandbox and Tailscale/UFW hardening, which is broader than any single existing surface.
- `02-03-install-containers-p001-s008` | `install/ansible` | `Manual installation`
  Recommendation: `new_surface`
  Source: `install/ansible` :: `L123 Manual installation`
  Target: `Ansible install path` / `Automated remote deployment and hardening` / `Manual playbook workflow`
  Closest existing: `Microsoft Teams` / `Setup, App Registration, Credentials, and Admin Install` / `Setup, App Registration, Credentials, and Admin Install`
  Why: This is the manual-control branch of the Ansible install path and still belongs to the unmodeled deployment surface.
- `02-03-install-containers-p001-s009` | `install/ansible` | `Updating`
  Recommendation: `new_surface`
  Source: `install/ansible` :: `L158 Updating`
  Target: `Ansible install path` / `Automated remote deployment and hardening` / `Playbook rerun and update model`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: Rerunning an idempotent playbook for configuration drift is specific to the Ansible deployment method, not the standard CLI update surface.
- `02-04-install-hosting-p009-root` | `install/kubernetes` | `(page)`
  Recommendation: `new_surface`
  Source: `install/kubernetes` :: `(page)`
  Target: `Kubernetes hosting` / `Kustomize deployment, secrets, and cluster lifecycle` / `Kustomize deployment baseline`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: The page defines Kubernetes deployment as a distinct hosting surface rather than a small variation on Linux VPS or Docker hosts.
- `02-04-install-hosting-p009-s001` | `install/kubernetes` | `Why not Helm?`
  Recommendation: `new_surface`
  Source: `install/kubernetes` :: `L11 Why not Helm?`
  Target: `Kubernetes hosting` / `Kustomize deployment, secrets, and cluster lifecycle` / `Kustomize-first packaging posture`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: The Helm-vs-Kustomize rationale describes packaging and maintenance choices unique to Kubernetes deployment.
- `02-04-install-hosting-p009-s002` | `install/kubernetes` | `What you need`
  Recommendation: `new_surface`
  Source: `install/kubernetes` :: `L15 What you need`
  Target: `Kubernetes hosting` / `Kustomize deployment, secrets, and cluster lifecycle` / `Cluster and provider-key prerequisites`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: Cluster connectivity and provider key requirements are Kubernetes-specific deployment prerequisites.
- `02-04-install-hosting-p009-s003` | `install/kubernetes` | `Quick start`
  Recommendation: `new_surface`
  Source: `install/kubernetes` :: `L21 Quick start`
  Target: `Kubernetes hosting` / `Kustomize deployment, secrets, and cluster lifecycle` / `One-command deploy and local port-forward`
  Closest existing: `CLI` / `CLI Setup` / `Installer scripts`
  Why: The quick-start path uses cluster deploy scripts and kubectl port-forward rather than host-level service management.
- `02-04-install-hosting-p009-s004` | `install/kubernetes` | `Local testing with Kind`
  Recommendation: `new_surface`
  Source: `install/kubernetes` :: `L41 Local testing with Kind`
  Target: `Kubernetes hosting` / `Kustomize deployment, secrets, and cluster lifecycle` / `Kind local cluster workflow`
  Closest existing: `CLI` / `CLI Setup` / `Local prefix install`
  Why: Local Kind testing is a Kubernetes-only workflow and has no real home in the current taxonomy.
- `02-04-install-hosting-p009-s005` | `install/kubernetes` | `Step by step`
  Recommendation: `new_surface`
  Source: `install/kubernetes` :: `L52 Step by step`
  Target: `Kubernetes hosting` / `Kustomize deployment, secrets, and cluster lifecycle` / `Cluster deployment walkthrough`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: The page-level walkthrough is a Kubernetes operator path, not generic Linux hosting.
- `02-04-install-hosting-p009-s006` | `install/kubernetes` | `1) Deploy`
  Recommendation: `new_surface`
  Source: `install/kubernetes` :: `L54 1) Deploy`
  Target: `Kubernetes hosting` / `Kustomize deployment, secrets, and cluster lifecycle` / `Secret creation and manifest apply`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: Deploying manifests and bootstrap secrets is specific to the cluster surface.
- `02-04-install-hosting-p009-s007` | `install/kubernetes` | `2) Access the gateway`
  Recommendation: `new_surface`
  Source: `install/kubernetes` :: `L76 2) Access the gateway`
  Target: `Kubernetes hosting` / `Kustomize deployment, secrets, and cluster lifecycle` / `Port-forward access path`
  Closest existing: `CLI` / `Gateway Service Management` / `Service health checks`
  Why: Accessing the gateway through kubectl port-forward is a Kubernetes-specific operator flow.
- `02-04-install-hosting-p009-s008` | `install/kubernetes` | `What gets deployed`
  Recommendation: `new_surface`
  Source: `install/kubernetes` :: `L83 What gets deployed`
  Target: `Kubernetes hosting` / `Kustomize deployment, secrets, and cluster lifecycle` / `Namespace, deployment, service, PVC, ConfigMap, and Secret layout`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: The deployed resource model is unique to the Kubernetes runtime.
- `02-04-install-hosting-p009-s009` | `install/kubernetes` | `Customization`
  Recommendation: `new_surface`
  Source: `install/kubernetes` :: `L94 Customization`
  Target: `Kubernetes hosting` / `Manifest customization, state, and exposure` / `Manifest customization`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: The customization section is about editing manifests and overlays rather than host config files.
- `02-04-install-hosting-p009-s010` | `install/kubernetes` | `Agent instructions`
  Recommendation: `new_surface`
  Source: `install/kubernetes` :: `L96 Agent instructions`
  Target: `Kubernetes hosting` / `Manifest customization, state, and exposure` / `ConfigMap-based AGENTS.md injection`
  Closest existing: `Native Windows CLI and Gateway` / `Windows Command Spawning and Package-manager Shims` / `Native Windows smoke coverage that exercises`
  Why: Injecting agent instructions through the ConfigMap is a Kubernetes-specific configuration mechanism.
- `02-04-install-hosting-p009-s011` | `install/kubernetes` | `Gateway config`
  Recommendation: `new_surface`
  Source: `install/kubernetes` :: `L104 Gateway config`
  Target: `Kubernetes hosting` / `Manifest customization, state, and exposure` / `ConfigMap-based gateway config`
  Closest existing: `CLI` / `Gateway Service Management` / `Service health checks`
  Why: Gateway config delivered through the ConfigMap is a distinct cluster capability.
- `02-04-install-hosting-p009-s012` | `install/kubernetes` | `Add providers`
  Recommendation: `new_surface`
  Source: `install/kubernetes` :: `L108 Add providers`
  Target: `Kubernetes hosting` / `Manifest customization, state, and exposure` / `Secret rotation and provider-key patching`
  Closest existing: `Agent runtime and provider execution` / `Local and Self-hosted Providers` / `Local failure handling`
  Why: Managing provider credentials through Kubernetes Secrets is cluster-specific.
- `02-04-install-hosting-p009-s013` | `install/kubernetes` | `Custom namespace`
  Recommendation: `new_surface`
  Source: `install/kubernetes` :: `L129 Custom namespace`
  Target: `Kubernetes hosting` / `Manifest customization, state, and exposure` / `Namespace override`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: Namespace-level deployment scoping is unique to the Kubernetes surface.
- `02-04-install-hosting-p009-s014` | `install/kubernetes` | `Custom image`
  Recommendation: `new_surface`
  Source: `install/kubernetes` :: `L135 Custom image`
  Target: `Kubernetes hosting` / `Manifest customization, state, and exposure` / `Image pinning`
  Closest existing: `Docker / Podman hosting` / `Image Build, Release Packaging, and Attestations` / `Excludes user-created custom Dockerfiles except where`
  Why: Custom image selection via deployment manifests is part of cluster deployment management.
- `02-04-install-hosting-p009-s015` | `install/kubernetes` | `Expose beyond port-forward`
  Recommendation: `new_surface`
  Source: `install/kubernetes` :: `L143 Expose beyond port-forward`
  Target: `Kubernetes hosting` / `Manifest customization, state, and exposure` / `Ingress and load-balancer exposure model`
  Closest existing: `Gateway runtime` / `Observability, Health, and Repair` / `Automated doctor checks`
  Why: Moving beyond port-forward requires Kubernetes-specific exposure and auth decisions.
- `02-04-install-hosting-p009-s016` | `install/kubernetes` | `Re-deploy`
  Recommendation: `new_surface`
  Source: `install/kubernetes` :: `L153 Re-deploy`
  Target: `Kubernetes hosting` / `Kustomize deployment, secrets, and cluster lifecycle` / `Redeploy workflow`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: Re-applying manifests and restarting the pod is a Kubernetes lifecycle step.
- `02-04-install-hosting-p009-s017` | `install/kubernetes` | `Teardown`
  Recommendation: `new_surface`
  Source: `install/kubernetes` :: `L161 Teardown`
  Target: `Kubernetes hosting` / `Kustomize deployment, secrets, and cluster lifecycle` / `Cluster teardown`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: Namespace deletion and PVC cleanup are cluster-specific removal flows.
- `02-04-install-hosting-p009-s018` | `install/kubernetes` | `Architecture notes`
  Recommendation: `new_surface`
  Source: `install/kubernetes` :: `L169 Architecture notes`
  Target: `Kubernetes hosting` / `Kustomize deployment, secrets, and cluster lifecycle` / `Cluster security and runtime notes`
  Closest existing: `Google Chat` / `Plugin Distribution Operator UI and Docs` / `Plugin Distribution Operator UI and Docs`
  Why: The architecture notes describe pod security context, namespace scope, and localhost access posture specific to Kubernetes.
- `02-04-install-hosting-p009-s019` | `install/kubernetes` | `File structure`
  Recommendation: `new_surface`
  Source: `install/kubernetes` :: `L178 File structure`
  Target: `Kubernetes hosting` / `Kustomize deployment, secrets, and cluster lifecycle` / `Script and manifest layout`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: The file structure documents the Kubernetes deployment toolchain itself.
- `02-04-install-hosting-p009-s020` | `install/kubernetes` | `Related`
  Recommendation: `new_surface`
  Source: `install/kubernetes` :: `L192 Related`
  Target: `Kubernetes hosting` / `Kustomize deployment, secrets, and cluster lifecycle` / `Reference docs adjacency`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: The related links close out a Kubernetes-specific deployment guide.
- `03-05-channels-configuration-p010-root` | `channels/qa-channel` | `(page)`
  Recommendation: `new_surface`
  Source: `channels/qa-channel` :: `(page)`
  Target: `QA channel` / `QA channel overview` / `Synthetic QA channel transport`
  Closest existing: `Feishu, QQ Bot, WeChat, Yuanbao, Zalo, Zalo Personal, regional channels` / `Shared Regional Channel Catalog, Install, and Status` / `Channel setup wizard`
  Why: `docs/channels/qa-channel.md` and `docs/plugins/reference/qa-channel.md` document a distinct bundled channel/plugin (`@openclaw/qa-channel`) with its own config and operator workflows, but no taxonomy surface currently owns it.
- `04-01-agents-fundamentals-p013-root` | `concepts/qa-e2e-automation` | `(page)`
  Recommendation: `new_surface`
  Source: `concepts/qa-e2e-automation` :: `(page)`
  Target: `QA framework and synthetic scenario automation` / `QA command surface, lab, and live transport contract` / `QA overview and command surface`
  Closest existing: `Discord` / `Realtime Discord Voice Channels` / `Includes Discord voice channel sessions controlled`
  Why: The exact auto-accept to Discord voice coverage is obviously wrong. `docs/concepts/qa-e2e-automation.md` is the shared QA stack overview for `qa-lab`, `qa-channel`, repo-backed scenarios, live transport lanes, and reporting, which is a missing cross-surface QA subsystem in the taxonomy.
- `04-01-agents-fundamentals-p013-s001` | `concepts/qa-e2e-automation` | `Command surface`
  Recommendation: `new_surface`
  Source: `concepts/qa-e2e-automation` :: `L27 Command surface`
  Target: `QA framework and synthetic scenario automation` / `QA command surface, lab, and live transport contract` / `QA overview and command surface`
  Closest existing: `Discord` / `Realtime Discord Voice Channels` / `Includes Discord voice channel sessions controlled`
  Why: `Command surface` enumerates the shared `pnpm openclaw qa <subcommand>` contract across synthetic and live QA lanes. Treating it as Discord voice behavior is a false-positive exact match.
- `04-01-agents-fundamentals-p013-s002` | `concepts/qa-e2e-automation` | `Operator flow`
  Recommendation: `new_surface`
  Source: `concepts/qa-e2e-automation` :: `L53 Operator flow`
  Target: `QA framework and synthetic scenario automation` / `QA command surface, lab, and live transport contract` / `QA lab operator flow`
  Closest existing: `Slack` / `Diagnostics, Status, and Operator Repair` / `Diagnostics, Status, and Operator Repair`
  Why: `Operator flow` documents the generic QA Lab plus Gateway dashboard workflow. It is shared QA infrastructure, not Slack diagnostics.
- `04-01-agents-fundamentals-p013-s003` | `concepts/qa-e2e-automation` | `Live transport coverage`
  Recommendation: `new_surface`
  Source: `concepts/qa-e2e-automation` :: `L265 Live transport coverage`
  Target: `QA framework and synthetic scenario automation` / `QA command surface, lab, and live transport contract` / `Shared live transport coverage contract`
  Closest existing: `Discord` / `Realtime Discord Voice Channels` / `Includes Discord voice channel sessions controlled`
  Why: `Live transport coverage` defines the shared contract that Matrix, Telegram, Discord, and Slack lanes implement. Auto-accepting it into a Discord-only category is incorrect.
- `04-01-agents-fundamentals-p014-root` | `concepts/personal-agent-benchmark-pack` | `(page)`
  Recommendation: `new_surface`
  Source: `concepts/personal-agent-benchmark-pack` :: `(page)`
  Target: `QA framework and synthetic scenario automation` / `Scenario packs and synthetic local assistant QA` / `Personal agent benchmark pack`
  Closest existing: `Gateway runtime` / `Core Rpc Coverage` / `Agents and artifacts`
  Why: This page documents a shared repo-backed QA surface for local personal-assistant workflows that is not represented anywhere in the current taxonomy. It is neither a channel plugin nor a runtime feature; it is a distinct QA subsystem.
- `04-01-agents-fundamentals-p014-s001` | `concepts/personal-agent-benchmark-pack` | `Scenarios`
  Recommendation: `new_surface`
  Source: `concepts/personal-agent-benchmark-pack` :: `L30 Scenarios`
  Target: `QA framework and synthetic scenario automation` / `Scenario packs and synthetic local assistant QA` / `Personal agent benchmark pack`
  Closest existing: `Gateway runtime` / `Core Rpc Coverage` / `Agents and artifacts`
  Why: The `Scenarios` section defines the pack contract, invocation path, additive scenario composition, and deterministic local runner expectations. That belongs on the same missing shared QA surface.
- `04-01-agents-fundamentals-p014-s002` | `concepts/personal-agent-benchmark-pack` | `Privacy Model`
  Recommendation: `new_surface`
  Source: `concepts/personal-agent-benchmark-pack` :: `L51 Privacy Model`
  Target: `QA framework and synthetic scenario automation` / `Scenario packs and synthetic local assistant QA` / `Personal agent benchmark pack`
  Closest existing: `Agent runtime and provider execution` / `Model and Runtime Selection` / `Model reference selection`
  Why: The privacy model is part of the benchmark-pack contract: fake users, fake secrets, temporary QA workspace boundaries, and artifact safety expectations. That is still the same missing QA surface.
- `04-01-agents-fundamentals-p014-s003` | `concepts/personal-agent-benchmark-pack` | `Extending The Pack`
  Recommendation: `new_surface`
  Source: `concepts/personal-agent-benchmark-pack` :: `L62 Extending The Pack`
  Target: `QA framework and synthetic scenario automation` / `Scenario packs and synthetic local assistant QA` / `Personal agent benchmark pack`
  Closest existing: `Gateway runtime` / `Core Rpc Coverage` / `Agents and artifacts`
  Why: `Extending The Pack` documents the scenario-catalog extension contract and reinforces that this is a reusable QA subsystem, not an incidental note on another surface.
- `05-01-capabilities-overview-p001-s002` | `tools/index` | `Choose tools, skills, or plugins`
  Recommendation: `new_surface`
  Source: `tools/index` :: `L34 Choose tools, skills, or plugins`
  Target: `Skills and instruction packs` / `Skill loading, sources, and workflow guidance` / `SKILL.md instruction packs`
  Closest existing: `Plugin SDK and bundled plugin architecture` / `Provider and tool plugins` / `Web search and fetch`
  Why: This section treats skills as a distinct operator-facing capability family: reusable `SKILL.md` packs with their own loading locations, workflow role, and plugin/workspace/shared-root packaging model. The current taxonomy has plugin, tool, and runtime surfaces, but no surface that actually owns skills as a first-class capability area.
- `05-03-capabilities-bundled-plugin-guides-p004-root` | `plugins/google-meet` | `(page)`
  Recommendation: `new_surface`
  Source: `plugins/google-meet` :: `(page)`
  Target: `Google Meet plugin` / `Meeting transport and participation` / `Explicit Google Meet join and create flows`
  Closest existing: `Google provider path` / `Plugin Distribution and Cross-surface Capability Adapters` / `Plugin Distribution and Cross-surface Capability Adapters`
  Why: docs/plugins/google-meet.md documents a distinct bundled plugin with its own CLI/tool surface, Chrome and Twilio transports, OAuth flows, browser-node topology, and meeting artifact workflows. No current taxonomy surface owns Google Meet participation as a durable product area.
- `05-03-capabilities-bundled-plugin-guides-p005-root` | `plugins/workboard` | `(page)`
  Recommendation: `new_surface`
  Source: `plugins/workboard` :: `(page)`
  Target: `Workboard plugin` / `Board and card lifecycle` / `Local workboard and card model`
  Closest existing: `Plugin SDK and bundled plugin architecture` / `Bundled plugins` / `Bundled channel IDs`
  Why: docs/plugins/workboard.md documents a bundled dashboard/CLI/agent-tool plugin with its own board storage, card lifecycle, session links, dispatch model, and permissions. No current taxonomy surface owns Workboard as a durable product area.
- `05-05-capabilities-skills-p001-root` | `tools/skills` | `(page)`
  Recommendation: `new_surface`
  Source: `tools/skills` :: `(page)`
  Target: `Skills` / `Skill loading, visibility, and prompt assembly` / `Skills reference surface`
  Closest existing: `Media understanding and media generation` / `Image Generation Tool and Provider Routing` / `Image Generation Tool and Provider Routing`
  Why: The current exact-doc-ref auto-match to `Media understanding and media generation > Image Generation Tool and Provider Routing` is a false positive caused by an incorrect `docs/tools/skills.md` link in taxonomy; `Skills` needs its own surface for section `(page)`.
- `05-05-capabilities-skills-p001-s001` | `tools/skills` | `Loading order`
  Recommendation: `new_surface`
  Source: `tools/skills` :: `L32 Loading order`
  Target: `Skills` / `Skill loading, visibility, and prompt assembly` / `Skill root precedence`
  Closest existing: `Media understanding and media generation` / `Image Generation Tool and Provider Routing` / `Image Generation Tool and Provider Routing`
  Why: The current exact-doc-ref auto-match to `Media understanding and media generation > Image Generation Tool and Provider Routing` is a false positive caused by an incorrect `docs/tools/skills.md` link in taxonomy; `Skills` needs its own surface for section `Loading order`.
- `05-05-capabilities-skills-p001-s002` | `tools/skills` | `Per-agent vs shared skills`
  Recommendation: `new_surface`
  Source: `tools/skills` :: `L64 Per-agent vs shared skills`
  Target: `Skills` / `Skill loading, visibility, and prompt assembly` / `Per-agent versus shared skill scope`
  Closest existing: `Media understanding and media generation` / `Image Generation Tool and Provider Routing` / `Image Generation Tool and Provider Routing`
  Why: The current exact-doc-ref auto-match to `Media understanding and media generation > Image Generation Tool and Provider Routing` is a false positive caused by an incorrect `docs/tools/skills.md` link in taxonomy; `Skills` needs its own surface for section `Per-agent vs shared skills`.
- `05-05-capabilities-skills-p001-s003` | `tools/skills` | `Agent allowlists`
  Recommendation: `new_surface`
  Source: `tools/skills` :: `L77 Agent allowlists`
  Target: `Skills` / `Skill loading, visibility, and prompt assembly` / `Agent skill allowlists`
  Closest existing: `Media understanding and media generation` / `Image Generation Tool and Provider Routing` / `Image Generation Tool and Provider Routing`
  Why: The current exact-doc-ref auto-match to `Media understanding and media generation > Image Generation Tool and Provider Routing` is a false positive caused by an incorrect `docs/tools/skills.md` link in taxonomy; `Skills` needs its own surface for section `Agent allowlists`.
- `05-05-capabilities-skills-p001-s004` | `tools/skills` | `Plugins and skills`
  Recommendation: `new_surface`
  Source: `tools/skills` :: `L110 Plugins and skills`
  Target: `Skills` / `Plugin-shipped skills and precedence` / `Plugin skill integration`
  Closest existing: `Media understanding and media generation` / `Image Generation Tool and Provider Routing` / `Image Generation Tool and Provider Routing`
  Why: The current exact-doc-ref auto-match to `Media understanding and media generation > Image Generation Tool and Provider Routing` is a false positive caused by an incorrect `docs/tools/skills.md` link in taxonomy; `Skills` needs its own surface for section `Plugins and skills`.
- `05-05-capabilities-skills-p001-s005` | `tools/skills` | `Skill Workshop`
  Recommendation: `new_surface`
  Source: `tools/skills` :: `L124 Skill Workshop`
  Target: `Skills` / `Skill Workshop proposals` / `Proposal-first skill updates`
  Closest existing: `Media understanding and media generation` / `Image Generation Tool and Provider Routing` / `Image Generation Tool and Provider Routing`
  Why: The current exact-doc-ref auto-match to `Media understanding and media generation > Image Generation Tool and Provider Routing` is a false positive caused by an incorrect `docs/tools/skills.md` link in taxonomy; `Skills` needs its own surface for section `Skill Workshop`.
- `05-05-capabilities-skills-p001-s006` | `tools/skills` | `Installing from ClawHub`
  Recommendation: `new_surface`
  Source: `tools/skills` :: `L140 Installing from ClawHub`
  Target: `Skills` / `Skill distribution and publishing` / `ClawHub skill install and update flows`
  Closest existing: `Media understanding and media generation` / `Image Generation Tool and Provider Routing` / `Image Generation Tool and Provider Routing`
  Why: The current exact-doc-ref auto-match to `Media understanding and media generation > Image Generation Tool and Provider Routing` is a false positive caused by an incorrect `docs/tools/skills.md` link in taxonomy; `Skills` needs its own surface for section `Installing from ClawHub`.
- `05-05-capabilities-skills-p001-s007` | `tools/skills` | `Security`
  Recommendation: `new_surface`
  Source: `tools/skills` :: `L194 Security`
  Target: `Skills` / `Skill trust and secret boundaries` / `Third-party skill trust and scanning`
  Closest existing: `Media understanding and media generation` / `Image Generation Tool and Provider Routing` / `Image Generation Tool and Provider Routing`
  Why: The current exact-doc-ref auto-match to `Media understanding and media generation > Image Generation Tool and Provider Routing` is a false positive caused by an incorrect `docs/tools/skills.md` link in taxonomy; `Skills` needs its own surface for section `Security`.
- `05-05-capabilities-skills-p001-s008` | `tools/skills` | `SKILL.md format`
  Recommendation: `new_surface`
  Source: `tools/skills` :: `L228 SKILL.md format`
  Target: `Skills` / `Skill authoring and metadata` / `SKILL.md schema reference`
  Closest existing: `Media understanding and media generation` / `Image Generation Tool and Provider Routing` / `Image Generation Tool and Provider Routing`
  Why: The current exact-doc-ref auto-match to `Media understanding and media generation > Image Generation Tool and Provider Routing` is a false positive caused by an incorrect `docs/tools/skills.md` link in taxonomy; `Skills` needs its own surface for section `SKILL.md format`.
- `05-05-capabilities-skills-p001-s009` | `tools/skills` | `Optional frontmatter keys`
  Recommendation: `new_surface`
  Source: `tools/skills` :: `L248 Optional frontmatter keys`
  Target: `Skills` / `Skill authoring and metadata` / `Optional skill frontmatter keys`
  Closest existing: `Media understanding and media generation` / `Image Generation Tool and Provider Routing` / `Image Generation Tool and Provider Routing`
  Why: The current exact-doc-ref auto-match to `Media understanding and media generation > Image Generation Tool and Provider Routing` is a false positive caused by an incorrect `docs/tools/skills.md` link in taxonomy; `Skills` needs its own surface for section `Optional frontmatter keys`.
- `05-05-capabilities-skills-p001-s010` | `tools/skills` | `Gating`
  Recommendation: `new_surface`
  Source: `tools/skills` :: `L280 Gating`
  Target: `Skills` / `Skill gating and runtime requirements` / `Conditional skill gating`
  Closest existing: `Media understanding and media generation` / `Image Generation Tool and Provider Routing` / `Image Generation Tool and Provider Routing`
  Why: The current exact-doc-ref auto-match to `Media understanding and media generation > Image Generation Tool and Provider Routing` is a false positive caused by an incorrect `docs/tools/skills.md` link in taxonomy; `Skills` needs its own surface for section `Gating`.
- `05-05-capabilities-skills-p001-s011` | `tools/skills` | `Installer specs`
  Recommendation: `new_surface`
  Source: `tools/skills` :: `L348 Installer specs`
  Target: `Skills` / `Skill distribution and publishing` / `Installer metadata and execution`
  Closest existing: `Media understanding and media generation` / `Image Generation Tool and Provider Routing` / `Image Generation Tool and Provider Routing`
  Why: The current exact-doc-ref auto-match to `Media understanding and media generation > Image Generation Tool and Provider Routing` is a false positive caused by an incorrect `docs/tools/skills.md` link in taxonomy; `Skills` needs its own surface for section `Installer specs`.
- `05-05-capabilities-skills-p001-s012` | `tools/skills` | `Config overrides`
  Recommendation: `new_surface`
  Source: `tools/skills` :: `L410 Config overrides`
  Target: `Skills` / `Skills configuration` / `Skill-specific config overrides`
  Closest existing: `Media understanding and media generation` / `Image Generation Tool and Provider Routing` / `Image Generation Tool and Provider Routing`
  Why: The current exact-doc-ref auto-match to `Media understanding and media generation > Image Generation Tool and Provider Routing` is a false positive caused by an incorrect `docs/tools/skills.md` link in taxonomy; `Skills` needs its own surface for section `Config overrides`.
- `05-05-capabilities-skills-p001-s013` | `tools/skills` | `Environment injection`
  Recommendation: `new_surface`
  Source: `tools/skills` :: `L467 Environment injection`
  Target: `Skills` / `Skills configuration` / `Host-only environment injection`
  Closest existing: `Media understanding and media generation` / `Image Generation Tool and Provider Routing` / `Image Generation Tool and Provider Routing`
  Why: The current exact-doc-ref auto-match to `Media understanding and media generation > Image Generation Tool and Provider Routing` is a false positive caused by an incorrect `docs/tools/skills.md` link in taxonomy; `Skills` needs its own surface for section `Environment injection`.
- `05-05-capabilities-skills-p001-s014` | `tools/skills` | `Snapshots and refresh`
  Recommendation: `new_surface`
  Source: `tools/skills` :: `L500 Snapshots and refresh`
  Target: `Skills` / `Skill loading, visibility, and prompt assembly` / `Skill snapshot refresh`
  Closest existing: `Media understanding and media generation` / `Image Generation Tool and Provider Routing` / `Image Generation Tool and Provider Routing`
  Why: The current exact-doc-ref auto-match to `Media understanding and media generation > Image Generation Tool and Provider Routing` is a false positive caused by an incorrect `docs/tools/skills.md` link in taxonomy; `Skills` needs its own surface for section `Snapshots and refresh`.
- `05-05-capabilities-skills-p001-s015` | `tools/skills` | `Token impact`
  Recommendation: `new_surface`
  Source: `tools/skills` :: `L550 Token impact`
  Target: `Skills` / `Skill loading, visibility, and prompt assembly` / `Prompt token cost controls`
  Closest existing: `Media understanding and media generation` / `Image Generation Tool and Provider Routing` / `Image Generation Tool and Provider Routing`
  Why: The current exact-doc-ref auto-match to `Media understanding and media generation > Image Generation Tool and Provider Routing` is a false positive caused by an incorrect `docs/tools/skills.md` link in taxonomy; `Skills` needs its own surface for section `Token impact`.
- `05-05-capabilities-skills-p001-s016` | `tools/skills` | `Related`
  Recommendation: `new_surface`
  Source: `tools/skills` :: `L566 Related`
  Target: `Skills` / `Skill loading, visibility, and prompt assembly` / `Skills reference surface`
  Closest existing: `Media understanding and media generation` / `Image Generation Tool and Provider Routing` / `Image Generation Tool and Provider Routing`
  Why: The current exact-doc-ref auto-match to `Media understanding and media generation > Image Generation Tool and Provider Routing` is a false positive caused by an incorrect `docs/tools/skills.md` link in taxonomy; `Skills` needs its own surface for section `Related`.
- `05-05-capabilities-skills-p002-root` | `tools/skill-workshop` | `(page)`
  Recommendation: `new_surface`
  Source: `tools/skill-workshop` :: `(page)`
  Target: `Skills` / `Skill Workshop proposals` / `Skill Workshop governance`
  Closest existing: `Docker / Podman hosting` / `Containerized Agents, Sandbox, and Tooling Support` / `Container image dependency baking`
  Why: `Skill Workshop` section `(page)` documents governed skill proposal lifecycle behavior that is not modeled as its own maturity-scorecard surface today; existing plugin, CLI, and Gateway categories only cover adjacent mechanics.
- `05-05-capabilities-skills-p002-s001` | `tools/skill-workshop` | `How it works`
  Recommendation: `new_surface`
  Source: `tools/skill-workshop` :: `L22 How it works`
  Target: `Skills` / `Skill Workshop proposals` / `Proposal-first skill updates`
  Closest existing: `CLI` / `Plugin and Channel Setup` / `Post-setup probes`
  Why: `Skill Workshop` section `How it works` documents governed skill proposal lifecycle behavior that is not modeled as its own maturity-scorecard surface today; existing plugin, CLI, and Gateway categories only cover adjacent mechanics.
- `05-05-capabilities-skills-p002-s002` | `tools/skill-workshop` | `Lifecycle`
  Recommendation: `new_surface`
  Source: `tools/skill-workshop` :: `L38 Lifecycle`
  Target: `Skills` / `Skill Workshop proposals` / `Proposal lifecycle states`
  Closest existing: `OpenAI / Codex provider path` / `Native Codex App-server Harness and Thread Lifecycle` / `Native Codex App-server Harness and Thread Lifecycle`
  Why: `Skill Workshop` section `Lifecycle` documents governed skill proposal lifecycle behavior that is not modeled as its own maturity-scorecard surface today; existing plugin, CLI, and Gateway categories only cover adjacent mechanics.
- `05-05-capabilities-skills-p002-s003` | `tools/skill-workshop` | `Chat`
  Recommendation: `new_surface`
  Source: `tools/skill-workshop` :: `L51 Chat`
  Target: `Skills` / `Skill Workshop proposals` / `Chat proposal operations`
  Closest existing: `Google Chat` / `Message Actions Reactions and Approval Auth` / `Message Actions Reactions and Approval Auth`
  Why: `Skill Workshop` section `Chat` documents governed skill proposal lifecycle behavior that is not modeled as its own maturity-scorecard surface today; existing plugin, CLI, and Gateway categories only cover adjacent mechanics.
- `05-05-capabilities-skills-p002-s004` | `tools/skill-workshop` | `CLI`
  Recommendation: `new_surface`
  Source: `tools/skill-workshop` :: `L80 CLI`
  Target: `Skills` / `Skill Workshop proposals` / `CLI proposal operations`
  Closest existing: `Docker / Podman hosting` / `Containerized Agents, Sandbox, and Tooling Support` / `Container image dependency baking`
  Why: `Skill Workshop` section `CLI` documents governed skill proposal lifecycle behavior that is not modeled as its own maturity-scorecard surface today; existing plugin, CLI, and Gateway categories only cover adjacent mechanics.
- `05-05-capabilities-skills-p002-s005` | `tools/skill-workshop` | `Proposal content`
  Recommendation: `new_surface`
  Source: `tools/skill-workshop` :: `L118 Proposal content`
  Target: `Skills` / `Skill Workshop proposals` / `Proposal-only frontmatter and payload schema`
  Closest existing: `Docker / Podman hosting` / `Containerized Agents, Sandbox, and Tooling Support` / `Container image dependency baking`
  Why: `Skill Workshop` section `Proposal content` documents governed skill proposal lifecycle behavior that is not modeled as its own maturity-scorecard surface today; existing plugin, CLI, and Gateway categories only cover adjacent mechanics.
- `05-05-capabilities-skills-p002-s006` | `tools/skill-workshop` | `Support files`
  Recommendation: `new_surface`
  Source: `tools/skill-workshop` :: `L136 Support files`
  Target: `Skills` / `Skill Workshop proposals` / `Proposal support-file packaging`
  Closest existing: `Session, memory, and context engine` / `Memory Files, Tools, and Active Memory` / `Memory Files, Tools, and Active Memory`
  Why: `Skill Workshop` section `Support files` documents governed skill proposal lifecycle behavior that is not modeled as its own maturity-scorecard surface today; existing plugin, CLI, and Gateway categories only cover adjacent mechanics.
- `05-05-capabilities-skills-p002-s007` | `tools/skill-workshop` | `Agent tool`
  Recommendation: `new_surface`
  Source: `tools/skill-workshop` :: `L162 Agent tool`
  Target: `Skills` / `Skill Workshop proposals` / `Skill Workshop tool contract`
  Closest existing: `Agent runtime and provider execution` / `Tool Execution Controls` / `Tool availability rules`
  Why: `Skill Workshop` section `Agent tool` documents governed skill proposal lifecycle behavior that is not modeled as its own maturity-scorecard surface today; existing plugin, CLI, and Gateway categories only cover adjacent mechanics.
- `05-05-capabilities-skills-p002-s008` | `tools/skill-workshop` | `Approval and autonomy`
  Recommendation: `new_surface`
  Source: `tools/skill-workshop` :: `L174 Approval and autonomy`
  Target: `Skills` / `Skill Workshop proposals` / `Approval policy and autonomous proposal creation`
  Closest existing: `Browser automation and exec/sandbox tools` / `Direct Tool Invoke API and Node System.run` / `Direct Tool Invoke API and Node System.run`
  Why: `Skill Workshop` section `Approval and autonomy` documents governed skill proposal lifecycle behavior that is not modeled as its own maturity-scorecard surface today; existing plugin, CLI, and Gateway categories only cover adjacent mechanics.
- `05-05-capabilities-skills-p002-s009` | `tools/skill-workshop` | `Gateway methods`
  Recommendation: `new_surface`
  Source: `tools/skill-workshop` :: `L202 Gateway methods`
  Target: `Skills` / `Skill Workshop proposals` / `Skill Workshop RPC surface`
  Closest existing: `Browser automation and exec/sandbox tools` / `Direct Tool Invoke API and Node System.run` / `Direct Tool Invoke API and Node System.run`
  Why: `Skill Workshop` section `Gateway methods` documents governed skill proposal lifecycle behavior that is not modeled as its own maturity-scorecard surface today; existing plugin, CLI, and Gateway categories only cover adjacent mechanics.
- `05-05-capabilities-skills-p002-s010` | `tools/skill-workshop` | `Storage`
  Recommendation: `new_surface`
  Source: `tools/skill-workshop` :: `L218 Storage`
  Target: `Skills` / `Skill Workshop proposals` / `Proposal storage and rollback metadata`
  Closest existing: `Docker / Podman hosting` / `Containerized Agents, Sandbox, and Tooling Support` / `Container image dependency baking`
  Why: `Skill Workshop` section `Storage` documents governed skill proposal lifecycle behavior that is not modeled as its own maturity-scorecard surface today; existing plugin, CLI, and Gateway categories only cover adjacent mechanics.
- `05-05-capabilities-skills-p002-s011` | `tools/skill-workshop` | `Limits`
  Recommendation: `new_surface`
  Source: `tools/skill-workshop` :: `L241 Limits`
  Target: `Skills` / `Skill Workshop proposals` / `Workshop size and quota limits`
  Closest existing: `Docker / Podman hosting` / `Containerized Agents, Sandbox, and Tooling Support` / `Container image dependency baking`
  Why: `Skill Workshop` section `Limits` documents governed skill proposal lifecycle behavior that is not modeled as its own maturity-scorecard surface today; existing plugin, CLI, and Gateway categories only cover adjacent mechanics.
- `05-05-capabilities-skills-p002-s012` | `tools/skill-workshop` | `Troubleshooting`
  Recommendation: `new_surface`
  Source: `tools/skill-workshop` :: `L250 Troubleshooting`
  Target: `Skills` / `Skill Workshop proposals` / `Workshop failure modes and operator recovery`
  Closest existing: `Docker / Podman hosting` / `Containerized Agents, Sandbox, and Tooling Support` / `Container image dependency baking`
  Why: `Skill Workshop` section `Troubleshooting` documents governed skill proposal lifecycle behavior that is not modeled as its own maturity-scorecard surface today; existing plugin, CLI, and Gateway categories only cover adjacent mechanics.
- `05-05-capabilities-skills-p002-s013` | `tools/skill-workshop` | `Related`
  Recommendation: `new_surface`
  Source: `tools/skill-workshop` :: `L261 Related`
  Target: `Skills` / `Skill Workshop proposals` / `Skill Workshop governance`
  Closest existing: `Docker / Podman hosting` / `Containerized Agents, Sandbox, and Tooling Support` / `Container image dependency baking`
  Why: `Skill Workshop` section `Related` documents governed skill proposal lifecycle behavior that is not modeled as its own maturity-scorecard surface today; existing plugin, CLI, and Gateway categories only cover adjacent mechanics.
- `05-05-capabilities-skills-p003-root` | `tools/creating-skills` | `(page)`
  Recommendation: `new_surface`
  Source: `tools/creating-skills` :: `(page)`
  Target: `Skills` / `Workspace skill authoring` / `Workspace skill authoring`
  Closest existing: `Docker / Podman hosting` / `Containerized Agents, Sandbox, and Tooling Support` / `Container image dependency baking`
  Why: `Creating skills` section `(page)` describes first-class skill authoring behavior rather than plugin SDK, CLI setup, or generic Gateway RPC coverage, so it needs a dedicated `Skills` surface in taxonomy.
- `05-05-capabilities-skills-p003-s001` | `tools/creating-skills` | `Create your first skill`
  Recommendation: `new_surface`
  Source: `tools/creating-skills` :: `L15 Create your first skill`
  Target: `Skills` / `Workspace skill authoring` / `Create, load, and test workspace skills`
  Closest existing: `Docker / Podman hosting` / `Containerized Agents, Sandbox, and Tooling Support` / `Container image dependency baking`
  Why: `Creating skills` section `Create your first skill` describes first-class skill authoring behavior rather than plugin SDK, CLI setup, or generic Gateway RPC coverage, so it needs a dedicated `Skills` surface in taxonomy.
- `05-05-capabilities-skills-p003-s002` | `tools/creating-skills` | `SKILL.md reference`
  Recommendation: `new_surface`
  Source: `tools/creating-skills` :: `L95 SKILL.md reference`
  Target: `Skills` / `Skill authoring and metadata` / `SKILL.md schema reference`
  Closest existing: `Docker / Podman hosting` / `Containerized Agents, Sandbox, and Tooling Support` / `Container image dependency baking`
  Why: `Creating skills` section `SKILL.md reference` describes first-class skill authoring behavior rather than plugin SDK, CLI setup, or generic Gateway RPC coverage, so it needs a dedicated `Skills` surface in taxonomy.
- `05-05-capabilities-skills-p003-s003` | `tools/creating-skills` | `Required fields`
  Recommendation: `new_surface`
  Source: `tools/creating-skills` :: `L97 Required fields`
  Target: `Skills` / `Skill authoring and metadata` / `Required skill frontmatter`
  Closest existing: `Docker / Podman hosting` / `Containerized Agents, Sandbox, and Tooling Support` / `Container image dependency baking`
  Why: `Creating skills` section `Required fields` describes first-class skill authoring behavior rather than plugin SDK, CLI setup, or generic Gateway RPC coverage, so it needs a dedicated `Skills` surface in taxonomy.
- `05-05-capabilities-skills-p003-s004` | `tools/creating-skills` | `Optional frontmatter keys`
  Recommendation: `new_surface`
  Source: `tools/creating-skills` :: `L104 Optional frontmatter keys`
  Target: `Skills` / `Skill authoring and metadata` / `Optional skill frontmatter keys`
  Closest existing: `Docker / Podman hosting` / `Containerized Agents, Sandbox, and Tooling Support` / `Container image dependency baking`
  Why: `Creating skills` section `Optional frontmatter keys` describes first-class skill authoring behavior rather than plugin SDK, CLI setup, or generic Gateway RPC coverage, so it needs a dedicated `Skills` surface in taxonomy.
- `05-05-capabilities-skills-p003-s005` | `tools/creating-skills` | `Using `{baseDir}``
Recommendation: `new_surface`
Source: `tools/creating-skills` :: `L118 Using `{baseDir}``
  Target: `Skills` / `Skill authoring and metadata` / `Skill-local file references`
  Closest existing: `Docker / Podman hosting` / `Containerized Agents, Sandbox, and Tooling Support` / `Container image dependency baking`
  Why: `Creating skills` section `Using `{baseDir}``describes first-class skill authoring behavior rather than plugin SDK, CLI setup, or generic Gateway RPC coverage, so it needs a dedicated`Skills` surface in taxonomy.
- `05-05-capabilities-skills-p003-s006` | `tools/creating-skills` | `Adding conditional activation`
  Recommendation: `new_surface`
  Source: `tools/creating-skills` :: `L127 Adding conditional activation`
  Target: `Skills` / `Skill gating and runtime requirements` / `Conditional skill activation`
  Closest existing: `Docker / Podman hosting` / `Containerized Agents, Sandbox, and Tooling Support` / `Container image dependency baking`
  Why: `Creating skills` section `Adding conditional activation` describes first-class skill authoring behavior rather than plugin SDK, CLI setup, or generic Gateway RPC coverage, so it needs a dedicated `Skills` surface in taxonomy.
- `05-05-capabilities-skills-p003-s007` | `tools/creating-skills` | `Propose via Skill Workshop`
  Recommendation: `new_surface`
  Source: `tools/creating-skills` :: `L176 Propose via Skill Workshop`
  Target: `Skills` / `Skill Workshop proposals` / `Workshop-based skill authoring`
  Closest existing: `Docker / Podman hosting` / `Containerized Agents, Sandbox, and Tooling Support` / `Container image dependency baking`
  Why: `Creating skills` section `Propose via Skill Workshop` describes first-class skill authoring behavior rather than plugin SDK, CLI setup, or generic Gateway RPC coverage, so it needs a dedicated `Skills` surface in taxonomy.
- `05-05-capabilities-skills-p003-s008` | `tools/creating-skills` | `Publishing to ClawHub`
  Recommendation: `new_surface`
  Source: `tools/creating-skills` :: `L216 Publishing to ClawHub`
  Target: `Skills` / `Skill distribution and publishing` / `ClawHub skill publishing`
  Closest existing: `Plugin SDK and bundled plugin architecture` / `Publishing plugins` / `ClawHub publishing`
  Why: `Creating skills` section `Publishing to ClawHub` describes first-class skill authoring behavior rather than plugin SDK, CLI setup, or generic Gateway RPC coverage, so it needs a dedicated `Skills` surface in taxonomy.
- `05-05-capabilities-skills-p003-s009` | `tools/creating-skills` | `Best practices`
  Recommendation: `new_surface`
  Source: `tools/creating-skills` :: `L242 Best practices`
  Target: `Skills` / `Skill authoring and metadata` / `Skill authoring safety and ergonomics`
  Closest existing: `CLI` / `Doctor` / `Runtime path checks`
  Why: `Creating skills` section `Best practices` describes first-class skill authoring behavior rather than plugin SDK, CLI setup, or generic Gateway RPC coverage, so it needs a dedicated `Skills` surface in taxonomy.
- `05-05-capabilities-skills-p003-s010` | `tools/creating-skills` | `Related`
  Recommendation: `new_surface`
  Source: `tools/creating-skills` :: `L253 Related`
  Target: `Skills` / `Workspace skill authoring` / `Workspace skill authoring`
  Closest existing: `Docker / Podman hosting` / `Containerized Agents, Sandbox, and Tooling Support` / `Container image dependency baking`
  Why: `Creating skills` section `Related` describes first-class skill authoring behavior rather than plugin SDK, CLI setup, or generic Gateway RPC coverage, so it needs a dedicated `Skills` surface in taxonomy.
- `05-05-capabilities-skills-p004-root` | `tools/skills-config` | `(page)`
  Recommendation: `new_surface`
  Source: `tools/skills-config` :: `(page)`
  Target: `Skills` / `Skills configuration` / `Skills configuration surface`
  Closest existing: `Browser automation and exec/sandbox tools` / `Sandboxed Browser and Codex Dynamic Tools` / `Sandboxed Browser and Codex Dynamic Tools`
  Why: `Skills config` section `(page)` is product-facing configuration surface area for skills (`skills.load`, `skills.install`, `skills.entries`, workshop, and allowlists) that is not represented by an existing maturity-scorecard surface.
- `05-05-capabilities-skills-p004-s001` | `tools/skills-config` | `Loading (`skills.load`)`
  Recommendation: `new_surface`
  Source: `tools/skills-config` :: `L55 Loading (`skills.load`)`
  Target: `Skills` / `Skills configuration` / `Skill root loading settings`
  Closest existing: `Security, auth, pairing, and secrets` / `Plugin Installation Trust and Security Boundaries` / `Plugin Installation Trust and Security Boundaries`
  Why: `Skills config` section `Loading (`skills.load`)` is product-facing configuration surface area for skills (`skills.load`, `skills.install`, `skills.entries`, workshop, and allowlists) that is not represented by an existing maturity-scorecard surface.
- `05-05-capabilities-skills-p004-s002` | `tools/skills-config` | `Install (`skills.install`)`
  Recommendation: `new_surface`
  Source: `tools/skills-config` :: `L79 Install (`skills.install`)`
  Target: `Skills` / `Skills configuration` / `Skill install settings`
  Closest existing: `Security, auth, pairing, and secrets` / `Plugin Installation Trust and Security Boundaries` / `Plugin Installation Trust and Security Boundaries`
  Why: `Skills config` section `Install (`skills.install`)` is product-facing configuration surface area for skills (`skills.load`, `skills.install`, `skills.entries`, workshop, and allowlists) that is not represented by an existing maturity-scorecard surface.
- `05-05-capabilities-skills-p004-s003` | `tools/skills-config` | `Bundled skill allowlist`
  Recommendation: `new_surface`
  Source: `tools/skills-config` :: `L98 Bundled skill allowlist`
  Target: `Skills` / `Skills configuration` / `Bundled skill allowlists`
  Closest existing: `Browser automation and exec/sandbox tools` / `Sandboxed Browser and Codex Dynamic Tools` / `Sandboxed Browser and Codex Dynamic Tools`
  Why: `Skills config` section `Bundled skill allowlist` is product-facing configuration surface area for skills (`skills.load`, `skills.install`, `skills.entries`, workshop, and allowlists) that is not represented by an existing maturity-scorecard surface.
- `05-05-capabilities-skills-p004-s004` | `tools/skills-config` | `Per-skill entries (`skills.entries`)`
  Recommendation: `new_surface`
  Source: `tools/skills-config` :: `L106 Per-skill entries (`skills.entries`)`
  Target: `Skills` / `Skills configuration` / `Per-skill runtime entries`
  Closest existing: `Media understanding and media generation` / `Media Understanding Orchestration and Configuration` / `In scope`
  Why: `Skills config` section `Per-skill entries (`skills.entries`)` is product-facing configuration surface area for skills (`skills.load`, `skills.install`, `skills.entries`, workshop, and allowlists) that is not represented by an existing maturity-scorecard surface.
- `05-05-capabilities-skills-p004-s005` | `tools/skills-config` | `Agent allowlists (`agents`)`
  Recommendation: `new_surface`
  Source: `tools/skills-config` :: `L132 Agent allowlists (`agents`)`
  Target: `Skills` / `Skills configuration` / `Agent skill visibility rules`
  Closest existing: `Gateway Web App` / `Operator Panels and Admin Workflows` / `Operator Panels and Admin Workflows`
  Why: `Skills config` section `Agent allowlists (`agents`)` is product-facing configuration surface area for skills (`skills.load`, `skills.install`, `skills.entries`, workshop, and allowlists) that is not represented by an existing maturity-scorecard surface.
- `05-05-capabilities-skills-p004-s006` | `tools/skills-config` | `Workshop (`skills.workshop`)`
  Recommendation: `new_surface`
  Source: `tools/skills-config` :: `L162 Workshop (`skills.workshop`)`
  Target: `Skills` / `Skills configuration` / `Workshop configuration`
  Closest existing: `Browser automation and exec/sandbox tools` / `Sandboxed Browser and Codex Dynamic Tools` / `Sandboxed Browser and Codex Dynamic Tools`
  Why: `Skills config` section `Workshop (`skills.workshop`)` is product-facing configuration surface area for skills (`skills.load`, `skills.install`, `skills.entries`, workshop, and allowlists) that is not represented by an existing maturity-scorecard surface.
- `05-05-capabilities-skills-p004-s007` | `tools/skills-config` | `Symlinked skill roots`
  Recommendation: `new_surface`
  Source: `tools/skills-config` :: `L184 Symlinked skill roots`
  Target: `Skills` / `Skills configuration` / `Symlink containment policy`
  Closest existing: `Browser automation and exec/sandbox tools` / `Sandbox Backends and Workspace Isolation` / `Sandbox Backends and Workspace Isolation`
  Why: `Skills config` section `Symlinked skill roots` is product-facing configuration surface area for skills (`skills.load`, `skills.install`, `skills.entries`, workshop, and allowlists) that is not represented by an existing maturity-scorecard surface.
- `05-05-capabilities-skills-p004-s008` | `tools/skills-config` | `Sandboxed skills and env vars`
  Recommendation: `new_surface`
  Source: `tools/skills-config` :: `L211 Sandboxed skills and env vars`
  Target: `Skills` / `Skills configuration` / `Host-only env injection versus sandbox`
  Closest existing: `Browser automation and exec/sandbox tools` / `Sandboxed Browser and Codex Dynamic Tools` / `Sandboxed Browser and Codex Dynamic Tools`
  Why: `Skills config` section `Sandboxed skills and env vars` is product-facing configuration surface area for skills (`skills.load`, `skills.install`, `skills.entries`, workshop, and allowlists) that is not represented by an existing maturity-scorecard surface.
- `05-05-capabilities-skills-p004-s009` | `tools/skills-config` | `Loading order reminder`
  Recommendation: `new_surface`
  Source: `tools/skills-config` :: `L242 Loading order reminder`
  Target: `Skills` / `Skills configuration` / `Skill precedence recap`
  Closest existing: `Security, auth, pairing, and secrets` / `Plugin Installation Trust and Security Boundaries` / `Plugin Installation Trust and Security Boundaries`
  Why: `Skills config` section `Loading order reminder` is product-facing configuration surface area for skills (`skills.load`, `skills.install`, `skills.entries`, workshop, and allowlists) that is not represented by an existing maturity-scorecard surface.
- `05-05-capabilities-skills-p004-s010` | `tools/skills-config` | `Related`
  Recommendation: `new_surface`
  Source: `tools/skills-config` :: `L256 Related`
  Target: `Skills` / `Skills configuration` / `Skills configuration surface`
  Closest existing: `Browser automation and exec/sandbox tools` / `Sandboxed Browser and Codex Dynamic Tools` / `Sandboxed Browser and Codex Dynamic Tools`
  Why: `Skills config` section `Related` is product-facing configuration surface area for skills (`skills.load`, `skills.install`, `skills.entries`, workshop, and allowlists) that is not represented by an existing maturity-scorecard surface.
- `05-05-capabilities-skills-p006-root` | `prose` | `(page)`
  Recommendation: `new_surface`
  Source: `prose` :: `(page)`
  Target: `OpenProse` / `OpenProse workflow runtime` / `Plugin-backed OpenProse workflows`
  Closest existing: `OpenRouter provider path` / `Model Catalog, Dynamic Capabilities, and Model Refs` / `Model Catalog, Dynamic Capabilities, and Model Refs`
  Why: `OpenProse` section `(page)` documents a plugin-backed workflow product (`/prose`, `.prose` programs, runtime mapping, and state backends) that is broader than existing generic plugin-install or subagent coverage and warrants its own surface.
- `05-05-capabilities-skills-p006-s001` | `prose` | `Install`
  Recommendation: `new_surface`
  Source: `prose` :: `L28 Install`
  Target: `OpenProse` / `OpenProse installation and entrypoints` / `OpenProse plugin enablement`
  Closest existing: `Security, auth, pairing, and secrets` / `Plugin Installation Trust and Security Boundaries` / `Plugin Installation Trust and Security Boundaries`
  Why: `OpenProse` section `Install` documents a plugin-backed workflow product (`/prose`, `.prose` programs, runtime mapping, and state backends) that is broader than existing generic plugin-install or subagent coverage and warrants its own surface.
- `05-05-capabilities-skills-p006-s002` | `prose` | `Slash command`
  Recommendation: `new_surface`
  Source: `prose` :: `L57 Slash command`
  Target: `OpenProse` / `OpenProse installation and entrypoints` / ``/prose` command entrypoint`Closest existing:`Slack`/`Slash Commands and Native Command Routing`/`Slash Commands and Native Command Routing`Why:`OpenProse`section`Slash command` documents a plugin-backed workflow product (`/prose`, `.prose` programs, runtime mapping, and state backends) that is broader than existing generic plugin-install or subagent coverage and warrants its own surface.
- `05-05-capabilities-skills-p006-s003` | `prose` | `What it can do`
  Recommendation: `new_surface`
  Source: `prose` :: `L74 What it can do`
  Target: `OpenProse` / `Program model and orchestration` / `Multi-agent `.prose` workflows`
  Closest existing: `CLI` / `Plugin and Channel Setup` / `Post-setup probes`
  Why: `OpenProse` section `What it can do` documents a plugin-backed workflow product (`/prose`, `.prose` programs, runtime mapping, and state backends) that is broader than existing generic plugin-install or subagent coverage and warrants its own surface.
- `05-05-capabilities-skills-p006-s004` | `prose` | `Example: parallel research and synthesis`
  Recommendation: `new_surface`
  Source: `prose` :: `L80 Example: parallel research and synthesis`
  Target: `OpenProse` / `Program model and orchestration` / `Parallel research and synthesis programs`
  Closest existing: `OpenRouter provider path` / `Model Catalog, Dynamic Capabilities, and Model Refs` / `Model Catalog, Dynamic Capabilities, and Model Refs`
  Why: `OpenProse` section `Example: parallel research and synthesis` documents a plugin-backed workflow product (`/prose`, `.prose` programs, runtime mapping, and state backends) that is broader than existing generic plugin-install or subagent coverage and warrants its own surface.
- `05-05-capabilities-skills-p006-s005` | `prose` | `OpenClaw runtime mapping`
  Recommendation: `new_surface`
  Source: `prose` :: `L105 OpenClaw runtime mapping`
  Target: `OpenProse` / `OpenClaw runtime integration` / `Tool and session mapping for `.prose` runs`
  Closest existing: `Anthropic provider path` / `Claude CLI Runtime and Session Bridge` / `Claude CLI Runtime and Session Bridge`
  Why: `OpenProse` section `OpenClaw runtime mapping` documents a plugin-backed workflow product (`/prose`, `.prose` programs, runtime mapping, and state backends) that is broader than existing generic plugin-install or subagent coverage and warrants its own surface.
- `05-05-capabilities-skills-p006-s006` | `prose` | `File locations`
  Recommendation: `new_surface`
  Source: `prose` :: `L121 File locations`
  Target: `OpenProse` / `State and storage` / `Workspace and user-level `.prose` state layout`
  Closest existing: `Google Chat` / `Message Actions Reactions and Approval Auth` / `Message Actions Reactions and Approval Auth`
  Why: `OpenProse` section `File locations` documents a plugin-backed workflow product (`/prose`, `.prose` programs, runtime mapping, and state backends) that is broader than existing generic plugin-install or subagent coverage and warrants its own surface.
- `05-05-capabilities-skills-p006-s007` | `prose` | `State backends`
  Recommendation: `new_surface`
  Source: `prose` :: `L143 State backends`
  Target: `OpenProse` / `State and storage` / `Filesystem, in-context, sqlite, and postgres backends`
  Closest existing: `Observability` / `Doctor Repair Diagnostics` / `Core doctor checks`
  Why: `OpenProse` section `State backends` documents a plugin-backed workflow product (`/prose`, `.prose` programs, runtime mapping, and state backends) that is broader than existing generic plugin-install or subagent coverage and warrants its own surface.
- `05-05-capabilities-skills-p006-s008` | `prose` | `Security`
  Recommendation: `new_surface`
  Source: `prose` :: `L168 Security`
  Target: `OpenProse` / `Execution safety` / `Review and allowlist controls for `.prose` programs`
  Closest existing: `Security, auth, pairing, and secrets` / `Plugin Installation Trust and Security Boundaries` / `Plugin Installation Trust and Security Boundaries`
  Why: `OpenProse` section `Security` documents a plugin-backed workflow product (`/prose`, `.prose` programs, runtime mapping, and state backends) that is broader than existing generic plugin-install or subagent coverage and warrants its own surface.
- `05-05-capabilities-skills-p006-s009` | `prose` | `Related`
  Recommendation: `new_surface`
  Source: `prose` :: `L174 Related`
  Target: `OpenProse` / `OpenProse workflow runtime` / `Plugin-backed OpenProse workflows`
  Closest existing: `OpenRouter provider path` / `Model Catalog, Dynamic Capabilities, and Model Refs` / `Model Catalog, Dynamic Capabilities, and Model Refs`
  Why: `OpenProse` section `Related` documents a plugin-backed workflow product (`/prose`, `.prose` programs, runtime mapping, and state backends) that is broader than existing generic plugin-install or subagent coverage and warrants its own surface.
- `10-01-reference-cli-commands-p048-root` | `cli/skills` | `(page)`
  Recommendation: `new_surface`
  Source: `cli/skills` :: `(page)`
  Target: `Skills system` / `Skill Lifecycle and Workshop` / `Skill Lifecycle and Workshop`
  Closest existing: `CLI` / `CLI Setup` / `CLI entrypoint`
  Why: Current taxonomy lacks a dedicated surface for Skills system.
- `10-01-reference-cli-commands-p057-root` | `cli/mcp` | `(page)`
  Recommendation: `new_surface`
  Source: `cli/mcp` :: `(page)`
  Target: `MCP bridge and server registry` / `MCP Server Bridge and Registry` / `MCP Server Bridge and Registry`
  Closest existing: `CLI` / `CLI Setup` / `CLI entrypoint`
  Why: Current taxonomy lacks a dedicated surface for MCP bridge and server registry.
- `10-02-reference-rpc-and-api-p002-root` | `concepts/openclaw-sdk` | `(page)`
  Recommendation: `new_surface`
  Source: `concepts/openclaw-sdk` :: `(page)`
  Target: `OpenClaw App SDK` / `Client surfaces and namespaces` / `OpenClaw App SDK overview`
  Closest existing: `Native Windows companion app` / `Native Chat Client and Session Controls` / `Gateway chat RPC use`
  Why: The taxonomy has Gateway runtime and Plugin SDK coverage, but it does not model the external `@openclaw/sdk` client package as its own scorecard surface.
- `10-02-reference-rpc-and-api-p002-s001` | `concepts/openclaw-sdk` | `What ships today`
  Recommendation: `new_surface`
  Source: `concepts/openclaw-sdk` :: `L24 What ships today`
  Target: `OpenClaw App SDK` / `Client surfaces and namespaces` / `What ships today`
  Closest existing: `Native Windows companion app` / `Native Chat Client and Session Controls` / `Gateway chat RPC use`
  Why: This section inventories the shipped `@openclaw/sdk` client entry points and helper objects, which are SDK-surface guarantees rather than server-side Gateway runtime features.
- `10-02-reference-rpc-and-api-p002-s002` | `concepts/openclaw-sdk` | `Connect to a Gateway`
  Recommendation: `new_surface`
  Source: `concepts/openclaw-sdk` :: `L60 Connect to a Gateway`
  Target: `OpenClaw App SDK` / `Gateway connection and transport` / `Connect to a Gateway`
  Closest existing: `Android app` / `Chat Sessions and Mobile UI` / `Chat tab`
  Why: Connection construction, explicit URL/token handling, custom transport injection, and `gateway: "auto"` semantics belong to a missing external client SDK surface.
- `10-02-reference-rpc-and-api-p002-s003` | `concepts/openclaw-sdk` | `Run an agent`
  Recommendation: `new_surface`
  Source: `concepts/openclaw-sdk` :: `L95 Run an agent`
  Target: `OpenClaw App SDK` / `Runs and agent execution` / `Run an agent`
  Closest existing: `Automation: cron, hooks, tasks, polling` / `Cron Job Lifecycle` / `Cron Job Lifecycle`
  Why: Agent handles, `Agent.run()`, streamed run events, and SDK-side timeout/result normalization are external client-contract capabilities not represented in current taxonomy.
- `10-02-reference-rpc-and-api-p002-s004` | `concepts/openclaw-sdk` | `Create and reuse sessions`
  Recommendation: `new_surface`
  Source: `concepts/openclaw-sdk` :: `L130 Create and reuse sessions`
  Target: `OpenClaw App SDK` / `Sessions and transcript state` / `Create and reuse sessions`
  Closest existing: `Native Windows companion app` / `Native Chat Client and Session Controls` / `Gateway chat RPC use`
  Why: Session handles, `sessions.create`, `Session.send`, patching, abort, and compact operations are documented as SDK ergonomics rather than raw Gateway runtime behavior.
- `10-02-reference-rpc-and-api-p002-s005` | `concepts/openclaw-sdk` | `Stream events`
  Recommendation: `new_surface`
  Source: `concepts/openclaw-sdk` :: `L153 Stream events`
  Target: `OpenClaw App SDK` / `Event stream and replay` / `Stream events`
  Closest existing: `Slack` / `Interactive Replies, App Home, and Assistant Events` / `Interactive Replies, App Home, and Assistant Events`
  Why: The stable `OpenClawEvent` envelope, replay behavior, and app-wide versus per-run event streams are App SDK contract details missing from taxonomy.
- `10-02-reference-rpc-and-api-p002-s006` | `concepts/openclaw-sdk` | `Models, tools, artifacts, and approvals`
  Recommendation: `new_surface`
  Source: `concepts/openclaw-sdk` :: `L214 Models, tools, artifacts, and approvals`
  Target: `OpenClaw App SDK` / `Gateway resource helpers` / `Models, tools, artifacts, approvals, tasks, and environments`
  Closest existing: `Linux companion app` / `Node-host Capabilities, Desktop Tools, and Exec Approvals` / `system.run`
  Why: This section defines the typed helper surfaces that wrap existing Gateway APIs for external apps; taxonomy currently covers the backend resources but not the client package that exposes them.
- `10-02-reference-rpc-and-api-p002-s007` | `concepts/openclaw-sdk` | `Explicitly unsupported today`
  Recommendation: `new_surface`
  Source: `concepts/openclaw-sdk` :: `L275 Explicitly unsupported today`
  Target: `OpenClaw App SDK` / `Compatibility and unsupported calls` / `Explicit unsupported SDK calls`
  Closest existing: `Native Windows companion app` / `Native Chat Client and Session Controls` / `Gateway chat RPC use`
  Why: Explicitly throwing on unsupported environment mutations and future per-run overrides is an SDK compatibility guarantee, not a current Gateway runtime category.
- `10-02-reference-rpc-and-api-p002-s008` | `concepts/openclaw-sdk` | `App SDK vs Plugin SDK`
  Recommendation: `new_surface`
  Source: `concepts/openclaw-sdk` :: `L292 App SDK vs Plugin SDK`
  Target: `OpenClaw App SDK` / `Surface positioning and package boundaries` / `App SDK vs Plugin SDK`
  Closest existing: `Plugin SDK and bundled plugin architecture` / `Authoring plugins` / `Entrypoint discovery`
  Why: The distinction between external app integrations and in-process plugin authoring is a missing top-level surface boundary in taxonomy.
- `10-02-reference-rpc-and-api-p002-s009` | `concepts/openclaw-sdk` | `Related`
  Recommendation: `new_surface`
  Source: `concepts/openclaw-sdk` :: `L314 Related`
  Target: `OpenClaw App SDK` / `Surface positioning and package boundaries` / `Related references`
  Closest existing: `Native Windows companion app` / `Native Chat Client and Session Controls` / `Gateway chat RPC use`
  Why: The related links are navigation for the missing App SDK surface; they do not reduce the need for a dedicated SDK row.
- `10-02-reference-rpc-and-api-p003-root` | `reference/openclaw-sdk-api-design` | `(page)`
  Recommendation: `new_surface`
  Source: `reference/openclaw-sdk-api-design` :: `(page)`
  Target: `OpenClaw App SDK` / `Client surfaces and namespaces` / `App SDK API design overview`
  Closest existing: `Native Windows companion app` / `Native Chat Client and Session Controls` / `Gateway chat RPC use`
  Why: This page is a detailed reference design for the same missing external App SDK surface.
- `10-02-reference-rpc-and-api-p003-s001` | `reference/openclaw-sdk-api-design` | `Namespace design`
  Recommendation: `new_surface`
  Source: `reference/openclaw-sdk-api-design` :: `L27 Namespace design`
  Target: `OpenClaw App SDK` / `Client surfaces and namespaces` / `Namespace design`
  Closest existing: `Native Windows companion app` / `Native Chat Client and Session Controls` / `Gateway chat RPC use`
  Why: Low-level and high-level SDK namespace layout (`oc.agents`, `oc.sessions`, `Run`, `Session`) is client-package contract surface, not existing Gateway taxonomy.
- `10-02-reference-rpc-and-api-p003-s002` | `reference/openclaw-sdk-api-design` | `Event contract`
  Recommendation: `new_surface`
  Source: `reference/openclaw-sdk-api-design` :: `L91 Event contract`
  Target: `OpenClaw App SDK` / `Event stream and replay` / `Event contract`
  Closest existing: `Native Windows companion app` / `Native Chat Client and Session Controls` / `Gateway chat RPC use`
  Why: Normalized, replayable event families with stable cursors are App SDK contract details missing from taxonomy.
- `10-02-reference-rpc-and-api-p003-s003` | `reference/openclaw-sdk-api-design` | `Result contract`
  Recommendation: `new_surface`
  Source: `reference/openclaw-sdk-api-design` :: `L149 Result contract`
  Target: `OpenClaw App SDK` / `Runs and agent execution` / `Run result contract`
  Closest existing: `Native Windows companion app` / `Native Chat Client and Session Controls` / `Gateway chat RPC use`
  Why: The stable `RunResult` envelope and wait semantics are SDK-level response guarantees rather than existing Gateway runtime feature entries.
- `10-02-reference-rpc-and-api-p003-s004` | `reference/openclaw-sdk-api-design` | `Approvals and questions`
  Recommendation: `new_surface`
  Source: `reference/openclaw-sdk-api-design` :: `L187 Approvals and questions`
  Target: `OpenClaw App SDK` / `Approval and question handling` / `Approvals and questions`
  Closest existing: `Linux companion app` / `Node-host Capabilities, Desktop Tools, and Exec Approvals` / `system.run`
  Why: First-class approval callbacks and question handling are described here as external-app APIs, which taxonomy does not currently model as a surface.
- `10-02-reference-rpc-and-api-p003-s005` | `reference/openclaw-sdk-api-design` | `ToolSpace model`
  Recommendation: `new_surface`
  Source: `reference/openclaw-sdk-api-design` :: `L217 ToolSpace model`
  Target: `OpenClaw App SDK` / `Gateway resource helpers` / `ToolSpace model`
  Closest existing: `Android app` / `Chat Sessions and Mobile UI` / `Chat tab`
  Why: The ToolSpace discovery model is an SDK abstraction for external apps and is not represented as an existing scorecard category.
- `10-02-reference-rpc-and-api-p003-s006` | `reference/openclaw-sdk-api-design` | `Artifact model`
  Recommendation: `new_surface`
  Source: `reference/openclaw-sdk-api-design` :: `L241 Artifact model`
  Target: `OpenClaw App SDK` / `Gateway resource helpers` / `Artifact model`
  Closest existing: `Android app` / `Chat Sessions and Mobile UI` / `Chat tab`
  Why: Artifact summaries, retention, and download behavior are documented as App SDK abstractions, not as their own existing external client surface.
- `10-02-reference-rpc-and-api-p003-s007` | `reference/openclaw-sdk-api-design` | `Security model`
  Recommendation: `new_surface`
  Source: `reference/openclaw-sdk-api-design` :: `L282 Security model`
  Target: `OpenClaw App SDK` / `Security and auth scopes` / `Security model`
  Closest existing: `Android app` / `Chat Sessions and Mobile UI` / `Chat tab`
  Why: Token scopes, secret-forwarding defaults, and redaction behavior are external client contract boundaries that need their own SDK surface coverage.
- `10-02-reference-rpc-and-api-p003-s008` | `reference/openclaw-sdk-api-design` | `Managed environment provider`
  Recommendation: `new_surface`
  Source: `reference/openclaw-sdk-api-design` :: `L313 Managed environment provider`
  Target: `OpenClaw App SDK` / `Managed environments` / `Managed environment provider`
  Closest existing: `Web search tools` / `Provider Registry, SDK Contracts, and Runtime Resolution` / `Provider Registry, SDK Contracts, and Runtime Resolution`
  Why: Environment-provider capabilities and lifecycle are proposed SDK-facing contracts; no current taxonomy surface captures them as part of an external app client.
- `10-02-reference-rpc-and-api-p003-s009` | `reference/openclaw-sdk-api-design` | `Package structure`
  Recommendation: `new_surface`
  Source: `reference/openclaw-sdk-api-design` :: `L347 Package structure`
  Target: `OpenClaw App SDK` / `Surface positioning and package boundaries` / `Package structure`
  Closest existing: `Native Windows companion app` / `Native Chat Client and Session Controls` / `Gateway chat RPC use`
  Why: Separate `@openclaw/sdk`, `@openclaw/sdk-react`, and testing packages are package-boundary commitments for a missing SDK surface.
- `10-02-reference-rpc-and-api-p003-s010` | `reference/openclaw-sdk-api-design` | `Generated client strategy`
  Recommendation: `new_surface`
  Source: `reference/openclaw-sdk-api-design` :: `L360 Generated client strategy`
  Target: `OpenClaw App SDK` / `Generated client and schema alignment` / `Generated client strategy`
  Closest existing: `Native Windows companion app` / `Native Chat Client and Session Controls` / `Gateway chat RPC use`
  Why: Generation from Gateway schemas plus handwritten ergonomic wrappers is a missing App SDK design capability rather than an existing server-side category.
- `10-02-reference-rpc-and-api-p003-s011` | `reference/openclaw-sdk-api-design` | `Related`
  Recommendation: `new_surface`
  Source: `reference/openclaw-sdk-api-design` :: `L382 Related`
  Target: `OpenClaw App SDK` / `Surface positioning and package boundaries` / `Related references`
  Closest existing: `Native Windows companion app` / `Native Chat Client and Session Controls` / `Gateway chat RPC use`
  Why: These related links support the same missing App SDK surface rather than mapping cleanly onto an existing row.
- `10-11-reference-release-and-ci-p001-root` | `reference/RELEASING` | `(page)`
  Recommendation: `new_surface`
  Source: `reference/RELEASING` :: `(page)`
  Target: `Release engineering and CI validation` / `Release policy, versioning, and cadence` / `OpenClaw release policy overview`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Play`
  Why: The page defines OpenClaw's public release lanes, versioning rules, cadence, preflight, validation, publish sequence, and operator-visible evidence model. No current surface owns OpenClaw's core release process as a first-class operating area.
- `10-11-reference-release-and-ci-p001-s001` | `reference/RELEASING` | `Version naming`
  Recommendation: `new_surface`
  Source: `reference/RELEASING` :: `L16 Version naming`
  Target: `Release engineering and CI validation` / `Release policy, versioning, and cadence` / `Version naming and tag scheme`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Play`
  Why: Stable, correction, and beta version/tag rules are release-process semantics for the core product rather than Android/iOS app distribution details, and no existing taxonomy surface captures them.
- `10-11-reference-release-and-ci-p001-s002` | `reference/RELEASING` | `Release cadence`
  Recommendation: `new_surface`
  Source: `reference/RELEASING` :: `L32 Release cadence`
  Target: `Release engineering and CI validation` / `Release policy, versioning, and cadence` / `Beta-first cadence and release branching`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Play`
  Why: This section covers beta-first promotion, release-branch policy, and prerelease repair rules for OpenClaw itself. That operating model is missing from the current surface set.
- `10-11-reference-release-and-ci-p001-s003` | `reference/RELEASING` | `Release operator checklist`
  Recommendation: `new_surface`
  Source: `reference/RELEASING` :: `L44 Release operator checklist`
  Target: `Release engineering and CI validation` / `Release policy, versioning, and cadence` / `Release operator checklist`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Play`
  Why: The checklist is the canonical public shape of the end-to-end release flow, including changelog prep, compatibility review, version bumping, preflight, validation, and publish handoff. No existing surface owns that operator workflow.
- `10-11-reference-release-and-ci-p001-s004` | `reference/RELEASING` | `Release preflight`
  Recommendation: `new_surface`
  Source: `reference/RELEASING` :: `L128 Release preflight`
  Target: `Release engineering and CI validation` / `Preflight, validation boxes, and publish orchestration` / `Release preflight gates and evidence bundle`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Play`
  Why: The preflight section defines deterministic local gates, workflow entrypoints, evidence artifacts, and publish invariants for OpenClaw releases. That is broader than CLI updates or plugin publishing and needs its own surface.
- `10-11-reference-release-and-ci-p001-s005` | `reference/RELEASING` | `Release test boxes`
  Recommendation: `new_surface`
  Source: `reference/RELEASING` :: `L332 Release test boxes`
  Target: `Release engineering and CI validation` / `Preflight, validation boxes, and publish orchestration` / `Full Release Validation orchestration`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Play`
  Why: This section documents the umbrella workflow that fans out CI, release checks, package artifacts, Telegram proof, rerun groups, and verifier semantics. The current taxonomy has no surface for OpenClaw's release-validation control plane.
- `10-11-reference-release-and-ci-p001-s006` | `reference/RELEASING` | `Vitest`
  Recommendation: `new_surface`
  Source: `reference/RELEASING` :: `L468 Vitest`
  Target: `Release engineering and CI validation` / `Preflight, validation boxes, and publish orchestration` / `Manual CI and Vitest release proof`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Play`
  Why: The Vitest box here is specifically release-candidate CI proof and shard evidence collection, not the CLI/TUI/runtime capability itself. That release-validation role is not currently modeled.
- `10-11-reference-release-and-ci-p001-s008` | `reference/RELEASING` | `QA Lab`
  Recommendation: `new_surface`
  Source: `reference/RELEASING` :: `L529 QA Lab`
  Target: `Release engineering and CI validation` / `Preflight, validation boxes, and publish orchestration` / `QA Lab release gates`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Play`
  Why: QA parity, live Matrix, live Telegram, and observability smoke are described here as release-approval gates. No existing surface owns QA-lab release orchestration as a coherent capability area.
- `10-11-reference-release-and-ci-p001-s009` | `reference/RELEASING` | `Package`
  Recommendation: `new_surface`
  Source: `reference/RELEASING` :: `L551 Package`
  Target: `Release engineering and CI validation` / `Preflight, validation boxes, and publish orchestration` / `Package Acceptance release gate`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Play`
  Why: The package gate covers candidate source resolution, package-under-test normalization, update/plugin lanes, and release-check usage for the core OpenClaw package. That installable-product validation workflow is not owned by an existing surface.
- `10-11-reference-release-and-ci-p001-s010` | `reference/RELEASING` | `Release publish automation`
  Recommendation: `new_surface`
  Source: `reference/RELEASING` :: `L643 Release publish automation`
  Target: `Release engineering and CI validation` / `Preflight, validation boxes, and publish orchestration` / `Release publish automation`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Play`
  Why: This section defines the mutating publish orchestrator for plugin npm, plugin ClawHub, and OpenClaw npm publish ordering. Existing plugin-distribution coverage does not own the core release orchestrator.
- `10-11-reference-release-and-ci-p001-s011` | `reference/RELEASING` | `NPM workflow inputs`
  Recommendation: `new_surface`
  Source: `reference/RELEASING` :: `L695 NPM workflow inputs`
  Target: `Release engineering and CI validation` / `Preflight, validation boxes, and publish orchestration` / `Release workflow inputs and invariants`
  Closest existing: `ClawHub` / `Clawhub and Npm Publishing Release Validation` / `OpenClaw-owned package release validation for ClawHub`
  Why: Operator-controlled inputs and invariants for `OpenClaw NPM Release`, `OpenClaw Release Publish`, and `OpenClaw Release Checks` are a missing release-ops contract, not an existing product-surface feature.
- `10-11-reference-release-and-ci-p001-s012` | `reference/RELEASING` | `Stable npm release sequence`
  Recommendation: `new_surface`
  Source: `reference/RELEASING` :: `L744 Stable npm release sequence`
  Target: `Release engineering and CI validation` / `Preflight, validation boxes, and publish orchestration` / `Stable npm release sequence`
  Closest existing: `ClawHub` / `Clawhub and Npm Publishing Release Validation` / `OpenClaw-owned package release validation for ClawHub`
  Why: The stable release sequence codifies how preflight, validation, publish, and beta-to-latest promotion fit together for the core package. No current surface owns that operator sequence.
- `10-11-reference-release-and-ci-p003-root` | `reference/release-performance-sweep` | `(page)`
  Recommendation: `new_surface`
  Source: `reference/release-performance-sweep` :: `(page)`
  Target: `Release engineering and CI validation` / `Performance, footprint, and dependency evidence` / `Release performance sweep overview`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Play`
  Why: The page is a technical evidence pack for release-level performance, package-size, dependency, and shrinkwrap analysis across shipped versions. No existing surface owns this cross-cutting release-evidence workflow.
- `10-11-reference-release-and-ci-p003-s001` | `reference/release-performance-sweep` | `Snapshot`
  Recommendation: `new_surface`
  Source: `reference/release-performance-sweep` :: `L39 Snapshot`
  Target: `Release engineering and CI validation` / `Performance, footprint, and dependency evidence` / `Release snapshot and trend summary`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Play`
  Why: The snapshot summarizes artifact-backed release measurements, stable baselines, and trend framing for release review rather than documenting a single product surface.
- `10-11-reference-release-and-ci-p003-s002` | `reference/release-performance-sweep` | `Install Footprint Timeline`
  Recommendation: `new_surface`
  Source: `reference/release-performance-sweep` :: `L74 Install Footprint Timeline`
  Target: `Release engineering and CI validation` / `Performance, footprint, and dependency evidence` / `Install footprint timeline`
  Closest existing: `Docker / Podman hosting` / `Docker e2e Release Smoke and Scheduler` / `Release-path install`
  Why: Install-size and dependency-count trends across releases are release-evidence inputs for the shipped package, and no current taxonomy surface owns them directly.
- `10-11-reference-release-and-ci-p003-s003` | `reference/release-performance-sweep` | `What Changed In 5.28`
  Recommendation: `new_surface`
  Source: `reference/release-performance-sweep` :: `L112 What Changed In 5.28`
  Target: `Release engineering and CI validation` / `Performance, footprint, and dependency evidence` / `5.28 cleanup impact analysis`
  Closest existing: `Anthropic provider path` / `Release, Integration, and Live Scenario Proof` / `Release, Integration, and Live Scenario Proof`
  Why: This section analyzes the concrete effect of a release-line cleanup on package graph, nested tree size, and native dependency fanout. That evidence belongs to a missing release-evidence surface.
- `10-11-reference-release-and-ci-p003-s004` | `reference/release-performance-sweep` | `Headline Numbers`
  Recommendation: `new_surface`
  Source: `reference/release-performance-sweep` :: `L136 Headline Numbers`
  Target: `Release engineering and CI validation` / `Performance, footprint, and dependency evidence` / `Release headline metrics`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Play`
  Why: The headline-number tables are cross-release evidence for cold/warm turn time, RSS, and package footprint, not a single user-facing capability already represented elsewhere.
- `10-11-reference-release-and-ci-p003-s005` | `reference/release-performance-sweep` | `Install footprint`
  Recommendation: `new_surface`
  Source: `reference/release-performance-sweep` :: `L173 Install footprint`
  Target: `Release engineering and CI validation` / `Performance, footprint, and dependency evidence` / `Install footprint audit`
  Closest existing: `Docker / Podman hosting` / `Docker e2e Release Smoke and Scheduler` / `Release-path install`
  Why: This audit tracks installed package count, fresh install size, nested dependency tree size, and shrinkwrap presence across releases. That release-package evidence is missing from the taxonomy.
- `10-11-reference-release-and-ci-p003-s006` | `reference/release-performance-sweep` | `npm package size`
  Recommendation: `new_surface`
  Source: `reference/release-performance-sweep` :: `L184 npm package size`
  Target: `Release engineering and CI validation` / `Performance, footprint, and dependency evidence` / `Published npm package size audit`
  Closest existing: `ClawHub` / `Clawhub and Npm Publishing Release Validation` / `OpenClaw-owned package release validation for ClawHub`
  Why: The npm tarball size sweep is about core-package release evidence, not ClawHub/plugin publishing. The current semantic suggestion into plugin-distribution taxonomy is too narrow.
- `10-11-reference-release-and-ci-p003-s007` | `reference/release-performance-sweep` | `Kova agent turn summary`
  Recommendation: `new_surface`
  Source: `reference/release-performance-sweep` :: `L202 Kova agent turn summary`
  Target: `Release engineering and CI validation` / `Performance, footprint, and dependency evidence` / `Agent turn regression trend evidence`
  Closest existing: `Agent runtime and provider execution` / `Agent Turn Execution` / `Turn startup and runtime choice`
  Why: The Kova turn table captures release-over-release performance regression and recovery evidence for shipped builds. That benchmark evidence is not owned by an existing scorecard surface.
- `10-11-reference-release-and-ci-p003-s008` | `reference/release-performance-sweep` | `Source probes`
  Recommendation: `new_surface`
  Source: `reference/release-performance-sweep` :: `L240 Source probes`
  Target: `Release engineering and CI validation` / `Performance, footprint, and dependency evidence` / `Source probe regression evidence`
  Closest existing: `Local model providers: Ollama, vLLM, SGLang, LM Studio` / `Local Service Lifecycle and Readiness` / `Local Service Lifecycle and Readiness`
  Why: Readyz, CLI-health, and plugin-RSS probe results are release investigation evidence used across CLI and Gateway surfaces; no existing category cleanly owns the cross-surface probe pack.
- `10-11-reference-release-and-ci-p003-s009` | `reference/release-performance-sweep` | `Install footprint audit`
  Recommendation: `new_surface`
  Source: `reference/release-performance-sweep` :: `L265 Install footprint audit`
  Target: `Release engineering and CI validation` / `Performance, footprint, and dependency evidence` / `Install footprint audit details`
  Closest existing: `Docker / Podman hosting` / `Docker e2e Release Smoke and Scheduler` / `Release-path install`
  Why: The detailed dependency and nested-tree table is part of the missing release-package evidence surface rather than an existing install/update capability category.
- `10-11-reference-release-and-ci-p003-s010` | `reference/release-performance-sweep` | `Shrinkwrap boundary`
  Recommendation: `new_surface`
  Source: `reference/release-performance-sweep` :: `L281 Shrinkwrap boundary`
  Target: `Release engineering and CI validation` / `Performance, footprint, and dependency evidence` / `Shrinkwrap boundary evidence`
  Closest existing: `Raspberry Pi / small Linux devices` / `Hardware-specific Release Smoke and Support Boundary` / `Hardware-specific Release Smoke and Support Boundary`
  Why: The shrinkwrap section explains release-package boundary behavior, nested dependency materialization, and published-tarball checks. That evidence does not fit existing plugin or install categories cleanly.
- `10-11-reference-release-and-ci-p003-s011` | `reference/release-performance-sweep` | `Supply-chain interpretation`
  Recommendation: `new_surface`
  Source: `reference/release-performance-sweep` :: `L325 Supply-chain interpretation`
  Target: `Release engineering and CI validation` / `Performance, footprint, and dependency evidence` / `Supply-chain dependency interpretation`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Play`
  Why: This is a release-governance interpretation of dependency count, native binary fanout, and package-shape risk. No current surface owns that release evidence narrative.
- `10-11-reference-release-and-ci-p004-root` | `reference/test` | `(page)`
  Recommendation: `new_surface`
  Source: `reference/test` :: `(page)`
  Target: `Release engineering and CI validation` / `Local test, benchmark, and smoke workflows` / `Test reference overview`
  Closest existing: `Anthropic provider path` / `Release, Integration, and Live Scenario Proof` / `Release, Integration, and Live Scenario Proof`
  Why: The page is a consolidated maintainer reference for local tests, changed gates, benchmarks, Docker smoke, and PR gates. The taxonomy does not currently model OpenClaw's contributor validation workflows as a surface.
- `10-11-reference-release-and-ci-p004-s001` | `reference/test` | `Local PR gate`
  Recommendation: `new_surface`
  Source: `reference/test` :: `L62 Local PR gate`
  Target: `Release engineering and CI validation` / `Local test, benchmark, and smoke workflows` / `Local PR validation gate`
  Closest existing: `Plugin SDK and bundled plugin architecture` / `Testing plugins` / `Smoke tests`
  Why: The explicit local PR gate bundles check, test, build, and docs expectations for maintainers. That contributor validation contract is missing from existing surface coverage.
- `10-11-reference-release-and-ci-p004-s002` | `reference/test` | `Model latency bench (local keys)`
  Recommendation: `new_surface`
  Source: `reference/test` :: `L78 Model latency bench (local keys)`
  Target: `Release engineering and CI validation` / `Local test, benchmark, and smoke workflows` / `Model latency benchmark harness`
  Closest existing: `Local model providers: Ollama, vLLM, SGLang, LM Studio` / `Local Service Lifecycle and Readiness` / `Local Service Lifecycle and Readiness`
  Why: This section documents a local benchmark harness for comparing model latency with live keys. It is a validation toolchain concern rather than an existing product capability category.
- `10-11-reference-release-and-ci-p004-s003` | `reference/test` | `CLI startup bench`
  Recommendation: `new_surface`
  Source: `reference/test` :: `L93 CLI startup bench`
  Target: `Release engineering and CI validation` / `Local test, benchmark, and smoke workflows` / `CLI startup benchmark harness`
  Closest existing: `Anthropic provider path` / `Release, Integration, and Live Scenario Proof` / `Release, Integration, and Live Scenario Proof`
  Why: The CLI startup bench is a regression-measurement harness for command latency, RSS, and baseline comparison. It should not be forced into provider release-proof taxonomy.
- `10-11-reference-release-and-ci-p004-s004` | `reference/test` | `Gateway startup bench`
  Recommendation: `new_surface`
  Source: `reference/test` :: `L135 Gateway startup bench`
  Target: `Release engineering and CI validation` / `Local test, benchmark, and smoke workflows` / `Gateway startup benchmark harness`
  Closest existing: `Anthropic provider path` / `Release, Integration, and Live Scenario Proof` / `Release, Integration, and Live Scenario Proof`
  Why: The gateway startup bench measures `/healthz`, `/readyz`, startup trace metrics, and plugin-heavy cases as validation evidence, not as a user-facing runtime capability already modeled elsewhere.
- `10-11-reference-release-and-ci-p004-s005` | `reference/test` | `Gateway restart bench`
  Recommendation: `new_surface`
  Source: `reference/test` :: `L178 Gateway restart bench`
  Target: `Release engineering and CI validation` / `Local test, benchmark, and smoke workflows` / `Gateway restart benchmark harness`
  Closest existing: `Anthropic provider path` / `Release, Integration, and Live Scenario Proof` / `Release, Integration, and Live Scenario Proof`
  Why: Restart timing, downtime, replacement-process readiness, and trace metrics are benchmark harness behavior used for regression analysis. No current surface owns that validation workflow.
- `10-11-reference-release-and-ci-p004-s007` | `reference/test` | `QR import smoke (Docker)`
  Recommendation: `new_surface`
  Source: `reference/test` :: `L235 QR import smoke (Docker)`
  Target: `Release engineering and CI validation` / `Local test, benchmark, and smoke workflows` / `Docker QR runtime compatibility smoke`
  Closest existing: `Anthropic provider path` / `Release, Integration, and Live Scenario Proof` / `Release, Integration, and Live Scenario Proof`
  Why: This is a maintainer smoke test that proves the QR runtime helper still loads under supported Docker Node runtimes. That compatibility-check workflow is not represented in current taxonomy.
- `11-03-help-testing-p002-root` | `help/testing-updates-plugins` | `(page)`
  Recommendation: `new_surface`
  Source: `help/testing-updates-plugins` :: `(page)`
  Target: `Release engineering and CI validation` / `Local test, benchmark, and smoke workflows` / `Update and plugin validation guide`
  Closest existing: `Plugin SDK and bundled plugin architecture` / `Testing plugins` / `Local test environment`
  Why: The page is a focused maintainer checklist for proving package updates, doctor-owned legacy repair, and plugin lifecycle behavior before release. Current taxonomy covers the user-facing CLI/plugin capabilities being exercised, but not this contributor validation workflow as its own surface.
- `11-03-help-testing-p002-s002` | `help/testing-updates-plugins` | `Local proof during development`
  Recommendation: `new_surface`
  Source: `help/testing-updates-plugins` :: `L39 Local proof during development`
  Target: `Release engineering and CI validation` / `Local test, benchmark, and smoke workflows` / `Local update and plugin regression gate`
  Closest existing: `Plugin SDK and bundled plugin architecture` / `Bundled plugins` / `Bundled source overlays`
  Why: This section defines the local pre-Docker proof stack for update/plugin changes: `changed:lanes`, changed checks/tests, focused seam tests, and `release:check` tarball validation. That maintainer gate is not represented by existing product-surface taxonomy.
- `11-03-help-testing-p002-s004` | `help/testing-updates-plugins` | `Package Acceptance`
  Recommendation: `new_surface`
  Source: `help/testing-updates-plugins` :: `L151 Package Acceptance`
  Target: `Release engineering and CI validation` / `Preflight, validation boxes, and publish orchestration` / `Package Acceptance release gate`
  Closest existing: `Plugin SDK and bundled plugin architecture` / `Publishing plugins` / `Third-party publication rules`
  Why: The section defines candidate-source resolution, `package-under-test` artifact identity, suite profiles, Docker lane selection, published-baseline expansion, and manual workflow entrypoints for installable-package validation. No current maturity-scorecard surface owns that release-validation control plane.
- `11-03-help-testing-p002-s005` | `help/testing-updates-plugins` | `Release default`
  Recommendation: `new_surface`
  Source: `help/testing-updates-plugins` :: `L234 Release default`
  Target: `Release engineering and CI validation` / `Preflight, validation boxes, and publish orchestration` / `Release candidate proof stack`
  Closest existing: `Local model providers: Ollama, vLLM, SGLang, LM Studio` / `Vllm and Sglang Openai-compatible Providers` / `Vllm and Sglang Openai-compatible Providers`
  Why: This section sets the default release-candidate evidence stack across changed gates, `release:check`, Package Acceptance, cross-OS checks, live suites, and Testbox usage. That cross-system approval workflow is a release-validation concern that existing runtime/install/plugin surfaces do not model.
- `11-03-help-testing-p002-s007` | `help/testing-updates-plugins` | `Adding coverage`
  Recommendation: `new_surface`
  Source: `help/testing-updates-plugins` :: `L265 Adding coverage`
  Target: `Release engineering and CI validation` / `Local test, benchmark, and smoke workflows` / `Test-layer selection for update and plugin changes`
  Closest existing: `Plugin SDK and bundled plugin architecture` / `Testing plugins` / `Local test environment`
  Why: The section gives contributor guidance for where to add coverage based on the failure seam: unit tests, package inventory checks, Docker CLI lanes, published-upgrade scenarios, update-owned restart proof, registry fixtures, and dependency-layout assertions. That validation-design workflow is not represented in the current taxonomy.
- `11-03-help-testing-p002-s008` | `help/testing-updates-plugins` | `Failure triage`
  Recommendation: `new_surface`
  Source: `help/testing-updates-plugins` :: `L286 Failure triage`
  Target: `Release engineering and CI validation` / `Local test, benchmark, and smoke workflows` / `Validation artifact triage and rerun guidance`
  Closest existing: `Plugin SDK and bundled plugin architecture` / `Testing plugins` / `Local test environment`
  Why: This section documents how maintainers debug failed update/plugin validation by starting from package identity, then inspecting Docker artifacts, upgrade-survivor summaries, lane logs, and exact rerun commands. That artifact-driven triage workflow is a missing validation-surface capability.

## Recommend new category

- `02-02-install-maintenance-p002-root` | `install/migrating` | `(page)`
  Recommendation: `new_category`
  Source: `install/migrating` :: `(page)`
  Target: `CLI` / `Migration and State Transfer` / `Migration hub and safety model`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: The taxonomy has CLI setup/update/onboarding/doctor coverage, but no category for `openclaw migrate`, cross-system imports, machine moves, backups, conflict handling, or migration reports; neither `docs/install/migrating.md` nor `docs/cli/migrate.md` is referenced today.
- `02-04-install-hosting-p005-root` | `install/fly` | `(page)`
  Recommendation: `new_category`
  Source: `install/fly` :: `(page)`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `Fly machine bootstrap`
  Closest existing: `Discord` / `Bot Setup and Account Configuration` / `Bot Setup and Account Configuration`
  Why: The exact auto-map to Discord bot setup is obviously wrong: install/fly.md is a hosted deployment guide and belongs with managed container hosting coverage instead.
- `02-04-install-hosting-p011-root` | `install/macos-vm` | `(page)`
  Recommendation: `new_category`
  Source: `install/macos-vm` :: `(page)`
  Target: `macOS Gateway host` / `Virtualized macOS host setup and image lifecycle` / `macOS VM provisioning and operation`
  Closest existing: `macOS Gateway host` / `Macos CLI Install and Runtime Prerequisites` / `Hosted installer`
  Why: The current macOS host taxonomy does not have a category for Lume or hosted-mac VM creation, image management, headless operation, and VM-specific troubleshooting.
- `02-04-install-hosting-p011-s001` | `install/macos-vm` | `Recommended default (most users)`
  Recommendation: `new_category`
  Source: `install/macos-vm` :: `L11 Recommended default (most users)`
  Target: `macOS Gateway host` / `Virtualized macOS host setup and image lifecycle` / `macOS VM provisioning and operation`
  Closest existing: `Nix install path` / `Macos Gui Defaults Read-only UX and Companion Behavior` / `Macos Gui Defaults Read-only UX and Companion Behavior`
  Why: The current macOS host taxonomy does not have a category for Lume or hosted-mac VM creation, image management, headless operation, and VM-specific troubleshooting.
- `02-04-install-hosting-p011-s002` | `install/macos-vm` | `macOS VM options`
  Recommendation: `new_category`
  Source: `install/macos-vm` :: `L19 macOS VM options`
  Target: `macOS Gateway host` / `Virtualized macOS host setup and image lifecycle` / `macOS VM provisioning and operation`
  Closest existing: `macOS Gateway host` / `Macos CLI Install and Runtime Prerequisites` / `Hosted installer`
  Why: The current macOS host taxonomy does not have a category for Lume or hosted-mac VM creation, image management, headless operation, and VM-specific troubleshooting.
- `02-04-install-hosting-p011-s003` | `install/macos-vm` | `Local VM on your Apple Silicon Mac (Lume)`
  Recommendation: `new_category`
  Source: `install/macos-vm` :: `L21 Local VM on your Apple Silicon Mac (Lume)`
  Target: `macOS Gateway host` / `Virtualized macOS host setup and image lifecycle` / `macOS VM provisioning and operation`
  Closest existing: `macOS Gateway host` / `Macos CLI Install and Runtime Prerequisites` / `Hosted installer`
  Why: The current macOS host taxonomy does not have a category for Lume or hosted-mac VM creation, image management, headless operation, and VM-specific troubleshooting.
- `02-04-install-hosting-p011-s004` | `install/macos-vm` | `Hosted Mac providers (cloud)`
  Recommendation: `new_category`
  Source: `install/macos-vm` :: `L32 Hosted Mac providers (cloud)`
  Target: `macOS Gateway host` / `Virtualized macOS host setup and image lifecycle` / `macOS VM provisioning and operation`
  Closest existing: `macOS Gateway host` / `Macos CLI Install and Runtime Prerequisites` / `Hosted installer`
  Why: The current macOS host taxonomy does not have a category for Lume or hosted-mac VM creation, image management, headless operation, and VM-specific troubleshooting.
- `02-04-install-hosting-p011-s005` | `install/macos-vm` | `Quick path (Lume, experienced users)`
  Recommendation: `new_category`
  Source: `install/macos-vm` :: `L43 Quick path (Lume, experienced users)`
  Target: `macOS Gateway host` / `Virtualized macOS host setup and image lifecycle` / `macOS VM provisioning and operation`
  Closest existing: `Linux Gateway host` / `Linux CLI Install and Update Path` / `Linux CLI Install and Update Path`
  Why: The current macOS host taxonomy does not have a category for Lume or hosted-mac VM creation, image management, headless operation, and VM-specific troubleshooting.
- `02-04-install-hosting-p011-s006` | `install/macos-vm` | `What you need (Lume)`
  Recommendation: `new_category`
  Source: `install/macos-vm` :: `L54 What you need (Lume)`
  Target: `macOS Gateway host` / `Virtualized macOS host setup and image lifecycle` / `macOS VM provisioning and operation`
  Closest existing: `macOS Gateway host` / `Macos CLI Install and Runtime Prerequisites` / `Hosted installer`
  Why: The current macOS host taxonomy does not have a category for Lume or hosted-mac VM creation, image management, headless operation, and VM-specific troubleshooting.
- `02-04-install-hosting-p011-s007` | `install/macos-vm` | `1) Install Lume`
  Recommendation: `new_category`
  Source: `install/macos-vm` :: `L63 1) Install Lume`
  Target: `macOS Gateway host` / `Virtualized macOS host setup and image lifecycle` / `macOS VM provisioning and operation`
  Closest existing: `macOS Gateway host` / `Macos CLI Install and Runtime Prerequisites` / `Hosted installer`
  Why: The current macOS host taxonomy does not have a category for Lume or hosted-mac VM creation, image management, headless operation, and VM-specific troubleshooting.
- `02-04-install-hosting-p011-s008` | `install/macos-vm` | `2) Create the macOS VM`
  Recommendation: `new_category`
  Source: `install/macos-vm` :: `L85 2) Create the macOS VM`
  Target: `macOS Gateway host` / `Virtualized macOS host setup and image lifecycle` / `macOS VM provisioning and operation`
  Closest existing: `macOS Gateway host` / `Macos CLI Install and Runtime Prerequisites` / `Hosted installer`
  Why: The current macOS host taxonomy does not have a category for Lume or hosted-mac VM creation, image management, headless operation, and VM-specific troubleshooting.
- `02-04-install-hosting-p011-s009` | `install/macos-vm` | `3) Complete Setup Assistant`
  Recommendation: `new_category`
  Source: `install/macos-vm` :: `L99 3) Complete Setup Assistant`
  Target: `macOS Gateway host` / `Virtualized macOS host setup and image lifecycle` / `macOS VM provisioning and operation`
  Closest existing: `CLI` / `Plugin and Channel Setup` / `Plugin install sources`
  Why: The current macOS host taxonomy does not have a category for Lume or hosted-mac VM creation, image management, headless operation, and VM-specific troubleshooting.
- `02-04-install-hosting-p011-s010` | `install/macos-vm` | `4) Get the VM IP address`
  Recommendation: `new_category`
  Source: `install/macos-vm` :: `L115 4) Get the VM IP address`
  Target: `macOS Gateway host` / `Virtualized macOS host setup and image lifecycle` / `macOS VM provisioning and operation`
  Closest existing: `macOS Gateway host` / `Macos CLI Install and Runtime Prerequisites` / `Hosted installer`
  Why: The current macOS host taxonomy does not have a category for Lume or hosted-mac VM creation, image management, headless operation, and VM-specific troubleshooting.
- `02-04-install-hosting-p011-s011` | `install/macos-vm` | `5) SSH into the VM`
  Recommendation: `new_category`
  Source: `install/macos-vm` :: `L125 5) SSH into the VM`
  Target: `macOS Gateway host` / `Virtualized macOS host setup and image lifecycle` / `macOS VM provisioning and operation`
  Closest existing: `macOS Gateway host` / `Macos CLI Install and Runtime Prerequisites` / `Hosted installer`
  Why: The current macOS host taxonomy does not have a category for Lume or hosted-mac VM creation, image management, headless operation, and VM-specific troubleshooting.
- `02-04-install-hosting-p011-s014` | `install/macos-vm` | `8) Run the VM headlessly`
  Recommendation: `new_category`
  Source: `install/macos-vm` :: `L180 8) Run the VM headlessly`
  Target: `macOS Gateway host` / `Virtualized macOS host setup and image lifecycle` / `macOS VM provisioning and operation`
  Closest existing: `macOS Gateway host` / `Macos CLI Install and Runtime Prerequisites` / `Hosted installer`
  Why: The current macOS host taxonomy does not have a category for Lume or hosted-mac VM creation, image management, headless operation, and VM-specific troubleshooting.
- `02-04-install-hosting-p011-s015` | `install/macos-vm` | `Bonus: iMessage integration`
  Recommendation: `new_category`
  Source: `install/macos-vm` :: `L199 Bonus: iMessage integration`
  Target: `macOS Gateway host` / `Virtualized macOS host setup and image lifecycle` / `macOS VM provisioning and operation`
  Closest existing: `macOS Gateway host` / `Macos CLI Install and Runtime Prerequisites` / `Hosted installer`
  Why: The current macOS host taxonomy does not have a category for Lume or hosted-mac VM creation, image management, headless operation, and VM-specific troubleshooting.
- `02-04-install-hosting-p011-s016` | `install/macos-vm` | `Save a golden image`
  Recommendation: `new_category`
  Source: `install/macos-vm` :: `L230 Save a golden image`
  Target: `macOS Gateway host` / `Virtualized macOS host setup and image lifecycle` / `macOS VM provisioning and operation`
  Closest existing: `macOS Gateway host` / `Macos CLI Install and Runtime Prerequisites` / `Hosted installer`
  Why: The current macOS host taxonomy does not have a category for Lume or hosted-mac VM creation, image management, headless operation, and VM-specific troubleshooting.
- `02-04-install-hosting-p011-s017` | `install/macos-vm` | `Running 24/7`
  Recommendation: `new_category`
  Source: `install/macos-vm` :: `L249 Running 24/7`
  Target: `macOS Gateway host` / `Virtualized macOS host setup and image lifecycle` / `macOS VM provisioning and operation`
  Closest existing: `macOS Gateway host` / `Macos CLI Install and Runtime Prerequisites` / `Hosted installer`
  Why: The current macOS host taxonomy does not have a category for Lume or hosted-mac VM creation, image management, headless operation, and VM-specific troubleshooting.
- `02-04-install-hosting-p011-s018` | `install/macos-vm` | `Troubleshooting`
  Recommendation: `new_category`
  Source: `install/macos-vm` :: `L261 Troubleshooting`
  Target: `macOS Gateway host` / `Virtualized macOS host setup and image lifecycle` / `macOS VM provisioning and operation`
  Closest existing: `macOS Gateway host` / `Macos CLI Install and Runtime Prerequisites` / `Hosted installer`
  Why: The current macOS host taxonomy does not have a category for Lume or hosted-mac VM creation, image management, headless operation, and VM-specific troubleshooting.
- `02-04-install-hosting-p011-s019` | `install/macos-vm` | `Related docs`
  Recommendation: `new_category`
  Source: `install/macos-vm` :: `L272 Related docs`
  Target: `macOS Gateway host` / `Virtualized macOS host setup and image lifecycle` / `macOS VM provisioning and operation`
  Closest existing: `macOS Gateway host` / `Macos CLI Install and Runtime Prerequisites` / `Hosted installer`
  Why: The current macOS host taxonomy does not have a category for Lume or hosted-mac VM creation, image management, headless operation, and VM-specific troubleshooting.
- `02-04-install-hosting-p012-root` | `install/northflank` | `(page)`
  Recommendation: `new_category`
  Source: `install/northflank` :: `(page)`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `Northflank hosted deploy`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: Northflank is a managed hosted deployment path with browser-driven stack creation, persistent volume wiring, and public Control UI access, which is not represented in the current Docker-hosting taxonomy.
- `02-04-install-hosting-p012-s001` | `install/northflank` | `Northflank`
  Recommendation: `new_category`
  Source: `install/northflank` :: `L9 Northflank`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `Northflank hosted deploy`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: Northflank is a managed hosted deployment path with browser-driven stack creation, persistent volume wiring, and public Control UI access, which is not represented in the current Docker-hosting taxonomy.
- `02-04-install-hosting-p012-s002` | `install/northflank` | `How to get started`
  Recommendation: `new_category`
  Source: `install/northflank` :: `L14 How to get started`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `Browser-only stack deployment`
  Closest existing: `Docker / Podman hosting` / `Networking, Control Ui, Health, and Observability` / `Excludes general Gateway protocol semantics not`
  Why: Northflank is a managed hosted deployment path with browser-driven stack creation, persistent volume wiring, and public Control UI access, which is not represented in the current Docker-hosting taxonomy.
- `02-04-install-hosting-p012-s003` | `install/northflank` | `What you get`
  Recommendation: `new_category`
  Source: `install/northflank` :: `L25 What you get`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `Managed persistent volume`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: Northflank is a managed hosted deployment path with browser-driven stack creation, persistent volume wiring, and public Control UI access, which is not represented in the current Docker-hosting taxonomy.
- `02-04-install-hosting-p012-s004` | `install/northflank` | `Connect a channel`
  Recommendation: `new_category`
  Source: `install/northflank` :: `L32 Connect a channel`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `Post-deploy channel onboarding`
  Closest existing: `Feishu, QQ Bot, WeChat, Yuanbao, Zalo, Zalo Personal, regional channels` / `Shared Regional Channel Catalog, Install, and Status` / `Core channel-plugin catalog`
  Why: Northflank is a managed hosted deployment path with browser-driven stack creation, persistent volume wiring, and public Control UI access, which is not represented in the current Docker-hosting taxonomy.
- `02-04-install-hosting-p012-s005` | `install/northflank` | `Next steps`
  Recommendation: `new_category`
  Source: `install/northflank` :: `L40 Next steps`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `Hosted follow-on operations`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: Northflank is a managed hosted deployment path with browser-driven stack creation, persistent volume wiring, and public Control UI access, which is not represented in the current Docker-hosting taxonomy.
- `02-04-install-hosting-p014-root` | `install/railway` | `(page)`
  Recommendation: `new_category`
  Source: `install/railway` :: `(page)`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `Railway hosted deploy`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: Railway is a managed hosted deployment path with public proxy wiring, attached volumes, and dashboard-driven operations that are not represented in the current taxonomy.
- `02-04-install-hosting-p014-s001` | `install/railway` | `Railway`
  Recommendation: `new_category`
  Source: `install/railway` :: `L9 Railway`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `Railway hosted deploy`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: Railway is a managed hosted deployment path with public proxy wiring, attached volumes, and dashboard-driven operations that are not represented in the current taxonomy.
- `02-04-install-hosting-p014-s002` | `install/railway` | `Quick checklist (new users)`
  Recommendation: `new_category`
  Source: `install/railway` :: `L14 Quick checklist (new users)`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `Quick checklist and proxy-volume-token prerequisites`
  Closest existing: `Native Windows CLI and Gateway` / `WSL2 Recommended Gateway Host Path` / `WSL2 install guidance`
  Why: Railway is a managed hosted deployment path with public proxy wiring, attached volumes, and dashboard-driven operations that are not represented in the current taxonomy.
- `02-04-install-hosting-p014-s003` | `install/railway` | `One-click deploy`
  Recommendation: `new_category`
  Source: `install/railway` :: `L22 One-click deploy`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `One-click deploy launcher`
  Closest existing: `Gateway Web App` / `PWA Install and Web Push Notifications` / `PWA Install and Web Push Notifications`
  Why: Railway is a managed hosted deployment path with public proxy wiring, attached volumes, and dashboard-driven operations that are not represented in the current taxonomy.
- `02-04-install-hosting-p014-s004` | `install/railway` | `What you get`
  Recommendation: `new_category`
  Source: `install/railway` :: `L39 What you get`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `Persistent volume-backed hosted runtime`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: Railway is a managed hosted deployment path with public proxy wiring, attached volumes, and dashboard-driven operations that are not represented in the current taxonomy.
- `02-04-install-hosting-p014-s005` | `install/railway` | `Required Railway settings`
  Recommendation: `new_category`
  Source: `install/railway` :: `L46 Required Railway settings`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `Provider settings contract`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: Railway is a managed hosted deployment path with public proxy wiring, attached volumes, and dashboard-driven operations that are not represented in the current taxonomy.
- `02-04-install-hosting-p014-s006` | `install/railway` | `Public Networking`
  Recommendation: `new_category`
  Source: `install/railway` :: `L48 Public Networking`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `HTTP proxy wiring`
  Closest existing: `Nix install path` / `Public Nix Docs and Nix-openclaw Handoff` / `Public Nix Docs and Nix-openclaw Handoff`
  Why: Railway is a managed hosted deployment path with public proxy wiring, attached volumes, and dashboard-driven operations that are not represented in the current taxonomy.
- `02-04-install-hosting-p014-s007` | `install/railway` | `Volume (required)`
  Recommendation: `new_category`
  Source: `install/railway` :: `L54 Volume (required)`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `Persistent volume mount`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: Railway is a managed hosted deployment path with public proxy wiring, attached volumes, and dashboard-driven operations that are not represented in the current taxonomy.
- `02-04-install-hosting-p014-s008` | `install/railway` | `Variables`
  Recommendation: `new_category`
  Source: `install/railway` :: `L60 Variables`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `Environment-variable state wiring`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: Railway is a managed hosted deployment path with public proxy wiring, attached volumes, and dashboard-driven operations that are not represented in the current taxonomy.
- `02-04-install-hosting-p014-s009` | `install/railway` | `Connect a channel`
  Recommendation: `new_category`
  Source: `install/railway` :: `L69 Connect a channel`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `Post-deploy channel onboarding`
  Closest existing: `Feishu, QQ Bot, WeChat, Yuanbao, Zalo, Zalo Personal, regional channels` / `Shared Regional Channel Catalog, Install, and Status` / `Core channel-plugin catalog`
  Why: Railway is a managed hosted deployment path with public proxy wiring, attached volumes, and dashboard-driven operations that are not represented in the current taxonomy.
- `02-04-install-hosting-p014-s010` | `install/railway` | `Backups & migration`
  Recommendation: `new_category`
  Source: `install/railway` :: `L77 Backups & migration`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `Backup export and migration`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: Railway is a managed hosted deployment path with public proxy wiring, attached volumes, and dashboard-driven operations that are not represented in the current taxonomy.
- `02-04-install-hosting-p014-s011` | `install/railway` | `Next steps`
  Recommendation: `new_category`
  Source: `install/railway` :: `L88 Next steps`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `Hosted follow-on operations`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: Railway is a managed hosted deployment path with public proxy wiring, attached volumes, and dashboard-driven operations that are not represented in the current taxonomy.
- `02-04-install-hosting-p016-root` | `install/render` | `(page)`
  Recommendation: `new_category`
  Source: `install/render` :: `(page)`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `Render Blueprint deploy`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: Render deployment is a hosted Blueprint-driven container path with provider-managed logs, shell, domains, scaling, and disk semantics that are missing from the current hosting taxonomy.
- `02-04-install-hosting-p016-s001` | `install/render` | `Render`
  Recommendation: `new_category`
  Source: `install/render` :: `L9 Render`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `Render Blueprint deploy`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: Render deployment is a hosted Blueprint-driven container path with provider-managed logs, shell, domains, scaling, and disk semantics that are missing from the current hosting taxonomy.
- `02-04-install-hosting-p016-s002` | `install/render` | `Prerequisites`
  Recommendation: `new_category`
  Source: `install/render` :: `L13 Prerequisites`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `Hosted provider prerequisites`
  Closest existing: `Raspberry Pi / small Linux devices` / `Arm Linux Install and Runtime Prerequisites` / `Arm Linux Install and Runtime Prerequisites`
  Why: Render deployment is a hosted Blueprint-driven container path with provider-managed logs, shell, domains, scaling, and disk semantics that are missing from the current hosting taxonomy.
- `02-04-install-hosting-p016-s003` | `install/render` | `Deploy with a Render Blueprint`
  Recommendation: `new_category`
  Source: `install/render` :: `L18 Deploy with a Render Blueprint`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `Blueprint launch flow`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: Render deployment is a hosted Blueprint-driven container path with provider-managed logs, shell, domains, scaling, and disk semantics that are missing from the current hosting taxonomy.
- `02-04-install-hosting-p016-s004` | `install/render` | `Understanding the Blueprint`
  Recommendation: `new_category`
  Source: `install/render` :: `L29 Understanding the Blueprint`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `Blueprint contract and generated token-disk wiring`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: Render deployment is a hosted Blueprint-driven container path with provider-managed logs, shell, domains, scaling, and disk semantics that are missing from the current hosting taxonomy.
- `02-04-install-hosting-p016-s005` | `install/render` | `Choosing a plan`
  Recommendation: `new_category`
  Source: `install/render` :: `L65 Choosing a plan`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `Plan and persistence tradeoffs`
  Closest existing: `Feishu, QQ Bot, WeChat, Yuanbao, Zalo, Zalo Personal, regional channels` / `Shared Regional Channel Catalog, Install, and Status` / `Core channel-plugin catalog`
  Why: Render deployment is a hosted Blueprint-driven container path with provider-managed logs, shell, domains, scaling, and disk semantics that are missing from the current hosting taxonomy.
- `02-04-install-hosting-p016-s006` | `install/render` | `After deployment`
  Recommendation: `new_category`
  Source: `install/render` :: `L77 After deployment`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `Post-deploy runtime access`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: Render deployment is a hosted Blueprint-driven container path with provider-managed logs, shell, domains, scaling, and disk semantics that are missing from the current hosting taxonomy.
- `02-04-install-hosting-p016-s007` | `install/render` | `Access the Control UI`
  Recommendation: `new_category`
  Source: `install/render` :: `L79 Access the Control UI`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `Hosted Control UI access`
  Closest existing: `Gateway Web App` / `Control UI Static Shell, Routing, and PWA Install Surface` / `Control UI Static Shell, Routing, and PWA Install Surface`
  Why: Render deployment is a hosted Blueprint-driven container path with provider-managed logs, shell, domains, scaling, and disk semantics that are missing from the current hosting taxonomy.
- `02-04-install-hosting-p016-s008` | `install/render` | `Render Dashboard features`
  Recommendation: `new_category`
  Source: `install/render` :: `L88 Render Dashboard features`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `Provider dashboard operations`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: Render deployment is a hosted Blueprint-driven container path with provider-managed logs, shell, domains, scaling, and disk semantics that are missing from the current hosting taxonomy.
- `02-04-install-hosting-p016-s009` | `install/render` | `Logs`
  Recommendation: `new_category`
  Source: `install/render` :: `L90 Logs`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `Hosted runtime logs`
  Closest existing: `CLI` / `CLI Observability` / `Remote log tailing`
  Why: Render deployment is a hosted Blueprint-driven container path with provider-managed logs, shell, domains, scaling, and disk semantics that are missing from the current hosting taxonomy.
- `02-04-install-hosting-p016-s010` | `install/render` | `Shell access`
  Recommendation: `new_category`
  Source: `install/render` :: `L98 Shell access`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `Provider shell access`
  Closest existing: `Gateway Web App` / `Control UI Static Shell, Routing, and PWA Install Surface` / `Control UI Static Shell, Routing, and PWA Install Surface`
  Why: Render deployment is a hosted Blueprint-driven container path with provider-managed logs, shell, domains, scaling, and disk semantics that are missing from the current hosting taxonomy.
- `02-04-install-hosting-p016-s011` | `install/render` | `Environment variables`
  Recommendation: `new_category`
  Source: `install/render` :: `L102 Environment variables`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `Dashboard environment mutation`
  Closest existing: `Nix install path` / `State and Config Path Handling for Immutable-store Installs` / `State and Config Path Handling for Immutable-store Installs`
  Why: Render deployment is a hosted Blueprint-driven container path with provider-managed logs, shell, domains, scaling, and disk semantics that are missing from the current hosting taxonomy.
- `02-04-install-hosting-p016-s012` | `install/render` | `Auto-deploy`
  Recommendation: `new_category`
  Source: `install/render` :: `L106 Auto-deploy`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `Provider auto-deploy behavior`
  Closest existing: `Nix install path` / `Doctor Setup Update and Daemon Service Mutation Guards` / `Doctor Setup Update and Daemon Service Mutation Guards`
  Why: Render deployment is a hosted Blueprint-driven container path with provider-managed logs, shell, domains, scaling, and disk semantics that are missing from the current hosting taxonomy.
- `02-04-install-hosting-p016-s013` | `install/render` | `Custom domain`
  Recommendation: `new_category`
  Source: `install/render` :: `L110 Custom domain`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `Custom domain and TLS handoff`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: Render deployment is a hosted Blueprint-driven container path with provider-managed logs, shell, domains, scaling, and disk semantics that are missing from the current hosting taxonomy.
- `02-04-install-hosting-p016-s014` | `install/render` | `Scaling`
  Recommendation: `new_category`
  Source: `install/render` :: `L117 Scaling`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `Plan-based scaling model`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: Render deployment is a hosted Blueprint-driven container path with provider-managed logs, shell, domains, scaling, and disk semantics that are missing from the current hosting taxonomy.
- `02-04-install-hosting-p016-s015` | `install/render` | `Backups and migration`
  Recommendation: `new_category`
  Source: `install/render` :: `L126 Backups and migration`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `Backup export and migration`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: Render deployment is a hosted Blueprint-driven container path with provider-managed logs, shell, domains, scaling, and disk semantics that are missing from the current hosting taxonomy.
- `02-04-install-hosting-p016-s016` | `install/render` | `Troubleshooting`
  Recommendation: `new_category`
  Source: `install/render` :: `L138 Troubleshooting`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `Hosted troubleshooting entrypoint`
  Closest existing: `CLI` / `Gateway Service Management` / `Service health checks`
  Why: Render deployment is a hosted Blueprint-driven container path with provider-managed logs, shell, domains, scaling, and disk semantics that are missing from the current hosting taxonomy.
- `02-04-install-hosting-p016-s017` | `install/render` | `Service will not start`
  Recommendation: `new_category`
  Source: `install/render` :: `L140 Service will not start`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `Startup failure diagnosis`
  Closest existing: `CLI` / `Gateway Service Management` / `Service install and control`
  Why: Render deployment is a hosted Blueprint-driven container path with provider-managed logs, shell, domains, scaling, and disk semantics that are missing from the current hosting taxonomy.
- `02-04-install-hosting-p016-s018` | `install/render` | `Slow cold starts (free tier)`
  Recommendation: `new_category`
  Source: `install/render` :: `L147 Slow cold starts (free tier)`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `Cold-start posture on free tier`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: Render deployment is a hosted Blueprint-driven container path with provider-managed logs, shell, domains, scaling, and disk semantics that are missing from the current hosting taxonomy.
- `02-04-install-hosting-p016-s019` | `install/render` | `Data loss after redeploy`
  Recommendation: `new_category`
  Source: `install/render` :: `L151 Data loss after redeploy`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `Persistence loss on diskless tier`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: Render deployment is a hosted Blueprint-driven container path with provider-managed logs, shell, domains, scaling, and disk semantics that are missing from the current hosting taxonomy.
- `02-04-install-hosting-p016-s020` | `install/render` | `Health check failures`
  Recommendation: `new_category`
  Source: `install/render` :: `L156 Health check failures`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `Health-check failure diagnosis`
  Closest existing: `CLI` / `Gateway Service Management` / `Service health checks`
  Why: Render deployment is a hosted Blueprint-driven container path with provider-managed logs, shell, domains, scaling, and disk semantics that are missing from the current hosting taxonomy.
- `02-04-install-hosting-p016-s021` | `install/render` | `Next steps`
  Recommendation: `new_category`
  Source: `install/render` :: `L163 Next steps`
  Target: `Docker / Podman hosting` / `Hosted PaaS and one-click deploys` / `Hosted follow-on operations`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: Render deployment is a hosted Blueprint-driven container path with provider-managed logs, shell, domains, scaling, and disk semantics that are missing from the current hosting taxonomy.
- `03-05-channels-configuration-p010-s001` | `channels/qa-channel` | `What it does`
  Recommendation: `new_category`
  Source: `channels/qa-channel` :: `L12 What it does`
  Target: `QA channel` / `Transport semantics and transcript bus` / `Slack-class targets and HTTP-backed synthetic bus`
  Closest existing: `Discord` / `Bot Setup and Account Configuration` / `Bot Setup and Account Configuration`
  Why: The `What it does` section defines QA-channel-specific behavior: `dm:/channel:/group:/thread:` target grammar, group/channel turn routing, transcript capture, thread creation, reactions, edits, deletes, and search/read actions. That is broader than a docs-link tweak to existing generic channel-framework entries.
- `03-05-channels-configuration-p010-s002` | `channels/qa-channel` | `Config`
  Recommendation: `new_category`
  Source: `channels/qa-channel` :: `L23 Config`
  Target: `QA channel` / `Configuration and access policy` / `Account schema and policy gates`
  Closest existing: `Discord` / `Realtime Discord Voice Channels` / `Includes Discord voice channel sessions controlled`
  Why: The `Config` section introduces a dedicated schema and operator knobs for QA Channel (`baseUrl`, `botUserId`, `botDisplayName`, `pollTimeoutMs`, `allowFrom`, `groupPolicy`, `groupAllowFrom`, per-room `requireMention`, `defaultTo`, `actions.*`, `accounts`, `defaultAccount`). Existing taxonomy covers similar concepts generically, but no current surface/category owns this channel-specific config surface.
- `03-05-channels-configuration-p010-s003` | `channels/qa-channel` | `Runners`
  Recommendation: `new_category`
  Source: `channels/qa-channel` :: `L63 Runners`
  Target: `QA channel` / `Runners and QA lab workflows` / `Self-check, suite, and QA Lab runners`
  Closest existing: `Feishu, QQ Bot, WeChat, Yuanbao, Zalo, Zalo Personal, regional channels` / `Shared Regional Channel Catalog, Install, and Status` / `Channel setup wizard`
  Why: The `Runners` section documents QA-channel-specific operator workflows (`pnpm qa:e2e`, `pnpm openclaw qa suite`, `pnpm qa:lab:up`) and ties the transport to the QA Lab stack. Current taxonomy reuses `docs/concepts/qa-e2e-automation.md` for live-channel validation, but it does not score the synthetic QA channel runner surface itself.
- `04-02-agents-sessions-and-memory-p004-root` | `concepts/session-tool` | `(page)`
  Recommendation: `new_category`
  Source: `concepts/session-tool` :: `(page)`
  Target: `Session, memory, and context engine` / `Session Tools and Sub-agent Orchestration` / `Session Tools and Sub-agent Orchestration`
  Closest existing: `Session, memory, and context engine` / `Memory Files, Tools, and Active Memory` / `Memory Files, Tools, and Active Memory`
  Why: Agent-facing sessions\_\* and subagents tools lack an owning category.
- `04-02-agents-sessions-and-memory-p005-s011` | `concepts/memory` | `Dreaming`
  Recommendation: `new_category`
  Source: `concepts/memory` :: `L218 Dreaming`
  Target: `Session, memory, and context engine` / `Dreaming, Promotion, and Memory Consolidation` / `Dreaming, Promotion, and Memory Consolidation`
  Closest existing: `Session, memory, and context engine` / `Memory Files, Tools, and Active Memory` / `Memory Files, Tools, and Active Memory`
  Why: Dreaming overview exposes the missing dreaming category.
- `04-02-agents-sessions-and-memory-p008-root` | `concepts/memory-honcho` | `(page)`
  Recommendation: `new_category`
  Source: `concepts/memory-honcho` :: `(page)`
  Target: `Session, memory, and context engine` / `Honcho Cross-session Memory and User Modeling` / `Honcho Cross-session Memory and User Modeling`
  Closest existing: `Session, memory, and context engine` / `Memory Files, Tools, and Active Memory` / `Memory Files, Tools, and Active Memory`
  Why: Honcho service, tools, migration, and user modeling lack an owning category.
- `04-02-agents-sessions-and-memory-p012-root` | `concepts/dreaming` | `(page)`
  Recommendation: `new_category`
  Source: `concepts/dreaming` :: `(page)`
  Target: `Session, memory, and context engine` / `Dreaming, Promotion, and Memory Consolidation` / `Dreaming, Promotion, and Memory Consolidation`
  Closest existing: `Session, memory, and context engine` / `Memory Files, Tools, and Active Memory` / `Memory Files, Tools, and Active Memory`
  Why: Dreaming, promotion, diary, backfill, and scheduling lack an owning category.
- `04-03-agents-multi-agent-p001-root` | `concepts/multi-agent` | `(page)`
  Recommendation: `new_category`
  Source: `concepts/multi-agent` :: `(page)`
  Target: `Channel framework` / `Multi-agent routing and account bindings` / `Multi-agent routing`
  Closest existing: `Telegram` / `Group Forum Topic and Session Routing` / `ACP topic binding`
  Why: Auto-match to Telegram is a false positive from a shared doc ref; the page actually defines gateway-wide agent and account binding behavior across channels.
- `04-03-agents-multi-agent-p001-s001` | `concepts/multi-agent` | `What is "one agent"?`
  Recommendation: `new_category`
  Source: `concepts/multi-agent` :: `L13 What is "one agent"?`
  Target: `Channel framework` / `Multi-agent routing and account bindings` / `Agent isolation model`
  Closest existing: `Telegram` / `Group Forum Topic and Session Routing` / `ACP topic binding`
  Why: Section defines per-agent workspace, state dir, auth, and session isolation, which is broader than any single channel category.
- `04-03-agents-multi-agent-p001-s002` | `concepts/multi-agent` | `Paths (quick map)`
  Recommendation: `new_category`
  Source: `concepts/multi-agent` :: `L48 Paths (quick map)`
  Target: `Channel framework` / `Multi-agent routing and account bindings` / `Agent and state path model`
  Closest existing: `Telegram` / `Group Forum Topic and Session Routing` / `ACP topic binding`
  Why: Config, state, workspace, agentDir, and session path conventions are part of the missing multi-agent routing category.
- `04-03-agents-multi-agent-p001-s003` | `concepts/multi-agent` | `Single-agent mode (default)`
  Recommendation: `new_category`
  Source: `concepts/multi-agent` :: `L56 Single-agent mode (default)`
  Target: `Channel framework` / `Multi-agent routing and account bindings` / `Single-agent default topology`
  Closest existing: `Telegram` / `Group Forum Topic and Session Routing` / `ACP topic binding`
  Why: Default main-agent behavior belongs to multi-agent topology coverage, not Telegram routing.
- `04-03-agents-multi-agent-p001-s004` | `concepts/multi-agent` | `Agent helper`
  Recommendation: `new_category`
  Source: `concepts/multi-agent` :: `L65 Agent helper`
  Target: `Channel framework` / `Multi-agent routing and account bindings` / `Agent provisioning workflow`
  Closest existing: `Telegram` / `Group Forum Topic and Session Routing` / `ACP topic binding`
  Why: openclaw agents add and binding verification are part of multi-agent setup coverage.
- `04-03-agents-multi-agent-p001-s005` | `concepts/multi-agent` | `Quick start`
  Recommendation: `new_category`
  Source: `concepts/multi-agent` :: `L81 Quick start`
  Target: `Channel framework` / `Multi-agent routing and account bindings` / `Multi-agent quick-start setup`
  Closest existing: `Telegram` / `Group Forum Topic and Session Routing` / `ACP topic binding`
  Why: Creating agents, accounts, bindings, and verification steps is core multi-agent onboarding coverage.
- `04-03-agents-multi-agent-p001-s006` | `concepts/multi-agent` | `Multiple agents = multiple people, multiple personalities`
  Recommendation: `new_category`
  Source: `concepts/multi-agent` :: `L121 Multiple agents = multiple people, multiple personalities`
  Target: `Channel framework` / `Multi-agent routing and account bindings` / `Persona and account isolation`
  Closest existing: `Telegram` / `Group Forum Topic and Session Routing` / `ACP topic binding`
  Why: Multiple agents as separate people or personas is a core multi-agent capability not captured by the Telegram exact-doc match.
- `04-03-agents-multi-agent-p001-s009` | `concepts/multi-agent` | `Routing rules (how messages pick an agent)`
  Recommendation: `new_category`
  Source: `concepts/multi-agent` :: `L210 Routing rules (how messages pick an agent)`
  Target: `Channel framework` / `Multi-agent routing and account bindings` / `Binding precedence and tie-breaking`
  Closest existing: `Telegram` / `Group Forum Topic and Session Routing` / `ACP topic binding`
  Why: Deterministic match order, AND semantics, and default-agent fallback are central multi-agent routing rules with no dedicated taxonomy category.
- `04-03-agents-multi-agent-p001-s010` | `concepts/multi-agent` | `Multiple accounts / phone numbers`
  Recommendation: `new_category`
  Source: `concepts/multi-agent` :: `L256 Multiple accounts / phone numbers`
  Target: `Channel framework` / `Multi-agent routing and account bindings` / `Multi-account channel routing`
  Closest existing: `Telegram` / `Group Forum Topic and Session Routing` / `ACP topic binding`
  Why: Per-account bindings and defaultAccount behavior are multi-agent routing coverage, not Telegram-specific functionality.
- `04-03-agents-multi-agent-p001-s011` | `concepts/multi-agent` | `Concepts`
  Recommendation: `new_category`
  Source: `concepts/multi-agent` :: `L268 Concepts`
  Target: `Channel framework` / `Multi-agent routing and account bindings` / `Agent-account-binding concepts`
  Closest existing: `Telegram` / `Group Forum Topic and Session Routing` / `ACP topic binding`
  Why: Definitions of agentId, accountId, and bindings are core vocabulary for the missing category.
- `04-03-agents-multi-agent-p001-s012` | `concepts/multi-agent` | `Platform examples`
  Recommendation: `new_category`
  Source: `concepts/multi-agent` :: `L275 Platform examples`
  Target: `Channel framework` / `Multi-agent routing and account bindings` / `Cross-channel binding examples`
  Closest existing: `Telegram` / `Group Forum Topic and Session Routing` / `ACP topic binding`
  Why: Discord, Telegram, and WhatsApp examples document generic multi-agent binding patterns across channels.
- `04-03-agents-multi-agent-p001-s013` | `concepts/multi-agent` | `Common patterns`
  Recommendation: `new_category`
  Source: `concepts/multi-agent` :: `L441 Common patterns`
  Target: `Channel framework` / `Multi-agent routing and account bindings` / `Common routing patterns`
  Closest existing: `Telegram` / `Group Forum Topic and Session Routing` / `ACP topic binding`
  Why: Split-by-channel and peer-override patterns are reusable routing capabilities beyond a single provider.
- `04-03-agents-multi-agent-p002-root` | `concepts/parallel-specialist-lanes` | `(page)`
  Recommendation: `new_category`
  Source: `concepts/parallel-specialist-lanes` :: `(page)`
  Target: `Agent runtime and provider execution` / `Parallel specialist lanes` / `Lane contracts and workload ownership`
  Closest existing: `Channel framework` / `Group Thread and Ambient Room Behavior` / `Broadcast groups`
  Why: Page defines lane ownership, shared-capacity contention, and background delegation as an operator-facing pattern; existing taxonomy only covers fragments like subagents and channel routing, not the lane construct itself.
- `04-03-agents-multi-agent-p002-s001` | `concepts/parallel-specialist-lanes` | `First principles`
  Recommendation: `new_category`
  Source: `concepts/parallel-specialist-lanes` :: `L16 First principles`
  Target: `Agent runtime and provider execution` / `Parallel specialist lanes` / `Contention-aware lane design`
  Closest existing: `Nix install path` / `Immutable Config and Agent-first Source Edits` / `Immutable Config and Agent-first Source Edits`
  Why: Section frames session locks, global model capacity, tool capacity, context budget, and ownership ambiguity as one maturity area; no existing category scores this lane-level coordination.
- `04-03-agents-multi-agent-p002-s002` | `concepts/parallel-specialist-lanes` | `Recommended rollout`
  Recommendation: `new_category`
  Source: `concepts/parallel-specialist-lanes` :: `L34 Recommended rollout`
  Target: `Agent runtime and provider execution` / `Parallel specialist lanes` / `Operational rollout for specialist lanes`
  Closest existing: `Channel framework` / `Group Thread and Ambient Room Behavior` / `Broadcast groups`
  Why: Rollout guidance is specific to adopting lane-based multi-agent operation rather than any single existing feature.
- `04-03-agents-multi-agent-p004-root` | `concepts/delegate-architecture` | `(page)`
  Recommendation: `new_category`
  Source: `concepts/delegate-architecture` :: `(page)`
  Target: `Agent runtime and provider execution` / `Delegate agents and organizational identity` / `Delegate architecture`
  Closest existing: `Channel framework` / `Group Thread and Ambient Room Behavior` / `Broadcast groups`
  Why: Page defines a named delegate agent with its own identity, credentials, and authority boundary; current taxonomy has no category for organizational delegate deployment.
- `04-03-agents-multi-agent-p004-s001` | `concepts/delegate-architecture` | `What is a delegate?`
  Recommendation: `new_category`
  Source: `concepts/delegate-architecture` :: `L12 What is a delegate?`
  Target: `Agent runtime and provider execution` / `Delegate agents and organizational identity` / `Named delegate agents`
  Closest existing: `Google Chat` / `Multi Account Secrets Status and Diagnostics` / `Multi Account Secrets Status and Diagnostics`
  Why: A delegate with its own identity and explicit authority is broader than existing subagent or binding coverage.
- `04-03-agents-multi-agent-p004-s002` | `concepts/delegate-architecture` | `Why delegates?`
  Recommendation: `new_category`
  Source: `concepts/delegate-architecture` :: `L23 Why delegates?`
  Target: `Agent runtime and provider execution` / `Delegate agents and organizational identity` / `On-behalf accountability model`
  Closest existing: `Channel framework` / `Group Thread and Ambient Room Behavior` / `Broadcast groups`
  Why: Accountability and scope-control model for delegates is a distinct operator-facing capability cluster not represented today.
- `04-03-agents-multi-agent-p004-s003` | `concepts/delegate-architecture` | `Capability tiers`
  Recommendation: `new_category`
  Source: `concepts/delegate-architecture` :: `L39 Capability tiers`
  Target: `Agent runtime and provider execution` / `Delegate agents and organizational identity` / `Delegate capability tiers`
  Closest existing: `Channel framework` / `Group Thread and Ambient Room Behavior` / `Broadcast groups`
  Why: Tiered delegate modes such as draft, send-on-behalf, and proactive define a structured maturity area absent from current taxonomy.
- `04-03-agents-multi-agent-p004-s012` | `concepts/delegate-architecture` | `Setting up a delegate`
  Recommendation: `new_category`
  Source: `concepts/delegate-architecture` :: `L136 Setting up a delegate`
  Target: `Agent runtime and provider execution` / `Delegate agents and organizational identity` / `Delegate setup flow`
  Closest existing: `Voice and realtime talk` / `Agent Consult, Steering, and Talkback Controls` / `Active Talk agent-run status`
  Why: Overall setup sequence is part of the uncovered delegate deployment area.
- `04-03-agents-multi-agent-p004-s013` | `concepts/delegate-architecture` | `1. Create the delegate agent`
  Recommendation: `new_category`
  Source: `concepts/delegate-architecture` :: `L140 1. Create the delegate agent`
  Target: `Agent runtime and provider execution` / `Delegate agents and organizational identity` / `Delegate agent provisioning`
  Closest existing: `Channel framework` / `Group Thread and Ambient Room Behavior` / `Broadcast groups`
  Why: Creating a dedicated delegate agent and workspace belongs to the missing delegate category, not just generic agent RPC coverage.
- `04-03-agents-multi-agent-p004-s019` | `concepts/delegate-architecture` | `Example: organizational assistant`
  Recommendation: `new_category`
  Source: `concepts/delegate-architecture` :: `L255 Example: organizational assistant`
  Target: `Agent runtime and provider execution` / `Delegate agents and organizational identity` / `Organizational delegate pattern`
  Closest existing: `Channel framework` / `Group Thread and Ambient Room Behavior` / `Broadcast groups`
  Why: End-to-end org-assistant example remains within the missing delegate deployment category.
- `04-03-agents-multi-agent-p004-s020` | `concepts/delegate-architecture` | `Scaling pattern`
  Recommendation: `new_category`
  Source: `concepts/delegate-architecture` :: `L302 Scaling pattern`
  Target: `Agent runtime and provider execution` / `Delegate agents and organizational identity` / `Multi-organization delegate deployment`
  Closest existing: `Channel framework` / `Group Thread and Ambient Room Behavior` / `Broadcast groups`
  Why: Scaling one Gateway across multiple delegate agents is not explicitly covered today.
- `05-02-capabilities-plugins-p004-root` | `plugins/bundles` | `(page)`
  Recommendation: `new_category`
  Source: `plugins/bundles` :: `(page)`
  Target: `Plugin SDK and bundled plugin architecture` / `Compatible bundle detection and capability mapping` / `Bundle capability mapping overview`
  Closest existing: `ClawHub` / `Marketplace and Compatible Bundle Import Support` / `Supported mapped features`
  Why: The page is not just about external marketplace install paths. It defines how Codex, Claude, and Cursor bundles are detected, mapped into OpenClaw-native skills/hooks/MCP/LSP/settings surfaces, and bounded by trust rules. No current plugin SDK category owns that capability area cleanly.
- `05-03-capabilities-bundled-plugin-guides-p004-s001` | `plugins/google-meet` | `Quick start`
  Recommendation: `new_category`
  Source: `plugins/google-meet` :: `L30 Quick start`
  Target: `Google Meet plugin` / `Meeting transport and participation` / `Explicit Google Meet join and create flows`
  Closest existing: `Google provider path` / `Plugin Distribution and Cross-surface Capability Adapters` / `Plugin Distribution and Cross-surface Capability Adapters`
  Why: The Quick start section defines the core operator path for enabling the plugin, preflighting transports, joining a Meet URL, creating rooms, and choosing agent, bidi, or transcribe modes. That is the primary capability slice for a new Google Meet surface.
- `05-03-capabilities-bundled-plugin-guides-p004-s004` | `plugins/google-meet` | `Transports`
  Recommendation: `new_category`
  Source: `plugins/google-meet` :: `L412 Transports`
  Target: `Google Meet plugin` / `Transport backends and audio requirements` / `Chrome and Twilio transport selection`
  Closest existing: `Google provider path` / `Plugin Distribution and Cross-surface Capability Adapters` / `Plugin Distribution and Cross-surface Capability Adapters`
  Why: The transport split between browser participation and Twilio dial-in is a major product boundary for this plugin and should be captured as its own category.
- `05-03-capabilities-bundled-plugin-guides-p004-s007` | `plugins/google-meet` | `OAuth and preflight`
  Recommendation: `new_category`
  Source: `plugins/google-meet` :: `L528 OAuth and preflight`
  Target: `Google Meet plugin` / `OAuth, API operations, and exported artifacts` / `OAuth-backed Meet API operations`
  Closest existing: `Google provider path` / `Plugin Distribution and Cross-surface Capability Adapters` / `Plugin Distribution and Cross-surface Capability Adapters`
  Why: This section introduces the separate OAuth/API side of the plugin: room creation, space resolution, media preflight, artifacts, attendance, and exports. That is a second major capability area beyond browser/twilio participation.
- `05-03-capabilities-bundled-plugin-guides-p004-s011` | `plugins/google-meet` | `Config`
  Recommendation: `new_category`
  Source: `plugins/google-meet` :: `L992 Config`
  Target: `Google Meet plugin` / `Config, tool surface, and participation modes` / `google-meet plugin configuration`
  Closest existing: `Plugin SDK and bundled plugin architecture` / `Packaging plugins` / `Plugin manifest`
  Why: The Config section defines the durable operator knobs for transports, node pinning, guest behavior, OAuth, audio bridge commands, and defaults. That deserves a dedicated category on the new surface.
- `05-03-capabilities-bundled-plugin-guides-p004-s014` | `plugins/google-meet` | `Live test checklist`
  Recommendation: `new_category`
  Source: `plugins/google-meet` :: `L1323 Live test checklist`
  Target: `Google Meet plugin` / `Diagnostics and live validation` / `Live smoke and checklist validation`
  Closest existing: `Google provider path` / `Plugin Distribution and Cross-surface Capability Adapters` / `Plugin Distribution and Cross-surface Capability Adapters`
  Why: The live test checklist introduces the maintained validation contract for browser joins, Twilio joins, OAuth checks, and retained-meeting smoke coverage. That is a separate operational category for the surface.
- `05-03-capabilities-bundled-plugin-guides-p005-s001` | `plugins/workboard` | `Default state`
  Recommendation: `new_category`
  Source: `plugins/workboard` :: `L18 Default state`
  Target: `Workboard plugin` / `Board and card lifecycle` / `Bundled dashboard workboard enablement`
  Closest existing: `Browser automation and exec/sandbox tools` / `Browser Plugin Service and Profiles` / `Browser Plugin Service and Profiles`
  Why: The default-state section defines how the board is enabled, where it appears in the Control UI, and the unavailable state when plugin policy blocks it. That is a primary category for the new surface.
- `05-03-capabilities-bundled-plugin-guides-p005-s004` | `plugins/workboard` | `Agent coordination`
  Recommendation: `new_category`
  Source: `plugins/workboard` :: `L88 Agent coordination`
  Target: `Workboard plugin` / `Agent tools, claims, and dispatch` / `Workboard agent-tool workflow`
  Closest existing: `Plugin SDK and bundled plugin architecture` / `Bundled plugins` / `Bundled channel IDs`
  Why: The large agent-coordination section defines a first-class tool surface for list/read/create/claim/heartbeat/release/complete/block/decompose/notify flows. That is a separate capability family.
- `05-03-capabilities-bundled-plugin-guides-p005-s008` | `plugins/workboard` | `CLI and slash command`
  Recommendation: `new_category`
  Source: `plugins/workboard` :: `L222 CLI and slash command`
  Target: `Workboard plugin` / `Operator UI and CLI workflows` / `CLI and slash-command control`
  Closest existing: `Automation: cron, hooks, tasks, polling` / `Internal Hooks` / `Internal Hooks`
  Why: The CLI and /workboard command surface is a separate operator-facing workflow area for the plugin.
- `05-03-capabilities-bundled-plugin-guides-p005-s013` | `plugins/workboard` | `Troubleshooting`
  Recommendation: `new_category`
  Source: `plugins/workboard` :: `L343 Troubleshooting`
  Target: `Workboard plugin` / `Diagnostics and recovery` / `Workboard troubleshooting`
  Closest existing: `Plugin SDK and bundled plugin architecture` / `Bundled plugins` / `Bundled channel IDs`
  Why: The troubleshooting section defines supported diagnosis and recovery for unavailable tabs, save failures, session mismatch, and stalled dispatch.
- `05-03-capabilities-bundled-plugin-guides-p009-root` | `plugins/memory-wiki` | `(page)`
  Recommendation: `new_category`
  Source: `plugins/memory-wiki` :: `(page)`
  Target: `Session, memory, and context engine` / `Compiled wiki vaults, claims, and dashboards` / `Deterministic wiki knowledge layer`
  Closest existing: `Google provider path` / `Plugin Distribution and Cross-surface Capability Adapters` / `Plugin Distribution and Cross-surface Capability Adapters`
  Why: docs/plugins/memory-wiki.md describes a durable compiled knowledge-vault layer with its own page model, claims/evidence structure, digests, tools, bridge mode, and dashboards. Current memory taxonomy covers active memory and embedding backends, but it does not own this wiki layer.
- `05-03-capabilities-bundled-plugin-guides-p009-s004` | `plugins/memory-wiki` | `Vault modes`
  Recommendation: `new_category`
  Source: `plugins/memory-wiki` :: `L74 Vault modes`
  Target: `Session, memory, and context engine` / `Vault modes and bridge ingestion` / `Isolated, bridge, and unsafe-local modes`
  Closest existing: `Google provider path` / `Plugin Distribution and Cross-surface Capability Adapters` / `Plugin Distribution and Cross-surface Capability Adapters`
  Why: Vault mode selection and bridge ingestion are a separate capability family from the compiled page model itself.
- `05-03-capabilities-bundled-plugin-guides-p009-s009` | `plugins/memory-wiki` | `Structured claims and evidence`
  Recommendation: `new_category`
  Source: `plugins/memory-wiki` :: `L138 Structured claims and evidence`
  Target: `Session, memory, and context engine` / `Claims, evidence, and provenance` / `Structured claim metadata`
  Closest existing: `Web search tools` / `Bundled Structured Search Providers` / `Bundled Structured Search Providers`
  Why: Structured claims with evidence, contradictions, and privacy metadata are a major missing category in the current memory taxonomy.
- `05-03-capabilities-bundled-plugin-guides-p009-s011` | `plugins/memory-wiki` | `Compile pipeline`
  Recommendation: `new_category`
  Source: `plugins/memory-wiki` :: `L237 Compile pipeline`
  Target: `Session, memory, and context engine` / `Compile pipeline and agent digests` / `Compiled digests and cache outputs`
  Closest existing: `Google provider path` / `Plugin Distribution and Cross-surface Capability Adapters` / `Plugin Distribution and Cross-surface Capability Adapters`
  Why: The compile pipeline and stable machine-facing artifacts (agent-digest.json, claims.jsonl) are a distinct capability family.
- `05-03-capabilities-bundled-plugin-guides-p009-s013` | `plugins/memory-wiki` | `Search and retrieval`
  Recommendation: `new_category`
  Source: `plugins/memory-wiki` :: `L285 Search and retrieval`
  Target: `Session, memory, and context engine` / `Wiki search and retrieval` / `Wiki search backends and corpora`
  Closest existing: `Google provider path` / `Plugin Distribution and Cross-surface Capability Adapters` / `Plugin Distribution and Cross-surface Capability Adapters`
  Why: Wiki-specific search backends, corpora, ranking modes, and claim-aware result metadata are not owned by current memory categories.
- `05-03-capabilities-bundled-plugin-guides-p009-s016` | `plugins/memory-wiki` | `Configuration`
  Recommendation: `new_category`
  Source: `plugins/memory-wiki` :: `L369 Configuration`
  Target: `Session, memory, and context engine` / `Configuration and editor integration` / `memory-wiki plugin configuration`
  Closest existing: `Google provider path` / `Plugin Distribution and Cross-surface Capability Adapters` / `Plugin Distribution and Cross-surface Capability Adapters`
  Why: The plugin's config surface—vault path/render mode, bridge/import behavior, search backend, context toggles, and render options—needs its own category.
- `05-03-capabilities-bundled-plugin-guides-p011-root` | `plugins/oc-path` | `(page)`
  Recommendation: `new_category`
  Source: `plugins/oc-path` :: `(page)`
  Target: `CLI` / `Workspace path addressing and leaf edits` / `openclaw path CLI and oc:// addresses`
  Closest existing: `Plugin SDK and bundled plugin architecture` / `Bundled plugins` / `Bundled channel IDs`
  Why: docs/plugins/oc-path.md adds a distinct CLI substrate for oc:// addressing, leaf-level reads/writes, and byte-preserving edits across Markdown/JSONC/JSONL/YAML. The current CLI taxonomy covers setup, onboarding, doctor, and updates, but not workspace path editing.
- `05-04-capabilities-building-plugins-p005-root` | `plugins/cli-backend-plugins` | `(page)`
  Recommendation: `new_category`
  Source: `plugins/cli-backend-plugins` :: `(page)`
  Target: `Plugin SDK and bundled plugin architecture` / `CLI backend plugins` / `CLI backend plugin overview`
  Closest existing: `Anthropic provider path` / `Claude CLI Runtime and Session Bridge` / `Claude CLI Runtime and Session Bridge`
  Why: The page is a dedicated authoring guide for local AI CLI backend plugins. Current taxonomy mentions runtime CLI backends under the Anthropic provider path and generic packaging/provider plugin categories, but it does not model the Plugin SDK capability of authoring, registering, and shipping CLI backend plugins as its own category.
- `05-06-capabilities-automation-p005-root` | `automation/standing-orders` | `(page)`
  Recommendation: `new_category`
  Source: `automation/standing-orders` :: `(page)`
  Target: `Automation: cron, hooks, tasks, polling` / `Standing Orders` / `Standing Orders`
  Closest existing: `Automation: cron, hooks, tasks, polling` / `Message Polls and Process Polling` / `Message Polls and Process Polling`
  Why: `docs/automation/index.md` already lists Standing Orders as a first-class automation mechanism, but the automation surface has no Standing Orders category yet. Add a category here instead of forcing this page into polling, cron, or heartbeat coverage.
- `05-07-capabilities-tools-p001-root` | `tools/apply-patch` | `(page)`
  Recommendation: `new_category`
  Source: `tools/apply-patch` :: `(page)`
  Target: `Browser automation and exec/sandbox tools` / `Patch Editing and Diff Artifacts` / `Patch Editing and Diff Artifacts`
  Closest existing: `Browser automation and exec/sandbox tools` / `Direct Tool Invoke API and Node System.run` / `Direct Tool Invoke API and Node System.run`
  Why: Structured patch-based file editing and diff-artifact tooling are not represented by any existing browser/exec/sandbox category.
- `05-07-capabilities-tools-p002-root` | `tools/btw` | `(page)`
  Recommendation: `new_category`
  Source: `tools/btw` :: `(page)`
  Target: `Session, memory, and context engine` / `Ephemeral Side Questions and Side Results` / `Ephemeral Side Questions and Side Results`
  Closest existing: `Security, auth, pairing, and secrets` / `Plugin Installation Trust and Security Boundaries` / `Plugin Installation Trust and Security Boundaries`
  Why: Ephemeral side questions and non-persistent side-result delivery are not represented in the current session taxonomy.
- `05-07-capabilities-tools-p003-root` | `tools/code-execution` | `(page)`
  Recommendation: `new_category`
  Source: `tools/code-execution` :: `(page)`
  Target: `Browser automation and exec/sandbox tools` / `Remote Code Execution and Analysis` / `Remote Code Execution and Analysis`
  Closest existing: `Linux companion app` / `Node-host Capabilities, Desktop Tools, and Exec Approvals` / `Desktop tools`
  Why: Provider-backed remote Python analysis is distinct from local exec/system.run and is not modeled in the current execution-tool taxonomy.
- `10-01-reference-cli-commands-p002-root` | `cli/backup` | `(page)`
  Recommendation: `new_category`
  Source: `cli/backup` :: `(page)`
  Target: `CLI` / `Backup, Reset, and Uninstall` / `Backup, Reset, and Uninstall`
  Closest existing: `CLI` / `CLI Setup` / `CLI entrypoint`
  Why: Current taxonomy lacks a dedicated category for Backup, Reset, and Uninstall.
- `10-01-reference-cli-commands-p009-root` | `cli/migrate` | `(page)`
  Recommendation: `new_category`
  Source: `cli/migrate` :: `(page)`
  Target: `Session, memory, and context engine` / `Cross-system Session and State Migration` / `Cross-system Session and State Migration`
  Closest existing: `CLI` / `CLI Setup` / `CLI entrypoint`
  Why: Current taxonomy lacks a dedicated category for Cross-system Session and State Migration.
- `10-01-reference-cli-commands-p013-root` | `cli/security` | `(page)`
  Recommendation: `new_category`
  Source: `cli/security` :: `(page)`
  Target: `Security, auth, pairing, and secrets` / `Security Audit and Remediation` / `Security Audit and Remediation`
  Closest existing: `CLI` / `CLI Setup` / `CLI entrypoint`
  Why: Current taxonomy lacks a dedicated category for Security Audit and Remediation.
- `10-01-reference-cli-commands-p019-root` | `cli/agents` | `(page)`
  Recommendation: `new_category`
  Source: `cli/agents` :: `(page)`
  Target: `Agent runtime and provider execution` / `Agent Definitions, Workspaces, and Identity` / `Agent Definitions, Workspaces, and Identity`
  Closest existing: `CLI` / `CLI Setup` / `CLI entrypoint`
  Why: Current taxonomy lacks a dedicated category for Agent Definitions, Workspaces, and Identity.
- `10-01-reference-cli-commands-p031-root` | `cli/directory` | `(page)`
  Recommendation: `new_category`
  Source: `cli/directory` :: `(page)`
  Target: `Channel framework` / `Directory Lookup and Target Discovery` / `Directory Lookup and Target Discovery`
  Closest existing: `CLI` / `CLI Setup` / `CLI entrypoint`
  Why: Current taxonomy lacks a dedicated category for Directory Lookup and Target Discovery.
- `10-01-reference-cli-commands-p046-root` | `cli/path` | `(page)`
  Recommendation: `new_category`
  Source: `cli/path` :: `(page)`
  Target: `Browser automation and exec/sandbox tools` / `Workspace Path Addressing and Surgical File Mutation` / `Workspace Path Addressing and Surgical File Mutation`
  Closest existing: `Session, memory, and context engine` / `CLI Session and Transcript Management` / `CLI Session and Transcript Management`
  Why: Current taxonomy lacks a dedicated category for Workspace Path Addressing and Surgical File Mutation.
- `10-01-reference-cli-commands-p047-root` | `cli/policy` | `(page)`
  Recommendation: `new_category`
  Source: `cli/policy` :: `(page)`
  Target: `Security, auth, pairing, and secrets` / `Workspace Policy Conformance and Attestation` / `Workspace Policy Conformance and Attestation`
  Closest existing: `CLI` / `CLI Setup` / `CLI entrypoint`
  Why: Current taxonomy lacks a dedicated category for Workspace Policy Conformance and Attestation.
- `10-01-reference-cli-commands-p052-root` | `cli/acp` | `(page)`
  Recommendation: `new_category`
  Source: `cli/acp` :: `(page)`
  Target: `Agent runtime and provider execution` / `ACP Bridge and IDE Session Mapping` / `ACP Bridge and IDE Session Mapping`
  Closest existing: `CLI` / `CLI Setup` / `CLI entrypoint`
  Why: Current taxonomy lacks a dedicated category for ACP Bridge and IDE Session Mapping.
- `10-01-reference-cli-commands-p058-root` | `cli/proxy` | `(page)`
  Recommendation: `new_category`
  Source: `cli/proxy` :: `(page)`
  Target: `Security, auth, pairing, and secrets` / `Network Proxy Validation and Debug Capture` / `Network Proxy Validation and Debug Capture`
  Closest existing: `CLI` / `CLI Setup` / `CLI entrypoint`
  Why: Current taxonomy lacks a dedicated category for Network Proxy Validation and Debug Capture.
- `10-01-reference-cli-commands-p059-root` | `cli/wiki` | `(page)`
  Recommendation: `new_category`
  Source: `cli/wiki` :: `(page)`
  Target: `Session, memory, and context engine` / `Memory Wiki Vault and Provenance Workflows` / `Memory Wiki Vault and Provenance Workflows`
  Closest existing: `CLI` / `CLI Setup` / `CLI entrypoint`
  Why: Current taxonomy lacks a dedicated category for Memory Wiki Vault and Provenance Workflows.
- `10-02-reference-rpc-and-api-p004-root` | `reference/code-mode` | `(page)`
  Recommendation: `new_category`
  Source: `reference/code-mode` :: `(page)`
  Target: `Agent runtime and provider execution` / `Code mode orchestration and runtime` / `Code mode surface`
  Closest existing: `CLI` / `CLI Observability` / `Remote log tailing`
  Why: Code mode is documented as an experimental agent-runtime feature with its own model-visible control surface, but the current Agent runtime taxonomy has no category for code-mode orchestration.
- `10-02-reference-rpc-and-api-p004-s001` | `reference/code-mode` | `What is this?`
  Recommendation: `new_category`
  Source: `reference/code-mode` :: `L33 What is this?`
  Target: `Agent runtime and provider execution` / `Code mode orchestration and runtime` / `What code mode is`
  Closest existing: `Nix install path` / `Nix Mode Activation and Runtime Detection` / `Nix Mode Activation and Runtime Detection`
  Why: This section defines the core code-mode behavior: replacing broad tool exposure with `exec` and `wait`, backed by a hidden catalog and guest runtime.
- `10-02-reference-rpc-and-api-p004-s002` | `reference/code-mode` | `Why is this good?`
  Recommendation: `new_category`
  Source: `reference/code-mode` :: `L56 Why is this good?`
  Target: `Agent runtime and provider execution` / `Code mode orchestration and runtime` / `Why code mode`
  Closest existing: `Nix install path` / `Nix Mode Activation and Runtime Detection` / `Nix Mode Activation and Runtime Detection`
  Why: The operator-facing rationale for smaller prompt surfaces, orchestration loops, and fail-closed behavior is specific to code mode and not covered by existing categories.
- `10-02-reference-rpc-and-api-p004-s003` | `reference/code-mode` | `How to enable it`
  Recommendation: `new_category`
  Source: `reference/code-mode` :: `L76 How to enable it`
  Target: `Agent runtime and provider execution` / `Code mode orchestration and runtime` / `Activation and enablement`
  Closest existing: `macOS companion app` / `Voice Wake, Push-to-talk, and Talk Mode` / `Push-to-talk`
  Why: Configuring `tools.codeMode.enabled` and runtime limits is code-mode-specific activation behavior missing from taxonomy.
- `10-02-reference-rpc-and-api-p004-s004` | `reference/code-mode` | `Technical tour`
  Recommendation: `new_category`
  Source: `reference/code-mode` :: `L137 Technical tour`
  Target: `Agent runtime and provider execution` / `Code mode orchestration and runtime` / `Technical tour`
  Closest existing: `CLI` / `CLI Observability` / `Remote log tailing`
  Why: The maintainers’ technical overview is part of the missing code-mode category rather than an existing generic tool-execution entry.
- `10-02-reference-rpc-and-api-p004-s005` | `reference/code-mode` | `Runtime status`
  Recommendation: `new_category`
  Source: `reference/code-mode` :: `L143 Runtime status`
  Target: `Agent runtime and provider execution` / `Code mode orchestration and runtime` / `Runtime status`
  Closest existing: `Slack` / `Socket/http Transport and Runtime Lifecycle` / `Socket/http Transport and Runtime Lifecycle`
  Why: Default-off experimental status and user-facing stability promise are code-mode-specific readiness signals not represented today.
- `10-02-reference-rpc-and-api-p004-s006` | `reference/code-mode` | `Scope`
  Recommendation: `new_category`
  Source: `reference/code-mode` :: `L154 Scope`
  Target: `Agent runtime and provider execution` / `Code mode orchestration and runtime` / `Scope boundaries`
  Closest existing: `Linux companion app` / `Gateway Connection, Pairing, Local Mode, and Remote Mode` / `Adjacent out-of-scope surfaces`
  Why: The explicit in-scope and out-of-scope boundaries for code mode are part of the missing category definition.
- `10-02-reference-rpc-and-api-p004-s007` | `reference/code-mode` | `Terms`
  Recommendation: `new_category`
  Source: `reference/code-mode` :: `L183 Terms`
  Target: `Agent runtime and provider execution` / `Code mode orchestration and runtime` / `Code mode terminology`
  Closest existing: `CLI` / `CLI Observability` / `Remote log tailing`
  Why: Terms such as guest runtime, host bridge, catalog, nested tool call, and snapshot are specific to code mode.
- `10-02-reference-rpc-and-api-p004-s008` | `reference/code-mode` | `Configuration`
  Recommendation: `new_category`
  Source: `reference/code-mode` :: `L201 Configuration`
  Target: `Agent runtime and provider execution` / `Code mode orchestration and runtime` / `Configuration`
  Closest existing: `macOS Gateway host` / `Local Gateway Mode and Host Configuration` / `gateway.mode=local configuration`
  Why: Supported fields, defaults, and runtime clamps are code-mode configuration semantics absent from current taxonomy.
- `10-02-reference-rpc-and-api-p004-s009` | `reference/code-mode` | `Activation`
  Recommendation: `new_category`
  Source: `reference/code-mode` :: `L233 Activation`
  Target: `Agent runtime and provider execution` / `Code mode orchestration and runtime` / `Activation lifecycle`
  Closest existing: `Nix install path` / `Nix Mode Activation and Runtime Detection` / `Nix Mode Activation and Runtime Detection`
  Why: The activation order after policy resolution and before model request assembly is unique to code mode.
- `10-02-reference-rpc-and-api-p004-s010` | `reference/code-mode` | `Model-visible tools`
  Recommendation: `new_category`
  Source: `reference/code-mode` :: `L257 Model-visible tools`
  Target: `Agent runtime and provider execution` / `Code mode orchestration and runtime` / `Model-visible tools`
  Closest existing: `Image/video/music generation tools` / `Configuration, Model Refs, and Provider Discovery` / `Configuration, Model Refs, and Provider Discovery`
  Why: Exposing exactly `exec` and `wait` as the model-facing tool surface is the defining missing capability.
- `10-02-reference-rpc-and-api-p004-s011` | `reference/code-mode` | `exec`
  Recommendation: `new_category`
  Source: `reference/code-mode` :: `L271 `exec``Target:`Agent runtime and provider execution`/`Code mode orchestration and runtime`/`exec contract`Closest existing:`Browser automation and exec/sandbox tools`/`Host Exec Approvals and Elevated Mode`/`Host Exec Approvals and Elevated Mode`Why: The hostile-code`exec` contract, accepted inputs, output unions, and suspension behavior are not covered by existing exec-tool or sandbox categories.
- `10-02-reference-rpc-and-api-p004-s012` | `reference/code-mode` | `wait`
  Recommendation: `new_category`
  Source: `reference/code-mode` :: `L338 `wait``Target:`Agent runtime and provider execution`/`Code mode orchestration and runtime`/`wait contract`Closest existing:`CLI`/`CLI Observability`/`Remote log tailing`Why: Snapshot restore, same-run scoping, and resumed completion semantics are specific to the code-mode`wait` tool.
- `10-02-reference-rpc-and-api-p004-s013` | `reference/code-mode` | `Guest runtime API`
  Recommendation: `new_category`
  Source: `reference/code-mode` :: `L379 Guest runtime API`
  Target: `Agent runtime and provider execution` / `Code mode orchestration and runtime` / `Guest runtime API`
  Closest existing: `Nix install path` / `Nix Mode Activation and Runtime Detection` / `Nix Mode Activation and Runtime Detection`
  Why: `ALL_TOOLS`, `tools`, `MCP`, `namespaces`, `text`, `json`, and `yield_control` define a missing guest-runtime capability area.
- `10-02-reference-rpc-and-api-p004-s014` | `reference/code-mode` | `Internal namespaces`
  Recommendation: `new_category`
  Source: `reference/code-mode` :: `L456 Internal namespaces`
  Target: `Agent runtime and provider execution` / `Code mode orchestration and runtime` / `Internal namespaces`
  Closest existing: `CLI` / `CLI Observability` / `Remote log tailing`
  Why: Loader-owned internal namespaces for concise domain APIs are code-mode-specific behavior.
- `10-02-reference-rpc-and-api-p004-s015` | `reference/code-mode` | `Registry lifecycle`
  Recommendation: `new_category`
  Source: `reference/code-mode` :: `L478 Registry lifecycle`
  Target: `Agent runtime and provider execution` / `Code mode orchestration and runtime` / `Namespace registry lifecycle`
  Closest existing: `Nix install path` / `Plugin Lifecycle and Nix-store Plugin Loading` / `Plugin Lifecycle and Nix-store Plugin Loading`
  Why: Process-local registration, visibility filtering, and resume behavior are part of the missing code-mode namespace contract.
- `10-02-reference-rpc-and-api-p004-s016` | `reference/code-mode` | `Registration shape`
  Recommendation: `new_category`
  Source: `reference/code-mode` :: `L505 Registration shape`
  Target: `Agent runtime and provider execution` / `Code mode orchestration and runtime` / `Namespace registration shape`
  Closest existing: `Browser automation and exec/sandbox tools` / `Host Exec Approvals and Elevated Mode` / `Host Exec Approvals and Elevated Mode`
  Why: Registration objects, required tool names, and input mappers are specific to code-mode namespaces.
- `10-02-reference-rpc-and-api-p004-s017` | `reference/code-mode` | `Ownership and visibility`
  Recommendation: `new_category`
  Source: `reference/code-mode` :: `L549 Ownership and visibility`
  Target: `Agent runtime and provider execution` / `Code mode orchestration and runtime` / `Namespace ownership and visibility`
  Closest existing: `CLI` / `CLI Observability` / `Remote log tailing`
  Why: Plugin ownership, source-name checks, and visibility gates are code-mode namespace rules not captured elsewhere.
- `10-02-reference-rpc-and-api-p004-s018` | `reference/code-mode` | `Scope serialization rules`
  Recommendation: `new_category`
  Source: `reference/code-mode` :: `L569 Scope serialization rules`
  Target: `Agent runtime and provider execution` / `Code mode orchestration and runtime` / `Scope serialization rules`
  Closest existing: `Linux companion app` / `Gateway Connection, Pairing, Local Mode, and Remote Mode` / `Adjacent out-of-scope surfaces`
  Why: JSON-safe scope serialization and forbidden keys are missing code-mode-specific safety rules.
- `10-02-reference-rpc-and-api-p004-s019` | `reference/code-mode` | `Prompts`
  Recommendation: `new_category`
  Source: `reference/code-mode` :: `L589 Prompts`
  Target: `Agent runtime and provider execution` / `Code mode orchestration and runtime` / `Namespace prompts`
  Closest existing: `Automation: cron, hooks, tasks, polling` / `Heartbeat and Commitments` / `Heartbeat and Commitments`
  Why: Prompt text for visible namespaces is part of the missing code-mode category.
- `10-02-reference-rpc-and-api-p004-s020` | `reference/code-mode` | `Cleanup`
  Recommendation: `new_category`
  Source: `reference/code-mode` :: `L606 Cleanup`
  Target: `Agent runtime and provider execution` / `Code mode orchestration and runtime` / `Namespace cleanup`
  Closest existing: `Automation: cron, hooks, tasks, polling` / `Channel Polling and Webhook Monitors` / `Channel Polling and Webhook Monitors`
  Why: Registration cleanup on disable, uninstall, rollback, and tests is code-mode-specific runtime hygiene.
- `10-02-reference-rpc-and-api-p004-s021` | `reference/code-mode` | `Test checklist`
  Recommendation: `new_category`
  Source: `reference/code-mode` :: `L619 Test checklist`
  Target: `Agent runtime and provider execution` / `Code mode orchestration and runtime` / `Namespace test checklist`
  Closest existing: `CLI` / `CLI Observability` / `Remote log tailing`
  Why: Security and suspend/resume coverage for namespaces belongs in the proposed code-mode category.
- `10-02-reference-rpc-and-api-p004-s022` | `reference/code-mode` | `Output API`
  Recommendation: `new_category`
  Source: `reference/code-mode` :: `L639 Output API`
  Target: `Agent runtime and provider execution` / `Code mode orchestration and runtime` / `Output API`
  Closest existing: `CLI` / `CLI Observability` / `Remote log tailing`
  Why: `text()` and `json()` output semantics are specific to the code-mode guest contract.
- `10-02-reference-rpc-and-api-p004-s023` | `reference/code-mode` | `Tool catalog`
  Recommendation: `new_category`
  Source: `reference/code-mode` :: `L663 Tool catalog`
  Target: `Agent runtime and provider execution` / `Code mode orchestration and runtime` / `Hidden tool catalog`
  Closest existing: `Voice Call channel` / `CLI, Gateway RPC, and Agent Tool` / `Voice Call Channel`
  Why: Run-scoped hidden catalog composition and stable ids are core code-mode capabilities missing from taxonomy.
- `10-02-reference-rpc-and-api-p004-s024` | `reference/code-mode` | `Tool Search interaction`
  Recommendation: `new_category`
  Source: `reference/code-mode` :: `L708 Tool Search interaction`
  Target: `Agent runtime and provider execution` / `Code mode orchestration and runtime` / `Tool Search interaction`
  Closest existing: `Voice Call channel` / `CLI, Gateway RPC, and Agent Tool` / `Voice Call Channel`
  Why: How code mode supersedes model-visible Tool Search while reusing internal catalog ideas is a missing code-mode behavior.
- `10-02-reference-rpc-and-api-p004-s025` | `reference/code-mode` | `Tool names and collisions`
  Recommendation: `new_category`
  Source: `reference/code-mode` :: `L728 Tool names and collisions`
  Target: `Agent runtime and provider execution` / `Code mode orchestration and runtime` / `Tool name collision handling`
  Closest existing: `Voice Call channel` / `CLI, Gateway RPC, and Agent Tool` / `Voice Call Channel`
  Why: Name collision handling between code-mode control tools and cataloged tools is not represented in existing taxonomy.
- `10-02-reference-rpc-and-api-p004-s026` | `reference/code-mode` | `Nested tool execution`
  Recommendation: `new_category`
  Source: `reference/code-mode` :: `L745 Nested tool execution`
  Target: `Agent runtime and provider execution` / `Code mode orchestration and runtime` / `Nested tool execution`
  Closest existing: `Automation: cron, hooks, tasks, polling` / `Cron Job Lifecycle` / `Cron Job Lifecycle`
  Why: Preserving agent/session context, approvals, hooks, telemetry, and transcript projection across nested guest calls is code-mode-specific.
- `10-02-reference-rpc-and-api-p004-s027` | `reference/code-mode` | `Runtime state`
  Recommendation: `new_category`
  Source: `reference/code-mode` :: `L767 Runtime state`
  Target: `Agent runtime and provider execution` / `Code mode orchestration and runtime` / `Runtime state`
  Closest existing: `Nix install path` / `Nix Mode Activation and Runtime Detection` / `Nix Mode Activation and Runtime Detection`
  Why: Running/waiting/completed/failed/expired/aborted state management is part of the missing category.
- `10-02-reference-rpc-and-api-p004-s028` | `reference/code-mode` | `QuickJS-WASI runtime`
  Recommendation: `new_category`
  Source: `reference/code-mode` :: `L789 QuickJS-WASI runtime`
  Target: `Agent runtime and provider execution` / `Code mode orchestration and runtime` / `QuickJS-WASI runtime`
  Closest existing: `Nix install path` / `Nix Mode Activation and Runtime Detection` / `Nix Mode Activation and Runtime Detection`
  Why: QuickJS-WASI loading, snapshotting, restoring, and worker isolation are code-mode runtime implementation capabilities.
- `10-02-reference-rpc-and-api-p004-s029` | `reference/code-mode` | `TypeScript`
  Recommendation: `new_category`
  Source: `reference/code-mode` :: `L810 TypeScript`
  Target: `Agent runtime and provider execution` / `Code mode orchestration and runtime` / `TypeScript transform`
  Closest existing: `CLI` / `CLI Observability` / `Remote log tailing`
  Why: Source-transform-only TypeScript support with no module resolution is code-mode-specific behavior.
- `10-02-reference-rpc-and-api-p004-s030` | `reference/code-mode` | `Security boundary`
  Recommendation: `new_category`
  Source: `reference/code-mode` :: `L826 Security boundary`
  Target: `Agent runtime and provider execution` / `Code mode orchestration and runtime` / `Security boundary`
  Closest existing: `Anthropic provider path` / `Prompt Caching, Context Windows, and Request Knobs` / `Prompt Caching, Context Windows, and Request Knobs`
  Why: The hostile-code defense-in-depth model for code mode is broader than existing generic sandbox or approval categories.
- `10-02-reference-rpc-and-api-p004-s031` | `reference/code-mode` | `Error codes`
  Recommendation: `new_category`
  Source: `reference/code-mode` :: `L847 Error codes`
  Target: `Agent runtime and provider execution` / `Code mode orchestration and runtime` / `Error codes`
  Closest existing: `Android app` / `Gateway Pairing, Discovery, and Security` / `Gateway discovery`
  Why: The dedicated `CodeModeErrorCode` taxonomy is specific to this missing category.
- `10-02-reference-rpc-and-api-p004-s032` | `reference/code-mode` | `Telemetry`
  Recommendation: `new_category`
  Source: `reference/code-mode` :: `L872 Telemetry`
  Target: `Agent runtime and provider execution` / `Code mode orchestration and runtime` / `Telemetry`
  Closest existing: `Gateway Web App` / `Diagnostics, Logs, Update, and Activity` / `Diagnostics, Logs, Update, and Activity`
  Why: Code-mode-specific counts, catalog breakdowns, and cap-failure telemetry are not modeled today.
- `10-02-reference-rpc-and-api-p004-s033` | `reference/code-mode` | `Debugging`
  Recommendation: `new_category`
  Source: `reference/code-mode` :: `L887 Debugging`
  Target: `Agent runtime and provider execution` / `Code mode orchestration and runtime` / `Debugging`
  Closest existing: `CLI` / `CLI Observability` / `Remote log tailing`
  Why: Dedicated debug flags and fail-closed payload checks are code-mode-specific operator guidance.
- `10-02-reference-rpc-and-api-p004-s034` | `reference/code-mode` | `Implementation layout`
  Recommendation: `new_category`
  Source: `reference/code-mode` :: `L909 Implementation layout`
  Target: `Agent runtime and provider execution` / `Code mode orchestration and runtime` / `Implementation layout`
  Closest existing: `CLI` / `CLI Observability` / `Remote log tailing`
  Why: The documented implementation units define the missing category’s maintainers’ architecture surface.
- `10-02-reference-rpc-and-api-p004-s035` | `reference/code-mode` | `Validation checklist`
  Recommendation: `new_category`
  Source: `reference/code-mode` :: `L927 Validation checklist`
  Target: `Agent runtime and provider execution` / `Code mode orchestration and runtime` / `Validation checklist`
  Closest existing: `Anthropic provider path` / `Claude CLI Runtime and Session Bridge` / `Claude CLI Runtime and Session Bridge`
  Why: Coverage expectations for activation, catalog behavior, sandboxing, resume, and transcript projection are specific to code mode.
- `10-02-reference-rpc-and-api-p004-s036` | `reference/code-mode` | `E2E test plan`
  Recommendation: `new_category`
  Source: `reference/code-mode` :: `L958 E2E test plan`
  Target: `Agent runtime and provider execution` / `Code mode orchestration and runtime` / `E2E test plan`
  Closest existing: `Android app` / `Voice, Talk Mode, and Wake` / `Voice tab`
  Why: The end-to-end validation plan is specific to code-mode runtime behavior.
- `10-02-reference-rpc-and-api-p004-s037` | `reference/code-mode` | `Related`
  Recommendation: `new_category`
  Source: `reference/code-mode` :: `L983 Related`
  Target: `Agent runtime and provider execution` / `Code mode orchestration and runtime` / `Related references`
  Closest existing: `CLI` / `CLI Observability` / `Remote log tailing`
  Why: The related links support the same missing code-mode category rather than mapping cleanly to an existing one.
- `10-05-reference-plugin-sdk-reference-p005-root` | `plugins/sdk-agent-harness` | `(page)`
  Recommendation: `new_category`
  Source: `plugins/sdk-agent-harness` :: `(page)`
  Target: `Plugin SDK and bundled plugin architecture` / `Agent harness plugins` / `Agent harness plugin architecture overview`
  Closest existing: `Plugin SDK and bundled plugin architecture` / `Authoring plugins` / `Entrypoint discovery`
  Why: The best candidate points at generic authoring entrypoint discovery, but this page defines a missing capability area for embedded agent harness plugins.
- `11-01-help-start-here-p003-root` | `help/debugging` | `(page)`
  Recommendation: `new_category`
  Source: `help/debugging` :: `(page)`
  Target: `Observability` / `Developer debugging, tracing, and profiling workflows` / `Developer debugging, tracing, and profiling overview`
  Closest existing: `Automation: cron, hooks, tasks, polling` / `Gmail Pubsub Watchers` / `Gmail Pubsub Watchers`
  Why: The page documents a coherent operator/developer debugging surface including runtime debug toggles, per-session trace controls, plugin lifecycle timing, CLI and gateway profiling, raw-stream capture, and IDE/source-map debugging. Current observability taxonomy covers doctor, health, logs, metrics, and exports, but not these local debug workflows.

## Recommend new feature

- `01-03-get-started-guides-p001-root` | `start/openclaw` | `(page)`
  Recommendation: `new_feature`
  Source: `start/openclaw` :: `(page)`
  Target: `CLI` / `Onboarding and Auth Setup` / `Personal assistant setup`
  Closest existing: `Linux companion app` / `Diagnostics, Health, and Operator Repair` / `Adjacent out-of-scope surfaces`
  Why: The exact auto-accept to `Linux companion app / Diagnostics, Health, and Operator Repair` is obviously wrong. `start/openclaw` is a broad personal-assistant setup guide covering gateway startup, workspace/bootstrap files, assistant defaults, sessions/memory, heartbeats, media handling, and ops checks; it is not primarily Linux companion-app diagnostics. Because the page path was used as a secondary docs reference there, the page should not have been bulk auto-accepted to that category.
- `01-03-get-started-guides-p003-root` | `start/wizard-cli-automation` | `(page)`
  Recommendation: `new_feature`
  Source: `start/wizard-cli-automation` :: `(page)`
  Target: `CLI` / `Onboarding and Auth Setup` / `Non-interactive onboarding automation`
  Closest existing: `CLI` / `Gateway Service Management` / `Service install and control`
  Why: The page is a dedicated guide to scripting `openclaw onboard` with `--non-interactive`, `--json`, ref-mode secrets, bootstrap/skills skips, and CI-friendly behavior. Existing CLI onboarding features cover guided setup and auth choices, but not automation as its own operator-facing capability.
- `01-03-get-started-guides-p003-s001` | `start/wizard-cli-automation` | `Baseline non-interactive example`
  Recommendation: `new_feature`
  Source: `start/wizard-cli-automation` :: `L16 Baseline non-interactive example`
  Target: `CLI` / `Onboarding and Auth Setup` / `Non-interactive onboarding automation`
  Closest existing: `CLI` / `Doctor` / `Interactive repair`
  Why: The baseline example is the canonical scripted onboarding recipe, including gateway mode/bind/auth choices, daemon install, and bootstrap suppression. That is stronger and more specific than the current `Guided onboarding` feature and warrants explicit coverage.
- `01-03-get-started-guides-p003-s003` | `start/wizard-cli-automation` | `Add another agent`
  Recommendation: `new_feature`
  Source: `start/wizard-cli-automation` :: `L202 Add another agent`
  Target: `CLI` / `Onboarding and Auth Setup` / `Additional agent creation and binding`
  Closest existing: `Voice Call channel` / `CLI, Gateway RPC, and Agent Tool` / `Voice Call Channel`
  Why: This section documents `openclaw agents add`, per-agent workspace and `agentDir` setup, model selection, and non-interactive `--bind` routing. The current CLI onboarding/setup taxonomy does not explicitly cover provisioning additional agents after first run.
- `02-02-install-maintenance-p002-s001` | `install/migrating` | `Import from another agent system`
  Recommendation: `new_feature`
  Source: `install/migrating` :: `L12 Import from another agent system`
  Target: `CLI` / `Migration and State Transfer` / `Cross-system import providers`
  Closest existing: `CLI` / `CLI Setup` / `Local prefix install`
  Why: This section documents importing from other agent systems through onboarding or `openclaw migrate`, which is a user-invokable migration capability not represented in current CLI categories.
- `02-02-install-maintenance-p002-s002` | `install/migrating` | `Move OpenClaw to a new machine`
  Recommendation: `new_feature`
  Source: `install/migrating` :: `L27 Move OpenClaw to a new machine`
  Target: `CLI` / `Migration and State Transfer` / `Machine-to-machine state migration`
  Closest existing: `Nix install path` / `Public Nix Docs and Nix-openclaw Handoff` / `Public Nix Docs and Nix-openclaw Handoff`
  Why: Copying the OpenClaw state directory and workspace to a new machine, preserving profiles, credentials, sessions, and channel state is not modeled in the current taxonomy.
- `02-02-install-maintenance-p003-root` | `install/migrating-claude` | `(page)`
  Recommendation: `new_feature`
  Source: `install/migrating-claude` :: `(page)`
  Target: `CLI` / `Migration and State Transfer` / `Claude provider import`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: The page documents a concrete `openclaw migrate claude` capability, including onboarding and CLI entrypoints, that is not represented in current CLI taxonomy.
- `02-02-install-maintenance-p003-s007` | `install/migrating-claude` | `JSON output for automation`
  Recommendation: `new_feature`
  Source: `install/migrating-claude` :: `L132 JSON output for automation`
  Target: `CLI` / `Migration and State Transfer` / `Migration JSON plan and apply output`
  Closest existing: `CLI` / `CLI Observability` / `Health snapshots`
  Why: Machine-readable `--json` plan/apply behavior for migration automation is not captured in existing CLI observability or update categories.
- `02-02-install-maintenance-p004-root` | `install/migrating-hermes` | `(page)`
  Recommendation: `new_feature`
  Source: `install/migrating-hermes` :: `(page)`
  Target: `CLI` / `Migration and State Transfer` / `Hermes provider import`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: The page documents a concrete `openclaw migrate hermes` capability with provider-specific import behavior that the current taxonomy does not model.
- `02-02-install-maintenance-p004-s006` | `install/migrating-hermes` | `Secrets`
  Recommendation: `new_feature`
  Source: `install/migrating-hermes` :: `L136 Secrets`
  Target: `CLI` / `Migration and State Transfer` / `Credential import controls`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: Interactive credential prompts plus `--include-secrets` and `--no-auth-credentials` are distinct migration controls not represented elsewhere in CLI taxonomy.
- `02-02-install-maintenance-p006-s002` | `install/development-channels` | `One-off version or tag targeting`
  Recommendation: `new_feature`
  Source: `install/development-channels` :: `L55 One-off version or tag targeting`
  Target: `CLI` / `Updates and Upgrades` / `One-off version, tag, and package-spec targeting`
  Closest existing: `CLI` / `CLI Setup` / `Source checkout install`
  Why: Targeting a specific dist-tag, version, GitHub spec, or `main` for one run is operator-facing update behavior not represented by the current feature list.
- `02-02-install-maintenance-p006-s003` | `install/development-channels` | `Dry run`
  Recommendation: `new_feature`
  Source: `install/development-channels` :: `L92 Dry run`
  Target: `CLI` / `Updates and Upgrades` / `Update dry-run preview`
  Closest existing: `CLI` / `CLI Setup` / `Source checkout install`
  Why: Dry-run preview of effective channel, target version, and planned actions is a distinct update capability that current features do not call out.
- `02-03-install-containers-p003-root` | `install/clawdock` | `(page)`
  Recommendation: `new_feature`
  Source: `install/clawdock` :: `(page)`
  Target: `Docker / Podman hosting` / `Host CLI Container Targeting and Update Lifecycle` / `ClawDock helper command layer`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: ClawDock is a helper abstraction over Docker Compose operations that is not represented by the current feature list.
- `02-03-install-containers-p003-s001` | `install/clawdock` | `Install`
  Recommendation: `new_feature`
  Source: `install/clawdock` :: `L15 Install`
  Target: `Docker / Podman hosting` / `Host CLI Container Targeting and Update Lifecycle` / `ClawDock helper install and shell activation`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: Installing and sourcing the helper layer is specific ClawDock functionality absent from the current taxonomy.
- `02-03-install-containers-p003-s002` | `install/clawdock` | `What you get`
  Recommendation: `new_feature`
  Source: `install/clawdock` :: `L26 What you get`
  Target: `Docker / Podman hosting` / `Host CLI Container Targeting and Update Lifecycle` / `ClawDock helper command layer`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: The command inventory is documentation for the helper wrapper itself, not just the underlying Docker install flow.
- `02-03-install-containers-p003-s003` | `install/clawdock` | `Basic operations`
  Recommendation: `new_feature`
  Source: `install/clawdock` :: `L28 Basic operations`
  Target: `Docker / Podman hosting` / `Host CLI Container Targeting and Update Lifecycle` / `ClawDock lifecycle aliases`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: Short aliases for start/stop/restart/status/logs are a distinct helper feature not called out in taxonomy today.
- `02-03-install-containers-p003-s004` | `install/clawdock` | `Container access`
  Recommendation: `new_feature`
  Source: `install/clawdock` :: `L38 Container access`
  Target: `Docker / Podman hosting` / `Host CLI Container Targeting and Update Lifecycle` / `ClawDock container access helpers`
  Closest existing: `Docker / Podman hosting` / `Podman Rootless, Quadlet, and Host CLI` / `docs/install/podman.md`
  Why: Shell, CLI, and arbitrary exec wrapper commands are helper-surface affordances that are not explicitly represented.
- `02-03-install-containers-p003-s005` | `install/clawdock` | `Web UI and pairing`
  Recommendation: `new_feature`
  Source: `install/clawdock` :: `L46 Web UI and pairing`
  Target: `Docker / Podman hosting` / `Networking, Control Ui, Health, and Observability` / `ClawDock dashboard and device-pairing helpers`
  Closest existing: `Gateway Web App` / `PWA Install and Web Push Notifications` / `PWA Install and Web Push Notifications`
  Why: Dashboard open and pairing-approval helpers are Docker-host operator conveniences that current categories do not name.
- `02-03-install-containers-p003-s006` | `install/clawdock` | `Setup and maintenance`
  Recommendation: `new_feature`
  Source: `install/clawdock` :: `L54 Setup and maintenance`
  Target: `Docker / Podman hosting` / `Host CLI Container Targeting and Update Lifecycle` / `ClawDock update and maintenance helpers`
  Closest existing: `CLI` / `Plugin and Channel Setup` / `Plugin install sources`
  Why: The helper commands for pull, rebuild, restart, and clean are a distinct operator layer over existing Docker lifecycle behavior.
- `02-03-install-containers-p003-s007` | `install/clawdock` | `Utilities`
  Recommendation: `new_feature`
  Source: `install/clawdock` :: `L63 Utilities`
  Target: `Docker / Podman hosting` / `Host CLI Container Targeting and Update Lifecycle` / `ClawDock operator utilities`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: Token print, config viewing, workspace jumping, and health wrappers are helper-specific operator ergonomics not listed today.
- `02-03-install-containers-p003-s008` | `install/clawdock` | `First-time flow`
  Recommendation: `new_feature`
  Source: `install/clawdock` :: `L74 First-time flow`
  Target: `Docker / Podman hosting` / `Docker Install, Compose, and First-run Setup` / `ClawDock first-time flow`
  Closest existing: `Nix install path` / `Public Nix Docs and Nix-openclaw Handoff` / `Public Nix Docs and Nix-openclaw Handoff`
  Why: The recommended start-token-dashboard flow is a ClawDock-guided first-run path, not a named feature in the existing taxonomy.
- `02-03-install-containers-p004-s012` | `install/docker` | `Shell helpers (optional)`
  Recommendation: `new_feature`
  Source: `install/docker` :: `L303 Shell helpers (optional)`
  Target: `Docker / Podman hosting` / `Host CLI Container Targeting and Update Lifecycle` / `ClawDock helper command layer`
  Closest existing: `Gateway Web App` / `Control UI Static Shell, Routing, and PWA Install Surface` / `Control UI Static Shell, Routing, and PWA Install Surface`
  Why: The optional helper install is a distinct operator convenience surface not represented by current Docker features.
- `02-04-install-hosting-p001-s003` | `install/azure` | `Configure deployment`
  Recommendation: `new_feature`
  Source: `install/azure` :: `L27 Configure deployment`
  Target: `Linux Gateway host` / `Vps, Container, and Cloud Deployment Guidance` / `Azure CLI environment bootstrap`
  Closest existing: `Microsoft Teams` / `Setup, App Registration, Credentials, and Admin Install` / `Setup, App Registration, Credentials, and Admin Install`
  Why: The taxonomy covers generic cloud hosting but does not explicitly capture Azure-specific subscription, provider registration, VNet, subnet, and size-selection setup.
- `02-04-install-hosting-p001-s004` | `install/azure` | `Deploy Azure resources`
  Recommendation: `new_feature`
  Source: `install/azure` :: `L118 Deploy Azure resources`
  Target: `Linux Gateway host` / `Vps, Container, and Cloud Deployment Guidance` / `Azure Bastion and NSG-gated VM deployment`
  Closest existing: `Microsoft Teams` / `Setup, App Registration, Credentials, and Admin Install` / `Setup, App Registration, Credentials, and Admin Install`
  Why: Provisioning a no-public-IP VM behind Azure Bastion with NSG-only SSH is a concrete hosting capability not called out in the current feature inventory.
- `02-04-install-hosting-p004-s003` | `install/exe-dev` | `Automated install with Shelley`
  Recommendation: `new_feature`
  Source: `install/exe-dev` :: `L26 Automated install with Shelley`
  Target: `Linux Gateway host` / `Vps, Container, and Cloud Deployment Guidance` / `Provider-managed agent bootstrap`
  Closest existing: `Gateway runtime` / `Observability, Health, and Repair` / `Automated doctor checks`
  Why: The Shelley-driven provisioning flow is a distinct hosting capability that is not represented in the current Linux cloud deployment feature list.
- `02-04-install-hosting-p004-s010` | `install/exe-dev` | `Remote channel setup`
  Recommendation: `new_feature`
  Source: `install/exe-dev` :: `L116 Remote channel setup`
  Target: `Linux Gateway host` / `Vps, Container, and Cloud Deployment Guidance` / `Remote SecretRef patching over SSH`
  Closest existing: `Microsoft Teams` / `Setup, App Registration, Credentials, and Admin Install` / `Setup, App Registration, Credentials, and Admin Install`
  Why: The remote channel setup flow uses config patch over stdin, remote env-backed secrets, and SSH-mediated config rollout, which is not called out in the current hosting taxonomy.
- `02-04-install-hosting-p006-s005` | `install/gcp` | `Service accounts (security best practice)`
  Recommendation: `new_feature`
  Source: `install/gcp` :: `L381 Service accounts (security best practice)`
  Target: `Linux Gateway host` / `Vps, Container, and Cloud Deployment Guidance` / `Cloud IAM deployment service accounts`
  Closest existing: `Gateway runtime` / `Observability, Health, and Repair` / `Automated doctor checks`
  Why: The service-account hardening advice for automated deployment on GCP is a concrete cloud-operator capability that is absent from the current taxonomy.
- `02-04-install-hosting-p010-s004` | `vps` | `Shared company agent on a VPS`
  Recommendation: `new_feature`
  Source: `vps` :: `L61 Shared company agent on a VPS`
  Target: `Security, auth, pairing, and secrets` / `Gateway Auth and Network Exposure` / `Shared-runtime trust boundaries`
  Closest existing: `Gateway runtime` / `Co-hosted HTTP and Browser Surfaces` / `Control UI hosting`
  Why: The guidance for team-shared VPS agents and when to split by host or OS user is a real security capability gap in the current taxonomy.
- `02-04-install-hosting-p013-s004` | `install/oracle` | `ARM notes`
  Recommendation: `new_feature`
  Source: `install/oracle` :: `L165 ARM notes`
  Target: `Linux Gateway host` / `Runtime Prerequisites and Package-manager Policy` / `Arm64 cloud-host runtime policy`
  Closest existing: `Raspberry Pi / small Linux devices` / `Arm Linux Install and Runtime Prerequisites` / `Arm Linux Install and Runtime Prerequisites`
  Why: ARM-specific binary and dependency expectations for cloud-hosted Ubuntu on Ampere are not called out in the current Linux host taxonomy.
- `02-04-install-hosting-p017-root` | `install/upstash` | `(page)`
  Recommendation: `new_feature`
  Source: `install/upstash` :: `(page)`
  Target: `Linux Gateway host` / `Vps, Container, and Cloud Deployment Guidance` / `Managed keep-alive box hosting`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: Upstash Box is a managed keep-alive host path with Box-specific creation and lifecycle semantics that are not captured in the current Linux hosting feature list.
- `02-04-install-hosting-p017-s001` | `install/upstash` | `Prerequisites`
  Recommendation: `new_feature`
  Source: `install/upstash` :: `L15 Prerequisites`
  Target: `Linux Gateway host` / `Vps, Container, and Cloud Deployment Guidance` / `Managed keep-alive box hosting`
  Closest existing: `Raspberry Pi / small Linux devices` / `Arm Linux Install and Runtime Prerequisites` / `Arm Linux Install and Runtime Prerequisites`
  Why: Upstash Box is a managed keep-alive host path with Box-specific creation and lifecycle semantics that are not captured in the current Linux hosting feature list.
- `02-04-install-hosting-p017-s002` | `install/upstash` | `Create a Box`
  Recommendation: `new_feature`
  Source: `install/upstash` :: `L21 Create a Box`
  Target: `Linux Gateway host` / `Vps, Container, and Cloud Deployment Guidance` / `Managed keep-alive box hosting`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: Upstash Box is a managed keep-alive host path with Box-specific creation and lifecycle semantics that are not captured in the current Linux hosting feature list.
- `02-04-install-hosting-p017-s007` | `install/upstash` | `Auto-restart`
  Recommendation: `new_feature`
  Source: `install/upstash` :: `L71 Auto-restart`
  Target: `Linux Gateway host` / `Vps, Container, and Cloud Deployment Guidance` / `Provider init-script restart hook`
  Closest existing: `CLI` / `Gateway Service Management` / `Service health checks`
  Why: Using the Box init script as the restart mechanism is a provider-specific lifecycle feature not represented in the current taxonomy.
- `02-04-install-hosting-p017-s009` | `install/upstash` | `Related`
  Recommendation: `new_feature`
  Source: `install/upstash` :: `L92 Related`
  Target: `Linux Gateway host` / `Vps, Container, and Cloud Deployment Guidance` / `Managed keep-alive box hosting`
  Closest existing: `Android app` / `Install, Release, and Distribution` / `Out of scope`
  Why: Upstash Box is a managed keep-alive host path with Box-specific creation and lifecycle semantics that are not captured in the current Linux hosting feature list.
- `04-01-agents-fundamentals-p011-root` | `start/bootstrapping` | `(page)`
  Recommendation: `new_feature`
  Source: `start/bootstrapping` :: `(page)`
  Target: `Session, memory, and context engine` / `Instruction Profile and Context Visibility` / `Workspace bootstrapping ritual`
  Closest existing: `Gateway runtime` / `Core Rpc Coverage` / `Agents and artifacts`
  Why: `docs/start/bootstrapping.md` describes the first-run ritual that seeds workspace files, runs identity Q&A, and removes `BOOTSTRAP.md` after completion. The current taxonomy covers injected files, but not the operator-visible lifecycle that creates and retires them.
- `04-01-agents-fundamentals-p011-s001` | `start/bootstrapping` | `What bootstrapping does`
  Recommendation: `new_feature`
  Source: `start/bootstrapping` :: `L15 What bootstrapping does`
  Target: `Session, memory, and context engine` / `Instruction Profile and Context Visibility` / `Workspace bootstrapping ritual`
  Closest existing: `Automation: cron, hooks, tasks, polling` / `Cron Job Lifecycle` / `Cron Job Lifecycle`
  Why: `What bootstrapping does` is the clearest evidence that the workspace seeding flow, bootstrap Q&A, and `BOOTSTRAP.md` retirement behavior are a real user-facing capability not currently named in the taxonomy.
- `04-01-agents-fundamentals-p011-s002` | `start/bootstrapping` | `Skipping bootstrapping`
  Recommendation: `new_feature`
  Source: `start/bootstrapping` :: `L31 Skipping bootstrapping`
  Target: `Session, memory, and context engine` / `Instruction Profile and Context Visibility` / `Workspace bootstrapping ritual`
  Closest existing: `Gateway runtime` / `Core Rpc Coverage` / `Agents and artifacts`
  Why: `Skipping bootstrapping` documents an explicit control surface (`openclaw onboard --skip-bootstrap`) for that first-run ritual, which reinforces that the ritual itself should be a named feature.
- `04-01-agents-fundamentals-p011-s003` | `start/bootstrapping` | `Where it runs`
  Recommendation: `new_feature`
  Source: `start/bootstrapping` :: `L35 Where it runs`
  Target: `Session, memory, and context engine` / `Instruction Profile and Context Visibility` / `Workspace bootstrapping ritual`
  Closest existing: `Automation: cron, hooks, tasks, polling` / `Cron Execution Diagnostics` / `Cron Execution Diagnostics`
  Why: `Where it runs` documents the gateway-host locality of the bootstrap ritual and remote-gateway implications. That is part of the same missing feature, not a separate category.
- `04-02-agents-sessions-and-memory-p005-s012` | `concepts/memory` | `Grounded backfill and live promotion`
  Recommendation: `new_feature`
  Source: `concepts/memory` :: `L237 Grounded backfill and live promotion`
  Target: `Session, memory, and context engine` / `Dreaming, Promotion, and Memory Consolidation` / `Grounded Backfill and Staged Promotion Review`
  Closest existing: `Session, memory, and context engine` / `Memory Files, Tools, and Active Memory` / `Memory Files, Tools, and Active Memory`
  Why: Grounded backfill/staging is a distinct dreaming feature.
- `04-03-agents-multi-agent-p001-s007` | `concepts/multi-agent` | `Cross-agent QMD memory search`
  Recommendation: `new_feature`
  Source: `concepts/multi-agent` :: `L131 Cross-agent QMD memory search`
  Target: `Session, memory, and context engine` / `Memory Backend Storage and Embedding Search` / `Cross-agent transcript collections`
  Closest existing: `Telegram` / `Group Forum Topic and Session Routing` / `ACP topic binding`
  Why: Cross-agent QMD extra collections extend memory search beyond the current explicit feature inventory.
- `04-03-agents-multi-agent-p002-s003` | `concepts/parallel-specialist-lanes` | `Phase 1: lane contracts + background heavy work`
  Recommendation: `new_feature`
  Source: `concepts/parallel-specialist-lanes` :: `L36 Phase 1: lane contracts + background heavy work`
  Target: `Agent runtime and provider execution` / `Parallel specialist lanes` / `Background heavy-work handoff`
  Closest existing: `Channel framework` / `Group Thread and Ambient Room Behavior` / `Broadcast groups`
  Why: Using background subagents and tasks as a lane handoff rule belongs under a lane category, but is not called out as a scored feature today.
- `04-03-agents-multi-agent-p002-s004` | `concepts/parallel-specialist-lanes` | `Phase 2: priority and concurrency controls`
  Recommendation: `new_feature`
  Source: `concepts/parallel-specialist-lanes` :: `L51 Phase 2: priority and concurrency controls`
  Target: `Agent runtime and provider execution` / `Parallel specialist lanes` / `Lane priority and concurrency controls`
  Closest existing: `Voice and realtime talk` / `Agent Consult, Steering, and Talkback Controls` / `Active Talk agent-run status`
  Why: The documented maxConcurrent, subagent concurrency, delegation mode, and queue tuning are concrete capabilities missing from the current feature inventory.
- `04-03-agents-multi-agent-p002-s005` | `concepts/parallel-specialist-lanes` | `Phase 3: coordinator / traffic controller`
  Recommendation: `new_feature`
  Source: `concepts/parallel-specialist-lanes` :: `L78 Phase 3: coordinator / traffic controller`
  Target: `Agent runtime and provider execution` / `Parallel specialist lanes` / `Coordinator and traffic-controller patterns`
  Closest existing: `Channel framework` / `Group Thread and Ambient Room Behavior` / `Broadcast groups`
  Why: Duplicate-request detection, owner tracking, and inter-lane handoff summaries are described as a supported operating pattern but have no current scored feature.
- `04-03-agents-multi-agent-p004-s004` | `concepts/delegate-architecture` | `Tier 1: Read-Only + Draft`
  Recommendation: `new_feature`
  Source: `concepts/delegate-architecture` :: `L43 Tier 1: Read-Only + Draft`
  Target: `Agent runtime and provider execution` / `Delegate agents and organizational identity` / `Read-only and draft delegates`
  Closest existing: `Nix install path` / `Macos Gui Defaults Read-only UX and Companion Behavior` / `Macos Gui Defaults Read-only UX and Companion Behavior`
  Why: Tier 1 delegate behavior is a specific capability mode within the missing delegate category.
- `04-03-agents-multi-agent-p004-s005` | `concepts/delegate-architecture` | `Tier 2: Send on Behalf`
  Recommendation: `new_feature`
  Source: `concepts/delegate-architecture` :: `L53 Tier 2: Send on Behalf`
  Target: `Agent runtime and provider execution` / `Delegate agents and organizational identity` / `Send-on-behalf delegates`
  Closest existing: `Channel framework` / `Group Thread and Ambient Room Behavior` / `Broadcast groups`
  Why: Tier 2 introduces explicit send-on-behalf behavior that is not enumerated as a scored feature.
- `04-03-agents-multi-agent-p004-s006` | `concepts/delegate-architecture` | `Tier 3: Proactive`
  Recommendation: `new_feature`
  Source: `concepts/delegate-architecture` :: `L63 Tier 3: Proactive`
  Target: `Agent runtime and provider execution` / `Delegate agents and organizational identity` / `Autonomous delegates with standing orders`
  Closest existing: `Channel framework` / `Group Thread and Ambient Room Behavior` / `Broadcast groups`
  Why: Tier 3 combines delegated identity with scheduled autonomy and needs explicit feature coverage.
- `04-03-agents-multi-agent-p004-s008` | `concepts/delegate-architecture` | `Hard blocks (non-negotiable)`
  Recommendation: `new_feature`
  Source: `concepts/delegate-architecture` :: `L83 Hard blocks (non-negotiable)`
  Target: `Session, memory, and context engine` / `Instruction Profile and Context Visibility` / `Standing orders and hard blocks`
  Closest existing: `Anthropic provider path` / `Tool Calls, Replay, and Native Thinking` / `Tool Calls, Replay, and Native Thinking`
  Why: Persistent standing orders and non-negotiable hard blocks in AGENTS.md and SOUL.md are documented here but not currently called out as a scored feature.
- `04-03-agents-multi-agent-p004-s014` | `concepts/delegate-architecture` | `2. Configure identity provider delegation`
  Recommendation: `new_feature`
  Source: `concepts/delegate-architecture` :: `L160 2. Configure identity provider delegation`
  Target: `Agent runtime and provider execution` / `Provider Auth and Credentials` / `Delegated organizational identities`
  Closest existing: `Automation: cron, hooks, tasks, polling` / `Cron Execution Diagnostics` / `Cron Execution Diagnostics`
  Why: Identity-provider delegation and least-privilege setup for a non-human agent is not represented by generic login or API-key features.
- `04-03-agents-multi-agent-p004-s015` | `concepts/delegate-architecture` | `Microsoft 365`
  Recommendation: `new_feature`
  Source: `concepts/delegate-architecture` :: `L164 Microsoft 365`
  Target: `Agent runtime and provider execution` / `Provider Auth and Credentials` / `Microsoft 365 send-on-behalf delegation`
  Closest existing: `Channel framework` / `Group Thread and Ambient Room Behavior` / `Broadcast groups`
  Why: Exchange and Graph send-on-behalf plus mailbox scoping are concrete delegate-auth capabilities missing from taxonomy.
- `04-03-agents-multi-agent-p004-s016` | `concepts/delegate-architecture` | `Google Workspace`
  Recommendation: `new_feature`
  Source: `concepts/delegate-architecture` :: `L191 Google Workspace`
  Target: `Agent runtime and provider execution` / `Provider Auth and Credentials` / `Google Workspace domain-wide delegation`
  Closest existing: `Google Chat` / `Multi Account Secrets Status and Diagnostics` / `Multi Account Secrets Status and Diagnostics`
  Why: Service-account impersonation and scoped domain-wide delegation are concrete delegate-auth capabilities missing from taxonomy.
- `04-04-agents-messages-and-delivery-p001-root` | `concepts/messages` | `(page)`
  Recommendation: `new_feature`
  Source: `concepts/messages` :: `(page)`
  Target: `Channel framework` / `Outbound Delivery and Reply Pipeline` / `Shared inbound-to-reply message lifecycle`
  Closest existing: `Media understanding and media generation` / `TTS and Outbound Voice Audio Delivery` / `TTS and Outbound Voice Audio Delivery`
  Why: The page is the canonical cross-channel overview of how inbound messages become replies through routing, queueing, tool execution, and outbound delivery. That shared lifecycle is not represented as its own feature in the current Channel framework taxonomy.
- `04-04-agents-messages-and-delivery-p001-s001` | `concepts/messages` | `Message flow (high level)`
  Recommendation: `new_feature`
  Source: `concepts/messages` :: `L12 Message flow (high level)`
  Target: `Channel framework` / `Outbound Delivery and Reply Pipeline` / `Shared inbound-to-reply message lifecycle`
  Closest existing: `Media understanding and media generation` / `TTS and Outbound Voice Audio Delivery` / `TTS and Outbound Voice Audio Delivery`
  Why: The high-level flow section documents the common pipeline from routing and session resolution through queueing, agent execution, and outbound replies. Existing features cover pieces of that path, but not the shared end-to-end lifecycle as one scoreable capability.
- `04-04-agents-messages-and-delivery-p001-s002` | `concepts/messages` | `Inbound dedupe`
  Recommendation: `new_feature`
  Source: `concepts/messages` :: `L30 Inbound dedupe`
  Target: `Channel framework` / `Routing Session and Agent Binding` / `Inbound message redelivery dedupe`
  Closest existing: `Mattermost, LINE, IRC, Nextcloud Talk, Nostr, Twitch, Tlon, Synology Chat` / `Line` / `Signed inbound webhook events`
  Why: Short-lived dedupe of redelivered inbound messages is a generic routing/runtime protection across channels, and the current shared routing features do not explicitly model that capability.
- `04-04-agents-messages-and-delivery-p001-s003` | `concepts/messages` | `Inbound debouncing`
  Recommendation: `new_feature`
  Source: `concepts/messages` :: `L36 Inbound debouncing`
  Target: `Channel framework` / `Routing Session and Agent Binding` / `Inbound debounce and same-sender coalescing`
  Closest existing: `Media understanding and media generation` / `Channel Attachment Staging and Reply Media Delivery` / `Channel Attachment Staging and Reply Media Delivery`
  Why: Text-only inbound debounce, per-channel debounce windows, and same-sender coalescing are shared delivery semantics that are not captured by the existing shared routing or room-behavior features.
- `04-04-agents-messages-and-delivery-p001-s007` | `concepts/messages` | `Queueing and followups`
  Recommendation: `new_feature`
  Source: `concepts/messages` :: `L126 Queueing and followups`
  Target: `Agent runtime and provider execution` / `Agent Turn Execution` / `Active-run queue modes and followups`
  Closest existing: `Media understanding and media generation` / `TTS and Outbound Voice Audio Delivery` / `TTS and Outbound Voice Audio Delivery`
  Why: The shared `steer`, `followup`, `collect`, and `interrupt` semantics for inbound messages arriving during an active run are user-facing runtime behavior not called out in the current Agent Turn Execution feature list.
- `04-04-agents-messages-and-delivery-p001-s012` | `concepts/messages` | `Silent replies`
  Recommendation: `new_feature`
  Source: `concepts/messages` :: `L182 Silent replies`
  Target: `Channel framework` / `Outbound Delivery and Reply Pipeline` / `Silent reply suppression and media-only delivery`
  Closest existing: `Discord` / `Outbound Message Rendering and Delivery` / `Outbound Message Rendering and Delivery`
  Why: Cross-surface `NO_REPLY` handling, media-only delivery when text is silent, and differing direct/group/internal suppression policy are not modeled by the current shared outbound-delivery feature set.
- `04-04-agents-messages-and-delivery-p005-root` | `concepts/retry` | `(page)`
  Recommendation: `new_feature`
  Source: `concepts/retry` :: `(page)`
  Target: `Channel framework` / `Outbound Delivery and Reply Pipeline` / `Configurable cross-surface retry policy`
  Closest existing: `Google Chat` / `Space Routing Mentions and Session Isolation` / `Space Routing Mentions and Session Isolation`
  Why: The page defines a shared retry policy contract, defaults, jitter, and per-provider/channel configuration knobs for outbound operations. The taxonomy has channel- and provider-specific retry behavior, but not the shared retry-policy surface itself.
- `04-04-agents-messages-and-delivery-p005-s001` | `concepts/retry` | `Goals`
  Recommendation: `new_feature`
  Source: `concepts/retry` :: `L9 Goals`
  Target: `Channel framework` / `Outbound Delivery and Reply Pipeline` / `Configurable cross-surface retry policy`
  Closest existing: `Google Chat` / `Space Routing Mentions and Session Isolation` / `Space Routing Mentions and Session Isolation`
  Why: Retry goals such as per-request retries, ordering preservation, and non-idempotent safety are part of the shared retry-policy capability and are not explicitly represented today.
- `04-04-agents-messages-and-delivery-p005-s002` | `concepts/retry` | `Defaults`
  Recommendation: `new_feature`
  Source: `concepts/retry` :: `L15 Defaults`
  Target: `Channel framework` / `Outbound Delivery and Reply Pipeline` / `Configurable cross-surface retry policy`
  Closest existing: `Google Chat` / `Space Routing Mentions and Session Isolation` / `Space Routing Mentions and Session Isolation`
  Why: Global retry defaults like attempts, max delay, jitter, and channel-specific minimum delay are operator-facing policy controls not called out in current shared delivery features.
- `04-04-agents-messages-and-delivery-p005-s003` | `concepts/retry` | `Behavior`
  Recommendation: `new_feature`
  Source: `concepts/retry` :: `L24 Behavior`
  Target: `Channel framework` / `Outbound Delivery and Reply Pipeline` / `Configurable cross-surface retry policy`
  Closest existing: `Automation: cron, hooks, tasks, polling` / `Heartbeat and Commitments` / `Heartbeat and Commitments`
  Why: The behavior section is the shared policy entrypoint for how retries are applied across model providers and channel transports. That shared policy layer is not currently scoreable as a distinct feature.
- `04-04-agents-messages-and-delivery-p005-s007` | `concepts/retry` | `Configuration`
  Recommendation: `new_feature`
  Source: `concepts/retry` :: `L51 Configuration`
  Target: `Channel framework` / `Outbound Delivery and Reply Pipeline` / `Configurable cross-surface retry policy`
  Closest existing: `Google Chat` / `Space Routing Mentions and Session Isolation` / `Space Routing Mentions and Session Isolation`
  Why: The configuration section documents explicit shared retry knobs in `openclaw.json` for channel transports, which the current taxonomy does not model as a standalone operator capability.
- `04-04-agents-messages-and-delivery-p005-s008` | `concepts/retry` | `Notes`
  Recommendation: `new_feature`
  Source: `concepts/retry` :: `L78 Notes`
  Target: `Channel framework` / `Outbound Delivery and Reply Pipeline` / `Configurable cross-surface retry policy`
  Closest existing: `Google Chat` / `Space Routing Mentions and Session Isolation` / `Space Routing Mentions and Session Isolation`
  Why: Per-request retry scope and non-retry of completed composite steps are part of the shared retry-policy contract rather than already-modeled channel-specific features.
- `04-04-agents-messages-and-delivery-p006-root` | `concepts/queue` | `(page)`
  Recommendation: `new_feature`
  Source: `concepts/queue` :: `(page)`
  Target: `Agent runtime and provider execution` / `Agent Turn Execution` / `Active-run queue modes and steering`
  Closest existing: `Media understanding and media generation` / `TTS and Outbound Voice Audio Delivery` / `TTS and Outbound Voice Audio Delivery`
  Why: The page defines the shared in-process queue for inbound auto-reply runs, lane behavior, and the operator-facing `/queue` contract. That queue/steering capability is not explicitly represented in current runtime taxonomy.
- `04-04-agents-messages-and-delivery-p006-s001` | `concepts/queue` | `Why`
  Recommendation: `new_feature`
  Source: `concepts/queue` :: `L11 Why`
  Target: `Agent runtime and provider execution` / `Agent Turn Execution` / `Active-run queue modes and steering`
  Closest existing: `Media understanding and media generation` / `TTS and Outbound Voice Audio Delivery` / `TTS and Outbound Voice Audio Delivery`
  Why: The rationale for serializing runs by session and capping shared concurrency describes the same missing queue capability, not an already-scored execution detail.
- `04-04-agents-messages-and-delivery-p006-s002` | `concepts/queue` | `How it works`
  Recommendation: `new_feature`
  Source: `concepts/queue` :: `L16 How it works`
  Target: `Agent runtime and provider execution` / `Agent Turn Execution` / `Active-run queue modes and steering`
  Closest existing: `Media understanding and media generation` / `TTS and Outbound Voice Audio Delivery` / `TTS and Outbound Voice Audio Delivery`
  Why: Lane-aware FIFO draining, session-key locking, global lanes, and enqueue timing behavior are central parts of the queue subsystem and are not broken out in the current feature list.
- `04-04-agents-messages-and-delivery-p006-s003` | `concepts/queue` | `Defaults`
  Recommendation: `new_feature`
  Source: `concepts/queue` :: `L24 Defaults`
  Target: `Agent runtime and provider execution` / `Agent Turn Execution` / `Active-run queue modes and steering`
  Closest existing: `Media understanding and media generation` / `TTS and Outbound Voice Audio Delivery` / `TTS and Outbound Voice Audio Delivery`
  Why: Default queue mode, debounce window, queue cap, and drop policy are operator-visible queue controls that do not have explicit scorecard coverage today.
- `04-04-agents-messages-and-delivery-p006-s004` | `concepts/queue` | `Queue modes`
  Recommendation: `new_feature`
  Source: `concepts/queue` :: `L38 Queue modes`
  Target: `Agent runtime and provider execution` / `Agent Turn Execution` / `Active-run queue modes and steering`
  Closest existing: `Media understanding and media generation` / `TTS and Outbound Voice Audio Delivery` / `TTS and Outbound Voice Audio Delivery`
  Why: The `steer`, `followup`, `collect`, and `interrupt` modes are concrete user-facing behaviors of active-run handling and should be modeled directly instead of being implied by generic execution coordination.
- `04-04-agents-messages-and-delivery-p006-s005` | `concepts/queue` | `Queue options`
  Recommendation: `new_feature`
  Source: `concepts/queue` :: `L68 Queue options`
  Target: `Agent runtime and provider execution` / `Agent Turn Execution` / `Active-run queue modes and steering`
  Closest existing: `Media understanding and media generation` / `TTS and Outbound Voice Audio Delivery` / `TTS and Outbound Voice Audio Delivery`
  Why: Queue options such as debounce, cap, and drop policy are core operator controls for the queue subsystem and are not captured by existing runtime features.
- `04-04-agents-messages-and-delivery-p006-s006` | `concepts/queue` | `Steer and streaming`
  Recommendation: `new_feature`
  Source: `concepts/queue` :: `L81 Steer and streaming`
  Target: `Agent runtime and provider execution` / `Agent Turn Execution` / `Active-run queue modes and steering`
  Closest existing: `Gateway Web App` / `Chat Composer, Session/model Controls, Attachments, and Message Rendering UX` / `Chat Composer, Session/model Controls, Attachments, and Message Rendering UX`
  Why: The interaction between steering and streaming, including runtime-boundary behavior and fallback from same-turn steering to later followups, is part of the missing shared queue/steering capability.
- `04-04-agents-messages-and-delivery-p006-s007` | `concepts/queue` | `Precedence`
  Recommendation: `new_feature`
  Source: `concepts/queue` :: `L95 Precedence`
  Target: `Agent runtime and provider execution` / `Agent Turn Execution` / `Active-run queue modes and steering`
  Closest existing: `Media understanding and media generation` / `TTS and Outbound Voice Audio Delivery` / `TTS and Outbound Voice Audio Delivery`
  Why: Mode and option precedence across per-session overrides, per-channel config, and global defaults is a queue-specific operator contract not represented in the current taxonomy.
- `04-04-agents-messages-and-delivery-p006-s008` | `concepts/queue` | `Per-session overrides`
  Recommendation: `new_feature`
  Source: `concepts/queue` :: `L110 Per-session overrides`
  Target: `Agent runtime and provider execution` / `Agent Turn Execution` / `Active-run queue modes and steering`
  Closest existing: `Gateway Web App` / `Chat Composer, Session/model Controls, Attachments, and Message Rendering UX` / `Chat Composer, Session/model Controls, Attachments, and Message Rendering UX`
  Why: Persisted per-session `/queue` overrides are part of the shared queue control surface and are not modeled by current execution or session-routing features.
- `04-04-agents-messages-and-delivery-p006-s009` | `concepts/queue` | `Scope and guarantees`
  Recommendation: `new_feature`
  Source: `concepts/queue` :: `L116 Scope and guarantees`
  Target: `Agent runtime and provider execution` / `Agent Turn Execution` / `Active-run queue modes and steering`
  Closest existing: `Media understanding and media generation` / `TTS and Outbound Voice Audio Delivery` / `TTS and Outbound Voice Audio Delivery`
  Why: Queue scope, per-session guarantees, lane separation for cron and nested work, and process-level concurrency bounds are central queue semantics that do not have explicit scorecard coverage.
- `04-04-agents-messages-and-delivery-p007-root` | `concepts/queue-steering` | `(page)`
  Recommendation: `new_feature`
  Source: `concepts/queue-steering` :: `(page)`
  Target: `Agent runtime and provider execution` / `Agent Turn Execution` / `Active-run queue modes and steering`
  Closest existing: `Media understanding and media generation` / `TTS and Outbound Voice Audio Delivery` / `TTS and Outbound Voice Audio Delivery`
  Why: The steering-queue page is a focused deep dive on the shared same-turn steering subsystem. That runtime behavior is not explicitly modeled in the current taxonomy.
- `04-04-agents-messages-and-delivery-p007-s001` | `concepts/queue-steering` | `Runtime boundary`
  Recommendation: `new_feature`
  Source: `concepts/queue-steering` :: `L16 Runtime boundary`
  Target: `Agent runtime and provider execution` / `Agent Turn Execution` / `Active-run queue modes and steering`
  Closest existing: `Microsoft Teams` / `Webhook Runtime, SDK Lifecycle, and Proactive Cloud Boundary` / `Webhook Runtime, SDK Lifecycle, and Proactive Cloud Boundary`
  Why: Tool-boundary draining, turn-end emission, Codex `turn/steer` batching, and runtimes that reject same-turn steering are core steering semantics missing from the current feature list.
- `04-04-agents-messages-and-delivery-p007-s002` | `concepts/queue-steering` | `Modes`
  Recommendation: `new_feature`
  Source: `concepts/queue-steering` :: `L44 Modes`
  Target: `Agent runtime and provider execution` / `Agent Turn Execution` / `Active-run queue modes and steering`
  Closest existing: `Media understanding and media generation` / `TTS and Outbound Voice Audio Delivery` / `TTS and Outbound Voice Audio Delivery`
  Why: The mode matrix here is the same missing shared queue capability: how `steer`, `followup`, `collect`, and `interrupt` behave while a run is active.
- `04-04-agents-messages-and-delivery-p007-s003` | `concepts/queue-steering` | `Burst example`
  Recommendation: `new_feature`
  Source: `concepts/queue-steering` :: `L53 Burst example`
  Target: `Agent runtime and provider execution` / `Agent Turn Execution` / `Active-run queue modes and steering`
  Closest existing: `Media understanding and media generation` / `TTS and Outbound Voice Audio Delivery` / `TTS and Outbound Voice Audio Delivery`
  Why: The burst example documents practical steering and batching semantics for multiple inbound prompts during tool execution, which are not explicitly scoreable today.
- `04-04-agents-messages-and-delivery-p007-s004` | `concepts/queue-steering` | `Scope`
  Recommendation: `new_feature`
  Source: `concepts/queue-steering` :: `L66 Scope`
  Target: `Agent runtime and provider execution` / `Agent Turn Execution` / `Active-run queue modes and steering`
  Closest existing: `Media understanding and media generation` / `TTS and Outbound Voice Audio Delivery` / `TTS and Outbound Voice Audio Delivery`
  Why: Scope limits such as steering staying within the active session and preserving the active run's policy are part of the same missing steering feature.
- `04-04-agents-messages-and-delivery-p007-s005` | `concepts/queue-steering` | `Debounce`
  Recommendation: `new_feature`
  Source: `concepts/queue-steering` :: `L77 Debounce`
  Target: `Agent runtime and provider execution` / `Agent Turn Execution` / `Active-run queue modes and steering`
  Closest existing: `Media understanding and media generation` / `TTS and Outbound Voice Audio Delivery` / `TTS and Outbound Voice Audio Delivery`
  Why: The steering-specific debounce contract, including Codex quiet-window batching versus OpenClaw model-boundary batching, is not represented in the current taxonomy.
- `05-02-capabilities-plugins-p001-s007` | `tools/plugin` | `Plugin hooks`
  Recommendation: `new_feature`
  Source: `tools/plugin` :: `L210 Plugin hooks`
  Target: `Plugin SDK and bundled plugin architecture` / `Authoring plugins` / `Runtime hook APIs`
  Closest existing: `ClawHub` / `Clawhub Discovery, Catalog Metadata, and Package Lookup` / `openclaw plugins search as the ClawHub`
  Why: This section documents the operator-visible authoring split between typed `api.on(...)` lifecycle hooks and `api.registerHook(...)` internal-hook compatibility. The current plugin authoring taxonomy names entrypoints and imports, but it does not represent hook API registration as its own capability.
- `05-02-capabilities-plugins-p004-s003` | `plugins/bundles` | `What OpenClaw maps from bundles`
  Recommendation: `new_feature`
  Source: `plugins/bundles` :: `L66 What OpenClaw maps from bundles`
  Target: `Plugin SDK and bundled plugin architecture` / `Compatible bundle detection and capability mapping` / `Bundle capability mapping matrix`
  Closest existing: `ClawHub` / `Marketplace and Compatible Bundle Import Support` / `Supported mapped features`
  Why: The section explicitly enumerates which bundle capabilities OpenClaw maps into native skills, commands, hook packs, MCP, LSP, and settings. That mapping matrix is not represented in current taxonomy.
- `05-02-capabilities-plugins-p004-s007` | `plugins/bundles` | `MCP for embedded OpenClaw`
  Recommendation: `new_feature`
  Source: `plugins/bundles` :: `L98 MCP for embedded OpenClaw`
  Target: `Plugin SDK and bundled plugin architecture` / `Compatible bundle detection and capability mapping` / `Embedded bundle MCP server import`
  Closest existing: `ClawHub` / `Marketplace and Compatible Bundle Import Support` / `Supported mapped features`
  Why: Bundle-contributed MCP server config, merged embedded-agent settings, default tool-profile exposure, and deterministic tool catalog behavior are not modeled by current plugin or ClawHub categories.
- `05-02-capabilities-plugins-p004-s010` | `plugins/bundles` | `Embedded OpenClaw settings`
  Recommendation: `new_feature`
  Source: `plugins/bundles` :: `L180 Embedded OpenClaw settings`
  Target: `Plugin SDK and bundled plugin architecture` / `Compatible bundle detection and capability mapping` / `Embedded bundle settings import`
  Closest existing: `ClawHub` / `Marketplace and Compatible Bundle Import Support` / `Supported mapped features`
  Why: Claude `settings.json` import into embedded OpenClaw defaults, including shell-key sanitization, is a specific mapped capability not represented today.
- `05-02-capabilities-plugins-p004-s011` | `plugins/bundles` | `Embedded OpenClaw LSP`
  Recommendation: `new_feature`
  Source: `plugins/bundles` :: `L191 Embedded OpenClaw LSP`
  Target: `Plugin SDK and bundled plugin architecture` / `Compatible bundle detection and capability mapping` / `Embedded bundle LSP import`
  Closest existing: `ClawHub` / `Marketplace and Compatible Bundle Import Support` / `Supported mapped features`
  Why: Bundle `.lsp.json` plus manifest-declared LSP server import into embedded OpenClaw defaults is a discrete capability absent from current taxonomy.
- `05-02-capabilities-plugins-p004-s012` | `plugins/bundles` | `Detected but not executed`
  Recommendation: `new_feature`
  Source: `plugins/bundles` :: `L199 Detected but not executed`
  Target: `Plugin SDK and bundled plugin architecture` / `Compatible bundle detection and capability mapping` / `Detect-only bundle capability reporting`
  Closest existing: `ClawHub` / `Marketplace and Compatible Bundle Import Support` / `Supported mapped features`
  Why: Recognizing unsupported bundle content and surfacing it in diagnostics without executing it is a meaningful compatibility behavior that the current taxonomy does not capture.
- `05-02-capabilities-plugins-p004-s013` | `plugins/bundles` | `Bundle formats`
  Recommendation: `new_feature`
  Source: `plugins/bundles` :: `L207 Bundle formats`
  Target: `Plugin SDK and bundled plugin architecture` / `Compatible bundle detection and capability mapping` / `Bundle format detection and precedence`
  Closest existing: `ClawHub` / `Marketplace and Compatible Bundle Import Support` / `Codex`
  Why: Codex, Claude, and Cursor marker detection, manifestless layout handling, and native-plugin precedence over bundle mode are not represented by current categories.
- `05-02-capabilities-plugins-p004-s016` | `plugins/bundles` | `Security`
  Recommendation: `new_feature`
  Source: `plugins/bundles` :: `L270 Security`
  Target: `Plugin SDK and bundled plugin architecture` / `Compatible bundle detection and capability mapping` / `Bundle security boundary`
  Closest existing: `ClawHub` / `Marketplace and Compatible Bundle Import Support` / `Supported mapped features`
  Why: The narrower trust model for bundles, path boundary checks, and constrained executable surfaces are not captured by current plugin SDK or ClawHub taxonomy.
- `05-03-capabilities-bundled-plugin-guides-p004-s002` | `plugins/google-meet` | `Local gateway + Parallels Chrome`
  Recommendation: `new_feature`
  Source: `plugins/google-meet` :: `L226 Local gateway + Parallels Chrome`
  Target: `Google Meet plugin` / `Meeting transport and participation` / `Remote Chrome-node participation`
  Closest existing: `Browser automation and exec/sandbox tools` / `Browser Plugin Service and Profiles` / `Browser Plugin Service and Profiles`
  Why: The Parallels Chrome section adds a specific remote-node topology where Gateway and model runtime stay on one host while Chrome/audio live on a paired macOS node. That is a distinct Google Meet capability not represented elsewhere today.
- `05-03-capabilities-bundled-plugin-guides-p004-s003` | `plugins/google-meet` | `Install notes`
  Recommendation: `new_feature`
  Source: `plugins/google-meet` :: `L397 Install notes`
  Target: `Google Meet plugin` / `Transport backends and audio requirements` / `Chrome audio host prerequisites`
  Closest existing: `CLI` / `Plugin and Channel Setup` / `Plugin install sources`
  Why: Install notes define the external audio dependencies (blackhole-2ch, sox) and host-level licensing/runtime prerequisites for Chrome talk-back participation. Those operator requirements are not owned by any existing surface.
- `05-03-capabilities-bundled-plugin-guides-p004-s005` | `plugins/google-meet` | `Chrome`
  Recommendation: `new_feature`
  Source: `plugins/google-meet` :: `L414 Chrome`
  Target: `Google Meet plugin` / `Transport backends and audio requirements` / `Chrome and chrome-node browser transport`
  Closest existing: `Google provider path` / `Plugin Distribution and Cross-surface Capability Adapters` / `Plugin Distribution and Cross-surface Capability Adapters`
  Why: The Chrome section documents local and node-hosted browser joins, browser-profile selection, audio routing, and fail-closed behavior when the Chrome audio path is unavailable.
- `05-03-capabilities-bundled-plugin-guides-p004-s006` | `plugins/google-meet` | `Twilio`
  Recommendation: `new_feature`
  Source: `plugins/google-meet` :: `L434 Twilio`
  Target: `Google Meet plugin` / `Transport backends and audio requirements` / `Twilio dial-in transport`
  Closest existing: `Google provider path` / `Plugin Distribution and Cross-surface Capability Adapters` / `Plugin Distribution and Cross-surface Capability Adapters`
  Why: The Twilio section is a separate transport backend with its own plugin dependency, credential wiring, dial-in/PIN behavior, and fallback semantics.
- `05-03-capabilities-bundled-plugin-guides-p004-s008` | `plugins/google-meet` | `Create Google credentials`
  Recommendation: `new_feature`
  Source: `plugins/google-meet` :: `L545 Create Google credentials`
  Target: `Google Meet plugin` / `OAuth, API operations, and exported artifacts` / `Google OAuth client and scope setup`
  Closest existing: `Google provider path` / `Plugin Distribution and Cross-surface Capability Adapters` / `Plugin Distribution and Cross-surface Capability Adapters`
  Why: Creating the OAuth client and selecting the specific Meet scopes is a real operator-facing feature requirement unique to this plugin.
- `05-03-capabilities-bundled-plugin-guides-p004-s009` | `plugins/google-meet` | `Mint the refresh token`
  Recommendation: `new_feature`
  Source: `plugins/google-meet` :: `L578 Mint the refresh token`
  Target: `Google Meet plugin` / `OAuth, API operations, and exported artifacts` / `Google Meet OAuth login and refresh tokens`
  Closest existing: `Google provider path` / `Plugin Distribution and Cross-surface Capability Adapters` / `Plugin Distribution and Cross-surface Capability Adapters`
  Why: The refresh-token minting flow, config placement, and environment fallbacks are a distinct supported workflow for this plugin.
- `05-03-capabilities-bundled-plugin-guides-p004-s010` | `plugins/google-meet` | `Verify OAuth with doctor`
  Recommendation: `new_feature`
  Source: `plugins/google-meet` :: `L652 Verify OAuth with doctor`
  Target: `Google Meet plugin` / `OAuth, API operations, and exported artifacts` / `OAuth doctor, space resolution, and preflight`
  Closest existing: `Google provider path` / `Plugin Distribution and Cross-surface Capability Adapters` / `Plugin Distribution and Cross-surface Capability Adapters`
  Why: Doctor checks, resolve-space, preflight, artifacts, attendance, and export validation are existing plugin behaviors that need their own scored feature coverage.
- `05-03-capabilities-bundled-plugin-guides-p004-s012` | `plugins/google-meet` | `Tool`
  Recommendation: `new_feature`
  Source: `plugins/google-meet` :: `L1200 Tool`
  Target: `Google Meet plugin` / `Config, tool surface, and participation modes` / `google_meet tool actions`
  Closest existing: `Plugin SDK and bundled plugin architecture` / `Provider and tool plugins` / `Web search and fetch`
  Why: The tool section defines the agent-facing google_meet action surface and payloads, which is a first-class capability beyond the raw CLI.
- `05-03-capabilities-bundled-plugin-guides-p004-s013` | `plugins/google-meet` | `Agent and bidi modes`
  Recommendation: `new_feature`
  Source: `plugins/google-meet` :: `L1262 Agent and bidi modes`
  Target: `Google Meet plugin` / `Config, tool surface, and participation modes` / `Agent, bidi, and transcribe participation modes`
  Closest existing: `Google provider path` / `Plugin Distribution and Cross-surface Capability Adapters` / `Plugin Distribution and Cross-surface Capability Adapters`
  Why: Agent talk-back, bidi realtime voice fallback, and transcribe-only browser participation are distinct runtime modes that the taxonomy does not currently capture.
- `05-03-capabilities-bundled-plugin-guides-p004-s015` | `plugins/google-meet` | `Troubleshooting`
  Recommendation: `new_feature`
  Source: `plugins/google-meet` :: `L1381 Troubleshooting`
  Target: `Google Meet plugin` / `Diagnostics and live validation` / `Transport and join troubleshooting`
  Closest existing: `Google provider path` / `Plugin Distribution and Cross-surface Capability Adapters` / `Plugin Distribution and Cross-surface Capability Adapters`
  Why: The top-level troubleshooting block establishes supported failure handling for setup, node availability, browser joins, creation, speaking, and Twilio delegation.
- `05-03-capabilities-bundled-plugin-guides-p004-s016` | `plugins/google-meet` | `Agent cannot see the Google Meet tool`
  Recommendation: `new_feature`
  Source: `plugins/google-meet` :: `L1383 Agent cannot see the Google Meet tool`
  Target: `Google Meet plugin` / `Diagnostics and live validation` / `Transport and join troubleshooting`
  Closest existing: `Plugin SDK and bundled plugin architecture` / `Provider and tool plugins` / `Web search and fetch`
  Why: Tool-visibility failures are part of the plugin's supported troubleshooting surface and need to be scored with the rest of the diagnostics path.
- `05-03-capabilities-bundled-plugin-guides-p004-s017` | `plugins/google-meet` | `No connected Google Meet-capable node`
  Recommendation: `new_feature`
  Source: `plugins/google-meet` :: `L1402 No connected Google Meet-capable node`
  Target: `Google Meet plugin` / `Diagnostics and live validation` / `Transport and join troubleshooting`
  Closest existing: `Google provider path` / `Plugin Distribution and Cross-surface Capability Adapters` / `Plugin Distribution and Cross-surface Capability Adapters`
  Why: Node-availability diagnostics are a core part of the supported chrome-node workflow, not a generic existing capability.
- `05-03-capabilities-bundled-plugin-guides-p004-s018` | `plugins/google-meet` | `Browser opens but agent cannot join`
  Recommendation: `new_feature`
  Source: `plugins/google-meet` :: `L1454 Browser opens but agent cannot join`
  Target: `Google Meet plugin` / `Diagnostics and live validation` / `Transport and join troubleshooting`
  Closest existing: `Browser automation and exec/sandbox tools` / `Browser Plugin Service and Profiles` / `Browser Plugin Service and Profiles`
  Why: Browser join failures and manual-action boundaries are a plugin-specific troubleshooting path.
- `05-03-capabilities-bundled-plugin-guides-p004-s019` | `plugins/google-meet` | `Meeting creation fails`
  Recommendation: `new_feature`
  Source: `plugins/google-meet` :: `L1476 Meeting creation fails`
  Target: `Google Meet plugin` / `Diagnostics and live validation` / `Transport and join troubleshooting`
  Closest existing: `Google provider path` / `Plugin Distribution and Cross-surface Capability Adapters` / `Plugin Distribution and Cross-surface Capability Adapters`
  Why: Meeting creation failure handling belongs with the plugin's supported diagnostics contract.
- `05-03-capabilities-bundled-plugin-guides-p004-s020` | `plugins/google-meet` | `Agent joins but does not talk`
  Recommendation: `new_feature`
  Source: `plugins/google-meet` :: `L1505 Agent joins but does not talk`
  Target: `Google Meet plugin` / `Diagnostics and live validation` / `Transport and join troubleshooting`
  Closest existing: `Google provider path` / `Plugin Distribution and Cross-surface Capability Adapters` / `Plugin Distribution and Cross-surface Capability Adapters`
  Why: Agent joined-but-no-speech failure analysis is specific to the Meet audio bridge and provider integration.
- `05-03-capabilities-bundled-plugin-guides-p004-s021` | `plugins/google-meet` | `Twilio setup checks fail`
  Recommendation: `new_feature`
  Source: `plugins/google-meet` :: `L1563 Twilio setup checks fail`
  Target: `Google Meet plugin` / `Diagnostics and live validation` / `Transport and join troubleshooting`
  Closest existing: `CLI` / `Plugin and Channel Setup` / `Plugin install sources`
  Why: Twilio setup validation failures are specific to this plugin's Twilio transport path.
- `05-03-capabilities-bundled-plugin-guides-p004-s022` | `plugins/google-meet` | `Twilio call starts but never enters the meeting`
  Recommendation: `new_feature`
  Source: `plugins/google-meet` :: `L1646 Twilio call starts but never enters the meeting`
  Target: `Google Meet plugin` / `Diagnostics and live validation` / `Transport and join troubleshooting`
  Closest existing: `Google provider path` / `Plugin Distribution and Cross-surface Capability Adapters` / `Plugin Distribution and Cross-surface Capability Adapters`
  Why: Twilio call-start but no-meeting-entry failures are a Google Meet transport problem, not a generic voice-call diagnostic already owned elsewhere.
- `05-03-capabilities-bundled-plugin-guides-p004-s023` | `plugins/google-meet` | `Notes`
  Recommendation: `new_feature`
  Source: `plugins/google-meet` :: `L1691 Notes`
  Target: `Google Meet plugin` / `Config, tool surface, and participation modes` / `Audio bridge boundaries and session behavior`
  Closest existing: `Google provider path` / `Plugin Distribution and Cross-surface Capability Adapters` / `Plugin Distribution and Cross-surface Capability Adapters`
  Why: The Notes section captures important runtime boundaries: Chrome vs Twilio participation, agent-consult transcript forking, bridge command modes, and leave vs end-active-conference semantics.
- `05-03-capabilities-bundled-plugin-guides-p005-s002` | `plugins/workboard` | `What cards contain`
  Recommendation: `new_feature`
  Source: `plugins/workboard` :: `L40 What cards contain`
  Target: `Workboard plugin` / `Board and card lifecycle` / `Card schema, events, and persistence`
  Closest existing: `Plugin SDK and bundled plugin architecture` / `Bundled plugins` / `Bundled channel IDs`
  Why: Card fields, event history, attachments, proof, diagnostics, and local persistence are the core data model for Workboard and need explicit coverage.
- `05-03-capabilities-bundled-plugin-guides-p005-s003` | `plugins/workboard` | `Card executions`
  Recommendation: `new_feature`
  Source: `plugins/workboard` :: `L68 Card executions`
  Target: `Workboard plugin` / `Board and card lifecycle` / `Card-started session execution`
  Closest existing: `Plugin SDK and bundled plugin architecture` / `Bundled plugins` / `Bundled channel IDs`
  Why: Starting work from a card, engine/model selection, attempt summaries, and execution metadata are distinct Workboard behaviors not captured elsewhere.
- `05-03-capabilities-bundled-plugin-guides-p005-s005` | `plugins/workboard` | `Dispatch worker selection`
  Recommendation: `new_feature`
  Source: `plugins/workboard` :: `L171 Dispatch worker selection`
  Target: `Workboard plugin` / `Agent tools, claims, and dispatch` / `Dispatch worker selection`
  Closest existing: `Plugin SDK and bundled plugin architecture` / `Bundled plugins` / `Bundled channel IDs`
  Why: Worker selection rules for ready cards, owner/agent deduping, and active-claim avoidance are distinct orchestration behavior.
- `05-03-capabilities-bundled-plugin-guides-p005-s006` | `plugins/workboard` | `Worker prompt and lifecycle`
  Recommendation: `new_feature`
  Source: `plugins/workboard` :: `L183 Worker prompt and lifecycle`
  Target: `Workboard plugin` / `Agent tools, claims, and dispatch` / `Worker prompt, claim token, and lifecycle`
  Closest existing: `Plugin SDK and bundled plugin architecture` / `Bundled plugins` / `Bundled channel IDs`
  Why: Worker prompt contents, claim-token usage, deterministic session keys, and failure recording are specific Workboard dispatch mechanics.
- `05-03-capabilities-bundled-plugin-guides-p005-s007` | `plugins/workboard` | `Dispatch entry points`
  Recommendation: `new_feature`
  Source: `plugins/workboard` :: `L201 Dispatch entry points`
  Target: `Workboard plugin` / `Agent tools, claims, and dispatch` / `Dispatch entry points and data-only fallback`
  Closest existing: `Plugin SDK and bundled plugin architecture` / `Bundled plugins` / `Bundled channel IDs`
  Why: Dashboard, CLI, and slash-command dispatch plus the Gateway-offline data-only fallback are a distinct operator/runtime behavior.
- `05-03-capabilities-bundled-plugin-guides-p005-s009` | `plugins/workboard` | `Session lifecycle sync`
  Recommendation: `new_feature`
  Source: `plugins/workboard` :: `L250 Session lifecycle sync`
  Target: `Workboard plugin` / `Operator UI and CLI workflows` / `Session lifecycle sync`
  Closest existing: `Automation: cron, hooks, tasks, polling` / `Plugin Hooks` / `Plugin Hooks`
  Why: Automatic card state updates from linked session lifecycle are a distinct Workboard integration behavior.
- `05-03-capabilities-bundled-plugin-guides-p005-s010` | `plugins/workboard` | `Dashboard workflow`
  Recommendation: `new_feature`
  Source: `plugins/workboard` :: `L277 Dashboard workflow`
  Target: `Workboard plugin` / `Operator UI and CLI workflows` / `Dashboard board workflow`
  Closest existing: `Plugin SDK and bundled plugin architecture` / `Bundled plugins` / `Bundled channel IDs`
  Why: The dashboard-driven create/drag/start/review/done workflow is a specific UI capability of the plugin.
- `05-03-capabilities-bundled-plugin-guides-p005-s011` | `plugins/workboard` | `Permissions`
  Recommendation: `new_feature`
  Source: `plugins/workboard` :: `L300 Permissions`
  Target: `Workboard plugin` / `Operator UI and CLI workflows` / `RPC permissions and operator scopes`
  Closest existing: `Plugin SDK and bundled plugin architecture` / `Bundled plugins` / `Bundled channel IDs`
  Why: The workboard.\* RPC namespace and its read/write permission split are an explicit supported surface for operators and clients.
- `05-03-capabilities-bundled-plugin-guides-p005-s012` | `plugins/workboard` | `Configuration`
  Recommendation: `new_feature`
  Source: `plugins/workboard` :: `L318 Configuration`
  Target: `Workboard plugin` / `Operator UI and CLI workflows` / `Plugin enablement config`
  Closest existing: `Plugin SDK and bundled plugin architecture` / `Bundled plugins` / `Bundled channel IDs`
  Why: Although minimal, the enable/disable config is still part of the operator surface for Workboard.
- `05-03-capabilities-bundled-plugin-guides-p005-s014` | `plugins/workboard` | `The tab says Workboard is unavailable`
  Recommendation: `new_feature`
  Source: `plugins/workboard` :: `L345 The tab says Workboard is unavailable`
  Target: `Workboard plugin` / `Diagnostics and recovery` / `Workboard troubleshooting`
  Closest existing: `Plugin SDK and bundled plugin architecture` / `Authoring plugins` / `Root SDK entrypoint`
  Why: Plugin-unavailable troubleshooting is specific to Workboard policy and runtime wiring.
- `05-03-capabilities-bundled-plugin-guides-p005-s015` | `plugins/workboard` | `Cards do not save`
  Recommendation: `new_feature`
  Source: `plugins/workboard` :: `L356 Cards do not save`
  Target: `Workboard plugin` / `Diagnostics and recovery` / `Workboard troubleshooting`
  Closest existing: `Plugin SDK and bundled plugin architecture` / `Bundled plugins` / `Bundled channel IDs`
  Why: Card-save failures document the operator.write boundary for this plugin.
- `05-03-capabilities-bundled-plugin-guides-p005-s016` | `plugins/workboard` | `Starting a card does not open the expected session`
  Recommendation: `new_feature`
  Source: `plugins/workboard` :: `L361 Starting a card does not open the expected session`
  Target: `Workboard plugin` / `Diagnostics and recovery` / `Workboard troubleshooting`
  Closest existing: `Browser automation and exec/sandbox tools` / `Browser Plugin Service and Profiles` / `Browser Plugin Service and Profiles`
  Why: Linked-session mismatch handling belongs with the Workboard diagnostics contract.
- `05-03-capabilities-bundled-plugin-guides-p005-s017` | `plugins/workboard` | `Dispatch does not start a worker`
  Recommendation: `new_feature`
  Source: `plugins/workboard` :: `L367 Dispatch does not start a worker`
  Target: `Workboard plugin` / `Diagnostics and recovery` / `Workboard troubleshooting`
  Closest existing: `Plugin SDK and bundled plugin architecture` / `Bundled plugins` / `Bundled channel IDs`
  Why: Dispatch-not-starting behavior and data-only fallback diagnosis are specific to Workboard orchestration.
- `05-03-capabilities-bundled-plugin-guides-p009-s001` | `plugins/memory-wiki` | `What it adds`
  Recommendation: `new_feature`
  Source: `plugins/memory-wiki` :: `L21 What it adds`
  Target: `Session, memory, and context engine` / `Compiled wiki vaults, claims, and dashboards` / `Compiled wiki pages, claims, and digests`
  Closest existing: `Google provider path` / `Plugin Distribution and Cross-surface Capability Adapters` / `Plugin Distribution and Cross-surface Capability Adapters`
  Why: The plugin's added capabilities—deterministic vault layout, claim metadata, digests, wiki-native tools, and dashboards—are not captured by existing memory categories.
- `05-03-capabilities-bundled-plugin-guides-p009-s002` | `plugins/memory-wiki` | `How it fits with memory`
  Recommendation: `new_feature`
  Source: `plugins/memory-wiki` :: `L31 How it fits with memory`
  Target: `Session, memory, and context engine` / `Compiled wiki vaults, claims, and dashboards` / `Active-memory and wiki layering`
  Closest existing: `Google provider path` / `Plugin Distribution and Cross-surface Capability Adapters` / `Plugin Distribution and Cross-surface Capability Adapters`
  Why: The explicit split between active memory runtime ownership and wiki compilation is a product boundary missing from the current taxonomy.
- `05-03-capabilities-bundled-plugin-guides-p009-s003` | `plugins/memory-wiki` | `Recommended hybrid pattern`
  Recommendation: `new_feature`
  Source: `plugins/memory-wiki` :: `L46 Recommended hybrid pattern`
  Target: `Session, memory, and context engine` / `Compiled wiki vaults, claims, and dashboards` / `Hybrid recall plus wiki workflow`
  Closest existing: `Google provider path` / `Plugin Distribution and Cross-surface Capability Adapters` / `Plugin Distribution and Cross-surface Capability Adapters`
  Why: The recommended QMD-plus-wiki pattern describes a supported hybrid operating mode that existing memory categories do not call out.
- `05-03-capabilities-bundled-plugin-guides-p009-s005` | `plugins/memory-wiki` | `isolated`
  Recommendation: `new_feature`
  Source: `plugins/memory-wiki` :: `L78 `isolated``Target:`Session, memory, and context engine`/`Vault modes and bridge ingestion`/`Isolated vault mode`Closest existing:`Google provider path`/`Plugin Distribution and Cross-surface Capability Adapters`/`Plugin Distribution and Cross-surface Capability Adapters`
  Why: A fully isolated wiki vault is a distinct supported mode of operation for the plugin.
- `05-03-capabilities-bundled-plugin-guides-p009-s006` | `plugins/memory-wiki` | `bridge`
  Recommendation: `new_feature`
  Source: `plugins/memory-wiki` :: `L84 `bridge``Target:`Session, memory, and context engine`/`Vault modes and bridge ingestion`/`Bridge mode imports and event following`Closest existing:`Google provider path`/`Plugin Distribution and Cross-surface Capability Adapters`/`Plugin Distribution and Cross-surface Capability Adapters`
  Why: Bridge-mode import of memory artifacts, dream reports, daily notes, memory roots, and event logs is a specific capability missing from current taxonomy.
- `05-03-capabilities-bundled-plugin-guides-p009-s007` | `plugins/memory-wiki` | `unsafe-local`
  Recommendation: `new_feature`
  Source: `plugins/memory-wiki` :: `L100 `unsafe-local``Target:`Session, memory, and context engine`/`Vault modes and bridge ingestion`/`Unsafe-local filesystem mode`Closest existing:`Browser automation and exec/sandbox tools`/`Browser Plugin Service and Profiles`/`Browser Plugin Service and Profiles`
  Why: The same-machine escape hatch is a distinct mode with its own trust boundary.
- `05-03-capabilities-bundled-plugin-guides-p009-s008` | `plugins/memory-wiki` | `Vault layout`
  Recommendation: `new_feature`
  Source: `plugins/memory-wiki` :: `L108 Vault layout`
  Target: `Session, memory, and context engine` / `Compiled wiki vaults, claims, and dashboards` / `Deterministic vault layout`
  Closest existing: `Google provider path` / `Plugin Distribution and Cross-surface Capability Adapters` / `Plugin Distribution and Cross-surface Capability Adapters`
  Why: The managed vault layout and preserved human blocks are part of the wiki product surface and are not reflected today.
- `05-03-capabilities-bundled-plugin-guides-p009-s010` | `plugins/memory-wiki` | `Agent-facing entity metadata`
  Recommendation: `new_feature`
  Source: `plugins/memory-wiki` :: `L166 Agent-facing entity metadata`
  Target: `Session, memory, and context engine` / `Claims, evidence, and provenance` / `Agent routing entity metadata`
  Closest existing: `Google provider path` / `Plugin Distribution and Cross-surface Capability Adapters` / `Plugin Distribution and Cross-surface Capability Adapters`
  Why: Entity frontmatter for routing, aliases, privacy tiers, and relationship edges is specific wiki-layer functionality not currently scored.
- `05-03-capabilities-bundled-plugin-guides-p009-s012` | `plugins/memory-wiki` | `Dashboards and health reports`
  Recommendation: `new_feature`
  Source: `plugins/memory-wiki` :: `L255 Dashboards and health reports`
  Target: `Session, memory, and context engine` / `Compile pipeline and agent digests` / `Dashboard and health report generation`
  Closest existing: `Google provider path` / `Plugin Distribution and Cross-surface Capability Adapters` / `Plugin Distribution and Cross-surface Capability Adapters`
  Why: Generated open-question, contradiction, freshness, privacy, and relationship dashboards are part of the compiled wiki layer and are not covered today.
- `05-03-capabilities-bundled-plugin-guides-p009-s014` | `plugins/memory-wiki` | `Agent tools`
  Recommendation: `new_feature`
  Source: `plugins/memory-wiki` :: `L329 Agent tools`
  Target: `Session, memory, and context engine` / `Wiki search and retrieval` / `Wiki agent tools`
  Closest existing: `Session, memory, and context engine` / `Memory Files, Tools, and Active Memory` / `Memory Files, Tools, and Active Memory`
  Why: wiki_status, wiki_search, wiki_get, wiki_apply, and wiki_lint are first-class agent/runtime tools missing from the current taxonomy.
- `05-03-capabilities-bundled-plugin-guides-p009-s015` | `plugins/memory-wiki` | `Prompt and context behavior`
  Recommendation: `new_feature`
  Source: `plugins/memory-wiki` :: `L353 Prompt and context behavior`
  Target: `Session, memory, and context engine` / `Wiki search and retrieval` / `Compiled digest prompt supplements`
  Closest existing: `Session, memory, and context engine` / `Memory Files, Tools, and Active Memory` / `Memory Files, Tools, and Active Memory`
  Why: Opt-in prompt supplements from compiled digests are a distinct integration point between the wiki and context assembly.
- `05-03-capabilities-bundled-plugin-guides-p009-s017` | `plugins/memory-wiki` | `Example: QMD + bridge mode`
  Recommendation: `new_feature`
  Source: `plugins/memory-wiki` :: `L435 Example: QMD + bridge mode`
  Target: `Session, memory, and context engine` / `Configuration and editor integration` / `QMD bridge configuration pattern`
  Closest existing: `Google provider path` / `Plugin Distribution and Cross-surface Capability Adapters` / `Plugin Distribution and Cross-surface Capability Adapters`
  Why: The QMD bridge-mode example is a concrete supported configuration pattern unique to this plugin.
- `05-03-capabilities-bundled-plugin-guides-p009-s018` | `plugins/memory-wiki` | `CLI`
  Recommendation: `new_feature`
  Source: `plugins/memory-wiki` :: `L479 CLI`
  Target: `Session, memory, and context engine` / `Configuration and editor integration` / `openclaw wiki CLI`
  Closest existing: `Google provider path` / `Plugin Distribution and Cross-surface Capability Adapters` / `Plugin Distribution and Cross-surface Capability Adapters`
  Why: The openclaw wiki CLI surface is a distinct operator workflow for this plugin.
- `05-03-capabilities-bundled-plugin-guides-p009-s019` | `plugins/memory-wiki` | `Obsidian support`
  Recommendation: `new_feature`
  Source: `plugins/memory-wiki` :: `L499 Obsidian support`
  Target: `Session, memory, and context engine` / `Configuration and editor integration` / `Obsidian render mode and CLI integration`
  Closest existing: `Google provider path` / `Plugin Distribution and Cross-surface Capability Adapters` / `Plugin Distribution and Cross-surface Capability Adapters`
  Why: Obsidian-friendly rendering and optional CLI support are specific integration features of the wiki layer.
- `05-03-capabilities-bundled-plugin-guides-p011-s001` | `plugins/oc-path` | `Why enable it`
  Recommendation: `new_feature`
  Source: `plugins/oc-path` :: `L29 Why enable it`
  Target: `CLI` / `Workspace path addressing and leaf edits` / `Cross-format leaf inspection and edit workflows`
  Closest existing: `Google provider path` / `Plugin Distribution and Cross-surface Capability Adapters` / `Plugin Distribution and Cross-surface Capability Adapters`
  Why: The motivation section defines the core user-visible value: deterministic leaf reads/writes across multiple workspace file kinds.
- `05-03-capabilities-bundled-plugin-guides-p011-s002` | `plugins/oc-path` | `Where it runs`
  Recommendation: `new_feature`
  Source: `plugins/oc-path` :: `L75 Where it runs`
  Target: `CLI` / `Workspace path addressing and leaf edits` / `CLI-local lazy-loaded runtime`
  Closest existing: `Google provider path` / `Plugin Distribution and Cross-surface Capability Adapters` / `Plugin Distribution and Cross-surface Capability Adapters`
  Why: The plugin's in-process, no-Gateway, lazy-loaded runtime model is part of the supported CLI behavior for this feature area.
- `05-03-capabilities-bundled-plugin-guides-p011-s003` | `plugins/oc-path` | `Enable`
  Recommendation: `new_feature`
  Source: `plugins/oc-path` :: `L99 Enable`
  Target: `CLI` / `Workspace path addressing and leaf edits` / `Plugin enablement for path CLI`
  Closest existing: `Google provider path` / `Plugin Distribution and Cross-surface Capability Adapters` / `Plugin Distribution and Cross-surface Capability Adapters`
  Why: Explicit enable/disable behavior for the path command is part of the operator surface.
- `05-03-capabilities-bundled-plugin-guides-p011-s004` | `plugins/oc-path` | `Dependencies`
  Recommendation: `new_feature`
  Source: `plugins/oc-path` :: `L115 Dependencies`
  Target: `CLI` / `Workspace path addressing and leaf edits` / `Plugin-local parser dependencies`
  Closest existing: `Plugin SDK and bundled plugin architecture` / `Bundled plugins` / `Bundled channel IDs`
  Why: The dependency-local parse stack and file-kind support are part of the feature contract for oc-path and do not fit any current CLI category.
- `05-03-capabilities-bundled-plugin-guides-p011-s005` | `plugins/oc-path` | `What it provides`
  Recommendation: `new_feature`
  Source: `plugins/oc-path` :: `L130 What it provides`
  Target: `CLI` / `Workspace path addressing and leaf edits` / `Resolve, find, set, and emit operations`
  Closest existing: `Google provider path` / `Plugin Distribution and Cross-surface Capability Adapters` / `Plugin Distribution and Cross-surface Capability Adapters`
  Why: The concrete CLI and substrate operations exposed by the plugin are the heart of the missing category.
- `05-03-capabilities-bundled-plugin-guides-p011-s006` | `plugins/oc-path` | `Relationship to other plugins`
  Recommendation: `new_feature`
  Source: `plugins/oc-path` :: `L143 Relationship to other plugins`
  Target: `CLI` / `Workspace path addressing and leaf edits` / `Boundary with memory and LKG workflows`
  Closest existing: `ClawHub` / `Compatibility Gates and Official External Catalog` / `Official external plugin catalog behavior`
  Why: The explicit separation from memory semantics and LKG promotion/recovery is part of the supported behavior boundary for this CLI surface.
- `05-03-capabilities-bundled-plugin-guides-p011-s007` | `plugins/oc-path` | `Safety`
  Recommendation: `new_feature`
  Source: `plugins/oc-path` :: `L153 Safety`
  Target: `CLI` / `Workspace path addressing and leaf edits` / `Redaction sentinel write guard`
  Closest existing: `Security, auth, pairing, and secrets` / `Plugin Installation Trust and Security Boundaries` / `Plugin Installation Trust and Security Boundaries`
  Why: The sentinel-guard safety behavior is a concrete user-visible capability of this CLI surface.
- `05-04-capabilities-building-plugins-p005-s002` | `plugins/cli-backend-plugins` | `Minimal backend plugin`
  Recommendation: `new_feature`
  Source: `plugins/cli-backend-plugins` :: `L43 Minimal backend plugin`
  Target: `Plugin SDK and bundled plugin architecture` / `CLI backend plugins` / `CLI backend registration and ownership`
  Closest existing: `Plugin SDK and bundled plugin architecture` / `Packaging plugins` / `Plugin manifest`
  Why: The minimal example covers `openclaw.plugin.json` `cliBackends`, `setup.cliBackends`, `activation`, and `api.registerCliBackend(...)` ownership rules. That authoring workflow is not represented by existing packaging or provider-tool features.
- `05-04-capabilities-building-plugins-p005-s003` | `plugins/cli-backend-plugins` | `Config shape`
  Recommendation: `new_feature`
  Source: `plugins/cli-backend-plugins` :: `L171 Config shape`
  Target: `Plugin SDK and bundled plugin architecture` / `CLI backend plugins` / `CLI backend config shape`
  Closest existing: `CLI` / `Doctor` / `Auth and SecretRef checks`
  Why: This section defines the `CliBackendConfig` contract: command/argv, parser modes, prompt transport, session handling, image support, serialization, and watchdog tuning. Current taxonomy does not capture the author-facing config schema for CLI backend plugins.
- `05-04-capabilities-building-plugins-p005-s004` | `plugins/cli-backend-plugins` | `Advanced backend hooks`
  Recommendation: `new_feature`
  Source: `plugins/cli-backend-plugins` :: `L196 Advanced backend hooks`
  Target: `Plugin SDK and bundled plugin architecture` / `CLI backend plugins` / `CLI backend execution hooks`
  Closest existing: `Anthropic provider path` / `Claude CLI Runtime and Session Bridge` / `Claude CLI Runtime and Session Bridge`
  Why: `normalizeConfig`, `resolveExecutionArgs`, `prepareExecution`, `transformSystemPrompt`, `textTransforms`, auth epoch behavior, and native-tool mode are backend-specific execution hooks that do not fit existing generic authoring or provider-plugin features.
- `05-04-capabilities-building-plugins-p005-s005` | `plugins/cli-backend-plugins` | `MCP tool bridge`
  Recommendation: `new_feature`
  Source: `plugins/cli-backend-plugins` :: `L215 MCP tool bridge`
  Target: `Plugin SDK and bundled plugin architecture` / `CLI backend plugins` / `CLI backend MCP tool bridge`
  Closest existing: `Anthropic provider path` / `Claude CLI Runtime and Session Bridge` / `Claude CLI Runtime and Session Bridge`
  Why: The page documents `bundleMcp`, `bundleMcpMode`, supported bridge modes, and fail-closed interaction with `nativeToolMode`. That is a discrete CLI backend authoring capability not modeled in the current Plugin SDK taxonomy.
- `05-04-capabilities-building-plugins-p005-s006` | `plugins/cli-backend-plugins` | `User configuration`
  Recommendation: `new_feature`
  Source: `plugins/cli-backend-plugins` :: `L245 User configuration`
  Target: `Plugin SDK and bundled plugin architecture` / `CLI backend plugins` / `CLI backend user override merge`
  Closest existing: `Anthropic provider path` / `Claude CLI Runtime and Session Bridge` / `Claude CLI Runtime and Session Bridge`
  Why: This section documents how runtime defaults from the plugin are merged with user configuration under `agents.defaults.cliBackends.<id>` and how model fallbacks consume those ids. That user-override merge behavior is specific to CLI backend plugins and is not represented elsewhere.
- `05-04-capabilities-building-plugins-p005-s007` | `plugins/cli-backend-plugins` | `Verification`
  Recommendation: `new_feature`
  Source: `plugins/cli-backend-plugins` :: `L274 Verification`
  Target: `Plugin SDK and bundled plugin architecture` / `CLI backend plugins` / `CLI backend verification and live smoke`
  Closest existing: `Anthropic provider path` / `Claude CLI Runtime and Session Bridge` / `Claude CLI Runtime and Session Bridge`
  Why: The verification guidance is specific to CLI backend plugins: targeted builder/setup tests, `plugins inspect --runtime`, real model turns, and extra live smoke for image or MCP paths. Existing testing taxonomy is too generic to express this backend-specific proof surface.
- `05-07-capabilities-tools-p011-root` | `tools/llm-task` | `(page)`
  Recommendation: `new_feature`
  Source: `tools/llm-task` :: `(page)`
  Target: `Automation: cron, hooks, tasks, polling` / `Task Flow Orchestration` / `Schema-validated LLM Task Steps`
  Closest existing: `Media understanding and media generation` / `Media Understanding Orchestration and Configuration` / `In scope`
  Why: Workflow-safe JSON-only LLM steps are mentioned indirectly via automation/Lobster docs, but the feature itself is not named in taxonomy.
- `05-07-capabilities-tools-p019-root` | `tools/tool-search` | `(page)`
  Recommendation: `new_feature`
  Source: `tools/tool-search` :: `(page)`
  Target: `Agent runtime and provider execution` / `Tool Execution Controls` / `Tool Search and Deferred Schema Loading`
  Closest existing: `Plugin SDK and bundled plugin architecture` / `Provider and tool plugins` / `Web search and fetch`
  Why: Deferred search/describe/call tool exposure is an agent-runtime capability missing from the current feature inventory.
- `05-07-capabilities-tools-p021-root` | `tools/trajectory` | `(page)`
  Recommendation: `new_feature`
  Source: `tools/trajectory` :: `(page)`
  Target: `Observability` / `Diagnostics Export and Support Bundles` / `Per-session Trajectory Export Bundles`
  Closest existing: `Security, auth, pairing, and secrets` / `Plugin Installation Trust and Security Boundaries` / `Plugin Installation Trust and Security Boundaries`
  Why: Per-session flight-recorder export is adjacent to diagnostics bundles, but not explicitly modeled in the current taxonomy.
- `05-08-capabilities-agent-coordination-p002-root` | `tools/goal` | `(page)`
  Recommendation: `new_feature`
  Source: `tools/goal` :: `(page)`
  Target: `Session, memory, and context engine` / `Cross-client History and Session Parity` / `Session goals and objective state`
  Closest existing: `Feishu, QQ Bot, WeChat, Yuanbao, Zalo, Zalo Personal, regional channels` / `Feishu / Lark Channel` / `Feishu document`
  Why: The current candidate is unrelated. This page defines durable per-session goal state shared across transports and tools, which the existing taxonomy does not model.
- `05-08-capabilities-agent-coordination-p002-s006` | `tools/goal` | `Token budgets`
  Recommendation: `new_feature`
  Source: `tools/goal` :: `L129 Token budgets`
  Target: `Session, memory, and context engine` / `Cross-client History and Session Parity` / `Goal token budgets and limit states`
  Closest existing: `Browser automation and exec/sandbox tools` / `Sandboxed Browser and Codex Dynamic Tools` / `Sandboxed Browser and Codex Dynamic Tools`
  Why: Token-budget tracking is a missing session-goal capability; the current browser sandbox candidate is unrelated.
- `05-08-capabilities-agent-coordination-p002-s007` | `tools/goal` | `Model tools`
  Recommendation: `new_feature`
  Source: `tools/goal` :: `L146 Model tools`
  Target: `Session, memory, and context engine` / `Cross-client History and Session Parity` / `Goal tool APIs for agents`
  Closest existing: `OpenAI / Codex provider path` / `Native Codex App-server Harness and Thread Lifecycle` / `Native Codex App-server Harness and Thread Lifecycle`
  Why: The section is about `get_goal`, `create_goal`, and `update_goal`, not the native Codex thread lifecycle candidate it currently matches.
- `05-08-capabilities-agent-coordination-p006-s010` | `tools/acp-agents-setup` | `Permission configuration`
  Recommendation: `new_feature`
  Source: `tools/acp-agents-setup` :: `L305 Permission configuration`
  Target: `Agent runtime and provider execution` / `Tool Execution Controls` / `ACP harness permission modes`
  Closest existing: `Discord` / `Bot Setup and Account Configuration` / `Bot Setup and Account Configuration`
  Why: ACP permission handling is its own harness-level control surface and should override the unrelated Discord setup candidate.
- `08-02-platforms-macos-companion-app-p016-root` | `platforms/mac/skills` | `(page)`
  Recommendation: `new_feature`
  Source: `platforms/mac/skills` :: `(page)`
  Target: `macOS companion app` / `Settings, Health, Channels, and Diagnostics` / `Gateway-backed skills management`
  Closest existing: `Linux companion app` / `Node-host Capabilities, Desktop Tools, and Exec Approvals` / `Adjacent out-of-scope surfaces`
  Why: The page documents a user-facing macOS app settings area for browsing skill eligibility, running gateway-host installs, and editing per-skill API key/env state. The current category covers settings navigation and channels/health, but it does not yet model Skills settings as a scoreable capability.
- `09-03-gateway-ops-security-p001-root` | `security/network-proxy` | `(page)`
  Recommendation: `new_feature`
  Source: `security/network-proxy` :: `(page)`
  Target: `Gateway runtime` / `Security Controls` / `Managed outbound proxy routing`
  Closest existing: `Security, auth, pairing, and secrets` / `Gateway Auth and Network Exposure` / `Device identity`
  Why: The page is a dedicated operator guide for routing runtime HTTP/WebSocket egress through an external filtering proxy, which is not represented by any current Gateway runtime feature.
- `09-03-gateway-ops-security-p001-s001` | `security/network-proxy` | `Why use a proxy`
  Recommendation: `new_feature`
  Source: `security/network-proxy` :: `L13 Why use a proxy`
  Target: `Gateway runtime` / `Security Controls` / `Managed outbound proxy routing`
  Closest existing: `Security, auth, pairing, and secrets` / `Gateway Auth and Network Exposure` / `Device identity`
  Why: This section defines the operator-facing value proposition for managed proxy egress control, DNS rebinding defense, and centralized SSRF hardening, all of which belong to the missing outbound proxy capability.
- `09-03-gateway-ops-security-p001-s002` | `security/network-proxy` | `How OpenClaw routes traffic`
  Recommendation: `new_feature`
  Source: `security/network-proxy` :: `L26 How OpenClaw routes traffic`
  Target: `Gateway runtime` / `Security Controls` / `Managed outbound proxy routing`
  Closest existing: `Security, auth, pairing, and secrets` / `Gateway Auth and Network Exposure` / `Device identity`
  Why: The routing contract for Gateway, node, and local agent traffic, including loopback control-plane exceptions, is core behavior of the missing managed proxy feature.
- `09-03-gateway-ops-security-p001-s003` | `security/network-proxy` | `Related proxy terms`
  Recommendation: `new_feature`
  Source: `security/network-proxy` :: `L54 Related proxy terms`
  Target: `Gateway runtime` / `Security Controls` / `Managed outbound proxy routing`
  Closest existing: `Security, auth, pairing, and secrets` / `Gateway Auth and Network Exposure` / `Device identity`
  Why: The terminology split between outbound forward-proxy routing, inbound trusted-proxy auth, and tool-specific env proxies documents the feature boundary that taxonomy does not currently capture.
- `09-03-gateway-ops-security-p001-s004` | `security/network-proxy` | `Configuration`
  Recommendation: `new_feature`
  Source: `security/network-proxy` :: `L62 Configuration`
  Target: `Gateway runtime` / `Security Controls` / `Managed outbound proxy routing`
  Closest existing: `Security, auth, pairing, and secrets` / `Gateway Auth and Network Exposure` / `Device identity`
  Why: The explicit `proxy.enabled`, `proxy.proxyUrl`, and TLS configuration surface is operator-visible product behavior and should be scored as part of the missing proxy feature.
- `09-03-gateway-ops-security-p001-s005` | `security/network-proxy` | `Gateway Loopback Mode`
  Recommendation: `new_feature`
  Source: `security/network-proxy` :: `L88 Gateway Loopback Mode`
  Target: `Gateway runtime` / `Security Controls` / `Managed outbound proxy routing`
  Closest existing: `Security, auth, pairing, and secrets` / `Gateway Auth and Network Exposure` / `gateway.auth.mode`
  Why: `proxy.loopbackMode` is a specific policy knob for managed proxy routing and does not fit existing inbound network-exposure or pairing features.
- `09-03-gateway-ops-security-p001-s006` | `security/network-proxy` | `Proxy Requirements`
  Recommendation: `new_feature`
  Source: `security/network-proxy` :: `L118 Proxy Requirements`
  Target: `Gateway runtime` / `Security Controls` / `Managed outbound proxy routing`
  Closest existing: `Security, auth, pairing, and secrets` / `Gateway Auth and Network Exposure` / `Device identity`
  Why: Proxy-side policy requirements are part of the operator contract for the managed egress-control feature and are not covered by current security-control feature names.
- `09-03-gateway-ops-security-p001-s007` | `security/network-proxy` | `Recommended blocked destinations`
  Recommendation: `new_feature`
  Source: `security/network-proxy` :: `L133 Recommended blocked destinations`
  Target: `Gateway runtime` / `Security Controls` / `Managed outbound proxy routing`
  Closest existing: `Security, auth, pairing, and secrets` / `Gateway Auth and Network Exposure` / `Device identity`
  Why: The denylist guidance is feature-specific operational policy for the managed outbound proxy path rather than general Gateway exposure guidance.
- `09-03-gateway-ops-security-p001-s008` | `security/network-proxy` | `Validation`
  Recommendation: `new_feature`
  Source: `security/network-proxy` :: `L160 Validation`
  Target: `Gateway runtime` / `Security Controls` / `Managed outbound proxy routing`
  Closest existing: `Security, auth, pairing, and secrets` / `Gateway Auth and Network Exposure` / `Trusted-proxy identity`
  Why: `openclaw proxy validate` is the verification and diagnostics path for this specific proxy-routing capability, so it should live with the missing feature rather than generic health checks.
- `09-03-gateway-ops-security-p001-s009` | `security/network-proxy` | `Proxy CA trust`
  Recommendation: `new_feature`
  Source: `security/network-proxy` :: `L214 Proxy CA trust`
  Target: `Gateway runtime` / `Security Controls` / `Managed outbound proxy routing`
  Closest existing: `Local model providers: Ollama, vLLM, SGLang, LM Studio` / `Safety Network and Prompt Pressure Controls` / `Safety Network and Prompt Pressure Controls`
  Why: Private-CA trust for the proxy endpoint is scoped behavior of managed proxy routing, not the existing TLS-pinning or inbound-auth categories.
- `09-03-gateway-ops-security-p001-s010` | `security/network-proxy` | `Limits`
  Recommendation: `new_feature`
  Source: `security/network-proxy` :: `L249 Limits`
  Target: `Gateway runtime` / `Security Controls` / `Managed outbound proxy routing`
  Closest existing: `Security, auth, pairing, and secrets` / `Gateway Auth and Network Exposure` / `Device identity`
  Why: The limits section defines the supported boundary of managed process-level proxy routing and confirms this is a distinct Gateway security capability.
- `10-01-reference-cli-commands-p022-s004` | `cli/memory` | `Dreaming`
  Recommendation: `new_feature`
  Source: `cli/memory` :: `L128 Dreaming`
  Target: `Session, memory, and context engine` / `Memory Files, Tools, and Active Memory` / `Dreaming and durable promotion`
  Closest existing: `Session, memory, and context engine` / `CLI Session and Transcript Management` / `CLI Session and Transcript Management`
  Why: Current category lacks a named feature for Dreaming and durable promotion.
- `10-02-reference-rpc-and-api-p001-root` | `reference/rpc` | `(page)`
  Recommendation: `new_feature`
  Source: `reference/rpc` :: `(page)`
  Target: `Channel framework` / `Registry Runtime Lifecycle` / `External JSON-RPC adapter patterns`
  Closest existing: `Agent runtime and provider execution` / `Hosted Provider Execution` / `Hosted streaming and replies`
  Why: The page-level summary documents Gateway-owned lifecycle and transport patterns for external JSON-RPC channel adapters, which is shared adapter guidance not explicitly modeled in the current Channel framework taxonomy.
- `10-02-reference-rpc-and-api-p001-s003` | `reference/rpc` | `Adapter guidelines`
  Recommendation: `new_feature`
  Source: `reference/rpc` :: `L35 Adapter guidelines`
  Target: `Channel framework` / `Registry Runtime Lifecycle` / `External JSON-RPC adapter patterns`
  Closest existing: `Google provider path` / `Plugin Distribution and Cross-surface Capability Adapters` / `Plugin Distribution and Cross-surface Capability Adapters`
  Why: Shared adapter guidance such as Gateway-owned process lifecycle, restart resilience, and stable identifier preference is not called out as its own feature in the current Channel framework taxonomy.
- `10-02-reference-rpc-and-api-p001-s004` | `reference/rpc` | `Related`
  Recommendation: `new_feature`
  Source: `reference/rpc` :: `L41 Related`
  Target: `Channel framework` / `Registry Runtime Lifecycle` / `External JSON-RPC adapter patterns`
  Closest existing: `CLI` / `Updates and Upgrades` / `Update status and RPC`
  Why: The related link points back to Gateway protocol context for the same external adapter pattern, so it fits the same missing shared adapter feature rather than a new surface.
- `10-02-reference-rpc-and-api-p005-root` | `reference/device-models` | `(page)`
  Recommendation: `new_feature`
  Source: `reference/device-models` :: `(page)`
  Target: `macOS companion app` / `Menu Status and Dashboard` / `Friendly device model names in Instances UI`
  Closest existing: `Gateway runtime` / `Core Rpc Coverage` / `Model catalog`
  Why: The macOS companion-app taxonomy covers dashboard and menu status, but it does not currently call out the vendored device-model database that makes Instances UI node names human-readable.
- `10-02-reference-rpc-and-api-p005-s001` | `reference/device-models` | `Data source`
  Recommendation: `new_feature`
  Source: `reference/device-models` :: `L15 Data source`
  Target: `macOS companion app` / `Menu Status and Dashboard` / `Friendly device model names in Instances UI`
  Closest existing: `Gateway runtime` / `Core Rpc Coverage` / `Model catalog`
  Why: The upstream source and pinned-commit policy support the same missing Instances UI naming feature rather than a separate surface or category.
- `10-02-reference-rpc-and-api-p005-s002` | `reference/device-models` | `Updating the database`
  Recommendation: `new_feature`
  Source: `reference/device-models` :: `L23 Updating the database`
  Target: `macOS companion app` / `Menu Status and Dashboard` / `Friendly device model names in Instances UI`
  Closest existing: `Gateway runtime` / `Core Rpc Coverage` / `Model catalog`
  Why: The update procedure is maintainer-facing operational detail for the same missing friendly-device-name feature in the macOS companion app.
- `10-02-reference-rpc-and-api-p005-s003` | `reference/device-models` | `Related`
  Recommendation: `new_feature`
  Source: `reference/device-models` :: `L47 Related`
  Target: `macOS companion app` / `Menu Status and Dashboard` / `Friendly device model names in Instances UI`
  Closest existing: `Gateway runtime` / `Core Rpc Coverage` / `Model catalog`
  Why: The related node links are navigation around the same missing Instances UI naming feature rather than evidence of a different surface.
- `10-05-reference-plugin-sdk-reference-p005-s002` | `plugins/sdk-agent-harness` | `What core still owns`
  Recommendation: `new_feature`
  Source: `plugins/sdk-agent-harness` :: `L34 What core still owns`
  Target: `Plugin SDK and bundled plugin architecture` / `Agent harness plugins` / `Host-owned runtime plan boundaries`
  Closest existing: `OpenAI / Codex provider path` / `Native Codex App-server Harness and Thread Lifecycle` / `Native Codex App-server Harness and Thread Lifecycle`
  Why: The candidate leans on the Codex-specific harness lifecycle, but the section defines the generic host-owned runtime-plan boundary for all harness plugins.
- `10-05-reference-plugin-sdk-reference-p005-s003` | `plugins/sdk-agent-harness` | `Register a harness`
  Recommendation: `new_feature`
  Source: `plugins/sdk-agent-harness` :: `L66 Register a harness`
  Target: `Plugin SDK and bundled plugin architecture` / `Agent harness plugins` / `Harness registration and supports contract`
  Closest existing: `Plugin SDK and bundled plugin architecture` / `Authoring plugins` / `Entrypoint discovery`
  Why: This is not generic entrypoint discovery; it is the specific registration contract for harness plugins.
- `10-05-reference-plugin-sdk-reference-p005-s005` | `plugins/sdk-agent-harness` | `Provider plus harness pairing`
  Recommendation: `new_feature`
  Source: `plugins/sdk-agent-harness` :: `L131 Provider plus harness pairing`
  Target: `Plugin SDK and bundled plugin architecture` / `Agent harness plugins` / `Provider and harness pairing`
  Closest existing: `Plugin SDK and bundled plugin architecture` / `Provider and tool plugins` / `Mixed plugins`
  Why: Generic provider/tool plugin coverage misses the paired-provider authoring pattern documented here.
- `10-05-reference-plugin-sdk-reference-p005-s006` | `plugins/sdk-agent-harness` | `Tool-result middleware`
  Recommendation: `new_feature`
  Source: `plugins/sdk-agent-harness` :: `L161 Tool-result middleware`
  Target: `Plugin SDK and bundled plugin architecture` / `Agent harness plugins` / `Runtime tool-result middleware`
  Closest existing: `Plugin SDK and bundled plugin architecture` / `Provider and tool plugins` / `Mixed plugins`
  Why: This section is about the harness/runtime middleware seam, not mixed provider-tool plugin registration.
- `10-05-reference-plugin-sdk-reference-p005-s007` | `plugins/sdk-agent-harness` | `Terminal outcome classification`
  Recommendation: `new_feature`
  Source: `plugins/sdk-agent-harness` :: `L175 Terminal outcome classification`
  Target: `Plugin SDK and bundled plugin architecture` / `Agent harness plugins` / `Terminal outcome classification`
  Closest existing: `Plugin SDK and bundled plugin architecture` / `Authoring plugins` / `Entrypoint discovery`
  Why: The candidate maps to generic authoring/test surfaces, but the section documents a distinct harness-specific classification helper.
- `10-05-reference-plugin-sdk-reference-p005-s010` | `plugins/sdk-agent-harness` | `Native sessions and transcript mirror`
  Recommendation: `new_feature`
  Source: `plugins/sdk-agent-harness` :: `L297 Native sessions and transcript mirror`
  Target: `Plugin SDK and bundled plugin architecture` / `Agent harness plugins` / `Native session mirror and result handoff`
  Closest existing: `OpenAI / Codex provider path` / `Native Codex App-server Harness and Thread Lifecycle` / `Native Codex App-server Harness and Thread Lifecycle`
  Why: The candidate is too Codex-specific for a generic harness contract around sidecar session bindings and transcript mirroring.
- `10-06-reference-plugin-maintainer-reference-p008-root` | `plugins/message-presentation` | `(page)`
  Recommendation: `new_feature`
  Source: `plugins/message-presentation` :: `(page)`
  Target: `Plugin SDK and bundled plugin architecture` / `Channel plugins` / `Semantic message presentation`
  Closest existing: `Automation: cron, hooks, tasks, polling` / `Plugin Hooks` / `Plugin Hooks`
  Why: The taxonomy covers channel outbound delivery and provider-specific payload translation, but it does not explicitly model the shared Plugin SDK contract for `MessagePresentation`, renderer capabilities, generic fallback/degradation rules, and cross-channel semantic UI production.
- `11-01-help-start-here-p003-s001` | `help/debugging` | `Runtime debug overrides`
  Recommendation: `new_feature`
  Source: `help/debugging` :: `L12 Runtime debug overrides`
  Target: `Observability` / `Developer debugging, tracing, and profiling workflows` / `Runtime debug overrides`
  Closest existing: `Agent runtime and provider execution` / `Model and Runtime Selection` / `Provider and runtime overrides`
  Why: The `/debug` command provides runtime-only config mutation for troubleshooting without editing disk config. That operator-facing debug control is not represented in current observability categories.
- `11-01-help-start-here-p003-s002` | `help/debugging` | `Session trace output`
  Recommendation: `new_feature`
  Source: `help/debugging` :: `L29 Session trace output`
  Target: `Observability` / `Developer debugging, tracing, and profiling workflows` / `Per-session trace toggles`
  Closest existing: `Browser automation and exec/sandbox tools` / `Browser Actions, Snapshots, and Artifacts` / `Browser Actions, Snapshots, and Artifacts`
  Why: The `/trace` workflow exposes plugin-owned trace lines for one session without enabling broad verbose logging. That scoped trace control is a real debugging capability gap in the existing taxonomy.
- `11-01-help-start-here-p003-s003` | `help/debugging` | `Plugin lifecycle trace`
  Recommendation: `new_feature`
  Source: `help/debugging` :: `L46 Plugin lifecycle trace`
  Target: `Observability` / `Developer debugging, tracing, and profiling workflows` / `Plugin lifecycle phase tracing`
  Closest existing: `Nix install path` / `Plugin Lifecycle and Nix-store Plugin Loading` / `Plugin Lifecycle and Nix-store Plugin Loading`
  Why: The `OPENCLAW_PLUGIN_LIFECYCLE_TRACE=1` path emits phase-by-phase timing for plugin install/refresh work. Current plugin and observability categories cover runtime behavior and diagnostics broadly, but not this dedicated lifecycle timing trace.
- `11-01-help-start-here-p003-s004` | `help/debugging` | `CLI startup and command profiling`
  Recommendation: `new_feature`
  Source: `help/debugging` :: `L72 CLI startup and command profiling`
  Target: `Observability` / `Developer debugging, tracing, and profiling workflows` / `CLI startup and sync-I/O profiling`
  Closest existing: `Native Windows CLI and Gateway` / `Windows Command Spawning and Package-manager Shims` / `Windows .cmd`
  Why: Startup benchmarks, CPU profile capture, and sync-I/O tracing for CLI commands are explicit debug/profiling workflows absent from the current observability taxonomy.
- `11-01-help-start-here-p003-s007` | `help/debugging` | `Raw stream logging (OpenClaw)`
  Recommendation: `new_feature`
  Source: `help/debugging` :: `L252 Raw stream logging (OpenClaw)`
  Target: `Observability` / `Developer debugging, tracing, and profiling workflows` / `Raw provider stream capture`
  Closest existing: `Local model providers: Ollama, vLLM, SGLang, LM Studio` / `Request Stream Compatibility and Tool Calling` / `Request Stream Compatibility and Tool Calling`
  Why: Raw assistant-stream logging before formatting/filtering is a concrete debugging workflow for provider and runtime investigation that is not represented by current logging/export categories.
- `11-01-help-start-here-p003-s010` | `help/debugging` | `Debugging in VSCode`
  Recommendation: `new_feature`
  Source: `help/debugging` :: `L306 Debugging in VSCode`
  Target: `Observability` / `Developer debugging, tracing, and profiling workflows` / `VSCode source-map debugging`
  Closest existing: `Telegram` / `Native Commands and Command UI` / `Built-in commands`
  Why: The page documents a supported source-map-based IDE debugging workflow with launch configurations for stepping through Gateway TypeScript. That contributor debugging path is not captured by existing observability taxonomy.

## Navigation-only or missing source

- `01-01-get-started-overview-p001-root` | `index` | `(page)`
  Recommendation: `nav_missing_source`
  Why: The page as a whole mixes hero CTAs, product overview, architecture, quick start, config, and docs-hub links across multiple existing surfaces, so it should be treated as an overview wrapper rather than a single maturity source.
- `01-01-get-started-overview-p001-s001` | `index` | `OpenClaw 🦞`
  Recommendation: `nav_missing_source`
  Why: The hero section is primarily CTA/navigation content for getting started, onboarding, and opening the Control UI; it spans multiple existing surfaces and does not stand alone as canonical feature evidence.
- `01-01-get-started-overview-p001-s002` | `index` | `What is OpenClaw?`
  Recommendation: `nav_missing_source`
  Why: This is product-positioning copy covering self-hosting, multi-channel/plugin reach, agent-native behavior, and runtime prerequisites across several surfaces, not a single maturity category.
- `01-01-get-started-overview-p001-s003` | `index` | `How it works`
  Recommendation: `nav_missing_source`
  Why: The architecture diagram spans chat apps/plugins, Gateway, agent runtime, CLI, Control UI, macOS app, and mobile nodes; it is cross-surface orientation content rather than a single source page for one taxonomy item.
- `01-01-get-started-overview-p001-s004` | `index` | `Key capabilities`
  Recommendation: `nav_missing_source`
  Why: The capability cards aggregate channels, plugin channels, multi-agent routing, media, web UI, and mobile nodes, so the section is an index over existing surfaces rather than a canonical source for one mapped feature.
- `01-01-get-started-overview-p001-s008` | `index` | `Start here`
  Recommendation: `nav_missing_source`
  Why: This is a docs-hub navigation section that routes users to configuration, remote access, channels, nodes, and help pages; it is navigation only and should not be counted as direct feature evidence.
- `01-01-get-started-overview-p001-s009` | `index` | `Learn more`
  Recommendation: `nav_missing_source`
  Why: This section is a pure link-out list to deeper docs such as features, multi-agent routing, security, and troubleshooting, so the underlying destination pages should carry coverage, not this overview wrapper.
- `01-01-get-started-overview-p002-root` | `start/showcase` | `(page)`
  Recommendation: `nav_missing_source`
  Why: `docs/start/showcase.md` is a community showcase/gallery spanning many unrelated surfaces (Telegram, browser automation, skills, mobile apps, hardware, memory workflows, and more). Its exact-path auto-accept into the Nix install surface is plainly incorrect and should be removed from that category's docs reference.
- `01-01-get-started-overview-p002-s001` | `start/showcase` | `Fresh from Discord`
  Recommendation: `nav_missing_source`
  Why: `docs/start/showcase.md` is a community showcase/gallery spanning many unrelated surfaces (Telegram, browser automation, skills, mobile apps, hardware, memory workflows, and more). Its exact-path auto-accept into the Nix install surface is plainly incorrect and should be removed from that category's docs reference.
- `01-01-get-started-overview-p002-s002` | `start/showcase` | `Automation and workflows`
  Recommendation: `nav_missing_source`
  Why: `docs/start/showcase.md` is a community showcase/gallery spanning many unrelated surfaces (Telegram, browser automation, skills, mobile apps, hardware, memory workflows, and more). Its exact-path auto-accept into the Nix install surface is plainly incorrect and should be removed from that category's docs reference.
- `01-01-get-started-overview-p002-s003` | `start/showcase` | `Knowledge and memory`
  Recommendation: `nav_missing_source`
  Why: `docs/start/showcase.md` is a community showcase/gallery spanning many unrelated surfaces (Telegram, browser automation, skills, mobile apps, hardware, memory workflows, and more). Its exact-path auto-accept into the Nix install surface is plainly incorrect and should be removed from that category's docs reference.
- `01-01-get-started-overview-p002-s004` | `start/showcase` | `Voice and phone`
  Recommendation: `nav_missing_source`
  Why: `docs/start/showcase.md` is a community showcase/gallery spanning many unrelated surfaces (Telegram, browser automation, skills, mobile apps, hardware, memory workflows, and more). Its exact-path auto-accept into the Nix install surface is plainly incorrect and should be removed from that category's docs reference.
- `01-01-get-started-overview-p002-s005` | `start/showcase` | `Infrastructure and deployment`
  Recommendation: `nav_missing_source`
  Why: `docs/start/showcase.md` is a community showcase/gallery spanning many unrelated surfaces (Telegram, browser automation, skills, mobile apps, hardware, memory workflows, and more). Its exact-path auto-accept into the Nix install surface is plainly incorrect and should be removed from that category's docs reference.
- `01-01-get-started-overview-p002-s006` | `start/showcase` | `Home and hardware`
  Recommendation: `nav_missing_source`
  Why: `docs/start/showcase.md` is a community showcase/gallery spanning many unrelated surfaces (Telegram, browser automation, skills, mobile apps, hardware, memory workflows, and more). Its exact-path auto-accept into the Nix install surface is plainly incorrect and should be removed from that category's docs reference.
- `01-01-get-started-overview-p002-s007` | `start/showcase` | `Community projects`
  Recommendation: `nav_missing_source`
  Why: `docs/start/showcase.md` is a community showcase/gallery spanning many unrelated surfaces (Telegram, browser automation, skills, mobile apps, hardware, memory workflows, and more). Its exact-path auto-accept into the Nix install surface is plainly incorrect and should be removed from that category's docs reference.
- `01-01-get-started-overview-p002-s008` | `start/showcase` | `Submit your project`
  Recommendation: `nav_missing_source`
  Why: `docs/start/showcase.md` is a community showcase/gallery spanning many unrelated surfaces (Telegram, browser automation, skills, mobile apps, hardware, memory workflows, and more). Its exact-path auto-accept into the Nix install surface is plainly incorrect and should be removed from that category's docs reference.
- `01-01-get-started-overview-p002-s009` | `start/showcase` | `Related`
  Recommendation: `nav_missing_source`
  Why: `docs/start/showcase.md` is a community showcase/gallery spanning many unrelated surfaces (Telegram, browser automation, skills, mobile apps, hardware, memory workflows, and more). Its exact-path auto-accept into the Nix install surface is plainly incorrect and should be removed from that category's docs reference.
- `01-01-get-started-overview-p003-root` | `concepts/features` | `(page)`
  Recommendation: `nav_missing_source`
  Why: The Features page is a cross-surface capability catalog spanning channels, routing, media, apps, providers, and tools; it is useful orientation material but not a single maturity source.
- `01-01-get-started-overview-p003-s001` | `concepts/features` | `Highlights`
  Recommendation: `nav_missing_source`
  Why: The highlight cards summarize several existing surfaces at once (channels, plugins, routing, media, UI, and nodes), so this section is an index rather than a one-category source.
- `01-01-get-started-overview-p003-s002` | `concepts/features` | `Full list`
  Recommendation: `nav_missing_source`
  Why: The full list enumerates capabilities across many surfaces including channels, agent runtime, providers, media, apps, and automation, so it should not be assigned to a single maturity mapping.
- `01-01-get-started-overview-p003-s003` | `concepts/features` | `Related`
  Recommendation: `nav_missing_source`
  Why: The Related section is only a set of outbound links to other docs pages and does not contain source coverage of its own.
- `01-02-get-started-first-steps-p003-s005` | `start/wizard` | `Full reference`
  Recommendation: `nav_missing_source`
  Why: This section is only a pointer list to deeper references and does not describe a capability by itself.
- `01-02-get-started-first-steps-p003-s006` | `start/wizard` | `Related docs`
  Recommendation: `nav_missing_source`
  Why: This section is related-links navigation rather than source content for a distinct maturity-scorecard capability.
- `01-02-get-started-first-steps-p004-s001` | `start/onboarding` | `Related`
  Recommendation: `nav_missing_source`
  Why: This is a related-links section, not capability evidence.
- `01-03-get-started-guides-p003-s004` | `start/wizard-cli-automation` | `Related docs`
  Recommendation: `nav_missing_source`
  Why: `Related docs` is navigation only. It points readers to other pages but does not add distinct product behavior evidence for scorecard coverage.
- `02-02-install-maintenance-p002-s006` | `install/migrating` | `Upgrade a plugin in place`
  Recommendation: `nav_missing_source`
  Target: `Matrix` / `E2ee, Verification, Backup, and Migration` / `Matrix migration`
  Why: The section is only a pointer to channel-specific upgrade guides and does not add standalone evidence beyond the linked source docs.
- `02-02-install-maintenance-p002-s007` | `install/migrating` | `Related`
  Recommendation: `nav_missing_source`
  Target: `n/a` / `n/a` / `Related links`
  Why: This is a navigation block that points to authoritative pages elsewhere and should not drive taxonomy changes by itself.
- `02-02-install-maintenance-p003-s009` | `install/migrating-claude` | `Related`
  Recommendation: `nav_missing_source`
  Target: `n/a` / `n/a` / `Related links`
  Why: This section only routes the reader to other canonical docs.
- `02-02-install-maintenance-p004-s009` | `install/migrating-hermes` | `Related`
  Recommendation: `nav_missing_source`
  Target: `n/a` / `n/a` / `Related links`
  Why: This block is navigation only.
- `02-02-install-maintenance-p006-s006` | `install/development-channels` | `Tagging best practices`
  Recommendation: `nav_missing_source`
  Target: `n/a` / `n/a` / `Release tagging guidance`
  Why: This is maintainer publishing guidance for git/npm tags rather than end-user product capability evidence.
- `02-02-install-maintenance-p006-s007` | `install/development-channels` | `macOS app availability`
  Recommendation: `nav_missing_source`
  Target: `n/a` / `n/a` / `Release artifact availability note`
  Why: The macOS-app caveat is a release-note qualification, not a standalone CLI update capability.
- `02-02-install-maintenance-p006-s008` | `install/development-channels` | `Related`
  Recommendation: `nav_missing_source`
  Target: `n/a` / `n/a` / `Related links`
  Why: This block only points to other docs.
- `02-03-install-containers-p001-s011` | `install/ansible` | `Advanced configuration`
  Recommendation: `nav_missing_source`
  Why: This section is only an external-doc handoff to the openclaw-ansible repo and does not add in-repo source evidence beyond navigation.
- `02-03-install-containers-p001-s012` | `install/ansible` | `Related`
  Recommendation: `nav_missing_source`
  Why: Related links are navigation only and do not need scorecard coverage.
- `02-03-install-containers-p002-s004` | `install/bun` | `Related`
  Recommendation: `nav_missing_source`
  Why: Related links are navigation only.
- `02-03-install-containers-p003-s010` | `install/clawdock` | `Related`
  Recommendation: `nav_missing_source`
  Why: Related cards are navigation only.
- `02-03-install-containers-p004-s017` | `install/docker` | `Related`
  Recommendation: `nav_missing_source`
  Why: Related links are navigation only.
- `02-03-install-containers-p005-s007` | `install/nix` | `Related`
  Recommendation: `nav_missing_source`
  Why: Related cards are navigation only and should not be auto-accepted into the doctor/setup/update mutation-guard category.
- `02-03-install-containers-p006-s008` | `install/podman` | `Related`
  Recommendation: `nav_missing_source`
  Why: Related links are navigation only.
- `03-05-channels-configuration-p010-s004` | `channels/qa-channel` | `Related`
  Recommendation: `nav_missing_source`
  Target: `QA channel` / `Related navigation` / `Cross-links to adjacent QA and channel docs`
  Why: The `Related` section is navigation-only (`QA overview`, `Matrix QA`, `Pairing`, `Groups`, `Channels overview`) and does not add independent scoreable behavior beyond sources that are already covered elsewhere.
- `04-01-agents-fundamentals-p002-s010` | `concepts/agent` | `Related`
  Recommendation: `nav_missing_source`
  Why: `Related` is navigation only. It points to other runtime/session pages but does not add new scorecard evidence itself.
- `04-01-agents-fundamentals-p005-s008` | `concepts/system-prompt` | `Related`
  Recommendation: `nav_missing_source`
  Why: `Related` is a navigation block only and does not add product-behavior evidence beyond the linked pages.
- `04-01-agents-fundamentals-p008-s009` | `concepts/agent-workspace` | `Related`
  Recommendation: `nav_missing_source`
  Why: `Related` is navigation only and does not provide distinct scorecard evidence.
- `04-01-agents-fundamentals-p009-s006` | `concepts/soul` | `Related`
  Recommendation: `nav_missing_source`
  Why: `Related` is navigation only.
- `04-01-agents-fundamentals-p011-s004` | `start/bootstrapping` | `Related docs`
  Recommendation: `nav_missing_source`
  Why: `Related docs` is navigation only.
- `04-01-agents-fundamentals-p012-s008` | `concepts/experimental-features` | `Related`
  Recommendation: `nav_missing_source`
  Why: `Related` is navigation only.
- `04-01-agents-fundamentals-p015-s012` | `concepts/qa-matrix` | `Related`
  Recommendation: `nav_missing_source`
  Why: `Related` is navigation only.
- `04-02-agents-sessions-and-memory-p003-s007` | `concepts/session-pruning` | `Further reading`
  Recommendation: `nav_missing_source`
  Why: Navigation only.
- `04-02-agents-sessions-and-memory-p003-s008` | `concepts/session-pruning` | `Related`
  Recommendation: `nav_missing_source`
  Why: Navigation only.
- `04-02-agents-sessions-and-memory-p004-s007` | `concepts/session-tool` | `Further reading`
  Recommendation: `nav_missing_source`
  Why: Navigation only.
- `04-02-agents-sessions-and-memory-p004-s008` | `concepts/session-tool` | `Related`
  Recommendation: `nav_missing_source`
  Why: Navigation only.
- `04-02-agents-sessions-and-memory-p006-s008` | `concepts/memory-builtin` | `Related`
  Recommendation: `nav_missing_source`
  Why: Navigation only.
- `04-02-agents-sessions-and-memory-p008-s009` | `concepts/memory-honcho` | `Further reading`
  Recommendation: `nav_missing_source`
  Why: Navigation only.
- `04-02-agents-sessions-and-memory-p008-s010` | `concepts/memory-honcho` | `Related`
  Recommendation: `nav_missing_source`
  Why: Navigation only.
- `04-02-agents-sessions-and-memory-p009-s011` | `concepts/memory-search` | `Further reading`
  Recommendation: `nav_missing_source`
  Why: Navigation only.
- `04-02-agents-sessions-and-memory-p009-s012` | `concepts/memory-search` | `Related`
  Recommendation: `nav_missing_source`
  Why: Navigation only.
- `04-02-agents-sessions-and-memory-p010-s025` | `concepts/active-memory` | `Related pages`
  Recommendation: `nav_missing_source`
  Why: Navigation only.
- `04-02-agents-sessions-and-memory-p012-s014` | `concepts/dreaming` | `Related`
  Recommendation: `nav_missing_source`
  Why: Navigation only.
- `05-01-capabilities-overview-p001-root` | `tools/index` | `(page)`
  Recommendation: `nav_missing_source`
  Why: The page is a cross-surface overview spanning tools, skills, plugins, automation, policy, and delegation. It is a routing hub into more specific capability docs rather than a single canonical maturity source.
- `05-01-capabilities-overview-p001-s001` | `tools/index` | `Start here`
  Recommendation: `nav_missing_source`
  Why: The `Start here` table is purely decision-routing content that points readers to built-in tools, policy, skills, plugins, automation, sub-agents, and Tool Search. The linked destination pages should carry maturity evidence instead of this summary table.
- `05-01-capabilities-overview-p001-s003` | `tools/index` | `Built-in tool categories`
  Recommendation: `nav_missing_source`
  Why: The built-in tool table is a broad catalog covering runtime, files, web, browser, messaging, sessions, automation, gateway/nodes, media, and large tool catalogs. It summarizes many existing surfaces at once and is not a single scoreable capability source on its own.
- `05-01-capabilities-overview-p001-s006` | `tools/index` | `Extend capabilities`
  Recommendation: `nav_missing_source`
  Why: The `Extend capabilities` bullets are extension-path routing: install plugins, build plugins, add skills, or consult SDK/manifest docs. They direct readers to authoritative pages elsewhere rather than introducing a new scoreable capability here.
- `05-01-capabilities-overview-p001-s008` | `tools/index` | `Related`
  Recommendation: `nav_missing_source`
  Why: The `Related` section is only a link-out list to other capability docs and does not provide standalone maturity evidence.
- `05-02-capabilities-plugins-p001-s012` | `tools/plugin` | `Related`
  Recommendation: `nav_missing_source`
  Why: The Related section is navigation only and should not be auto-accepted into plugin discovery or troubleshooting coverage.
- `05-02-capabilities-plugins-p002-s008` | `plugins/manage-plugins` | `Related`
  Recommendation: `nav_missing_source`
  Why: The Related section is navigation only and should not count as security, Nix, or plugin-distribution evidence.
- `05-02-capabilities-plugins-p003-s003` | `plugins/community` | `Related`
  Recommendation: `nav_missing_source`
  Why: The Related section is a pointer block and does not add distinct maturity evidence beyond the linked plugin discovery and publishing pages.
- `05-02-capabilities-plugins-p004-s018` | `plugins/bundles` | `Related`
  Recommendation: `nav_missing_source`
  Why: The Related section is navigation only and should not be auto-accepted as evidence for bundle capability coverage.
- `05-03-capabilities-bundled-plugin-guides-p003-s001` | `plugins/codex-computer-use` | `OpenClaw.app and Peekaboo`
  Recommendation: `nav_missing_source`
  Why: This section is a boundary/comparison note pointing readers to the separate Peekaboo bridge surface. It should not be scored as the canonical source for either product area.
- `05-03-capabilities-bundled-plugin-guides-p003-s002` | `plugins/codex-computer-use` | `iOS app`
  Recommendation: `nav_missing_source`
  Why: This is a comparison handoff to the iOS node surface, not the canonical maturity source for iOS capabilities or Codex Computer Use itself.
- `05-03-capabilities-bundled-plugin-guides-p003-s003` | `plugins/codex-computer-use` | `Direct cua-driver MCP`
  Recommendation: `nav_missing_source`
  Why: The direct cua-driver MCP alternative is a neighboring integration path, but this section is only a contrast note inside the Codex Computer Use page rather than the canonical source for that MCP surface.
- `05-03-capabilities-bundled-plugin-guides-p003-s013` | `plugins/codex-computer-use` | `Related`
  Recommendation: `nav_missing_source`
  Why: The Related block is navigation only and does not add scoreable product behavior beyond the linked pages.
- `05-03-capabilities-bundled-plugin-guides-p004-s024` | `plugins/google-meet` | `Related`
  Recommendation: `nav_missing_source`
  Why: The Related block is navigation only and does not add independent maturity evidence beyond the linked docs.
- `05-03-capabilities-bundled-plugin-guides-p005-s018` | `plugins/workboard` | `Related`
  Recommendation: `nav_missing_source`
  Why: The Related section is only navigation to adjacent docs and does not add distinct maturity evidence.
- `05-03-capabilities-bundled-plugin-guides-p006-s009` | `plugins/webhooks` | `Related docs`
  Recommendation: `nav_missing_source`
  Why: The Related docs block is navigation only and should not be scored as a source capability.
- `05-03-capabilities-bundled-plugin-guides-p007-s011` | `plugins/admin-http-rpc` | `Related`
  Recommendation: `nav_missing_source`
  Why: The Related section is just outbound links and does not add independent capability evidence.
- `05-03-capabilities-bundled-plugin-guides-p009-s020` | `plugins/memory-wiki` | `Recommended workflow`
  Recommendation: `nav_missing_source`
  Why: The Recommended workflow section is synthesis and usage guidance built from the page's existing capabilities rather than a separate source capability.
- `05-03-capabilities-bundled-plugin-guides-p009-s021` | `plugins/memory-wiki` | `Related docs`
  Recommendation: `nav_missing_source`
  Why: The Related docs block is navigation only.
- `05-03-capabilities-bundled-plugin-guides-p010-s014` | `plugins/memory-lancedb` | `Related`
  Recommendation: `nav_missing_source`
  Why: The Related section is navigation only.
- `05-03-capabilities-bundled-plugin-guides-p011-s008` | `plugins/oc-path` | `Related`
  Recommendation: `nav_missing_source`
  Why: The Related section is navigation only.
- `05-04-capabilities-building-plugins-p005-s009` | `plugins/cli-backend-plugins` | `Related`
  Recommendation: `nav_missing_source`
  Why: The Related section is only a link-out list to CLI backends, plugin basics, SDK overview, manifest docs, and agent harness docs, so it should not count as standalone maturity evidence.
- `05-07-capabilities-tools-p001-s004` | `tools/apply-patch` | `Related`
  Recommendation: `nav_missing_source`
  Why: Related-links navigation only.
- `05-07-capabilities-tools-p002-s011` | `tools/btw` | `Related`
  Recommendation: `nav_missing_source`
  Why: Related-links navigation only.
- `05-07-capabilities-tools-p003-s005` | `tools/code-execution` | `Related`
  Recommendation: `nav_missing_source`
  Why: Related-links navigation only.
- `05-07-capabilities-tools-p004-s018` | `tools/diffs` | `Related`
  Recommendation: `nav_missing_source`
  Why: Related-links navigation only.
- `05-07-capabilities-tools-p006-s006` | `tools/permission-modes` | `Related`
  Recommendation: `nav_missing_source`
  Why: Related-links navigation only.
- `05-07-capabilities-tools-p011-s008` | `tools/llm-task` | `Related`
  Recommendation: `nav_missing_source`
  Why: Related-links navigation only.
- `05-07-capabilities-tools-p012-s021` | `tools/lobster` | `Learn more`
  Recommendation: `nav_missing_source`
  Why: Outbound reference links only.
- `05-07-capabilities-tools-p012-s023` | `tools/lobster` | `Related`
  Recommendation: `nav_missing_source`
  Why: Related-links navigation only.
- `05-07-capabilities-tools-p017-s009` | `tools/thinking` | `Related`
  Recommendation: `nav_missing_source`
  Why: Related-links navigation only.
- `05-07-capabilities-tools-p018-s005` | `tools/tokenjuice` | `Related`
  Recommendation: `nav_missing_source`
  Why: Related-links navigation only.
- `05-07-capabilities-tools-p019-s010` | `tools/tool-search` | `Related`
  Recommendation: `nav_missing_source`
  Why: Related-links navigation only.
- `05-07-capabilities-tools-p020-s007` | `tools/loop-detection` | `Related`
  Recommendation: `nav_missing_source`
  Why: Related-links navigation only.
- `05-07-capabilities-tools-p021-s010` | `tools/trajectory` | `Related`
  Recommendation: `nav_missing_source`
  Why: Related-links navigation only.
- `05-07-capabilities-tools-p026-s005` | `tools/browser-login` | `Related`
  Recommendation: `nav_missing_source`
  Why: Related-links navigation only.
- `05-07-capabilities-tools-p027-s008` | `tools/browser-linux-troubleshooting` | `Related`
  Recommendation: `nav_missing_source`
  Why: Related-links navigation only.
- `05-08-capabilities-agent-coordination-p001-s005` | `tools/agent-send` | `Related`
  Recommendation: `nav_missing_source`
  Why: The section is navigation only, so treating it as execution-coordination evidence would overcount related links.
- `05-08-capabilities-agent-coordination-p002-s011` | `tools/goal` | `Related`
  Recommendation: `nav_missing_source`
  Why: The section is only related navigation and should not map to execution-coordination coverage.
- `05-08-capabilities-agent-coordination-p003-s005` | `tools/steer` | `Related`
  Recommendation: `nav_missing_source`
  Why: The related-links list should not be treated as independent capability evidence.
- `05-08-capabilities-agent-coordination-p006-s014` | `tools/acp-agents-setup` | `Related`
  Recommendation: `nav_missing_source`
  Why: The final related-links block is navigation only.
- `06-01-clawhub-overview-p001-root` | `clawhub/index` | `(page)`
  Recommendation: `nav_missing_source`
  Why: The review bundle points at slug 'clawhub/index' with source_exists=false and no source_path. Existing ClawHub coverage already exists elsewhere in the repo, including the /clawhub redirect in docs/tools/clawhub.md and the scored ClawHub taxonomy surface, so there is no auditable page body here to map or use for new taxonomy.
- `06-01-clawhub-overview-p002-root` | `clawhub/quickstart` | `(page)`
  Recommendation: `nav_missing_source`
  Why: The bundle points at 'clawhub/quickstart' but no source file exists. The current taxonomy already covers ClawHub discovery, install-source selection, and operator workflows, and the docs tree routes users through existing plugin and community-plugin pages instead, so the gap is the missing quickstart source/nav entry rather than missing maturity taxonomy.
- `06-01-clawhub-overview-p003-root` | `clawhub/how-it-works` | `(page)`
  Recommendation: `nav_missing_source`
  Why: The bundle points at 'clawhub/how-it-works' with no source file. The nearest real docs are docs/clawhub/publishing.md plus existing ClawHub install/discovery docs, and the suggested Google Chat mapping is clearly unrelated. This should be fixed by restoring or retargeting the missing overview page, not by adding a new taxonomy feature/category/surface.
- `06-02-clawhub-using-clawhub-p001-root` | `clawhub/cli` | `(page)`
  Recommendation: `nav_missing_source`
  Why: The review bundle marks `clawhub/cli` as `source_exists: false`, and there is no matching source file under `/Users/kevinlin/code/openclaw/docs/`. Existing taxonomy already covers ClawHub CLI-adjacent behavior under the ClawHub distribution surface, but without a real page there is nothing precise to map or extend.
- `06-02-clawhub-using-clawhub-p003-root` | `clawhub/skill-format` | `(page)`
  Recommendation: `nav_missing_source`
  Why: The `clawhub/skill-format` page has no source file in the docs tree. The taxonomy already includes ClawHub publishing and catalog metadata coverage, so this should not drive new taxonomy until the missing page exists and its actual capability scope can be reviewed.
- `06-02-clawhub-using-clawhub-p004-root` | `clawhub/soul-format` | `(page)`
  Recommendation: `nav_missing_source`
  Why: The `clawhub/soul-format` nav target is missing from `/Users/kevinlin/code/openclaw/docs/`. Existing taxonomy already covers archive/integrity and package distribution concepts for ClawHub, so the blocker here is missing source content rather than a proven taxonomy gap.
- `06-02-clawhub-using-clawhub-p005-root` | `clawhub/auth` | `(page)`
  Recommendation: `nav_missing_source`
  Why: The review bundle shows `clawhub/auth` with no backing doc source. `docs/clawhub/publishing.md` does document owner-scoped publish authorization, but the requested page itself does not exist, so the correct action is to flag missing source rather than add or remap taxonomy.
- `06-02-clawhub-using-clawhub-p006-root` | `clawhub/telemetry` | `(page)`
  Recommendation: `nav_missing_source`
  Why: The `clawhub/telemetry` nav entry has no source file. No precise ClawHub telemetry capability can be audited from the missing page, and there is not enough evidence to recommend a new taxonomy feature or category from the slug alone.
- `06-02-clawhub-using-clawhub-p007-root` | `clawhub/troubleshooting` | `(page)`
  Recommendation: `nav_missing_source`
  Why: The `clawhub/troubleshooting` page is missing from the docs tree. The existing taxonomy already has `Operator Inventory, Inspect, Doctor, and Troubleshooting` on the ClawHub distribution surface, so this is a missing-doc-source problem rather than missing taxonomy.
- `06-03-clawhub-api-and-trust-p001-root` | `clawhub/api` | `(page)`
  Recommendation: `nav_missing_source`
  Why: The review bundle points at slug 'clawhub/api' with source_exists=false and no source_path. There is no corresponding ClawHub API page in the docs tree, and existing scored taxonomy already covers the real ClawHub distribution/trust surface, so there is no auditable source body here to map into taxonomy.
- `06-03-clawhub-api-and-trust-p002-root` | `clawhub/http-api` | `(page)`
  Recommendation: `nav_missing_source`
  Why: The bundle points at 'clawhub/http-api' but no source file exists. The repo does have Gateway HTTP API docs under docs/gateway/, but those are Gateway runtime APIs rather than ClawHub docs, so this should be treated as a missing ClawHub nav/source page, not as evidence for a new or remapped maturity taxonomy capability.
- `06-03-clawhub-api-and-trust-p003-root` | `clawhub/acceptable-usage` | `(page)`
  Recommendation: `nav_missing_source`
  Why: The bundle points at 'clawhub/acceptable-usage' with source_exists=false and no source_path. Existing ClawHub trust and publishing docs cover review and install-safety behavior, but there is no acceptable-usage policy page in the docs tree, so this is a missing-source/navigation gap rather than a taxonomy gap.
- `08-02-platforms-macos-companion-app-p016-s005` | `platforms/mac/skills` | `Related`
  Recommendation: `nav_missing_source`
  Why: The Related section is only a pointer block to the generic Skills and macOS app docs and does not add distinct maturity evidence by itself.
- `09-01-gateway-ops-gateway-p009-s012` | `auth-credential-semantics` | `Related`
  Recommendation: `nav_missing_source`
  Why: The related-links block is navigation only and does not add distinct capability evidence.
- `09-01-gateway-ops-gateway-p011-s010` | `gateway/secrets-plan-contract` | `Related docs`
  Recommendation: `nav_missing_source`
  Why: This is a related-docs pointer section rather than source evidence for a separate capability.
- `09-01-gateway-ops-gateway-p022-s005` | `gateway/gateway-lock` | `Related`
  Recommendation: `nav_missing_source`
  Why: The related-links block is navigation only.
- `09-01-gateway-ops-gateway-p032-s017` | `gateway/openshell` | `Related`
  Recommendation: `nav_missing_source`
  Why: The related-links section is navigation only.
- `09-01-gateway-ops-gateway-p042-s006` | `network` | `Related`
  Recommendation: `nav_missing_source`
  Why: The related-links block is navigation only.
- `09-02-gateway-ops-remote-access-p002-s014` | `gateway/remote-gateway-readme` | `Related`
  Recommendation: `nav_missing_source`
  Why: The Related section is navigation only.
- `09-03-gateway-ops-security-p002-root` | `security/formal-verification` | `(page)`
  Recommendation: `nav_missing_source`
  Why: The page is a cross-surface security-evidence index for multiple existing capabilities and does not act as a single canonical maturity source.
- `09-03-gateway-ops-security-p002-s001` | `security/formal-verification` | `Where the models live`
  Recommendation: `nav_missing_source`
  Why: `Where the models live` is repository-location metadata for the external models repo, not product-surface evidence.
- `09-03-gateway-ops-security-p002-s002` | `security/formal-verification` | `Important caveats`
  Recommendation: `nav_missing_source`
  Why: The caveats describe modeling limits and evidence quality rather than an operator-facing OpenClaw capability.
- `09-03-gateway-ops-security-p002-s003` | `security/formal-verification` | `Reproducing results`
  Recommendation: `nav_missing_source`
  Why: Reproduction instructions are workflow/governance content for the model suite, not direct maturity coverage of one taxonomy feature.
- `09-03-gateway-ops-security-p002-s009` | `security/formal-verification` | `v1++: additional bounded models (concurrency, retries, trace correctness)`
  Recommendation: `nav_missing_source`
  Why: This heading is just a bucket for future/follow-on model families spanning multiple existing surfaces.
- `09-03-gateway-ops-security-p002-s013` | `security/formal-verification` | `Related`
  Recommendation: `nav_missing_source`
  Why: The Related section is navigation only.
- `09-03-gateway-ops-security-p003-root` | `security/THREAT-MODEL-ATLAS` | `(page)`
  Recommendation: `nav_missing_source`
  Why: The threat model page spans Gateway, agent runtime, channels, ClawHub, MCP, and user devices, so the page root is cross-surface security governance rather than one taxonomy source.
- `09-03-gateway-ops-security-p003-s001` | `security/THREAT-MODEL-ATLAS` | `MITRE ATLAS framework`
  Recommendation: `nav_missing_source`
  Why: The MITRE ATLAS intro is framework metadata, not a product capability description.
- `09-03-gateway-ops-security-p003-s002` | `security/THREAT-MODEL-ATLAS` | `Framework attribution`
  Recommendation: `nav_missing_source`
  Why: Framework attribution is external methodology context only.
- `09-03-gateway-ops-security-p003-s003` | `security/THREAT-MODEL-ATLAS` | `Contributing to This Threat Model`
  Recommendation: `nav_missing_source`
  Why: Contribution guidance is governance/process content, not maturity evidence for one surface.
- `09-03-gateway-ops-security-p003-s004` | `security/THREAT-MODEL-ATLAS` | `1. Introduction`
  Recommendation: `nav_missing_source`
  Why: The introduction is a cross-surface orientation section for the threat document.
- `09-03-gateway-ops-security-p003-s005` | `security/THREAT-MODEL-ATLAS` | `1.1 Purpose`
  Recommendation: `nav_missing_source`
  Why: Purpose explains document intent rather than product behavior.
- `09-03-gateway-ops-security-p003-s006` | `security/THREAT-MODEL-ATLAS` | `1.2 Scope`
  Recommendation: `nav_missing_source`
  Why: Scope intentionally aggregates many product areas, so it should not be treated as a single maturity-source mapping.
- `09-03-gateway-ops-security-p003-s007` | `security/THREAT-MODEL-ATLAS` | `1.3 Out of Scope`
  Recommendation: `nav_missing_source`
  Why: Out-of-scope policy is document-governance metadata only.
- `09-03-gateway-ops-security-p003-s008` | `security/THREAT-MODEL-ATLAS` | `2. System Architecture`
  Recommendation: `nav_missing_source`
  Why: System architecture is a cross-surface trust-boundary diagram, not canonical evidence for one scored feature.
- `09-03-gateway-ops-security-p003-s009` | `security/THREAT-MODEL-ATLAS` | `2.1 Trust Boundaries`
  Recommendation: `nav_missing_source`
  Why: Trust-boundary framing spans channels, Gateway, sessions, tools, and ClawHub simultaneously.
- `09-03-gateway-ops-security-p003-s010` | `security/THREAT-MODEL-ATLAS` | `2.2 Data Flows`
  Recommendation: `nav_missing_source`
  Why: The data-flow summary is architecture overview content spanning multiple surfaces.
- `09-03-gateway-ops-security-p003-s011` | `security/THREAT-MODEL-ATLAS` | `3. Threat Analysis by ATLAS Tactic`
  Recommendation: `nav_missing_source`
  Why: This tactic-level heading is just an organizational wrapper for lower-level threat items.
- `09-03-gateway-ops-security-p003-s012` | `security/THREAT-MODEL-ATLAS` | `3.1 Reconnaissance (AML.TA0002)`
  Recommendation: `nav_missing_source`
  Why: The Reconnaissance tactic heading groups threat entries but is not itself a capability source.
- `09-03-gateway-ops-security-p003-s014` | `security/THREAT-MODEL-ATLAS` | `T-RECON-002: Channel Integration Probing`
  Recommendation: `nav_missing_source`
  Why: Channel-integration probing is a generic cross-channel reconnaissance scenario without a single canonical taxonomy triplet.
- `09-03-gateway-ops-security-p003-s015` | `security/THREAT-MODEL-ATLAS` | `3.2 Initial Access (AML.TA0004)`
  Recommendation: `nav_missing_source`
  Why: The Initial Access tactic heading is only an organizational wrapper.
- `09-03-gateway-ops-security-p003-s019` | `security/THREAT-MODEL-ATLAS` | `3.3 Execution (AML.TA0005)`
  Recommendation: `nav_missing_source`
  Why: The Execution tactic heading is only structural.
- `09-03-gateway-ops-security-p003-s020` | `security/THREAT-MODEL-ATLAS` | `T-EXEC-001: Direct Prompt Injection`
  Recommendation: `nav_missing_source`
  Why: Direct prompt injection spans agent/runtime/tool policy behavior and is described here as a broad threat scenario rather than a single canonical docs source.
- `09-03-gateway-ops-security-p003-s021` | `security/THREAT-MODEL-ATLAS` | `T-EXEC-002: Indirect Prompt Injection`
  Recommendation: `nav_missing_source`
  Why: Indirect prompt injection crosses fetched content, email/webhook inputs, and model behavior, so this threat entry is too cross-surface for one taxonomy mapping.
- `09-03-gateway-ops-security-p003-s022` | `security/THREAT-MODEL-ATLAS` | `T-EXEC-003: Tool Argument Injection`
  Recommendation: `nav_missing_source`
  Why: Tool-argument injection depends on model behavior, tool safety hooks, and approvals simultaneously, making this threat entry broader than one existing feature doc.
- `09-03-gateway-ops-security-p003-s024` | `security/THREAT-MODEL-ATLAS` | `3.4 Persistence (AML.TA0006)`
  Recommendation: `nav_missing_source`
  Why: The Persistence tactic heading is only structural.
- `09-03-gateway-ops-security-p003-s028` | `security/THREAT-MODEL-ATLAS` | `3.5 Defense Evasion (AML.TA0007)`
  Recommendation: `nav_missing_source`
  Why: The Defense Evasion tactic heading is only structural.
- `09-03-gateway-ops-security-p003-s031` | `security/THREAT-MODEL-ATLAS` | `3.6 Discovery (AML.TA0008)`
  Recommendation: `nav_missing_source`
  Why: The Discovery tactic heading is only structural.
- `09-03-gateway-ops-security-p003-s034` | `security/THREAT-MODEL-ATLAS` | `3.7 Collection & Exfiltration (AML.TA0009, AML.TA0010)`
  Recommendation: `nav_missing_source`
  Why: The Collection and Exfiltration tactic heading is only structural.
- `09-03-gateway-ops-security-p003-s038` | `security/THREAT-MODEL-ATLAS` | `3.8 Impact (AML.TA0011)`
  Recommendation: `nav_missing_source`
  Why: The Impact tactic heading is only structural.
- `09-03-gateway-ops-security-p003-s040` | `security/THREAT-MODEL-ATLAS` | `T-IMPACT-002: Resource Exhaustion (DoS)`
  Recommendation: `nav_missing_source`
  Why: Resource-exhaustion risk spans model calls, channels, Gateway, and queues; this threat entry is too cross-surface to serve as one canonical maturity mapping.
- `09-03-gateway-ops-security-p003-s041` | `security/THREAT-MODEL-ATLAS` | `T-IMPACT-003: Reputation Damage`
  Recommendation: `nav_missing_source`
  Why: Reputation damage is an outcome/risk summary, not an operator-facing product capability.
- `09-03-gateway-ops-security-p003-s045` | `security/THREAT-MODEL-ATLAS` | `4.3 Planned Improvements`
  Recommendation: `nav_missing_source`
  Why: Planned improvements are future work, not current maturity evidence.
- `09-03-gateway-ops-security-p003-s046` | `security/THREAT-MODEL-ATLAS` | `5. Risk Matrix`
  Recommendation: `nav_missing_source`
  Why: The risk-matrix heading summarizes cross-surface prioritization rather than one feature.
- `09-03-gateway-ops-security-p003-s047` | `security/THREAT-MODEL-ATLAS` | `5.1 Likelihood vs Impact`
  Recommendation: `nav_missing_source`
  Why: Likelihood-vs-impact scoring is governance content only.
- `09-03-gateway-ops-security-p003-s048` | `security/THREAT-MODEL-ATLAS` | `5.2 Critical Path Attack Chains`
  Recommendation: `nav_missing_source`
  Why: Critical attack chains intentionally combine multiple surfaces, so this section should not be forced into one taxonomy mapping.
- `09-03-gateway-ops-security-p003-s049` | `security/THREAT-MODEL-ATLAS` | `6. Recommendations Summary`
  Recommendation: `nav_missing_source`
  Why: Recommendations summary is portfolio-level prioritization across multiple areas.
- `09-03-gateway-ops-security-p003-s050` | `security/THREAT-MODEL-ATLAS` | `6.1 Immediate (P0)`
  Recommendation: `nav_missing_source`
  Why: Immediate recommendations are cross-surface remediation priorities, not a single capability description.
- `09-03-gateway-ops-security-p003-s051` | `security/THREAT-MODEL-ATLAS` | `6.2 Short-term (P1)`
  Recommendation: `nav_missing_source`
  Why: Short-term recommendations remain cross-surface planning content.
- `09-03-gateway-ops-security-p003-s052` | `security/THREAT-MODEL-ATLAS` | `6.3 Medium-term (P2)`
  Recommendation: `nav_missing_source`
  Why: Medium-term recommendations are roadmap guidance, not current product coverage evidence.
- `09-03-gateway-ops-security-p003-s053` | `security/THREAT-MODEL-ATLAS` | `7. Appendices`
  Recommendation: `nav_missing_source`
  Why: Appendices is a structural wrapper only.
- `09-03-gateway-ops-security-p003-s054` | `security/THREAT-MODEL-ATLAS` | `7.1 ATLAS Technique Mapping`
  Recommendation: `nav_missing_source`
  Why: ATLAS technique mapping is external-framework reference material rather than product-surface evidence.
- `09-03-gateway-ops-security-p003-s055` | `security/THREAT-MODEL-ATLAS` | `7.2 Key Security Files`
  Recommendation: `nav_missing_source`
  Why: The key-files appendix is an inventory of implementation references across many subsystems, not one canonical maturity source.
- `09-03-gateway-ops-security-p003-s056` | `security/THREAT-MODEL-ATLAS` | `7.3 Glossary`
  Recommendation: `nav_missing_source`
  Why: Glossary content is reference/navigation only.
- `09-03-gateway-ops-security-p003-s057` | `security/THREAT-MODEL-ATLAS` | `Related`
  Recommendation: `nav_missing_source`
  Why: The Related section is navigation only.
- `09-03-gateway-ops-security-p004-root` | `security/CONTRIBUTING-THREAT-MODEL` | `(page)`
  Recommendation: `nav_missing_source`
  Why: The contribution guide is governance/process documentation for maintaining the threat model, not a product capability source.
- `09-03-gateway-ops-security-p004-s001` | `security/CONTRIBUTING-THREAT-MODEL` | `Ways to contribute`
  Recommendation: `nav_missing_source`
  Why: Ways-to-contribute is contributor workflow guidance only.
- `09-03-gateway-ops-security-p004-s002` | `security/CONTRIBUTING-THREAT-MODEL` | `Add a threat`
  Recommendation: `nav_missing_source`
  Why: Adding a threat is community process guidance, not surface evidence.
- `09-03-gateway-ops-security-p004-s003` | `security/CONTRIBUTING-THREAT-MODEL` | `Suggest a mitigation`
  Recommendation: `nav_missing_source`
  Why: Mitigation-submission guidance is threat-model process content only.
- `09-03-gateway-ops-security-p004-s004` | `security/CONTRIBUTING-THREAT-MODEL` | `Propose an attack chain`
  Recommendation: `nav_missing_source`
  Why: Attack-chain contribution guidance is governance/process material.
- `09-03-gateway-ops-security-p004-s005` | `security/CONTRIBUTING-THREAT-MODEL` | `Fix or improve existing content`
  Recommendation: `nav_missing_source`
  Why: Editing/contribution guidance does not document a product capability.
- `09-03-gateway-ops-security-p004-s006` | `security/CONTRIBUTING-THREAT-MODEL` | `What we use`
  Recommendation: `nav_missing_source`
  Why: `What we use` is framework/process context, not product behavior.
- `09-03-gateway-ops-security-p004-s007` | `security/CONTRIBUTING-THREAT-MODEL` | `MITRE ATLAS framework`
  Recommendation: `nav_missing_source`
  Why: The ATLAS-framework subsection is methodology reference only.
- `09-03-gateway-ops-security-p004-s008` | `security/CONTRIBUTING-THREAT-MODEL` | `Threat ids`
  Recommendation: `nav_missing_source`
  Why: Threat-id conventions are editorial metadata for the threat model.
- `09-03-gateway-ops-security-p004-s009` | `security/CONTRIBUTING-THREAT-MODEL` | `Risk levels`
  Recommendation: `nav_missing_source`
  Why: Risk-level definitions are review/governance metadata rather than product-surface docs.
- `09-03-gateway-ops-security-p004-s010` | `security/CONTRIBUTING-THREAT-MODEL` | `Review process`
  Recommendation: `nav_missing_source`
  Why: Review-process steps are contributor workflow only.
- `09-03-gateway-ops-security-p004-s011` | `security/CONTRIBUTING-THREAT-MODEL` | `Resources`
  Recommendation: `nav_missing_source`
  Why: Resources is a link list, not direct feature evidence.
- `09-03-gateway-ops-security-p004-s012` | `security/CONTRIBUTING-THREAT-MODEL` | `Contact`
  Recommendation: `nav_missing_source`
  Why: Contact information is navigation/support metadata only.
- `09-03-gateway-ops-security-p004-s013` | `security/CONTRIBUTING-THREAT-MODEL` | `Recognition`
  Recommendation: `nav_missing_source`
  Why: Recognition policy is community/governance content only.
- `09-03-gateway-ops-security-p004-s014` | `security/CONTRIBUTING-THREAT-MODEL` | `Related`
  Recommendation: `nav_missing_source`
  Why: The Related section is navigation only.
- `09-04-gateway-ops-nodes-and-media-p010-s009` | `nodes/location-command` | `Related`
  Recommendation: `nav_missing_source`
  Why: The Related block is just outbound navigation to other docs pages and does not add standalone maturity evidence.
- `09-05-gateway-ops-web-interfaces-p002-s022` | `web/control-ui` | `Related`
  Recommendation: `nav_missing_source`
  Why: The Related section is navigation only and does not add distinct source evidence.
- `09-05-gateway-ops-web-interfaces-p003-s004` | `web/dashboard` | `Related`
  Recommendation: `nav_missing_source`
  Why: The Related section is navigation only and does not add capability evidence.
- `09-05-gateway-ops-web-interfaces-p004-s008` | `web/webchat` | `Related`
  Recommendation: `nav_missing_source`
  Why: The Related section is navigation only and does not add distinct capability evidence.
- `09-05-gateway-ops-web-interfaces-p005-s019` | `web/tui` | `Related`
  Recommendation: `nav_missing_source`
  Why: The Related section is navigation only and does not contribute separate source evidence.
- `10-01-reference-cli-commands-p002-s006` | `cli/backup` | `Related`
  Recommendation: `nav_missing_source`
  Why: Navigation links only.
- `10-01-reference-cli-commands-p003-s010` | `cli/crestodian` | `Related`
  Recommendation: `nav_missing_source`
  Why: Navigation links only.
- `10-01-reference-cli-commands-p004-s006` | `cli/daemon` | `Related`
  Recommendation: `nav_missing_source`
  Why: Navigation links only.
- `10-01-reference-cli-commands-p009-s017` | `cli/migrate` | `Related`
  Recommendation: `nav_missing_source`
  Why: Navigation links only.
- `10-01-reference-cli-commands-p011-s002` | `cli/reset` | `Related`
  Recommendation: `nav_missing_source`
  Why: Navigation links only.
- `10-01-reference-cli-commands-p013-s005` | `cli/security` | `Related`
  Recommendation: `nav_missing_source`
  Why: Navigation links only.
- `10-01-reference-cli-commands-p016-s002` | `cli/uninstall` | `Related`
  Recommendation: `nav_missing_source`
  Why: Navigation links only.
- `10-01-reference-cli-commands-p019-s016` | `cli/agents` | `Related`
  Recommendation: `nav_missing_source`
  Why: Navigation links only.
- `10-01-reference-cli-commands-p022-s005` | `cli/memory` | `Related`
  Recommendation: `nav_missing_source`
  Why: Navigation links only.
- `10-01-reference-cli-commands-p023-s005` | `cli/commitments` | `Related`
  Recommendation: `nav_missing_source`
  Why: Navigation links only.
- `10-01-reference-cli-commands-p027-s007` | `cli/system` | `Related`
  Recommendation: `nav_missing_source`
  Why: Navigation links only.
- `10-01-reference-cli-commands-p031-s009` | `cli/directory` | `Related`
  Recommendation: `nav_missing_source`
  Why: Navigation links only.
- `10-01-reference-cli-commands-p032-s006` | `cli/pairing` | `Related`
  Recommendation: `nav_missing_source`
  Why: Navigation links only.
- `10-01-reference-cli-commands-p034-s019` | `cli/voicecall` | `Related`
  Recommendation: `nav_missing_source`
  Why: Navigation links only.
- `10-01-reference-cli-commands-p036-s014` | `cli/browser` | `Related`
  Recommendation: `nav_missing_source`
  Why: Navigation links only.
- `10-01-reference-cli-commands-p038-s005` | `cli/flows` | `Related`
  Recommendation: `nav_missing_source`
  Why: Navigation links only.
- `10-01-reference-cli-commands-p039-s009` | `cli/node` | `Related`
  Recommendation: `nav_missing_source`
  Why: Navigation links only.
- `10-01-reference-cli-commands-p040-s004` | `cli/nodes` | `Related`
  Recommendation: `nav_missing_source`
  Why: Navigation links only.
- `10-01-reference-cli-commands-p041-s016` | `cli/sandbox` | `Related`
  Recommendation: `nav_missing_source`
  Why: Navigation links only.
- `10-01-reference-cli-commands-p042-s014` | `cli/config` | `Related`
  Recommendation: `nav_missing_source`
  Why: Navigation links only.
- `10-01-reference-cli-commands-p046-s025` | `cli/path` | `Related`
  Recommendation: `nav_missing_source`
  Why: Navigation links only.
- `10-01-reference-cli-commands-p047-s022` | `cli/policy` | `Related`
  Recommendation: `nav_missing_source`
  Why: Navigation links only.
- `10-01-reference-cli-commands-p048-s004` | `cli/skills` | `Related`
  Recommendation: `nav_missing_source`
  Why: Navigation links only.
- `10-01-reference-cli-commands-p049-s012` | `cli/workboard` | `Related`
  Recommendation: `nav_missing_source`
  Why: Navigation links only.
- `10-01-reference-cli-commands-p050-s002` | `cli/dashboard` | `Related`
  Recommendation: `nav_missing_source`
  Why: Navigation links only.
- `10-01-reference-cli-commands-p052-s014` | `cli/acp` | `Related`
  Recommendation: `nav_missing_source`
  Why: Navigation links only.
- `10-01-reference-cli-commands-p053-root` | `cli/clawbot` | `(page)`
  Recommendation: `nav_missing_source`
  Why: Legacy alias guidance only.
- `10-01-reference-cli-commands-p053-s001` | `cli/clawbot` | `openclaw clawbot`
  Recommendation: `nav_missing_source`
  Why: Legacy alias guidance only.
- `10-01-reference-cli-commands-p053-s002` | `cli/clawbot` | `Migration`
  Recommendation: `nav_missing_source`
  Why: Legacy alias guidance only.
- `10-01-reference-cli-commands-p053-s003` | `cli/clawbot` | `Related`
  Recommendation: `nav_missing_source`
  Why: Legacy alias guidance only.
- `10-01-reference-cli-commands-p055-s004` | `cli/dns` | `Related`
  Recommendation: `nav_missing_source`
  Why: Navigation links only.
- `10-01-reference-cli-commands-p056-s007` | `cli/docs` | `Related`
  Recommendation: `nav_missing_source`
  Why: Navigation links only.
- `10-01-reference-cli-commands-p057-s026` | `cli/mcp` | `Related`
  Recommendation: `nav_missing_source`
  Why: Navigation links only.
- `10-01-reference-cli-commands-p058-s006` | `cli/proxy` | `Related`
  Recommendation: `nav_missing_source`
  Why: Navigation links only.
- `10-01-reference-cli-commands-p059-s019` | `cli/wiki` | `Related`
  Recommendation: `nav_missing_source`
  Why: Navigation links only.
- `10-03-reference-codex-harness-p001-s011` | `plugins/codex-harness-reference` | `Related`
  Recommendation: `nav_missing_source`
  Why: The exact auto-accept to the native Codex harness category is wrong here because this section is only a related-links list, not source capability content.
- `10-03-reference-codex-harness-p002-s011` | `plugins/codex-harness-runtime` | `Related`
  Recommendation: `nav_missing_source`
  Why: The exact auto-accept to the native Codex harness category is wrong here because the section is navigation-only.
- `10-05-reference-plugin-sdk-reference-p005-s013` | `plugins/sdk-agent-harness` | `Related`
  Recommendation: `nav_missing_source`
  Why: The candidate is a taxonomy false positive because the Related block is navigation only.
- `10-06-reference-plugin-maintainer-reference-p008-s010` | `plugins/message-presentation` | `Related docs`
  Recommendation: `nav_missing_source`
  Why: This is a related-docs navigation block, not standalone capability evidence.
- `10-07-reference-templates-p001-s012` | `reference/AGENTS.default` | `Related`
  Recommendation: `nav_missing_source`
  Why: The auto-map is wrong here because this section is navigation-only rather than source capability content.
- `10-07-reference-templates-p002-s017` | `reference/templates/AGENTS` | `Related`
  Recommendation: `nav_missing_source`
  Why: The auto-map is wrong here because this section is navigation-only rather than source capability content.
- `10-07-reference-templates-p003-s002` | `reference/templates/BOOT` | `Related`
  Recommendation: `nav_missing_source`
  Why: The auto-map is wrong here because this section is navigation-only rather than source capability content.
- `10-07-reference-templates-p004-s006` | `reference/templates/BOOTSTRAP` | `Related`
  Recommendation: `nav_missing_source`
  Why: The auto-map is wrong here because this section is navigation-only rather than source capability content.
- `10-07-reference-templates-p005-s002` | `reference/templates/HEARTBEAT` | `Related`
  Recommendation: `nav_missing_source`
  Why: The auto-map is wrong here because this section is navigation-only rather than source capability content.
- `10-07-reference-templates-p006-s002` | `reference/templates/IDENTITY` | `Related`
  Recommendation: `nav_missing_source`
  Why: The auto-map is wrong here because this section is navigation-only rather than source capability content.
- `10-07-reference-templates-p007-s006` | `reference/templates/SOUL` | `Related`
  Recommendation: `nav_missing_source`
  Why: The auto-map is wrong here because this section is navigation-only rather than source capability content.
- `10-07-reference-templates-p008-s005` | `reference/templates/TOOLS` | `Related`
  Recommendation: `nav_missing_source`
  Why: The auto-map is wrong here because this section is navigation-only rather than source capability content.
- `10-07-reference-templates-p009-s003` | `reference/templates/USER` | `Related`
  Recommendation: `nav_missing_source`
  Why: The auto-map is wrong here because this section is navigation-only rather than source capability content.
- `10-09-reference-concept-internals-p002-s011` | `concepts/markdown-formatting` | `Related`
  Recommendation: `nav_missing_source`
  Why: The Related card links are navigation only and do not introduce a separate taxonomy capability.
- `10-09-reference-concept-internals-p003-s005` | `concepts/typing-indicators` | `Related`
  Recommendation: `nav_missing_source`
  Why: The Related links point to adjacent references and are navigation only.
- `10-09-reference-concept-internals-p004-s004` | `concepts/usage-tracking` | `Related`
  Recommendation: `nav_missing_source`
  Why: The Related links are supporting navigation to adjacent reference pages, not a distinct capability.
- `10-10-reference-project-p001-root` | `reference/application-modernization-plan` | `(page)`
  Recommendation: `nav_missing_source`
  Why: The auto mapping points at execution and plugin-distribution surfaces because of generic terms like plugin and workflow, but this page is a modernization plan rather than shipped capability documentation.
- `10-10-reference-project-p001-s001` | `reference/application-modernization-plan` | `Goal`
  Recommendation: `nav_missing_source`
  Why: The auto mapping treats the goal statement as tool or runtime coverage, but the section is process guidance about how to execute modernization work.
- `10-10-reference-project-p001-s002` | `reference/application-modernization-plan` | `Principles`
  Recommendation: `nav_missing_source`
  Why: Keyword matches like auth, chat, provider, plugin, and diagnostics incorrectly pull this principles section into product surfaces even though it is contributor guidance.
- `10-10-reference-project-p001-s003` | `reference/application-modernization-plan` | `Phase 1: Baseline audit`
  Recommendation: `nav_missing_source`
  Why: The baseline-audit phase is a project workflow and should not be auto-accepted into automation or browser-tool taxonomy categories.
- `10-10-reference-project-p001-s004` | `reference/application-modernization-plan` | `Phase 2: Product and UX cleanup`
  Recommendation: `nav_missing_source`
  Why: The candidate surfaces are triggered by words like gateway, plugin, and browser, but this section is still a proposed UX cleanup plan rather than documentation of current behavior.
- `10-10-reference-project-p001-s005` | `reference/application-modernization-plan` | `Phase 3: Frontend architecture tightening`
  Recommendation: `nav_missing_source`
  Why: The frontend-architecture guidance is not evidence for exec, plugin, or browser runtime capabilities despite overlapping engineering vocabulary.
- `10-10-reference-project-p001-s006` | `reference/application-modernization-plan` | `Phase 4: Performance and reliability`
  Recommendation: `nav_missing_source`
  Why: Performance and reliability guidance uses technical terms that collide with runtime/tool taxonomy, but the section is still methodology rather than capability documentation.
- `10-10-reference-project-p001-s007` | `reference/application-modernization-plan` | `Phase 5: Type, contract, and test hardening`
  Recommendation: `nav_missing_source`
  Why: Strings like plugin manifests, provider catalogs, protocol messages, and config migration produce false positives, but this section is a testing checklist, not scorecard surface evidence.
- `10-10-reference-project-p001-s008` | `reference/application-modernization-plan` | `Phase 6: Documentation and release readiness`
  Recommendation: `nav_missing_source`
  Why: Release-readiness and docs-process guidance should not be auto-mapped onto install or provider surfaces.
- `10-10-reference-project-p001-s009` | `reference/application-modernization-plan` | `Recommended first slice`
  Recommendation: `nav_missing_source`
  Why: Although this slice mentions existing UI and onboarding areas, it is still prioritization guidance rather than direct documentation of a taxonomy feature.
- `10-10-reference-project-p001-s010` | `reference/application-modernization-plan` | `Frontend skill update`
  Recommendation: `nav_missing_source`
  Why: The auto mapping pulls this into Browser Control UI and CLI observability because of UI wording, but the section is actually a maintainer skill template for frontend delivery standards.
- `10-10-reference-project-p002-root` | `reference/credits` | `(page)`
  Recommendation: `nav_missing_source`
  Why: The page is project metadata, yet keyword overlap around project and related links causes false positives into plugin or chat surfaces.
- `10-10-reference-project-p002-s001` | `reference/credits` | `The name`
  Recommendation: `nav_missing_source`
  Why: The name etymology is unrelated to any taxonomy capability despite spurious token matches.
- `10-10-reference-project-p002-s002` | `reference/credits` | `Credits`
  Recommendation: `nav_missing_source`
  Why: Contributor credits are project metadata and should not be auto-accepted into product-surface coverage.
- `10-10-reference-project-p002-s003` | `reference/credits` | `Core contributors`
  Recommendation: `nav_missing_source`
  Why: Contributor-role text is not evidence for runtime, plugin, or provider capabilities.
- `10-10-reference-project-p002-s004` | `reference/credits` | `License`
  Recommendation: `nav_missing_source`
  Why: The license statement is legal metadata and the auto mapping is a false positive.
- `10-10-reference-project-p002-s005` | `reference/credits` | `Related`
  Recommendation: `nav_missing_source`
  Why: The Related section is navigation only, so any auto-accepted product mapping is incorrect.
- `10-11-reference-release-and-ci-p001-s013` | `reference/RELEASING` | `Public references`
  Recommendation: `nav_missing_source`
  Why: This is an outbound reference list to workflows and scripts rather than source content describing a maturity capability by itself.
- `10-11-reference-release-and-ci-p001-s014` | `reference/RELEASING` | `Related`
  Recommendation: `nav_missing_source`
  Why: The Related section is navigation to other docs pages and should not be scored as its own maturity source.
- `10-11-reference-release-and-ci-p004-s008` | `reference/test` | `Related`
  Recommendation: `nav_missing_source`
  Why: The Related section is only a pointer list to broader testing docs and does not provide standalone maturity evidence.
- `10-11-reference-release-and-ci-p006-root` | `help/scripts` | `(page)`
  Recommendation: `nav_missing_source`
  Why: This page is a generic helper-script index that explicitly says to prefer CLI surfaces when they exist. It is maintainer navigation/tooling guidance rather than canonical scorecard evidence.
- `10-11-reference-release-and-ci-p006-s001` | `help/scripts` | `Conventions`
  Recommendation: `nav_missing_source`
  Why: The conventions section is repository usage guidance for scripts, not a product or operator capability area that should map into the maturity taxonomy.
- `10-11-reference-release-and-ci-p006-s002` | `help/scripts` | `Auth monitoring scripts`
  Recommendation: `nav_missing_source`
  Why: This section mostly redirects readers back to the Authentication docs and labels the scripts as optional extras, so it is not a canonical maturity source on its own.
- `10-11-reference-release-and-ci-p006-s003` | `help/scripts` | `GitHub read helper`
  Recommendation: `nav_missing_source`
  Why: The GitHub read helper is a host-specific maintainer script for repo-scoped `gh` reads, not a current OpenClaw product surface or scorecard-backed user capability.
- `10-11-reference-release-and-ci-p006-s004` | `help/scripts` | `When adding scripts`
  Recommendation: `nav_missing_source`
  Why: This is authoring guidance for adding scripts under `scripts/`, which is repository maintenance process rather than maturity-scorecard source content.
- `10-11-reference-release-and-ci-p006-s005` | `help/scripts` | `Related`
  Recommendation: `nav_missing_source`
  Why: The Related links are navigation only and should not be treated as direct evidence for a taxonomy capability.
- `11-01-help-start-here-p001-root` | `help/index` | `(page)`
  Recommendation: `nav_missing_source`
  Why: The Help page is a front-door hub that routes users to troubleshooting, debugging, install, gateway, doctor, testing, and docs-organization pages across many existing surfaces, so it should not count as standalone capability evidence.
- `11-01-help-start-here-p001-s001` | `help/index` | `FAQ`
  Recommendation: `nav_missing_source`
  Why: FAQ is only a list of outbound links to deeper operational pages and does not provide canonical maturity evidence by itself.
- `11-01-help-start-here-p001-s002` | `help/index` | `Diagnostics`
  Recommendation: `nav_missing_source`
  Why: Diagnostics is a catalog of environment, flags, and crash-runbook links; the destination docs should carry coverage rather than this index section.
- `11-01-help-start-here-p001-s003` | `help/index` | `Testing`
  Recommendation: `nav_missing_source`
  Why: Testing is a link list to testing guides and does not itself document one scored capability area.
- `11-01-help-start-here-p001-s004` | `help/index` | `Community and meta`
  Recommendation: `nav_missing_source`
  Why: Community and meta points to lore and docs-organization pages, which are navigation and project-context material rather than product capability evidence.
- `11-01-help-start-here-p002-root` | `help/troubleshooting` | `(page)`
  Recommendation: `nav_missing_source`
  Why: General troubleshooting is a symptom-first triage hub spanning CLI observability, tool policy, provider quirks, plugin repair, channel delivery, automation, nodes, and browser failures, so the page as a whole is cross-surface routing rather than one canonical maturity source.
- `11-01-help-start-here-p002-s003` | `help/troubleshooting` | `Anthropic long context 429`
  Recommendation: `nav_missing_source`
  Why: The Anthropic 429 section is only an error-string handoff to a deeper gateway troubleshooting anchor and does not stand alone as capability evidence.
- `11-01-help-start-here-p002-s007` | `help/troubleshooting` | `Decision tree`
  Recommendation: `nav_missing_source`
  Why: The decision tree fans out into no-reply, Control UI, gateway, channel, automation, node, and browser troubleshooting paths, so it should be treated as cross-surface routing rather than direct evidence for one scored capability.
- `11-01-help-start-here-p002-s008` | `help/troubleshooting` | `Related`
  Recommendation: `nav_missing_source`
  Why: Related is an outbound link block and should not count as maturity coverage on its own.
- `11-01-help-start-here-p003-s013` | `help/debugging` | `Related`
  Recommendation: `nav_missing_source`
  Why: Related is a pointer block back to troubleshooting and FAQ pages and should not be scored independently.
- `11-02-help-faq-p002-root` | `help/faq-first-run` | `(page)`
  Recommendation: `nav_missing_source`
  Why: The page as a whole is a catch-all first-run FAQ spanning onboarding, dashboard auth, exec approvals, provider auth, update channels, Windows/Linux/VPS guidance, nodes, and channel-specific setup. It aggregates many existing surfaces instead of serving as the canonical source for one maturity category.
- `11-02-help-faq-p002-s001` | `help/faq-first-run` | `Quick start and first-run setup`
  Recommendation: `nav_missing_source`
  Why: The `Quick start and first-run setup` section is still an umbrella FAQ wrapper: it mixes stuck/debug guidance, onboarding, dashboard access, remote auth, exec approvals, Raspberry Pi notes, migration, release channels, installer troubleshooting, platform install advice, provider auth, local-model cautions, channel-specific setup, install-mode switching, and VPS/VM hosting. Those details belong to existing destination docs and surfaces, not one unified scorecard source.
- `11-02-help-faq-p002-s002` | `help/faq-first-run` | `Related`
  Recommendation: `nav_missing_source`
  Why: The `Related` section is only an outbound link list to the main FAQ, install overview, getting started, and troubleshooting pages, so it is navigation rather than direct maturity evidence.
- `11-04-help-diagnostics-p003-s007` | `debug/node-issue` | `Notes / hypothesis`
  Recommendation: `nav_missing_source`
  Why: The hypothesis section is root-cause speculation about esbuild helper emission and loader internals. It is useful debugging context, but not canonical capability coverage for the scorecard.
- `11-04-help-diagnostics-p003-s008` | `debug/node-issue` | `Regression history`
  Recommendation: `nav_missing_source`
  Why: The regression-history block is project-history context about when the scripts switched from Bun to `tsx`, which is lore rather than direct capability evidence.
- `11-04-help-diagnostics-p003-s010` | `debug/node-issue` | `References`
  Recommendation: `nav_missing_source`
  Why: This section is only an external reference list to upstream `keepNames` and esbuild material, so it should not count as OpenClaw capability coverage.
- `11-04-help-diagnostics-p003-s011` | `debug/node-issue` | `Next steps`
  Recommendation: `nav_missing_source`
  Why: The next-steps block is future investigation guidance for verifying the regression and filing upstream issues, not a stable product capability description.
- `11-04-help-diagnostics-p003-s012` | `debug/node-issue` | `Related`
  Recommendation: `nav_missing_source`
  Why: The related links are navigation to broader install and gateway troubleshooting pages rather than source coverage themselves.
- `11-05-help-community-and-meta-p001-root` | `start/lore` | `(page)`
  Recommendation: `nav_missing_source`
  Why: The `start/lore` page is an explicit backstory and tone-setting document for the OpenClaw project. It references product concepts, but it is not canonical feature documentation for any single maturity surface.
- `11-05-help-community-and-meta-p001-s001` | `start/lore` | `The Lore of OpenClaw 🦞📖`
  Recommendation: `nav_missing_source`
  Why: The page-intro section frames the lore as a story about the lobster mascot and project identity. It is thematic copy, not capability evidence.
- `11-05-help-community-and-meta-p001-s002` | `start/lore` | `The Origin Story`
  Recommendation: `nav_missing_source`
  Why: The origin story is rename and trademark backstory for the mascot and project. It does not document a shipped operator or user workflow.
- `11-05-help-community-and-meta-p001-s003` | `start/lore` | `The First Molt (January 27, 2026)`
  Recommendation: `nav_missing_source`
  Why: The First Molt section is a community naming-story anecdote. It is project history rather than product-surface documentation.
- `11-05-help-community-and-meta-p001-s004` | `start/lore` | `The Name`
  Recommendation: `nav_missing_source`
  Why: The Name section explains brand meaning and slogans such as 'the claw is the law'. That is identity copy, not maturity coverage.
- `11-05-help-community-and-meta-p001-s005` | `start/lore` | `The Daleks vs The Lobsters`
  Recommendation: `nav_missing_source`
  Why: The Daleks vs The Lobsters section is a joke/in-universe bit and has no taxonomy-bearing capability content.
- `11-05-help-community-and-meta-p001-s006` | `start/lore` | `Key Characters`
  Recommendation: `nav_missing_source`
  Why: Key Characters is community/persona framing about who the mascot and creator are. It is not a user-facing capability area.
- `11-05-help-community-and-meta-p001-s007` | `start/lore` | `Molty 🦞`
  Recommendation: `nav_missing_source`
  Why: The Molty section is a persona profile with likes, dislikes, and lore references. Mentions of workspace paths or memory files are narrative color here, not canonical docs for those systems.
- `11-05-help-community-and-meta-p001-s008` | `start/lore` | `Peter 👨‍💻`
  Recommendation: `nav_missing_source`
  Why: The Peter section is creator biography and quote material, not scorecard evidence.
- `11-05-help-community-and-meta-p001-s009` | `start/lore` | `The Moltiverse`
  Recommendation: `nav_missing_source`
  Why: The Moltiverse section describes community ethos and ecosystem identity. It is meta/community framing rather than capability documentation.
- `11-05-help-community-and-meta-p001-s010` | `start/lore` | `The Great Incidents`
  Recommendation: `nav_missing_source`
  Why: The Great Incidents is a wrapper for project anecdotes and stories. It should not be treated as direct evidence for runtime, security, or automation features mentioned inside the anecdotes.
- `11-05-help-community-and-meta-p001-s011` | `start/lore` | `The Directory Dump (Dec 3, 2025)`
  Recommendation: `nav_missing_source`
  Why: The Directory Dump section recounts a historical mishap. It is an anecdote about behavior, not a supported workflow or product surface.
- `11-05-help-community-and-meta-p001-s012` | `start/lore` | `The Great Molt (Jan 27, 2026)`
  Recommendation: `nav_missing_source`
  Why: The Great Molt section is rename-migration history mixed with social-media and scam anecdotes. It is project lore, not canonical docs for install, migration, or account-security features.
- `11-05-help-community-and-meta-p001-s013` | `start/lore` | `The Final Form (January 30, 2026)`
  Recommendation: `nav_missing_source`
  Why: The Final Form section documents the brand migration story, contributors, and announcement impact. It is community/project history rather than a capability source.
- `11-05-help-community-and-meta-p001-s014` | `start/lore` | `The Robot Shopping Spree (Dec 3, 2025)`
  Recommendation: `nav_missing_source`
  Why: The Robot Shopping Spree is another humorous anecdote and should not count as robotics, commerce, or node-surface coverage.
- `11-05-help-community-and-meta-p001-s015` | `start/lore` | `Sacred Texts`
  Recommendation: `nav_missing_source`
  Why: Sacred Texts lists important repo/workspace files in a playful way, but this section is still lore-oriented meta material rather than the primary documentation for agent workspace or memory behavior.
- `11-05-help-community-and-meta-p001-s016` | `start/lore` | `The Lobster Creed`
  Recommendation: `nav_missing_source`
  Why: The Lobster Creed is manifesto/voice copy. It does not document a discrete product capability.
- `11-05-help-community-and-meta-p001-s017` | `start/lore` | `The Icon Generation Saga (Jan 27, 2026)`
  Recommendation: `nav_missing_source`
  Why: The Icon Generation Saga is mascot-art history and community storytelling. It is not source evidence for image-generation or design-system taxonomy.
- `11-05-help-community-and-meta-p001-s018` | `start/lore` | `The Future`
  Recommendation: `nav_missing_source`
  Why: The Future section is aspirational and playful. It mentions possible future hardware and integrations, but those are not current documented capabilities here.
- `11-05-help-community-and-meta-p001-s019` | `start/lore` | `Related`
  Recommendation: `nav_missing_source`
  Why: The Related block is navigation only and should not count as capability evidence.
- `11-05-help-community-and-meta-p002-root` | `start/hubs` | `(page)`
  Recommendation: `nav_missing_source`
  Why: The `start/hubs` page is a documentation directory that links out to canonical pages across many existing surfaces. It is intentionally cross-surface navigation, not a single maturity source.
- `11-05-help-community-and-meta-p002-s001` | `start/hubs` | `Start here`
  Recommendation: `nav_missing_source`
  Why: Start here is a top-level link hub spanning getting started, onboarding, setup, dashboard, help, configuration, showcase, and lore. The destination pages should own capability coverage, not this index.
- `11-05-help-community-and-meta-p002-s002` | `start/hubs` | `Installation + updates`
  Recommendation: `nav_missing_source`
  Why: Installation + updates is a pure navigation list for existing install-path docs. It does not add new source content beyond the linked pages.
- `11-05-help-community-and-meta-p002-s003` | `start/hubs` | `Core concepts`
  Recommendation: `nav_missing_source`
  Why: Core concepts is a catalog of architecture, memory, sessions, routing, and related docs across several surfaces. It is navigation only.
- `11-05-help-community-and-meta-p002-s004` | `start/hubs` | `Providers + ingress`
  Recommendation: `nav_missing_source`
  Why: Providers + ingress is a link list for channel, provider, webhook, and Gmail pubsub docs. The linked pages remain the real capability evidence.
- `11-05-help-community-and-meta-p002-s005` | `start/hubs` | `Gateway + operations`
  Recommendation: `nav_missing_source`
  Why: Gateway + operations is an index over pairing, health, doctor, logging, dashboard, remote access, security, and troubleshooting docs. It is not a canonical source page for any one category.
- `11-05-help-community-and-meta-p002-s006` | `start/hubs` | `Tools + automation`
  Recommendation: `nav_missing_source`
  Why: Tools + automation collects links for tools, CLI, browser control, automation, models, sub-agents, and TUI. It is a navigation wrapper rather than direct documentation of those features.
- `11-05-help-community-and-meta-p002-s007` | `start/hubs` | `Nodes, media, voice`
  Recommendation: `nav_missing_source`
  Why: Nodes, media, voice is a docs index for nodes and media capabilities. Coverage belongs to the destination pages, not this list.
- `11-05-help-community-and-meta-p002-s008` | `start/hubs` | `Platforms`
  Recommendation: `nav_missing_source`
  Why: Platforms is a cross-platform navigation section covering macOS, iOS, Android, Windows, Linux, and web. It should not be counted as direct taxonomy evidence.
- `11-05-help-community-and-meta-p002-s009` | `start/hubs` | `macOS companion app (advanced)`
  Recommendation: `nav_missing_source`
  Why: The macOS companion app subsection is still just a route list into advanced macOS docs. It is navigation, not independent capability documentation.
- `11-05-help-community-and-meta-p002-s010` | `start/hubs` | `Plugins`
  Recommendation: `nav_missing_source`
  Why: Plugins is an index to plugin overview, SDK, bundles, ClawHub, and examples. The underlying plugin docs own the taxonomy evidence.
- `11-05-help-community-and-meta-p002-s011` | `start/hubs` | `Workspace + templates`
  Recommendation: `nav_missing_source`
  Why: Workspace + templates links to skills, config, default AGENTS, and template files, but it is still just a docs directory rather than source content for one scorecard category.
- `11-05-help-community-and-meta-p002-s012` | `start/hubs` | `Project`
  Recommendation: `nav_missing_source`
  Why: Project is a navigation pointer to credits/project metadata and does not document a product capability.
- `11-05-help-community-and-meta-p002-s013` | `start/hubs` | `Testing + release`
  Recommendation: `nav_missing_source`
  Why: Testing + release is a navigation list for reference/process docs. It should not count as direct feature coverage.
- `11-05-help-community-and-meta-p002-s014` | `start/hubs` | `Related`
  Recommendation: `nav_missing_source`
  Why: The Related block is navigation only.
