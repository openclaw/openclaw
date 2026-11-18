# Human approval service (in development)

Independently deployable Node.js service for immutable approval requests delivered
as Google Chat Workspace add-on cards. No OpenClaw runtime dependency. Publisher
integration is still in development. Normal release validation has not changed.
Deployment, identity enrollment and human mobile proof are separate acceptance
steps; local tests alone do not establish them.

## Contract

- `POST /requests` with `{"payload":"<compact JSON object>"}`. Payload must contain
  lowercase UUIDv4 `requestId`, explicit `action`, and ISO `expiresAt` within 24 hours. All other
  fields are displayed, not interpreted. Noncompact or duplicate-key JSON fails.
  Digest is `sha256:` followed by SHA-256 of the exact UTF-8 payload bytes.
- Request ID is an idempotency key. Different bytes under the same ID fail.
  Repeat the same POST after uncertain/partial delivery. Per-DM deterministic
  Chat message IDs prevent duplicate notifications. No queue or scheduler.
- `GET /requests/<requestId>` returns stored payload, digest, expiry, and
  `state: pending|approved|rejected`. A decision adds stable `approver` (`users/N`),
  `approverEmail`, and server `decidedAt`. Each authenticated button attempt also
  records bounded `lastAttempt` metadata (requested decision, previous state,
  recorded/unchanged outcome, stable user ID and receive time). It never replaces
  the first decision or stores the callback body. Conflicting later clicks return
  an explicit no-change confirmation, not an apparent new approval. Decision
  responses replace the original card with its final status and remove buttons,
  preserving all immutable review details. Expiry is enforced when deciding and
  must also be enforced by the consumer. An expired stored approval is not usable.
- `/chat` is the only decision path. Google-authenticated modern Workspace add-on
  `chat.buttonClickedPayload` events only, not ordinary text or machine-submitted
  identity. First decision wins transactionally, including opposing duplicate
  clicks. Either designated human may decide.
- Only `vincent@openclaw.org` and `dallin@openclaw.org` may enroll and approve.
  Enrollment occurs when the user adds the app to a private DM. The authenticated
  Google user ID is persisted; an ID change fails rather than silently rebinding.
  Requests notify every enrolled approver and require at least one enrolled approver. No domain-wide approval.

## Card presentation

The service renders labeled fields rather than a JSON blob. Numeric summaries
are compact, named outstanding checks are prominent, and nested evidence/artifact
and technical identity sections can be expanded. All request fields remain
reviewable, including fields from applications other than OpenClaw. Links only
open HTTPS URLs without user information. The exact compact JSON still owns the
digest and persisted approval; presentation never changes its contents. Cards
exceeding 32,000 serialized bytes or 99 pending widgets are rejected before
delivery, reserving the final widget for the recorded decision.

## Deployment requirements

Use a separate project managed by `services@openclaw.org`. Do not reuse a project
where release-agent-accessible principals have project-wide service-account
impersonation, deployment or database write access. Project separation does not
remove inherited organization access or an agent's access to the setup account.

Required resources: one Cloud Run service, one Firestore Native database, one
Artifact Registry image repository, Google Chat API configuration, a runtime
service account, and request/read-only caller identities. A build service is
optional if an image is built locally. Use no service-account JSON keys, no domain
wide delegation, no public Firestore rules, no additional always-on instance,
load balancer, custom domain, Cloud SQL, or scheduler.

Runtime configuration:

- `SERVICE_URL`: exact HTTPS service origin without trailing slash.
- `CHAT_SERVICE_ACCOUNT`: per-project identity copied from the saved Chat API
  configuration, `service-N@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`.
- `REQUESTER_EMAILS`: comma-separated Google service-account identities permitted
  to create and read requests. Not allowed to approve.
- `READER_EMAILS`: comma-separated publisher identities permitted only to read.
- Standard Google ADC/project settings; `PORT` defaults to 8080.

