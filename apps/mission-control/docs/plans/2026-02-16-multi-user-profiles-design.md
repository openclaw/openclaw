# Multi-User Profiles Design

## Goal

Add profile-based account switching so two family members can use OpenClaw Mission Control independently — each with their own workspaces, integrations, and channel accounts — without login/logout. Both profiles run simultaneously in the background.

## Context

- Mission Control currently has no user/account concept (single operator)
- Workspaces exist (golden, ras, mustadem, anteja) but aren't tied to users
- Integrations are stored in a single JSON file (`~/.openclaw/dashboard-integrations.json`)
- The OpenClaw gateway already supports Telegram, WhatsApp, Discord, Slack, Signal, iMessage, Google Chat, Teams, Matrix, LINE, and more — with multi-account support per channel
- Gateway channels are configured via `config.get/set/patch` RPC and `~/.openclaw/config.yaml`

## Approach: Profile Switcher (No Auth)

Instant profile switching via avatar dropdown in the header. No login, no logout, no passwords. Profiles are trust-based — like Chrome profiles. Both profiles' agents and tasks continue running in the background when the other profile is active.

---

## Data Model

### New Tables

```sql
CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar_color TEXT NOT NULL DEFAULT 'blue',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE profile_workspaces (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('owner','shared')) DEFAULT 'owner',
  PRIMARY KEY (profile_id, workspace_id)
);

CREATE TABLE profile_integrations (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  service TEXT NOT NULL,
  account_id TEXT,
  config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(profile_id, service)
);
```

### Migration

1. Seed default profile: "Abdulrahman" (id: generated UUID, is_default: 1, avatar_color: 'blue')
2. Link all 4 existing workspaces to Abdulrahman's profile as "owner"
3. Migrate `~/.openclaw/dashboard-integrations.json` entries to `profile_integrations`

---

## API Routes

### Profile CRUD

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/api/profiles` | List all profiles |
| POST | `/api/profiles` | Create profile (name, avatar_color) |
| PATCH | `/api/profiles` | Update profile (id, name?, avatar_color?) |
| DELETE | `/api/profiles?id=xxx` | Delete profile (can't delete last one) |

### Profile-Workspace Links

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/api/profiles/workspaces?profile_id=xxx` | Workspaces for a profile |
| POST | `/api/profiles/workspaces` | Link workspace to profile (profile_id, workspace_id, role) |
| DELETE | `/api/profiles/workspaces?profile_id=xxx&workspace_id=yyy` | Unlink workspace |

### Profile-Integration Mappings

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/api/profiles/integrations?profile_id=xxx` | Channel mappings for profile |
| POST | `/api/profiles/integrations` | Map gateway channel to profile |
| DELETE | `/api/profiles/integrations?id=xxx` | Remove mapping |

### Existing APIs

No changes needed. Tasks, missions, and activity are already filtered by `workspace_id`. Since workspaces are scoped to profiles, isolation is automatic.

---

## Frontend Components

### New

- **`ProfileProvider`** — React context wrapping the app. Provides `activeProfile`, `setActiveProfile`, and `profiles` list. Reads/writes `localStorage` key `oc-active-profile`.

- **`ProfileSwitcher`** — Avatar dropdown in header, left of "// Mission Control". Shows colored circle with first letter of profile name. Click opens dropdown with all profiles + "Manage Profiles" link.

- **`ManageProfilesDialog`** — Modal for creating, editing, deleting profiles. Also allows sharing/unsharing workspaces between profiles.

### Modified

- **`page.tsx`** — Wrap with `ProfileProvider`. Pass `profile_id` to workspace selector filter.
- **Workspace selector** — Filter options by `profile_workspaces` for active profile.

### State Hierarchy

```
ProfileProvider (active profile in context + localStorage)
  └── page.tsx
       ├── ProfileSwitcher (header)
       ├── Workspace selector (filtered by profile)
       └── All views (filtered by workspace → automatic profile isolation)
```

---

## Integration Architecture

Mission Control does NOT build its own Telegram/WhatsApp adapters. Instead, it maps profiles to the gateway's existing multi-account channel system.

**Flow**:
1. User configures Telegram/WhatsApp/etc. in the gateway's built-in dashboard (`:18789`)
2. In Mission Control, user maps their profile to gateway channel accounts via `profile_integrations`
3. When Mission Control sends notifications, it tells the gateway which `account_id` to use based on the active profile

**Gateway RPC methods used**:
- `channels.status` — probe channel health
- `config.get` — read channel config (discover available accounts)
- `send` — send messages to a specific channel account

---

## Key Design Decisions

1. **No auth** — Trust-based switching. Profiles are a view filter, not a security boundary.
2. **Workspaces drive isolation** — No changes to existing task/mission/activity APIs. Profile → workspace → data.
3. **Gateway handles channels** — Telegram, WhatsApp, etc. are already built. We just map profiles to accounts.
4. **Both run simultaneously** — Switching profiles is purely client-side (localStorage + React context). Server-side work continues for all profiles.
5. **Extensible** — Adding a third profile or PIN protection later is trivial.
