# Mattermost, LINE, IRC, Nextcloud Talk, Nostr, Twitch, Tlon, Synology Chat Completeness

Use this rubric when assigning category Completeness scores for the
`mattermost-line-irc-nextcloud-talk-nostr-twitch-tlon-synology-chat` surface.

## What Completeness Means Here

Completeness measures how fully OpenClaw exposes the intended `Mattermost, LINE, IRC, Nextcloud Talk, Nostr, Twitch, Tlon, Synology Chat` capability set to the user, operator, author, or maintainer persona for this surface. Score whether each category delivers the full expected workflow, including setup, normal use, status or inspection, recovery, and important platform/provider/channel variants where they apply.

## Scoring Questions

For each category, ask:

- Can the intended user or operator complete the category workflow end to end?
- Are the taxonomy features present as supported capabilities rather than isolated implementation fragments?
- Are the important lifecycle stages represented: setup, normal operation, status/inspection, recovery, and upgrade or removal where relevant?
- Are the important environment, provider, platform, channel, or security branches present for this surface?
- Do the known gaps leave major user-visible capability branches missing?

## Surface-Specific Guidance

- Favor higher Completeness when the category supports the full operator-visible workflow described by taxonomy and the category note evidence.
- Lower Completeness when only the happy path exists, when important variants are undocumented or unimplemented, or when recovery/status paths are missing.
- Do not lower Completeness because tests are thin; that is Coverage.
- Do not lower Completeness because implementation quality is fragile; that is Quality.

## Category Scope

- Channel Setup and Operations: Mattermost bot account setup, WebSocket inbound monitoring, Outbound delivery, LINE Messaging API webhook setup, Signed inbound webhook events, Rich LINE payloads, Nextcloud Talk bot installation, Webhook ingress, Outbound markdown/text, Synology Chat incoming/outgoing webhook setup, Webhook token verification, Outbound text, IRC server/nick/TLS/NickServ setup, Raw IRC receive/send, Probe/status, Twitch bot account setup, Twitch IRC monitor/client lifecycle, Message tool send action, Nostr key setup, NIP-04 encrypted DM receive/send, Profile import/publish, Tlon/Urbit ship URL/code setup, Urbit API auth/session, Rich text conversion, Nextcloud Talk bot installation, Webhook ingress, Outbound markdown/text, Synology Chat incoming/outgoing webhook setup, Webhook token verification, Outbound text and URL media delivery, Twitch bot account setup, Twitch IRC monitor/client lifecycle, Message tool send action, Tlon/Urbit ship URL/code setup, Urbit API auth/session, Rich text conversion
- Access and Identity: Mattermost bot account setup, WebSocket inbound monitoring, Outbound delivery, LINE Messaging API webhook setup, Signed inbound webhook events, Rich LINE payloads, Nextcloud Talk bot installation, Webhook ingress, Outbound markdown/text, Synology Chat incoming/outgoing webhook setup, Webhook token verification, Outbound text, IRC server/nick/TLS/NickServ setup, Raw IRC receive/send, Probe/status, Twitch bot account setup, Twitch IRC monitor/client lifecycle, Message tool send action, Nostr key setup, NIP-04 encrypted DM receive/send, Profile import/publish, Tlon/Urbit ship URL/code setup, Urbit API auth/session, Rich text conversion, Synology Chat incoming/outgoing webhook setup, Webhook token verification, Outbound text and URL media delivery, Tlon/Urbit ship URL/code setup, Urbit API auth/session, Rich text conversion
- Conversation Routing and Delivery: Mattermost bot account setup, WebSocket inbound monitoring, Outbound delivery, LINE Messaging API webhook setup, Signed inbound webhook events, Rich LINE payloads, Nextcloud Talk bot installation, Webhook ingress, Outbound markdown/text, Synology Chat incoming/outgoing webhook setup, Webhook token verification, Outbound text, IRC server/nick/TLS/NickServ setup, Raw IRC receive/send, Probe/status, Twitch bot account setup, Twitch IRC monitor/client lifecycle, Message tool send action, Nostr key setup, NIP-04 encrypted DM receive/send, Profile import/publish, Tlon/Urbit ship URL/code setup, Urbit API auth/session, Rich text conversion, Nextcloud Talk bot installation, Webhook ingress, Outbound markdown/text, Synology Chat incoming/outgoing webhook setup, Webhook token verification, Outbound text and URL media delivery, Twitch bot account setup, Twitch IRC monitor/client lifecycle, Message tool send action, Tlon/Urbit ship URL/code setup, Urbit API auth/session, Rich text conversion
- Media and Rich Content: LINE Messaging API webhook setup, Signed inbound webhook events, Rich LINE payloads, Nextcloud Talk bot installation, Webhook ingress, Outbound markdown/text, Synology Chat incoming/outgoing webhook setup, Webhook token verification, Outbound text, Nostr key setup, NIP-04 encrypted DM receive/send, Profile import/publish, Tlon/Urbit ship URL/code setup, Urbit API auth/session, Rich text conversion, Tlon/Urbit ship URL/code setup, Urbit API auth/session, Rich text conversion

## Suggested Bands

- `Lovable` (95-100): complete across expected workflows, variants, and recovery branches, with only minor polish gaps.
- `Stable` (80-95): the expected workflow set is broadly present, with only bounded missing branches.
- `Beta` (70-80): the main workflow exists, but meaningful branches or recovery paths are still absent.
- `Alpha` (50-70): only a partial capability set is present; users can complete some core tasks but not the full expected workflow.
- `Experimental` (0-50): the category exposes only fragments of the intended capability.
