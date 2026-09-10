---
summary: "Microsoft Teams bot support status, capabilities, and configuration"
read_when:
  - Working on Microsoft Teams channel features
title: "Microsoft Teams"
---

Status: text + DM attachments are supported; channel/group file sending requires `sharePointSiteId` + Graph permissions (see [Sending files in group chats](/channels/msteams/messaging#sending-files-in-group-chats)). Polls and approval prompts are sent via Adaptive Cards. Message actions expose explicit `upload-file` for file-first sends.

<CardGroup cols={3}>
  <Card title="Setup" icon="rocket" href="/channels/msteams/setup">
    Register the bot and install the Teams app.
  </Card>
  <Card title="Pairing" icon="link" href="/channels/pairing">
    Teams DMs default to pairing mode.
  </Card>
  <Card title="Channel troubleshooting" icon="wrench" href="/channels/troubleshooting">
    Cross-channel diagnostics and repair playbooks.
  </Card>
</CardGroup>

## What each page covers

- [Microsoft Teams setup](/channels/msteams/setup) — install the plugin, register the bot and Teams app, and run against a dev tunnel.
- [Microsoft Teams access control](/channels/msteams/access-control) — DM and group policy, team and channel allowlists, and conversation IDs.
- [Microsoft Teams authentication](/channels/msteams/authentication) — certificate and managed identity auth instead of a client secret.
- [Microsoft Teams manifest and permissions](/channels/msteams/manifest-and-permissions) — the app manifest, RSC permissions, and the Graph permissions each capability needs.
- [Microsoft Teams configuration](/channels/msteams/configuration) — `channels.msteams` keys, environment variables, and history limits.
- [Microsoft Teams message behavior](/channels/msteams/messaging) — session routing, reply style, attachments, and file sending.
- [Microsoft Teams cards and actions](/channels/msteams/cards-and-actions) — approvals, polls, presentation cards, member info, and target formats.
- [Microsoft Teams troubleshooting](/channels/msteams/troubleshooting) — known limitations, common failures, and reference links.

## Where each section moved

Every section heading from the previous single-page version keeps its anchor here, so an existing link such as `/channels/msteams#reply-style-threads-vs-posts` still resolves. Each entry points at the page that now holds the content.

- <a id="bundled-plugin" />[Bundled plugin](/channels/msteams/setup#bundled-plugin)
- <a id="quick-setup" />[Quick setup](/channels/msteams/setup#quick-setup)
- <a id="goals" />[Goals](/channels/msteams/setup#goals)
- <a id="config-writes" />[Config writes](/channels/msteams/access-control#config-writes)
- <a id="access-control-(dms-%2B-groups)" />[Access control (DMs + groups)](</channels/msteams/access-control#access-control-(dms-%2B-groups)>)
- <a id="access-control-dms-+-groups" />[Access control (DMs + groups)](/channels/msteams/access-control#access-control-dms-+-groups)
- <a id="how-it-works" />[How it works](/channels/msteams/setup#how-it-works)
- <a id="step-1%3A-create-azure-bot" />[Step 1: Create Azure Bot](/channels/msteams/setup#step-1%3A-create-azure-bot)
- <a id="step-1-create-azure-bot" />[Step 1: Create Azure Bot](/channels/msteams/setup#step-1-create-azure-bot)
- <a id="step-2%3A-get-credentials" />[Step 2: Get credentials](/channels/msteams/setup#step-2%3A-get-credentials)
- <a id="step-2-get-credentials" />[Step 2: Get credentials](/channels/msteams/setup#step-2-get-credentials)
- <a id="step-3%3A-configure-messaging-endpoint" />[Step 3: Configure messaging endpoint](/channels/msteams/setup#step-3%3A-configure-messaging-endpoint)
- <a id="step-3-configure-messaging-endpoint" />[Step 3: Configure messaging endpoint](/channels/msteams/setup#step-3-configure-messaging-endpoint)
- <a id="step-4%3A-enable-teams-channel" />[Step 4: Enable Teams channel](/channels/msteams/setup#step-4%3A-enable-teams-channel)
- <a id="step-4-enable-teams-channel" />[Step 4: Enable Teams channel](/channels/msteams/setup#step-4-enable-teams-channel)
- <a id="step-5%3A-build-teams-app-manifest" />[Step 5: Build Teams app manifest](/channels/msteams/setup#step-5%3A-build-teams-app-manifest)
- <a id="step-5-build-teams-app-manifest" />[Step 5: Build Teams app manifest](/channels/msteams/setup#step-5-build-teams-app-manifest)
- <a id="step-6%3A-configure-openclaw" />[Step 6: Configure OpenClaw](/channels/msteams/setup#step-6%3A-configure-openclaw)
- <a id="step-6-configure-openclaw" />[Step 6: Configure OpenClaw](/channels/msteams/setup#step-6-configure-openclaw)
- <a id="step-7%3A-run-the-gateway" />[Step 7: Run the gateway](/channels/msteams/setup#step-7%3A-run-the-gateway)
- <a id="step-7-run-the-gateway" />[Step 7: Run the gateway](/channels/msteams/setup#step-7-run-the-gateway)
- <a id="federated-authentication-(certificate-plus-managed-identity)" />[Federated authentication (certificate plus managed identity)](</channels/msteams/authentication#federated-authentication-(certificate-plus-managed-identity)>)
- <a id="federated-authentication-certificate-plus-managed-identity" />[Federated authentication (certificate plus managed identity)](/channels/msteams/authentication#federated-authentication-certificate-plus-managed-identity)
- <a id="option-a%3A-certificate-based-authentication" />[Option A: Certificate-based authentication](/channels/msteams/authentication#option-a%3A-certificate-based-authentication)
- <a id="option-a-certificate-based-authentication" />[Option A: Certificate-based authentication](/channels/msteams/authentication#option-a-certificate-based-authentication)
- <a id="option-b%3A-azure-managed-identity" />[Option B: Azure Managed Identity](/channels/msteams/authentication#option-b%3A-azure-managed-identity)
- <a id="option-b-azure-managed-identity" />[Option B: Azure Managed Identity](/channels/msteams/authentication#option-b-azure-managed-identity)
- <a id="aks-workload-identity-setup" />[AKS Workload Identity setup](/channels/msteams/authentication#aks-workload-identity-setup)
- <a id="auth-type-comparison" />[Auth type comparison](/channels/msteams/authentication#auth-type-comparison)
- <a id="local-development-(tunneling)" />[Local development (tunneling)](</channels/msteams/setup#local-development-(tunneling)>)
- <a id="local-development-tunneling" />[Local development (tunneling)](/channels/msteams/setup#local-development-tunneling)
- <a id="testing-the-bot" />[Testing the bot](/channels/msteams/setup#testing-the-bot)
- <a id="environment-variables" />[Environment variables](/channels/msteams/configuration#environment-variables)
- <a id="member-info-action" />[Member info action](/channels/msteams/cards-and-actions#member-info-action)
- <a id="history-context" />[History context](/channels/msteams/configuration#history-context)
- <a id="current-teams-rsc-permissions-(manifest)" />[Current Teams RSC permissions (manifest)](</channels/msteams/manifest-and-permissions#current-teams-rsc-permissions-(manifest)>)
- <a id="current-teams-rsc-permissions-manifest" />[Current Teams RSC permissions (manifest)](/channels/msteams/manifest-and-permissions#current-teams-rsc-permissions-manifest)
- <a id="example-teams-manifest-(redacted)" />[Example Teams manifest (redacted)](</channels/msteams/manifest-and-permissions#example-teams-manifest-(redacted)>)
- <a id="example-teams-manifest-redacted" />[Example Teams manifest (redacted)](/channels/msteams/manifest-and-permissions#example-teams-manifest-redacted)
- <a id="manifest-caveats-(must-have-fields)" />[Manifest caveats (must-have fields)](</channels/msteams/manifest-and-permissions#manifest-caveats-(must-have-fields)>)
- <a id="manifest-caveats-must-have-fields" />[Manifest caveats (must-have fields)](/channels/msteams/manifest-and-permissions#manifest-caveats-must-have-fields)
- <a id="updating-an-existing-app" />[Updating an existing app](/channels/msteams/manifest-and-permissions#updating-an-existing-app)
- <a id="capabilities%3A-rsc-only-vs-graph" />[Capabilities: RSC only vs Graph](/channels/msteams/manifest-and-permissions#capabilities%3A-rsc-only-vs-graph)
- <a id="capabilities-rsc-only-vs-graph" />[Capabilities: RSC only vs Graph](/channels/msteams/manifest-and-permissions#capabilities-rsc-only-vs-graph)
- <a id="with-teams-rsc-only-(app-installed%2C-no-graph-api-permissions)" />[With **Teams RSC only** (app installed, no Graph API permissions)](</channels/msteams/manifest-and-permissions#with-teams-rsc-only-(app-installed%2C-no-graph-api-permissions)>)
- <a id="with-teams-rsc-only-app-installed-no-graph-api-permissions" />[With **Teams RSC only** (app installed, no Graph API permissions)](/channels/msteams/manifest-and-permissions#with-teams-rsc-only-app-installed-no-graph-api-permissions)
- <a id="with-teams-rsc-%2B-microsoft-graph-application-permissions" />[With **Teams RSC + Microsoft Graph Application permissions**](/channels/msteams/manifest-and-permissions#with-teams-rsc-%2B-microsoft-graph-application-permissions)
- <a id="with-teams-rsc-+-microsoft-graph-application-permissions" />[With **Teams RSC + Microsoft Graph Application permissions**](/channels/msteams/manifest-and-permissions#with-teams-rsc-+-microsoft-graph-application-permissions)
- <a id="rsc-vs-graph-api" />[RSC vs Graph API](/channels/msteams/manifest-and-permissions#rsc-vs-graph-api)
- <a id="graph-enabled-media-%2B-history" />[Graph-enabled media + history](/channels/msteams/manifest-and-permissions#graph-enabled-media-%2B-history)
- <a id="graph-enabled-media-+-history" />[Graph-enabled media + history](/channels/msteams/manifest-and-permissions#graph-enabled-media-+-history)
- <a id="channel%2Fgroup-file-recovery-(graphmediafallback)" />[Channel/group file recovery (`graphMediaFallback`)](</channels/msteams/manifest-and-permissions#channel%2Fgroup-file-recovery-(graphmediafallback)>)
- <a id="channel/group-file-recovery-graphmediafallback" />[Channel/group file recovery (`graphMediaFallback`)](/channels/msteams/manifest-and-permissions#channel/group-file-recovery-graphmediafallback)
- <a id="known-limitations" />[Known limitations](/channels/msteams/troubleshooting#known-limitations)
- <a id="webhook-timeouts" />[Webhook timeouts](/channels/msteams/troubleshooting#webhook-timeouts)
- <a id="teams-cloud-and-service-url-support" />[Teams cloud and service URL support](/channels/msteams/troubleshooting#teams-cloud-and-service-url-support)
- <a id="formatting" />[Formatting](/channels/msteams/troubleshooting#formatting)
- <a id="configuration" />[Configuration](/channels/msteams/configuration#configuration)
- <a id="routing-and-sessions" />[Routing and sessions](/channels/msteams/messaging#routing-and-sessions)
- <a id="reply-style%3A-threads-vs-posts" />[Reply style: threads vs posts](/channels/msteams/messaging#reply-style%3A-threads-vs-posts)
- <a id="reply-style-threads-vs-posts" />[Reply style: threads vs posts](/channels/msteams/messaging#reply-style-threads-vs-posts)
- <a id="resolution-precedence" />[Resolution precedence](/channels/msteams/messaging#resolution-precedence)
- <a id="thread-context-preservation" />[Thread context preservation](/channels/msteams/messaging#thread-context-preservation)
- <a id="attachments-and-images" />[Attachments and images](/channels/msteams/messaging#attachments-and-images)
- <a id="sending-files-in-group-chats" />[Sending files in group chats](/channels/msteams/messaging#sending-files-in-group-chats)
- <a id="why-group-chats-need-sharepoint" />[Why group chats need SharePoint](/channels/msteams/messaging#why-group-chats-need-sharepoint)
- <a id="setup" />[Setup](/channels/msteams/messaging#setup)
- <a id="sharing-behavior" />[Sharing behavior](/channels/msteams/messaging#sharing-behavior)
- <a id="fallback-behavior" />[Fallback behavior](/channels/msteams/messaging#fallback-behavior)
- <a id="files-stored-location" />[Files stored location](/channels/msteams/messaging#files-stored-location)
- <a id="native-approval-cards" />[Native approval cards](/channels/msteams/cards-and-actions#native-approval-cards)
- <a id="polls-(adaptive-cards)" />[Polls (Adaptive Cards)](</channels/msteams/cards-and-actions#polls-(adaptive-cards)>)
- <a id="polls-adaptive-cards" />[Polls (Adaptive Cards)](/channels/msteams/cards-and-actions#polls-adaptive-cards)
- <a id="presentation-cards" />[Presentation cards](/channels/msteams/cards-and-actions#presentation-cards)
- <a id="target-formats" />[Target formats](/channels/msteams/cards-and-actions#target-formats)
- <a id="proactive-messaging" />[Proactive messaging](/channels/msteams/cards-and-actions#proactive-messaging)
- <a id="team-and-channel-ids-(common-gotcha)" />[Team and Channel IDs (Common Gotcha)](</channels/msteams/access-control#team-and-channel-ids-(common-gotcha)>)
- <a id="team-and-channel-ids-common-gotcha" />[Team and Channel IDs (Common Gotcha)](/channels/msteams/access-control#team-and-channel-ids-common-gotcha)
- <a id="private-channels" />[Private channels](/channels/msteams/access-control#private-channels)
- <a id="troubleshooting" />[Troubleshooting](/channels/msteams/troubleshooting#troubleshooting)
- <a id="common-issues" />[Common issues](/channels/msteams/troubleshooting#common-issues)
- <a id="manifest-upload-errors" />[Manifest upload errors](/channels/msteams/troubleshooting#manifest-upload-errors)
- <a id="rsc-permissions-not-working" />[RSC permissions not working](/channels/msteams/troubleshooting#rsc-permissions-not-working)
- <a id="references" />[References](/channels/msteams/troubleshooting#references)

## Related

<CardGroup cols={2}>
  <Card title="Channels Overview" icon="list" href="/channels">
    All supported channels.
  </Card>
  <Card title="Pairing" icon="link" href="/channels/pairing">
    DM authentication and pairing flow.
  </Card>
  <Card title="Groups" icon="users" href="/channels/groups">
    Group chat behavior and mention gating.
  </Card>
  <Card title="Channel Routing" icon="route" href="/channels/channel-routing">
    Session routing for messages.
  </Card>
  <Card title="Configuration reference" icon="sliders" href="/gateway/config-channels/workplace-chat">
    Teams fields in the channel configuration reference.
  </Card>
  <Card title="Security" icon="shield" href="/gateway/security">
    Access model and hardening.
  </Card>
  <Card title="Microsoft Teams meetings plugin" icon="video" href="/plugins/teams-meetings">
    Joining Teams meetings as a guest.
  </Card>
</CardGroup>
