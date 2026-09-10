---
summary: "Google Meet OAuth setup, refresh tokens, preflight, and conference artifact exports"
read_when:
  - You are creating Google Cloud credentials for the Google Meet REST API
  - You are minting or rotating the Google Meet refresh token
  - You are reading Meet artifacts, attendance, or transcript exports
title: "Google Meet OAuth and artifacts"
sidebarTitle: "OAuth and artifacts"
---

Google Cloud credentials, the refresh token, OAuth verification, and reading Meet artifacts, attendance, and exports. Part of the [Google Meet plugin](/plugins/google-meet) guide.

## OAuth and preflight

OAuth is optional for creating a Meet link, because `googlemeet create` can fall back to browser automation. Configure OAuth for official API create, space resolution, or Meet Media API preflight. Chrome/Chrome-node joins never depend on OAuth; they use a signed-in Chrome profile, the host's native virtual-audio backend, and (for `chrome-node`) a connected node either way.

### Create Google credentials

In Google Cloud Console:

<Steps>
<Step title="Create or select a project">
</Step>
<Step title="Enable the Google Meet REST API">
</Step>
<Step title="Configure the OAuth consent screen">
Internal is simplest for a Google Workspace organization. External works for personal/test setups; while the app is in Testing, add each Google account that will authorize it as a test user.
</Step>
<Step title="Add the requested scopes">
- `https://www.googleapis.com/auth/meetings.space.created`
- `https://www.googleapis.com/auth/meetings.space.readonly`
- `https://www.googleapis.com/auth/meetings.space.settings`
- `https://www.googleapis.com/auth/meetings.conference.media.readonly`
- `https://www.googleapis.com/auth/calendar.events.readonly` (Calendar lookup)
- `https://www.googleapis.com/auth/drive.meet.readonly` (transcript/smart-note document body export)

</Step>
<Step title="Create an OAuth client ID">
Application type **Web application**. Authorized redirect URI:

```text
http://localhost:8085/oauth2callback
```

</Step>
<Step title="Copy the client ID and client secret">
</Step>
</Steps>

`meetings.space.created` is required by `spaces.create`. `meetings.space.readonly` resolves Meet URLs/codes to spaces. `meetings.space.settings` lets OpenClaw pass `SpaceConfig` settings such as `accessType` during API room creation. `meetings.conference.media.readonly` is for Meet Media API preflight and media work; Google may require Developer Preview enrollment for actual Media API use. `calendar.events.readonly` is only needed for `--today`/`--event` calendar lookup. `drive.meet.readonly` is only needed for `--include-doc-bodies` export. If you only need browser-based Chrome joins, skip OAuth entirely.

### Mint the refresh token

Configure `oauth.clientId` and optionally `oauth.clientSecret` (or pass them as environment variables), then run:

```bash
openclaw googlemeet auth login --json
```

This runs a PKCE flow with a localhost callback on `http://localhost:8085/oauth2callback`, and prints an `oauth` config block with a refresh token. Add `--manual` for a copy/paste flow when the browser cannot reach the local callback:

```bash
OPENCLAW_GOOGLE_MEET_CLIENT_ID="your-client-id" \
OPENCLAW_GOOGLE_MEET_CLIENT_SECRET="your-client-secret" \
openclaw googlemeet auth login --json --manual
```

JSON output:

```json
{
  "oauth": {
    "clientId": "your-client-id",
    "clientSecret": "your-client-secret",
    "refreshToken": "refresh-token",
    "accessToken": "access-token",
    "expiresAt": 1770000000000
  },
  "scope": "..."
}
```

Store the `oauth` object under the plugin config:

```json5
{
  plugins: {
    entries: {
      "google-meet": {
        enabled: true,
        config: {
          oauth: {
            clientId: "your-client-id",
            clientSecret: "your-client-secret",
            refreshToken: "refresh-token",
          },
        },
      },
    },
  },
}
```

Prefer environment variables when you do not want the refresh token in config; config is resolved first, then environment as fallback. If you authenticated before meeting creation, calendar lookup, or document-body export support existed, rerun `openclaw googlemeet auth login --json` so the refresh token covers the current scope set.

### Verify OAuth with doctor

```bash
openclaw googlemeet doctor --oauth --json
```

This checks OAuth config exists and the refresh token can mint an access token, without loading the Chrome runtime or requiring a connected node. The report includes only status fields (`ok`, `configured`, `tokenSource`, `expiresAt`, check messages) and never prints the access token, refresh token, or client secret.

| Check                | Meaning                                                                          |
| -------------------- | -------------------------------------------------------------------------------- |
| `oauth-config`       | `oauth.clientId` plus `oauth.refreshToken`, or a cached access token, is present |
| `oauth-token`        | The cached access token is still valid, or the refresh token minted a new one    |
| `meet-spaces-get`    | Optional `--meeting` check resolved an existing Meet space                       |
| `meet-spaces-create` | Optional `--create-space` check created a new Meet space                         |