Use request-based Cloud Run billing, minimum instances 0 and maximum instances 1.
Use a free-tier eligible region, colocate image and service, retain few image
versions, and do not enable paid vulnerability scanning, Firestore PITR/backups or
TTL deletion. Configure the authorized monthly budget alert (the billing account uses EUR; a conservative EUR 5 alert is below the proposed USD 10 warning), noting that alerts
are not a hard spending limit. At roughly 20 requests/month, runtime/database
usage should fit free allowances; shared quotas, build/storage or unexpected
traffic can still incur charges. Paid billing requires explicit owner approval.

The runtime needs Firestore read/write access and Chat app authentication
(`chat.bot`). It must not have project IAM admin, service deployment, service
account key creation, or impersonation authority. Requests are private DMs, not
public spaces. Configure app visibility to the two exact emails, never the domain.
The HTTPS server authenticates every route with Google's maintained ID-token
verifier and separate callback versus caller allowlists. Configure Chat's exact
HTTP endpoint audience. Public ingress, if selected, still requires these tokens
and requires explicit permission approval before enabling it. Alternatively use
Cloud Run IAM plus compatible per-route ID-token audience configuration and
specific invokers; verify the actual deployed combination rather than assuming it.

Build and local tests (from this directory):

```sh
npm ci --ignore-scripts
npm test
docker build -t release-approval .
```

Local tests include synthetic HTTP and decision-boundary fixtures, not live
Firestore, actual Google-issued callbacks, human mobile taps or deployment proof.
Malformed-token rejection uses the real Google authentication library. Do not
present the synthetic accepted identity fixture as verified Google authentication.

## Provisioning automation

The documented `projects.chatAppConfig.get` and `patch` methods can manage the
Chat configuration without UI automation. They currently carry a Developer
Preview designation. Read the complete existing configuration first, patch only
owned fields, then read with `view=FULL` to verify the exact two-person visibility
list and callback URL. Do not enroll the organization in a preview or change
organization policies to obtain access. The Cloud console remains an alternative
administration surface. Use the actual per-project identity returned by
`gcloud workspace-add-ons get-authorization`, not a guessed Google callback
identity.

Cloud Build uses `cloudbuild.yaml` with `_IMAGE` supplied explicitly and a
user-managed builder identity. Grant that builder source-bucket object read,
image-repository write and log write only. It does not need access to approval
records or deployment. The image starts as a non-root user and includes a
non-root startup/auth-rejection smoke in the build. `.gcloudignore` keeps local
credentials, dependency installs and proof fixtures out of source uploads.

Prefer private Cloud Run IAM invocation: grant `roles/run.invoker` only to the
verified Google Chat principal and the request/read identities. Add the exact
`SERVICE_URL/chat` custom audience to Cloud Run for callbacks. The application
still verifies each route's audience and principal, so a request-only token cannot
approve even though that identity may invoke the service.

## Mobile setup and production acceptance (pending)

1. Save Chat configuration with the exact two-person visibility list and verified
   per-project callback identity. Verify no other identity can invoke decisions.
2. Each approver signs into the existing Google Chat mobile app with their own
   account, adds this app in a DM, and enables notifications for that DM.
3. Verify both stored Google user IDs against the two authenticated enrollment
   events. Do not guess IDs from display names or accept agent-supplied IDs.
4. Submit synthetic, non-publishing requests. Have a real human tap Approve and
   Reject on mobile; inspect exact status/digest, expiry, and repeat delivery.
5. Verify Firestore transaction races and real callback token/audience rejection.
6. Independently audit Workspace domain-wide delegation and Google impersonation,
   GitHub protected tooling tags/workflows, npm trusted publishers and Docker
   credentials. Agents that can replace the enforcing publisher can bypass it.
7. Revoke temporary setup CLI credentials, remove setup-vault and administrative
   access from release agents, and verify deployment/allowlist/database writes
   remain outside their authority. The setup agent currently retains equivalent
   administrative access, so production isolation cannot yet be claimed.

## Official contracts

- https://developers.google.com/workspace/chat/verify-requests-from-chat
- https://developers.google.com/workspace/add-ons/concepts/event-objects
- https://developers.google.com/workspace/chat/create-messages
- https://cloud.google.com/run/pricing
- https://cloud.google.com/firestore/pricing

- https://developers.google.com/workspace/add-ons/reference/rest/v1/projects.chatAppConfig
