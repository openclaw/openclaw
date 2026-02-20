# Multi-User Profiles Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add profile-based account switching so two family members (Abdulrahman and Abdulaziz) can use Mission Control independently with isolated workspaces and integrations.

**Architecture:** Profiles are a lightweight layer on top of workspaces. A `profiles` table owns workspaces via a `profile_workspaces` junction table. Active profile is stored in localStorage and React context. Switching profiles filters the workspace selector — all downstream data (tasks, missions, activity) is already filtered by workspace_id, so isolation is automatic. Gateway channel integrations map to profiles via `profile_integrations`.

**Tech Stack:** Next.js 16, React 19, TypeScript 5.9, SQLite (better-sqlite3), Zod validation, Radix UI dialogs, Tailwind CSS 4, Lucide icons

**UX Requirements:** Our own UI design. Extremely easy to use. Emojis for visual clarity. Descriptions explaining how to use each feature.

---

### Task 1: Database Migration — Profile Tables

**Files:**
- Modify: `src/lib/db.ts` (add migration + CRUD functions + interfaces)

**Step 1: Add interfaces after the Workspace interface**

Add these TypeScript interfaces near the existing `Workspace` interface in `db.ts`:

```typescript
export interface Profile {
  id: string;
  name: string;
  avatar_color: string;
  avatar_emoji: string;
  is_default: number;
  created_at: string;
}

export interface ProfileWorkspace {
  profile_id: string;
  workspace_id: string;
  role: string;
}

export interface ProfileIntegration {
  id: string;
  profile_id: string;
  service: string;
  account_id: string | null;
  config: string;
  created_at: string;
  updated_at: string;
}
```

**Step 2: Add migration `2026-02-16-005-profiles`**

Append to the `getMigrations()` array:

