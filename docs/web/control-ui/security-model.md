---
summary: "Content security policy, public transcript boundaries, authenticated media routes, and approval links"
read_when:
  - Reviewing Control UI browser security
  - Exposing public session links through a login proxy
  - Debugging a blocked avatar or assistant media request
  - Forwarding an approval link
title: "Security model"
sidebarTitle: "Security model"
---

How the Control UI restricts the browser and authenticates its own routes.

## Content security policy

The Control UI allows **same-origin** assets, `data:` URLs, locally generated `blob:` URLs, and remote HTTPS images. Remote HTTP images are blocked. Protocol-relative image URLs follow the document's scheme.

In practice:

- Avatars and images served under relative paths (for example `/avatars/<id>`) still render, including authenticated avatar routes the UI fetches and converts into local `blob:` URLs.
- Inline `data:image/...` URLs still render.
- Local `blob:` URLs created by the Control UI still render. Text attachment previews can read those local bytes before the attachment is sent.
- HTTPS transcript images render in Chat image galleries and Activity previews. The browser contacts the image host directly, disclosing its network address; thumbnails, the expanded image viewer, and neighboring-image preloads send no page referrer.
- Markdown attachment and Skill Workshop previews keep remote images as click-to-open links. Plugin README and agent-file previews automatically load HTTPS images and contact their hosts directly from the browser.
- Verified GitHub account avatars render from `avatars.githubusercontent.com`; avatar helpers continue to reject arbitrary remote avatar URLs.
- GitHub link preview avatars are fetched by the Gateway from GitHub's fixed avatar host and returned as bounded `data:` URLs; the operator browser never contacts the remote avatar host.
- Link favicons are on by default. The authenticated Control UI requests them through the Gateway; the browser never contacts link destinations directly. The link-favicon route requests each public hostname's HTTPS `/favicon.ico`, with strict DNS-pinned SSRF checks on the original URL and every redirect plus bounded time, bytes, concurrency, and image validation. Private, internal, and IP-literal destinations are rejected. This discloses linked hostnames and the Gateway's network address to those sites. Browser-tab cards and ordinary external-link hover previews also fetch the public page’s title, bounded description, declared favicon, and Open Graph or Twitter social image through the authenticated Gateway. These anonymous requests never use browser cookies or site credentials; HTML, redirects, and images receive the same public-network checks and bounded resource limits. The browser receives validated image data, not remote image URLs. This also discloses the target page URL (including path and query) to that site and image requests to its declared image hosts. Ordinary link previews start on deliberate hover or keyboard focus, not transcript prefetch; touch taps retain normal navigation. Wizard sign-in actions stay external and are not fetched for previews. Plugin-owned previews keep their own routing and credential policy. Set `gateway.controlUi.automaticallyFetchFavicons: false` to disable link favicon requests, browser-tab page previews, and ordinary external-link previews. Live browser screenshots are separate and remain available.
- Animated PNG (APNG) icons are accepted as PNG images. Workspace icons and managed channel avatars retain their animation; remote plugin, catalog, and link icons use a resized PNG preview.
- Remote avatar URLs emitted by channel metadata are stripped at the Control UI's avatar helpers and replaced with the built-in logo/badge, so a compromised or malicious channel cannot force arbitrary remote image fetches from an operator browser.

Page metadata reads stop at the end of the HTML head or after 64 KiB, whichever
comes first; metadata beyond that limit is omitted. The Gateway streams the head
without building a page DOM. Anonymous previews use a bounded cache per requesting
principal and runtime config revision for one hour when available, or five minutes
when unavailable; URL fragments share the same entry. Repeated links share pending
requests, and a page that declares the same social image and favicon downloads it
once. The 15-second preview deadline includes queue wait, fetching, and image work.
Disabling automatic favicons or retiring the request's authority suppresses cached
previews too.

The browser-side CSP restriction itself is always on and not configurable.

## Public transcript boundary