Prove Meet API enablement and `spaces.create` scope with the side-effecting create check:

```bash
openclaw googlemeet doctor --oauth --create-space --json
```

Prove read access to an existing space:

```bash
openclaw googlemeet doctor --oauth --meeting https://meet.google.com/abc-defg-hij --json
openclaw googlemeet resolve-space --meeting https://meet.google.com/abc-defg-hij
```

A `403` from these checks usually means the Meet REST API is disabled, the refresh token is missing the required scope, or the Google account cannot access that space. A refresh-token error means rerun `openclaw googlemeet auth login --json` and store the new `oauth` block.

No OAuth is needed for the browser fallback; Google auth there comes from the signed-in Chrome profile on the selected node, not OpenClaw config.

These environment variables are accepted as fallbacks:

- `OPENCLAW_GOOGLE_MEET_CLIENT_ID` or `GOOGLE_MEET_CLIENT_ID`
- `OPENCLAW_GOOGLE_MEET_CLIENT_SECRET` or `GOOGLE_MEET_CLIENT_SECRET`
- `OPENCLAW_GOOGLE_MEET_REFRESH_TOKEN` or `GOOGLE_MEET_REFRESH_TOKEN`
- `OPENCLAW_GOOGLE_MEET_ACCESS_TOKEN` or `GOOGLE_MEET_ACCESS_TOKEN`
- `OPENCLAW_GOOGLE_MEET_ACCESS_TOKEN_EXPIRES_AT` or `GOOGLE_MEET_ACCESS_TOKEN_EXPIRES_AT`
- `OPENCLAW_GOOGLE_MEET_DEFAULT_MEETING` or `GOOGLE_MEET_DEFAULT_MEETING`
- `OPENCLAW_GOOGLE_MEET_PREVIEW_ACK` or `GOOGLE_MEET_PREVIEW_ACK`

### Resolve, preflight, and read artifacts

```bash
openclaw googlemeet resolve-space --meeting https://meet.google.com/abc-defg-hij
openclaw googlemeet preflight --meeting https://meet.google.com/abc-defg-hij
```

After Meet has created conference records:

```bash
openclaw googlemeet artifacts --meeting https://meet.google.com/abc-defg-hij
openclaw googlemeet attendance --meeting https://meet.google.com/abc-defg-hij
openclaw googlemeet export --meeting https://meet.google.com/abc-defg-hij --output ./meet-export
```

With `--meeting`, `artifacts` and `attendance` use the latest conference record by default; pass `--all-conference-records` for every retained record.

Calendar lookup resolves the meeting URL from Google Calendar before reading artifacts (requires a refresh token that includes the Calendar events readonly scope):

```bash
openclaw googlemeet latest --today
openclaw googlemeet calendar-events --today --json
openclaw googlemeet artifacts --event "Weekly sync"
openclaw googlemeet attendance --today --format csv --output attendance.csv
```

`--today` searches today's `primary` calendar for an event with a Meet link; `--event <query>` searches matching event text; `--calendar <id>` targets a non-primary calendar. `calendar-events` previews matching events and marks which one `latest`/`artifacts`/`attendance`/`export` will choose.

If you already know the conference record id, address it directly:

```bash
openclaw googlemeet latest --meeting https://meet.google.com/abc-defg-hij
openclaw googlemeet artifacts --conference-record conferenceRecords/abc123 --json
openclaw googlemeet attendance --conference-record conferenceRecords/abc123 --json
```

Close the room for an API-created space:

```bash
openclaw googlemeet end-active-conference https://meet.google.com/abc-defg-hij
```

Calls `spaces.endActiveConference` and requires OAuth with the `meetings.space.created` scope for a space the authorized account can manage. Accepts a Meet URL, meeting code, or `spaces/{id}` and resolves it to the API space resource first. This is separate from `googlemeet leave`: `leave` stops OpenClaw's local/session participation; `end-active-conference` asks Google Meet to end the active conference for the space.

Write a readable report:

```bash
openclaw googlemeet artifacts --conference-record conferenceRecords/abc123 \
  --format markdown --output meet-artifacts.md
openclaw googlemeet attendance --conference-record conferenceRecords/abc123 \
  --format csv --output meet-attendance.csv
openclaw googlemeet export --conference-record conferenceRecords/abc123 \
  --include-doc-bodies --zip --output meet-export
openclaw googlemeet export --conference-record conferenceRecords/abc123 \
  --include-doc-bodies --dry-run
```

`artifacts` returns conference record metadata plus participant, recording, transcript, structured transcript-entry, and smart-note resource metadata when Google exposes it. `--no-transcript-entries` skips entry lookup for large meetings. `attendance` expands participants into participant-session rows with first/last seen times, total session duration, late/early-leave flags, and duplicate participant resources merged by signed-in user or display name; `--no-merge-duplicates` keeps raw resources separate, `--late-after-minutes`/`--early-before-minutes` tune the thresholds.

