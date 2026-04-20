# Employee Performance Grading — API & Data Source Reference

This document summarizes the APIs and data sources used for the **Employee Performance Grading System** (ops team scorecards: Coperniq 40%, Slack 30%, Email 20%, Proactive 10% — see `skills/performance-grading/SKILL.md` for weights, rubrics, and output format), and what exists in the codebase vs what must be added.

---

## 1. Coperniq (40% weight)

**Metrics:** Tasks/WOs assigned vs completed; phase transition speed; comment activity and follow-through.

### 1.1 Work orders — assigned vs completed, per person

| What                 | API                                          | Notes                                                                                                                                                                                                                                                                     |
| -------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **List work orders** | `GET https://api.coperniq.io/v1/work-orders` | Pagination: `page_size` (max 100), `page`. Filters: `updated_after`, `updated_before` (ISO 8601). Sort: `order_by` (asc/desc).                                                                                                                                            |
| **Per‑WO fields**    | Response shape                               | `assignee` (id, firstName, lastName, email), `isCompleted`, `completedAt`, `createdAt`, `updatedAt`, `status` (string: "Completed" or "Assigned"), `checklist[]` (id, detail, isCompleted, completedAt), `statuses[]` (status, startedAt, endedAt, spentTime in seconds). |
| **Project context**  | Inline on WO                                 | Each WO has `project` (id, uid, title, address, phaseId).                                                                                                                                                                                                                 |

**Fields to use for grading (verified with live API):**

- **Group by employee:** `assignee.email` or `assignee.id` (nullable; omit unassigned).
- **Completion:** `isCompleted` (boolean), `completedAt` (ISO 8601 or null), `status` ("Completed" | "Assigned").
- **Checklist follow-through:** `checklist[].isCompleted`, `checklist[].completedAt` → % checklist items completed per WO.
- **Time-in-status / speed:** `statuses[]` has `startedAt`, `endedAt`, `spentTime` (seconds) per status (e.g. ASSIGNED, COMPLETED); use for avg days per WO or per phase.

**Exclusion rule — apply before any scoring:**
Only include WOs where the parent project status is `ACTIVE`. Drop any WO where `project` resolves to a project with status `CANCELLED` or `ON_HOLD`. Cross-reference via `project.id` against `projects.json` (or the inline `project` field on the WO).

| Project Status | Include? |
| -------------- | -------- |
| `ACTIVE`       | Yes      |
| `CANCELLED`    | No       |
| `ON_HOLD`      | No       |

**Scoring:** Completion rate = count of WOs with `isCompleted === true` for that assignee / total WOs assigned (ACTIVE projects only); optionally weight by checklist completion; optionally use `spentTime` for "speed" (lower = better).

**Codebase:** No Coperniq API client in repo yet. Use `COPERNIQ_API_KEY` and `x-api-key` header; see `skills/coperniq.io/Skill.MD` and `references/projects.md`.

### 1.2 Phase transition speed (projects)

| What               | API                                     | Notes                                                                                                                                                                                                                |
| ------------------ | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **List projects**  | `GET /v1/projects?page_size=100&page=1` | Returns array of projects with `owner`, `salesRep`, `projectManager` (id, firstName, lastName, email), `phase` (name, status, instanceId), `lastActivity`, but **not** full `phaseInstances[]`.                      |
| **Single project** | `GET /v1/projects/{id}`                 | Returns full `phaseInstances[]`: each has `id`, `name`, `status` (NOT_STARTED, IN_PROGRESS, COMPLETED), `position`, `startedAt`, `completedAt` (null if not completed), `phaseTemplate` (redSla, yellowSla in days). |

**Fields to use for grading (verified):**

- **Attribution:** `owner`, `salesRep`, `projectManager` — each `{ id, firstName, lastName, email }` (any can be null). Use for "who owns this project" (e.g. owner + salesRep).
- **Phase speed:** From `GET /v1/projects/{id}` → `phaseInstances[]`: for each instance with both `startedAt` and `completedAt`, compute days in phase; average per project then per person (by owner/salesRep/projectManager).
- **SLA context:** `phaseTemplate.redSla`, `yellowSla` (days) for "on time" scoring if desired.
- **Exclusion rule:** Only include projects where `status === "ACTIVE"`. Skip projects with `status === "CANCELLED"` or `status === "ON_HOLD"` before computing phase speed or attribution.

**Note:** `GET /v1/requests` may return `[]` if the org uses Projects only. Prefer projects for phase data.

### 1.3 Comments — activity and follow-through

| What              | API                                                   | Notes                                                |
| ----------------- | ----------------------------------------------------- | ---------------------------------------------------- |
| **List comments** | `GET /v1/projects/{id}/comments?page_size=100&page=1` | Response: `{ comments: [...], totalCount: number }`. |