Public threads use the same `/chat/...` URL as the authenticated Control UI.
Anonymous readers receive a separate, read-only document, never an operator
connection. **Log in** goes through a protected same-origin handoff and returns
to that thread with the person's existing permissions. Identity headers on the
anonymous thread path do not authorize private access. Private and missing
threads have the same anonymous unavailable response.

In token/password deployments, the reader can recognize a browser-held session
token or paired-device credential scoped to the current Gateway address and base
path. After the protected probe returns `401`, that presence is only a navigation
hint to open the app shell; the reader never sends the credential or authorizes
session data. The app's existing WebSocket and bootstrap checks still apply.
A `204` probe continues into the app, while `403` keeps the public reader even
when local credentials exist. Trusted-proxy and external-login handoffs retain
their existing authentication and permission checks.

Loopback HTTP retains its public-reader support. On non-secure ingress where
publication is unavailable, token/password chat links serve the app shell
directly, without looking up or disclosing a transcript. Serving the shell grants
no Gateway or session access.

The public renderer includes only user messages and assistant final-answer text.
It omits tools, reasoning, files, images, widgets, hidden messages, and internal
metadata. Included text preserves credentials; review it before publishing. A restrictive
content security policy permits only the fixed reader script; transcript HTML
cannot execute. Responses retain `Cache-Control: no-store` and
`Referrer-Policy: no-referrer`. Server-side representation reuse never substitutes
for a current publication check, including before a `304` response.

Anyone who knows a public thread URL can read its existing and future published
text until the creator or a Gateway admin disables access. Re-enabling access
revives the normal thread URL, but not previously revoked token links.