`export` writes a folder with `summary.md`, `attendance.csv`, `transcript.md`, `artifacts.json`, `attendance.json`, and `manifest.json`. `manifest.json` records the chosen input, export options, conference records, output files, counts, token source, any Calendar event used, and partial-retrieval warnings. `--zip` also writes a portable archive next to the folder. `--include-doc-bodies` exports linked transcript/smart-note Google Docs text through Drive `files.export` (requires the Drive Meet readonly scope); without it, exports include Meet metadata and structured transcript entries only. A partial artifact failure (smart-note listing, transcript-entry, or document-body error) keeps the warning in the summary/manifest instead of failing the whole export. `--dry-run` fetches the same data and prints the manifest JSON without creating the folder or ZIP.

Agents use the same actions through the `google_meet` tool (`export`, `create` with `accessType`, `end_active_conference`, `test_listen`); see [Tool](/plugins/google-meet/tool-and-modes#tool).

### Live smoke test

```bash
OPENCLAW_LIVE_TEST=1 \
OPENCLAW_GOOGLE_MEET_LIVE_MEETING=https://meet.google.com/abc-defg-hij \
pnpm test:live -- extensions/google-meet/google-meet.live.test.ts
```

```bash
openclaw googlemeet setup --transport chrome-node --mode transcribe
openclaw googlemeet test-listen https://meet.google.com/abc-defg-hij --transport chrome-node --timeout-ms 30000
```

| Variable                                                                                                                  | Purpose                                                                |
| ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `OPENCLAW_LIVE_TEST=1`                                                                                                    | Enables guarded live tests                                             |
| `OPENCLAW_GOOGLE_MEET_LIVE_MEETING`                                                                                       | Retained Meet URL, code, or `spaces/{id}`                              |
| `OPENCLAW_GOOGLE_MEET_CLIENT_ID` / `GOOGLE_MEET_CLIENT_ID`                                                                | OAuth client id                                                        |
| `OPENCLAW_GOOGLE_MEET_REFRESH_TOKEN` / `GOOGLE_MEET_REFRESH_TOKEN`                                                        | Refresh token                                                          |
| `OPENCLAW_GOOGLE_MEET_CLIENT_SECRET`, `OPENCLAW_GOOGLE_MEET_ACCESS_TOKEN`, `OPENCLAW_GOOGLE_MEET_ACCESS_TOKEN_EXPIRES_AT` | Optional; same fallback names without the `OPENCLAW_` prefix also work |

The base artifact/attendance smoke needs `meetings.space.readonly` and `meetings.conference.media.readonly`. Calendar lookup needs `calendar.events.readonly`. Drive document-body export needs `drive.meet.readonly`.

### Create examples

```bash
openclaw googlemeet create
```

Prints the new meeting URI, source, and join session. With OAuth it uses the Meet API; without it, the pinned Chrome node's signed-in profile. Browser fallback JSON:

```json
{
  "source": "browser",
  "meetingUri": "https://meet.google.com/abc-defg-hij",
  "joined": true,
  "browser": {
    "nodeId": "ba0f4e4bc...",
    "targetId": "tab-1"
  },
  "join": {
    "session": {
      "id": "meet_...",
      "url": "https://meet.google.com/abc-defg-hij"
    }
  }
}
```

If the browser fallback hits Google login or a Meet permission blocker first, `google_meet` returns structured details instead of a plain string:

```json
{
  "source": "browser",
  "error": "google-login-required: Sign in to Google in the OpenClaw browser profile, then retry meeting creation.",
  "manualAction": {
    "reason": "google-login-required",
    "message": "Sign in to Google in the OpenClaw browser profile, then retry meeting creation."
  },
  "browser": {
    "nodeId": "ba0f4e4bc...",
    "targetId": "tab-1",
    "browserUrl": "https://accounts.google.com/signin",
    "browserTitle": "Sign in - Google Accounts"
  }
}
```

API create JSON:

```json
{
  "source": "api",
  "meetingUri": "https://meet.google.com/abc-defg-hij",
  "joined": true,
  "space": {
    "name": "spaces/abc-defg-hij",
    "meetingCode": "abc-defg-hij",
    "meetingUri": "https://meet.google.com/abc-defg-hij"
  },
  "join": {
    "session": {
      "id": "meet_...",
      "url": "https://meet.google.com/abc-defg-hij"
    }
  }
}
```

Creating joins by default, but Chrome/Chrome-node still needs a signed-in Google profile to join through the browser; if signed out, OpenClaw returns `manualAction` or a browser fallback error and asks the operator to finish Google login before retrying.

Set `preview.enrollmentAcknowledged: true` only after confirming your Cloud project, OAuth principal, and meeting participants are enrolled in the Google Workspace Developer Preview Program for Meet media APIs.