**Fields to use for grading (verified):**

- **Each comment:** `id`, `comment` (HTML string), `createdByUser`: `{ id, firstName, lastName, email }`, `createdAt` (ISO 8601).
- **Per project:** Use `totalCount` or length of `comments`; for "comments per project" ratio, count comments per project (then average per owner/salesRep).
- **Per employee:** Group by `createdByUser.email` (or id) to get comment volume per person; combine with projects they own (owner/salesRep/projectManager) for "comments per project they're on" or follow-through (comment activity on assigned projects).

---

## 2. Slack Responsiveness (30% weight — see SKILL.md §4)

**Metric:** Average response time from rep message to ops employee reply, scored as letter grade A–F.

### 2.1 Monitored channels

**Rep-specific channels** (primary — see SKILL.md §4.3 for config format):

> Action required: populate rep-channel config with actual Slack channel IDs and user mappings.

**Additional monitored channels** (supplementary data):

| Channel               | Slack ID      |
| --------------------- | ------------- |
| #corporate-operations | `C0AB50H2K9R` |
| #vero                 | `C0AC5MSF4PJ` |

### 2.2 Employee Slack user IDs

| Employee      | Slack User ID                              |
| ------------- | ------------------------------------------ |
| Sam LeSueur   | `U0AB51A9J9H`                              |
| Clay Neser    | `U0ABF0QGM0C`                              |
| Daxton Dillon | `U0AB9B36PM4`                              |
| Ridge Payne   | `U096S2FQTUZ` (not graded — for reference) |

### 2.3 What the codebase already has

| Capability               | Location                                                                                   | Notes                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| **Read channel history** | `src/slack/actions.ts`: `readSlackMessages(channelId, { limit, before, after, threadId })` | Returns `{ messages: SlackMessageSummary[], hasMore }`. Wraps `conversations.history`.                     |
| **Message shape**        | `SlackMessageSummary`                                                                      | `ts` (decimal seconds, sortable), `user` (Slack user ID), `text`, `thread_ts`, `reply_count`, `reactions`. |
| **Thread replies**       | Same `readSlackMessages` with `threadId`                                                   | Wraps `conversations.replies`.                                                                             |
| **User info**            | `getSlackMemberInfo(userId)`                                                               | Resolve display name / email if needed.                                                                    |

### 2.4 Scoring algorithm

**Step 1 — Fetch channel history:** For each monitored channel (rep channels + supplementary), call `readSlackMessages(channelId, { oldest: windowStart, latest: windowEnd })` (paginate until `hasMore` is false). Or read from cache if daily sync is current.

**Step 2 — Identify rep messages:** In each rep-specific channel, identify messages from the rep user ID(s) configured for that channel. In supplementary channels, identify messages from non-ops, non-bot users directed at ops employees.

**Step 3 — Find first ops reply:** For each rep message, scan subsequent messages (same channel or thread, chronological by `ts`) for the first message from the assigned ops employee. Compute `delta_minutes = (reply_ts - rep_message_ts) / 60`.

**Step 4 — Compute rolling average:** Average all `delta_minutes` values per ops employee across all their assigned channels for the scoring window.

**Step 5 — Map to letter grade:**

| Grade | Numeric Score | Avg Response Time |
| ----- | ------------- | ----------------- |
| A     | 95            | < 15 minutes      |
| B     | 85            | < 30 minutes      |
| C     | 75            | < 1 hour          |
| D     | 65            | < 2 hours         |
| F     | 30            | > 2 hours         |

The numeric score feeds directly into the composite formula (see SKILL.md §1).

### 2.5 Baseline data (Q1 2026, from live channel pull)

> Historical reference from @mention-based measurement. The current scoring model uses **avg response time to rep messages** (not p50 of @mentions), but the `avg` column below is useful for calibration — all three employees averaged well over 2 hours, placing them at **grade F** under the current tiers.

| Employee | @mention n | p50     | avg     | ≤30min | ≤1hr | ≤4hr |
| -------- | ---------- | ------- | ------- | ------ | ---- | ---- |
| Sam      | 54         | 221 min | 289 min | 22%    | 27%  | 53%  |
| Daxton   | 76         | 211 min | 363 min | 17%    | 25%  | 53%  |
| Clay     | 40         | 291 min | 649 min | 22%    | 27%  | 42%  |

### 2.6 Ingestion strategy

**Script:** `scripts/slack-sync.ts` — standalone, uses Slack Web API directly with bot token from config or `SLACK_BOT_TOKEN` env.

**Schedule:** LaunchAgent `scripts/slack-sync.plist` — every 15 minutes. Can also be run manually: `pnpm exec tsx scripts/slack-sync.ts` (or `--force` for last 90 days).