```typescript
{
  id: "2026-02-16-005-profiles",
  description: "Create profiles, profile_workspaces, and profile_integrations tables. Seed Abdulrahman and Abdulaziz profiles.",
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        avatar_color TEXT NOT NULL DEFAULT 'blue',
        avatar_emoji TEXT NOT NULL DEFAULT '👤',
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS profile_workspaces (
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('owner','shared')) DEFAULT 'owner',
        PRIMARY KEY (profile_id, workspace_id)
      );

      CREATE TABLE IF NOT EXISTS profile_integrations (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        service TEXT NOT NULL,
        account_id TEXT,
        config TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(profile_id, service)
      );

      CREATE INDEX IF NOT EXISTS idx_profile_workspaces_profile ON profile_workspaces(profile_id);
      CREATE INDEX IF NOT EXISTS idx_profile_workspaces_workspace ON profile_workspaces(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_profile_integrations_profile ON profile_integrations(profile_id);
    `);

    // Seed two default profiles
    const abdulrahmanId = "profile-abdulrahman";
    const abdulazizId = "profile-abdulaziz";

    db.prepare(
      `INSERT OR IGNORE INTO profiles (id, name, avatar_color, avatar_emoji, is_default)
       VALUES (?, ?, ?, ?, ?)`
    ).run(abdulrahmanId, "Abdulrahman", "blue", "👑", 1);

    db.prepare(
      `INSERT OR IGNORE INTO profiles (id, name, avatar_color, avatar_emoji, is_default)
       VALUES (?, ?, ?, ?, ?)`
    ).run(abdulazizId, "Abdulaziz", "emerald", "🦁", 0);

    // Link all existing workspaces to Abdulrahman as owner
    const workspaces = db.prepare("SELECT id FROM workspaces").all() as { id: string }[];
    const linkStmt = db.prepare(
      "INSERT OR IGNORE INTO profile_workspaces (profile_id, workspace_id, role) VALUES (?, ?, 'owner')"
    );
    for (const ws of workspaces) {
      linkStmt.run(abdulrahmanId, ws.id);
    }
  },
},
```

**Step 3: Add CRUD functions for profiles**

Add after the workspace CRUD functions in db.ts. See design doc for full function signatures:
- `listProfiles()`, `getProfile(id)`, `createProfile(data)`, `updateProfile(id, patch)`, `deleteProfile(id)`
- `listProfileWorkspaces(profileId)`, `linkProfileWorkspace(...)`, `unlinkProfileWorkspace(...)`
- `listProfileIntegrations(profileId)`, `upsertProfileIntegration(data)`, `deleteProfileIntegration(id)`

**Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: 0 errors

**Step 5: Commit**

```
git add src/lib/db.ts
git commit -m "feat: add profiles database migration, tables, and CRUD functions"
```

---

### Task 2: Zod Schemas for Profile Operations

**Files:**
- Modify: `src/lib/schemas.ts`

**Step 1: Add profile schemas**

Add near the workspace schemas:
- `PROFILE_COLORS` enum, `profileColorSchema`, `profileIdSchema`
- `createProfileSchema` (name, avatar_color?, avatar_emoji?)
- `updateProfileSchema` (id, name?, avatar_color?, avatar_emoji?)
- `deleteProfileQuerySchema` (id)
- `profileWorkspaceLinkSchema` (profile_id, workspace_id, role?)
- `profileWorkspaceUnlinkSchema` (profile_id, workspace_id)
- `profileIntegrationSchema` (profile_id, service, account_id?, config?)

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: 0 errors

**Step 3: Commit**

```
git add src/lib/schemas.ts
git commit -m "feat: add Zod validation schemas for profile operations"
```

---

### Task 3: Profile API Routes

**Files:**
- Create: `src/app/api/profiles/route.ts`

Standard CRUD following workspaces route pattern:
- GET: list all profiles with their workspace links
- POST: create profile (name, avatar_color, avatar_emoji)
- PATCH: update profile
- DELETE: delete profile (can't delete last one)

**Step 1: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: 0 errors

**Step 2: Commit**

```
git add src/app/api/profiles/route.ts
git commit -m "feat: add profile CRUD API routes"
```

---

### Task 4: Profile-Workspace Link API Routes

**Files:**
- Create: `src/app/api/profiles/workspaces/route.ts`

- GET: list workspaces for a profile
- POST: link workspace to profile
- DELETE: unlink workspace from profile

**Step 1: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: 0 errors

**Step 2: Commit**

```
git add src/app/api/profiles/workspaces/route.ts
git commit -m "feat: add profile-workspace link API routes"
```

---

### Task 5: ProfileProvider React Context

**Files:**
- Create: `src/lib/hooks/use-profiles.ts`

React context that:
- Fetches profiles from `/api/profiles`
- Stores active profile in localStorage (`oc-active-profile`)
- Auto-selects default profile if none active
- Provides: `profiles`, `activeProfile`, `setActiveProfileId`, `refreshProfiles`, `loading`

**Step 1: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: 0 errors

**Step 2: Commit**

```
git add src/lib/hooks/use-profiles.ts
git commit -m "feat: add ProfileProvider context and useProfiles hook"
```

---

### Task 6: ProfileSwitcher Component

**Files:**
- Create: `src/components/layout/profile-switcher.tsx`

Avatar dropdown for the header:
- Colored circle with emoji (e.g. 👑 for Abdulrahman in blue, 🦁 for Abdulaziz in green)
- Click opens popover with all profiles
- Check mark on active profile
- Workspace count per profile
- "Manage Profiles" button at bottom
- Exports `ProfileAvatar` for reuse

**Step 1: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: 0 errors

**Step 2: Commit**

```
git add src/components/layout/profile-switcher.tsx
git commit -m "feat: add ProfileSwitcher avatar dropdown component"
```

---

### Task 7: ManageProfilesDialog

**Files:**
- Create: `src/components/modals/manage-profiles.tsx`

Three-view dialog (list / create-edit / sharing):
- **List view**: All profiles with edit, share, delete buttons. Emojis and descriptions.
- **Create/Edit view**: Live avatar preview, name input, emoji picker (12 options), color picker (8 colors)
- **Sharing view**: Toggle workspaces on/off for a profile with visual feedback

UX: Extremely easy to use. Emojis on labels. Clear descriptions.

**Step 1: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: 0 errors

**Step 2: Commit**

```
git add src/components/modals/manage-profiles.tsx
git commit -m "feat: add ManageProfilesDialog with create, edit, delete, and workspace sharing"
```

---

### Task 8: Wire Into Header

**Files:**
- Modify: `src/components/layout/header.tsx`

- Import `ProfileSwitcher`
- Add `onManageProfiles` to HeaderProps
- Insert `<ProfileSwitcher>` before the workspace selector div

**Step 1: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: May error because page.tsx doesn't pass the new prop yet — fixed in Task 9.

**Step 2: Commit**

```
git add src/components/layout/header.tsx
git commit -m "feat: add ProfileSwitcher to header"
```

---

### Task 9: Wire Into page.tsx — ProfileProvider + Workspace Filtering

**Files:**
- Modify: `src/app/page.tsx`

This is the most complex integration step:

1. Wrap entire Dashboard return with `<ProfileProvider>`
2. Extract inner component `DashboardInner` (because useProfiles must be inside ProfileProvider)
3. Add `manageProfilesOpen` state, pass `onManageProfiles` to Header
4. Render `<ManageProfilesDialog>`
5. Filter workspace options by active profile's workspaces
6. Auto-switch to first available workspace when profile changes

**Step 1: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: 0 errors

**Step 2: Commit**

```
git add src/app/page.tsx
git commit -m "feat: wire ProfileProvider and workspace filtering into Dashboard"
```

---

### Task 10: Final Verification

**Step 1: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: 0 errors

**Step 2: Start dev server and test in browser**

Run: `npm run dev`

Test checklist:
- Profile switcher appears in header (left of workspace selector)
- Shows Abdulrahman (default, blue, 👑) avatar
- Click opens dropdown showing both profiles
- Switching to Abdulaziz filters workspace selector to his workspaces
- "Manage Profiles" opens the dialog
- Can create a new profile with name, emoji, and color
- Can edit profile name/emoji/color
- Can share/unshare workspaces between profiles
- Can delete a profile (unless it's the last one)
- Switching back to Abdulrahman restores his workspaces
- Page refresh preserves active profile (localStorage)
- Both profiles' data continues running in background

**Step 3: Commit and push**

```
git add -A
git commit -m "feat: multi-user profile system with account switching"
git push
```
