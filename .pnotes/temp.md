Good — you’ve done the one part that’s usually human-only: creating the **AgentMail account identity**.

Now the sequence is:

1. **You** create the credentials/API key (because Tim can’t bootstrap that without access)
2. **Tim** uses the API key to create/configure the mailbox + gateway + restrictions

## Step 1 — What you must do first (human steps)

You said you haven’t set any credentials yet. Do these in this order:

1. **Set the password** for `timsmail@agentmail.to` (whatever the AgentMail signup flow requires).
2. **Enable 2FA** if AgentMail supports it.
3. **Create an API key** in the AgentMail dashboard (this is what Tim will use; he should not be using your interactive login).
4. Decide where you want secrets stored (recommended):

   * `C:\Users\fjventura20\.openclaw\workspace\secrets\agentmail.env` (or inside your project workspace)
   * The key point: **store secrets inside the workspace Tim can access**, not in your home directory unless that directory is mounted/allowed.

When you finish step (3), you will have something like:

* `AGENTMAIL_API_KEY=am_us_2152135269b7ca63bddf3123c8719b65878f4f07a9167161313f73c9e34be0e8`
* (optionally) base URL `https://api.agentmail.to`

## Step 2 — What to tell Tim (prompt you can paste)

Paste this to Tim exactly. Replace placeholders in ALL CAPS.

```text
Tim,

We now have an AgentMail account identity: timsmail@agentmail.to

You are NOT allowed to sign up for AgentMail or log into any human dashboard.
You are allowed to use the AgentMail API ONLY via a gateway you build in this workspace.

I (Frank) will provide the AgentMail API key via a local secrets file in the workspace.
Your job is to:

1) Validate secrets file exists and is readable:
   - Path: ./secrets/agentmail.env
   - Expected keys:
     AGENTMAIL_API_KEY=...
     AGENTMAIL_BASE_URL=https://api.agentmail.to

2) Create/update the mailbox configuration file:
   - Path: ./config/agent_email.json
   - Contents must include:
     {
       "email": "timsmail@agentmail.to",
       "inbox_id": "<resolved from API if applicable>",
       "provider": "agentmail",
       "base_url": "https://api.agentmail.to"
     }

3) Implement a gateway service so the LLM never sees the API key:
   - Path: ./services/agentmail-gateway.js
   - Expose ONLY these functions:
     - send_email(to, subject, body)
     - read_agent_inbox()
     - get_verification_links()

4) Enforce restrictions in the gateway:
   - Outbound allowlist recipients ONLY:
     - OWNER_EMAIL = "YOUR_EMAIL_HERE"
   - If recipient not allowlisted:
     BLOCK_REQUEST, LOG_EVENT, RETURN_ERROR
   - Rate limits:
     max_emails_per_hour = 5
     max_emails_per_day  = 20

5) Logging:
   - Path: ./logs/email_activity.log
   - Log fields:
     timestamp, action, recipient, subject, message_hash, status
   - Do NOT log message bodies.

6) Tests:
   - If API calls are possible, run:
     a) send test email to OWNER_EMAIL
     b) read inbox for a known test message (if available)
     c) extract any verification link found
   - If tests cannot run due to missing tooling, output MISSING CAPABILITY with tool_required and reason.

Operational rule:
- If any required tool/permission is missing, do NOT refuse.
  Output:
  MISSING CAPABILITY
  tool_required:
  reason:

Begin by printing an execution plan + the exact files you will create/modify.
Then implement.
```

## Step 3 — Create the secrets file Tim expects (you do this once)

Create this file inside Tim’s accessible workspace:

`./secrets/agentmail.env`

Contents:

```env
AGENTMAIL_API_KEY=am_us_2152135269b7ca63bddf3123c8719b65878f4f07a9167161313f73c9e34be0e8
AGENTMAIL_BASE_URL=https://api.agentmail.to
AGENTMAIL_EMAIL=timsmail@agentmail.to
OWNER_EMAIL=PUT_YOUR_EMAIL_HERE
```

### Windows PowerShell quick-create (in your project/workspace root)

```powershell
New-Item -ItemType Directory -Force -Path .\secrets | Out-Null
@"
AGENTMAIL_API_KEY=am_us_2152135269b7ca63bddf3123c8719b65878f4f07a9167161313f73c9e34be0e8
AGENTMAIL_BASE_URL=https://api.agentmail.to
AGENTMAIL_EMAIL=timsmail@agentmail.to
OWNER_EMAIL=PUT_YOUR_EMAIL_HERE
"@ | Set-Content -Encoding utf8 .\secrets\agentmail.env
```

## Step 4 — If Tim still says “MISSING CAPABILITY”

That means his environment still lacks at least one of these:

* **file read/write** in the workspace
* an **HTTP request tool** (or Node runtime allowed to make HTTPS calls)
* permission to create `./services`, `./config`, `./logs`

In that case, Tim should report exactly which tool is missing, and you’ll fix the agent/tooling config (not the model).