A login proxy must expose only the public thread documents and share namespace.
Keep the session-entry login handoff, WebSocket, bootstrap, API, media, dashboard,
and other application routes protected. The detailed deployment and revocation
contract is in [Public session transcripts](/web/urls#public-session-transcripts).

## Avatar route auth

When gateway auth is configured, the Control UI avatar endpoint requires the same gateway token as the rest of the API:

- `GET /avatar/<agentId>` returns the avatar image only to authenticated callers. `GET /avatar/<agentId>?meta=1` returns the avatar metadata under the same rule.
- Unauthenticated requests to either route are rejected (matching the sibling assistant-media route), so the avatar route cannot leak agent identity on hosts that are otherwise protected.
- The Control UI forwards the gateway token as a bearer header when fetching avatars, and uses authenticated blob URLs so the image still renders in dashboards.
- Browser avatar URLs include an opaque `v` revision. Static PNG, JPEG, and WebP avatars use cached previews with a maximum side of 128 pixels. Animated images, SVG, and other accepted data-URL formats retain their original bytes and encoding. The sidebar and chat panes share fetched images, and private browser caching avoids downloading unchanged bytes on reload.
- Refreshed metadata uses a new URL after the source changes. Replacing a local avatar file is picked up by the next identity refresh after the shared 60-second freshness window. Conditional requests still require authentication before returning `304 Not Modified`. The revision is a cache key, not an access token; unversioned image requests retain the original image.

If you disable gateway auth (not recommended on shared hosts), the avatar route also becomes unauthenticated, in line with the rest of the gateway.

Concurrent profile-photo requests can share a Gravatar lookup. Each HTTP request
keeps its own timeout and disconnect lifecycle, so one expired or disconnected
request does not interrupt another client loading the same photo.

Saved profile photos use a bounded in-memory cache tied to the Gateway's profile
catalog. Committed profile edits and merges invalidate cached representations;
authentication still runs before cached responses and `304 Not Modified`.
Cold photo reads have a separate concurrency budget to preserve shared-state read
capacity. During overload, the endpoint returns `503 Service Unavailable` with
`Retry-After: 1` instead of a permanent lookup failure.

## Assistant media route auth

Local image previews follow the chat's filesystem permissions. Project chats use
their session workspace, including managed worktrees. Full Access, or disabled
workspace-only filesystem protection, also permits image previews outside that
workspace. An explicit session permission mode takes precedence over the agent's
filesystem setting.

Assistant `MEDIA:` attachments in local project chats resolve relative paths
inside the session workspace, including managed worktrees. Absolute paths in
that workspace are staged for delivery under the same file-access checks.
Selecting a project does not grant access to sibling worktrees.

Trusted audio attachments use the same session workspace boundary during playback.
Mixed replies retain a separate failure card for each rejected attachment alongside
successfully delivered media.

Attachment staging and trusted audio retain the requesting sender's read
restrictions. Pending reads and copies stop when the source session's permission
mode, workspace, or execution placement changes, or the turn is canceled. Rejected
staged files are cleaned up before delivery.

Sessions dispatched to a cloud worker cannot read Gateway-local file paths,
even with Full Access. Dispatch also revokes pending local previews and downloads.
Gateway-owned inbound uploads remain available.

Full Access also preserves playback and downloads for existing attachments in
the agent's configured workspace. It does not permit arbitrary outside
non-image files.

With workspace protection enabled, an outside image shows **Outside allowed
folders**. Hover over its filename to inspect the source path. Administrators can
select **Allow image** to preview that exact file without changing the session's
permissions or allowing its parent folder. The allowance uses a short-lived media
ticket; replacing the file or restarting the Gateway requires a new allowance.

When gateway auth is configured, assistant local-media previews use a two-step route:

- `GET /__openclaw__/assistant-media?meta=1&source=<path>&sessionKey=<key>&agentId=<id>` requires the normal Control UI operator auth and access to the selected session; the browser sends the gateway token as a bearer header when checking availability.
- Successful metadata responses include a short-lived `mediaTicket` scoped to the file and session. Explicit outside-image allowances use an authenticated administrator `POST` to the same route with `meta=1&allow=1`.
- Browser-rendered image, audio, video, and document URLs use `mediaTicket=<ticket>` instead of the active gateway token or password. The ticket expires quickly and cannot authorize a different source.

Tickets remain bound to the issuing reader's current access. Losing session
visibility or role permissions stops new reads through existing tickets, even
before they expire.

This keeps media rendering compatible with browser-native media elements without putting reusable gateway credentials in visible media URLs.

Uploaded and local chat image previews rendered with native image elements keep an already-loaded image visible during temporary connection or metadata-renewal failures. That failure tolerance applies only to the mounted image; it does not extend its media ticket or authorize fresh reads. Scrolling can reuse a successfully decoded image from the bounded in-memory preview cache while its existing metadata and ticket remain valid, without another image download or loading placeholder. An explicit missing or access-denied response, or a change to the source, credentials, or access scope, clears the retained image. When the UI receives a sharing invalidation, a role-configuration change, or the connection close for a role reassignment, cached previews must pass fresh admission before remounting.

Uploaded images also stay visible while a new session's workspace or worktree details arrive. Media access is rechecked in the background without replacing the loaded preview with a loading card.

Generated images under `/api/chat/media/outgoing/...` use the same capability
principle through `artifacts.download`. The authenticated WebSocket request
authorizes the transcript artifact and returns a short-lived URL. The HTTP media
route rechecks that the artifact still belongs to the transcript before serving
bytes. The previous shared-owner bearer path remains available for older Control
UI clients during the compatibility window.

## Approval links

Operator approval notifications can deep-link to a [standalone approval document](/web/urls#other-special-documents-and-startup-modes). The URL is stable for the lifetime of the approval and safe to forward between your own devices: it identifies the approval, never authorizes it.

- The approval namespace is reserved by the Gateway ahead of plugin HTTP routes for **all** HTTP methods, so a plugin route can never shadow or intercept an approval document.
- Opening an approval document requires the same gateway auth as the rest of the Control UI (token/password, Tailscale Serve identity, or trusted-proxy identity); credentials are never part of the approval URL.
- When Control UI serving is disabled, requests to the namespace return `404` instead of falling through to plugin handlers.
- Signing in on an approval document is ephemeral for that page: it does not overwrite the gateway selection or settings saved by the full Control UI in the same browser.