**Cache location:** `~/.openclaw/cache/slack/`

| File                  | Contents                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `meta.json`           | `lastSyncAt` (ISO 8601), per-channel message count and lastTs                            |
| `C0AB50H2K9R.json`    | All fetched messages for #corporate-operations, sorted by `ts` ascending                 |
| `C0AC5MSF4PJ.json`    | All fetched messages for #vero, sorted by `ts` ascending                                 |
| `{repChannelId}.json` | Rep channel messages (once rep channels are added to `MONITORED_CHANNELS` in the script) |

**Sync steps:**

1. Read `meta.json` → get per-channel `lastTs`.
2. For each channel: `conversations.history` with `oldest: lastTs`, paginate via cursor.
3. Dedup by `ts`, append to `{channelId}.json`, sort ascending.
4. Update `meta.json` with new `lastSyncAt` and per-channel stats.

**No retention limit.** Cache grows over time so you can look back to any date. Trim manually if disk space becomes a concern.

**Scoring always reads from cache.** Never hits the live Slack API during scoring.

### 2.7 What's needed for grading

| Need                       | Description                                                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Daily sync**             | 1 `readSlackMessages` call per channel with `oldest: lastSyncAt`; append to cache; update `meta.json`. Expand to cover rep-specific channels. |
| **Rep-channel config**     | JSON config mapping channel IDs → rep user IDs + ops employee IDs (see SKILL.md §4.3).                                                        |
| **Cache reader**           | Load `{channelId}.json`; filter by `ts` to desired scoring window.                                                                            |
| **Rep message identifier** | Filter messages by configured rep user IDs per channel.                                                                                       |
| **Response finder**        | After each rep message, scan forward by `ts` for the first message from the assigned ops employee.                                            |
| **Average calculator**     | Average all response deltas per employee; map to letter grade tier.                                                                           |

---

## 3. Email Responsiveness (20% weight — see SKILL.md §5)

**Data source:** `email-archive/emails.json` (local archive, 500 messages, 328 threads).

**Metrics:** Response speed (letter grade A–F, same tiers as Slack) · open loop count.

### 3.1 File structure

```
email-archive/emails.json → { messages: Message[], nextPageToken: string }
```

Each `Message`:

```
{
  id: string,
  threadId: string,       // group by this to reconstruct conversations
  date: "YYYY-MM-DD HH:MM",
  from: "Name <email>",   // extract email with /<(.+?)>/
  subject: string,
  labels: string[],       // e.g. ["INBOX","UNREAD","CATEGORY_UPDATES"]
  body: string            // HTML; strip tags for text analysis
}
```

### 3.2 Employee email addresses

| Employee      | Email              |
| ------------- | ------------------ |
| Sam LeSueur   | sam@veropwr.com    |
| Clay Neser    | clay@veropwr.com   |
| Daxton Dillon | daxton@veropwr.com |

Skip senders containing: `notification@coperniq.io`, `noreply@`, `mailer-daemon`, `stripe.com`, `bill.com`, `powerclerk`, `scribehow`.

### 3.3 Scoring algorithm

**Step 1 — Build threads:** Group `messages` by `threadId`, sort each group by `date` ascending.

**Step 2 — Response Speed (75% of email score):**
For each thread, scan chronologically. When a non-employee message appears, find the next employee message in the same thread and compute `delta_minutes = (reply.date - inbound.date) / 60`. Average all deltas per employee for the scoring window. Map to letter grade:

| Grade | Numeric Score | Avg Response Time |
| ----- | ------------- | ----------------- |
| A     | 95            | < 15 minutes      |
| B     | 85            | < 30 minutes      |
| C     | 75            | < 1 hour          |
| D     | 65            | < 2 hours         |
| F     | 30            | > 2 hours         |

**Step 3 — Open Loop Rate (25% of email score):**
For each thread where an employee was previously involved: if the last message in the thread is NOT from an employee and is older than 24 hours at scoring time, count as 1 open loop for that employee.

| Score  | Open Loops (per scoring period) |
| ------ | ------------------------------- |
| 90–100 | 0                               |
| 80–89  | 1–2                             |
| 70–79  | 3–5                             |
| 40–69  | 6–10                            |
| 0–39   | 11+                             |

**Step 4 — Email Score:**

```
email_score = (response_speed_score × 0.75) + (open_loop_score × 0.25)
```

The email score feeds directly into the composite formula (see SKILL.md §1).

### 3.4 What the codebase has

| Capability               | Location                                                 | Notes                                                                                                                                                          |
| ------------------------ | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Email archive**        | `email-archive/emails.json`                              | Auto-refreshed by `scripts/email-sync.ts`.                                                                                                                     |
| **Email sync**           | `scripts/email-sync.ts`                                  | Gmail API via `gog` CLI (handles OAuth/keychain). LaunchAgent `scripts/email-sync.plist` runs every 15 minutes. Manual: `pnpm exec tsx scripts/email-sync.ts`. |
| **Gmail push (inbound)** | `src/hooks/gmail.ts`, `gmail-watcher.ts`, `gmail-ops.ts` | Watch configured label; push notifications only — not used for grading.                                                                                        |

### 3.5 What's needed for grading

| Need                         | Description                                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| **Archive reader**           | Parse `email-archive/emails.json`; group by threadId; filter by date range (scoring window).       |
| **Response time calculator** | Per thread: find inbound → next employee reply delta; aggregate per employee; map to letter grade. |
| **Open loop detector**       | Threads where employee was involved but last message is inbound and >24h old.                      |

---

## 4. Proactive Communication Bonus (10% weight — see SKILL.md §6)

**Definition:** Percentage of an employee's messages (Slack + Email) that are **proactive** — i.e. first in a thread or unprompted outreach, not replies to inbound messages. Derived from existing Slack and Email data; no additional APIs.

**Scoring:** See SKILL.md §6.2 for rubric (proactive rate → 0–100 score).

---

## 5. Output

- **Weekly scorecard** posted every Monday to Ridge's private Slack channel (see SKILL.md §7.2 for format).
- **Monthly scorecard** posted on the 1st of each month to the same channel (see SKILL.md §7.3).
- **On-request grade** via `@JR` — employee sees only their own scores (see SKILL.md §8.2).
- **Quarterly bonus report** (pending confirmation — see SKILL.md Appendix A) delivered as a private Slack DM to Ridge on the first Monday of each new quarter.

Implementation: use existing `sendMessageSlack` targeting Ridge's Slack user ID or private channel; no new API beyond Slack send.

---

## 6. Implementation checklist (high level)

1. **Coperniq (40%)**
   - Coperniq sync already runs every 15 min (`scripts/coperniq-sync.ts`); read from `~/.openclaw/cache/coperniq/`.
   - **Filter first:** build an ACTIVE project id set (`status === "ACTIVE"`); drop all WOs and phase data whose parent project is not in that set.
   - Completion rate: count WOs with `isCompleted === true` per assignee / total assigned (ACTIVE only).
   - Phase speed: from `project-details.json` → `phaseInstances[]`, compute avg days per phase; compare to SLA thresholds.
   - Comment activity: from `comments.json`, count per employee per project; compute comments-per-project ratio.
   - `coperniq_score = (completion_score + phase_speed_score + comment_score) / 3`
2. **Slack (30%)**
   - **Rep-channel config required:** map channel IDs → rep user IDs + ops employee IDs.
   - Supplementary channels: `C0AB50H2K9R`, `C0AC5MSF4PJ`. Employee user IDs: see §2.2.
   - For each rep message, find first ops reply → compute `delta_minutes`.
   - Average all deltas per employee → map to letter grade (A/B/C/D/F → 95/85/75/65/30).
3. **Email (20%)**
   - Read `email-archive/emails.json`; group by `threadId`; filter to scoring window.
   - Response speed: inbound → next employee reply delta → average → letter grade (same tiers as Slack).
   - Open loop rate: threads with unanswered inbound >24h → score 0–100.
   - `email_score = (speed_score × 0.75) + (open_loop_score × 0.25)`
4. **Proactive Bonus (10%)**
   - Count employee messages that are first-in-thread or unprompted (Slack + Email).
   - `proactive_rate = proactive / total` → score per SKILL.md §6.2 rubric.
5. **Composite**
   - `composite = (coperniq × 0.40) + (slack × 0.30) + (email × 0.20) + (proactive × 0.10)`
   - Map to letter grade (A/B/C/D/F) for display.
6. **Delivery**
   - **Weekly:** every Monday → post scorecard to Ridge's private channel.
   - **Monthly:** 1st of month → post scorecard to Ridge's private channel.
   - **On request:** `@JR` responds with employee's own scores only.
   - **Quarterly bonus** (pending confirmation): first Monday of quarter → private DM to Ridge with Model A + Model B.

---

## 7. References in repo

- Coperniq: `skills/coperniq.io/Skill.MD`, `skills/coperniq.io/listrequestsSKILL.md`, `skills/coperniq.io/references/projects.md`.
- Slack: `src/slack/actions.ts` (`readSlackMessages`, `SlackMessageSummary`), `src/slack/send.ts` (`sendMessageSlack`).
- Email archive: `email-archive/emails.json`.
- Gmail hooks (non-grading): `src/hooks/gmail.ts`, `src/hooks/gmail-watcher.ts`, `src/hooks/gmail-ops.ts`.
