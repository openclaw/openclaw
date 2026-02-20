"use client";

import { useState, useCallback } from "react";
import { Plus, Trash2, Share2, Pencil, ArrowLeft, FolderPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useProfiles, type Profile } from "@/lib/hooks/use-profiles";
import { ProfileAvatar } from "@/components/layout/profile-switcher";
import { apiFetch } from "@/lib/api-fetch";

// ── Constants ────────────────────────────────────────────────────────────────

const PROFILE_COLORS: { id: string; label: string; class: string }[] = [
  { id: "blue", label: "Blue", class: "bg-blue-500" },
  { id: "emerald", label: "Emerald", class: "bg-emerald-500" },
  { id: "amber", label: "Amber", class: "bg-amber-500" },
  { id: "rose", label: "Rose", class: "bg-rose-500" },
  { id: "violet", label: "Violet", class: "bg-violet-500" },
  { id: "cyan", label: "Cyan", class: "bg-cyan-500" },
  { id: "orange", label: "Orange", class: "bg-orange-500" },
  { id: "slate", label: "Slate", class: "bg-slate-500" },
];

const EMOJI_OPTIONS = [
  "👑", "🦁", "🚀", "🌟", "💎", "🔥", "🎯", "🛡️", "⚡", "🎨", "📊", "🤖",
];

// ── Types ────────────────────────────────────────────────────────────────────

type View = "list" | "create" | "edit";

interface Workspace {
  id: string;
  label: string;
  color?: string;
  [key: string]: unknown;
}

const WORKSPACE_COLORS: { id: string; label: string; class: string }[] = [
  { id: "amber", label: "Amber", class: "bg-amber-500" },
  { id: "emerald", label: "Emerald", class: "bg-emerald-500" },
  { id: "sky", label: "Sky", class: "bg-sky-500" },
  { id: "rose", label: "Rose", class: "bg-rose-500" },
  { id: "violet", label: "Violet", class: "bg-violet-500" },
  { id: "cyan", label: "Cyan", class: "bg-cyan-500" },
  { id: "orange", label: "Orange", class: "bg-orange-500" },
  { id: "slate", label: "Slate", class: "bg-slate-500" },
];

interface ManageProfilesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ── Component ────────────────────────────────────────────────────────────────

export function ManageProfilesDialog({
  open,
  onOpenChange,
}: ManageProfilesDialogProps) {
  const { profiles, refreshProfiles } = useProfiles();

  // View management
  const [view, setView] = useState<View>("list");
  const [sharingProfile, setSharingProfile] = useState<Profile | null>(null);

  // Form state for create / edit
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null);
  const [name, setName] = useState("");
  const [selectedEmoji, setSelectedEmoji] = useState(EMOJI_OPTIONS[0]);
  const [selectedColor, setSelectedColor] = useState(PROFILE_COLORS[0].id);

  // Sharing view state
  const [allWorkspaces, setAllWorkspaces] = useState<Workspace[]>([]);
  const [profileWorkspaceIds, setProfileWorkspaceIds] = useState<Set<string>>(
    new Set()
  );
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // Create workspace form state
  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false);
  const [wsName, setWsName] = useState("");
  const [wsId, setWsId] = useState("");
  const [wsColor, setWsColor] = useState("amber");
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);

  // Loading / error
  const [submitting, setSubmitting] = useState(false);

  // ── Reset state when dialog closes ──────────────────────────────────────

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setView("list");
      setSharingProfile(null);
      setShowCreateWorkspace(false);
      resetForm();
      resetWsForm();
    }
    onOpenChange(nextOpen);
  };

  const resetWsForm = () => {
    setWsName("");
    setWsId("");
    setWsColor("amber");
    setCreatingWorkspace(false);
    setShowCreateWorkspace(false);
  };

  const resetForm = () => {
    setName("");
    setSelectedEmoji(EMOJI_OPTIONS[0]);
    setSelectedColor(PROFILE_COLORS[0].id);
    setEditingProfile(null);
    setSubmitting(false);
  };

  // ── Create profile ──────────────────────────────────────────────────────

  const handleCreate = async () => {
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    try {
      await fetch("/api/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          avatar_color: selectedColor,
          avatar_emoji: selectedEmoji,
        }),
      });
      await refreshProfiles();
      resetForm();
      setView("list");
    } finally {
      setSubmitting(false);
    }
  };

  // ── Update profile ──────────────────────────────────────────────────────

  const handleUpdate = async () => {
    if (!editingProfile || !name.trim() || submitting) return;
    setSubmitting(true);
    try {
      await fetch("/api/profiles", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: editingProfile.id,
          name: name.trim(),
          avatar_color: selectedColor,
          avatar_emoji: selectedEmoji,
        }),
      });
      await refreshProfiles();
      resetForm();
      setView("list");
    } finally {
      setSubmitting(false);
    }
  };

  // ── Delete profile ──────────────────────────────────────────────────────

  const handleDelete = async (profile: Profile) => {
    if (profiles.length <= 1) return;
    const confirmed = window.confirm(
      `Are you sure you want to delete "${profile.name}"? This cannot be undone.`
    );
    if (!confirmed) return;
    await fetch(`/api/profiles?id=${profile.id}`, { method: "DELETE" });
    await refreshProfiles();
  };

  // ── Open edit view ──────────────────────────────────────────────────────

  const openEdit = (profile: Profile) => {
    setEditingProfile(profile);
    setName(profile.name);
    setSelectedEmoji(profile.avatar_emoji || EMOJI_OPTIONS[0]);
    setSelectedColor(profile.avatar_color || PROFILE_COLORS[0].id);
    setView("edit");
  };

  // ── Open create view ───────────────────────────────────────────────────

  const openCreate = () => {
    resetForm();
    setView("create");
  };

  // ── Sharing: fetch workspaces ───────────────────────────────────────────

  const fetchWorkspaces = useCallback(async (profile: Profile) => {
    setLoadingWorkspaces(true);
    try {
      const res = await apiFetch("/api/workspaces");
      const data = await res.json();
      const workspaces: Workspace[] = Array.isArray(data)
        ? data
        : data.workspaces ?? [];
      setAllWorkspaces(workspaces);

      const linkedIds = new Set(
        profile.workspaces.map((pw) => pw.workspace_id)
      );
      const linked = new Set<string>();
      for (const ws of workspaces) {
        if (linkedIds.has(ws.id)) {
          linked.add(ws.id);
        }
      }
      setProfileWorkspaceIds(linked);
    } finally {
      setLoadingWorkspaces(false);
    }
  }, []);

  const openSharing = useCallback(async (profile: Profile) => {
    setSharingProfile(profile);
    setShowCreateWorkspace(false);
    resetWsForm();
    await fetchWorkspaces(profile);
  }, [fetchWorkspaces]);

  // ── Create workspace ────────────────────────────────────────────────────

  const handleCreateWorkspace = async () => {
    if (!wsName.trim() || !wsId.trim() || !sharingProfile || creatingWorkspace) return;
    setCreatingWorkspace(true);
    try {
      const slugId = wsId.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
      // Create workspace
      await apiFetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: slugId,
          label: wsName.trim(),
          color: wsColor,
        }),
      });
      // Auto-link to the current profile
      await apiFetch("/api/profiles/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile_id: sharingProfile.id,
          workspace_id: slugId,
          role: "owner",
        }),
      });
      await refreshProfiles();
      // Refresh workspace list in sharing view
      const updatedProfile = profiles.find((p) => p.id === sharingProfile.id);
      if (updatedProfile) {
        setSharingProfile(updatedProfile);
        await fetchWorkspaces(updatedProfile);
      }
      resetWsForm();
    } finally {
      setCreatingWorkspace(false);
    }
  };

  // ── Delete workspace ────────────────────────────────────────────────────

  const handleDeleteWorkspace = async (workspaceId: string) => {
    const ws = allWorkspaces.find((w) => w.id === workspaceId);
    const confirmed = window.confirm(
      `Delete workspace "${ws?.label || workspaceId}"? All tasks and data in this workspace will be permanently removed.`
    );
    if (!confirmed) return;
    setTogglingId(workspaceId);
    try {
      await apiFetch(`/api/workspaces?id=${workspaceId}`, { method: "DELETE" });
      await refreshProfiles();
      if (sharingProfile) {
        const updatedProfile = profiles.find((p) => p.id === sharingProfile.id);
        if (updatedProfile) {
          setSharingProfile(updatedProfile);
          await fetchWorkspaces(updatedProfile);
        }
      }
    } finally {
      setTogglingId(null);
    }
  };

  // ── Sharing: toggle workspace access ────────────────────────────────────

  const toggleWorkspaceAccess = async (workspaceId: string) => {
    if (!sharingProfile || togglingId) return;
    setTogglingId(workspaceId);

    const hasAccess = profileWorkspaceIds.has(workspaceId);
    try {
      if (hasAccess) {
        await apiFetch(
          `/api/profiles/workspaces?profile_id=${sharingProfile.id}&workspace_id=${workspaceId}`,
          { method: "DELETE" }
        );
        setProfileWorkspaceIds((prev) => {
          const next = new Set(prev);
          next.delete(workspaceId);
          return next;
        });
      } else {
        await apiFetch("/api/profiles/workspaces", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            profile_id: sharingProfile.id,
            workspace_id: workspaceId,
            role: "shared",
          }),
        });
        setProfileWorkspaceIds((prev) => new Set(prev).add(workspaceId));
      }
      await refreshProfiles();
    } finally {
      setTogglingId(null);
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        {/* ───────── Sharing View ───────── */}
        {view === "list" && sharingProfile ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={() => setSharingProfile(null)}
                >
                  <ArrowLeft className="w-4 h-4" />
                </Button>
                🔗 Workspaces for {sharingProfile.name}
              </DialogTitle>
              <DialogDescription>
                Toggle workspace access, create new workspaces, or remove existing ones.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-2 py-4 max-h-[360px] overflow-y-auto">
              {/* ── Create Workspace Form ── */}
              {showCreateWorkspace ? (
                <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-3">
                  <p className="text-sm font-medium">✨ New Workspace</p>
                  <div className="space-y-2">
                    <input
                      type="text"
                      className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      value={wsName}
                      onChange={(e) => {
                        setWsName(e.target.value);
                        // Auto-generate ID from name
                        if (!wsId || wsId === wsName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")) {
                          setWsId(e.target.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
                        }
                      }}
                      placeholder="Workspace name (e.g. Acme Corp)"
                      autoFocus
                      maxLength={50}
                    />
                    <input
                      type="text"
                      className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring font-mono text-xs"
                      value={wsId}
                      onChange={(e) => setWsId(e.target.value)}
                      placeholder="workspace-id (auto-generated)"
                      maxLength={30}
                    />
                    <div className="flex gap-1.5">
                      {WORKSPACE_COLORS.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => setWsColor(c.id)}
                          title={c.label}
                          className={`h-6 w-6 rounded-full transition-all hover:scale-110 ${c.class} ${wsColor === c.id
                              ? "ring-2 ring-primary ring-offset-1 ring-offset-background"
                              : ""
                            }`}
                        />
                      ))}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={resetWsForm}
                      disabled={creatingWorkspace}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      disabled={!wsName.trim() || !wsId.trim() || creatingWorkspace}
                      onClick={handleCreateWorkspace}
                    >
                      {creatingWorkspace ? "Creating..." : "Create & Link"}
                    </Button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowCreateWorkspace(true)}
                  className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg border border-dashed border-border hover:border-primary/50 hover:bg-primary/5 transition-colors text-sm text-muted-foreground hover:text-foreground"
                >
                  <FolderPlus className="w-4 h-4" />
                  Create New Workspace
                </button>
              )}

              {/* ── Workspace List ── */}
              {loadingWorkspaces ? (
                <div className="text-center text-muted-foreground text-sm py-8">
                  Loading workspaces...
                </div>
              ) : allWorkspaces.length === 0 ? (
                <div className="text-center text-muted-foreground text-sm py-8">
                  No workspaces yet. Create your first one above!
                </div>
              ) : (
                allWorkspaces.map((ws) => {
                  const hasAccess = profileWorkspaceIds.has(ws.id);
                  const ownerWs = sharingProfile.workspaces.find(
                    (pw) => pw.workspace_id === ws.id && pw.role === "owner"
                  );
                  const isOwner = !!ownerWs;
                  const colorClass = WORKSPACE_COLORS.find((c) => c.id === ws.color)?.class || "bg-slate-500";

                  return (
                    <div
                      key={ws.id}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border hover:bg-accent/30 transition-colors"
                    >
                      <div className={`w-3 h-3 rounded-full shrink-0 ${colorClass}`} />
                      <button
                        type="button"
                        className="flex-1 text-left min-w-0"
                        disabled={togglingId !== null}
                        onClick={() => toggleWorkspaceAccess(ws.id)}
                      >
                        <span className="font-medium text-sm truncate block">
                          {ws.label}
                        </span>
                        <span className="text-[10px] text-muted-foreground font-mono">{ws.id}</span>
                      </button>
                      <span className="shrink-0 text-xs">
                        {isOwner ? (
                          <span className="text-emerald-400">✅ Owner</span>
                        ) : hasAccess ? (
                          <span className="text-blue-400">🔗 Shared</span>
                        ) : (
                          <span className="text-muted-foreground">
                            No access
                          </span>
                        )}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive shrink-0"
                        title="Delete workspace"
                        disabled={togglingId !== null}
                        onClick={() => handleDeleteWorkspace(ws.id)}
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  );
                })
              )}
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setSharingProfile(null)}
              >
                Back
              </Button>
            </DialogFooter>
          </>
        ) : view === "list" ? (
          /* ───────── List View ───────── */
          <>
            <DialogHeader>
              <DialogTitle>👥 Manage Profiles</DialogTitle>
              <DialogDescription>
                Each profile has its own workspaces, tasks, and integrations.
                Switch between them instantly — both keep running in the
                background.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-2 py-4 max-h-[360px] overflow-y-auto">
              {profiles.map((profile) => {
                const workspaceCount = profile.workspaces.length;

                return (
                  <div
                    key={profile.id}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border hover:bg-accent/30 transition-colors"
                  >
                    {/* Avatar */}
                    <ProfileAvatar profile={profile} />

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm truncate">
                          {profile.name}
                        </span>
                        {profile.is_default === 1 && (
                          <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                            Default
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {Number(workspaceCount)} workspace
                        {Number(workspaceCount) !== 1 ? "s" : ""}
                      </p>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                        title="Share workspaces"
                        onClick={() => openSharing(profile)}
                      >
                        <Share2 className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                        title="Edit profile"
                        onClick={() => openEdit(profile)}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                        title="Delete profile"
                        disabled={profiles.length <= 1}
                        onClick={() => handleDelete(profile)}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => handleOpenChange(false)}
              >
                Done
              </Button>
              <Button onClick={openCreate}>
                <Plus className="w-4 h-4 mr-1.5" />
                New Profile
              </Button>
            </DialogFooter>
          </>
        ) : (
          /* ───────── Create / Edit View ───────── */
          <>
            <DialogHeader>
              <DialogTitle>
                {view === "create" ? "✨ Create New Profile" : "✏️ Edit Profile"}
              </DialogTitle>
              <DialogDescription>
                {view === "create"
                  ? "Set up a new profile with a name, emoji, and color."
                  : "Update this profile's appearance and name."}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-5 py-4">
              {/* Live avatar preview */}
              <div className="flex justify-center">
                <div className="flex flex-col items-center gap-2">
                  <ProfileAvatar
                    profile={{
                      name: name || "Preview",
                      avatar_emoji: selectedEmoji,
                      avatar_color: selectedColor,
                    } as Profile}
                  />
                  <span className="text-xs text-muted-foreground">
                    Live preview
                  </span>
                </div>
              </div>

              {/* Name input */}
              <div className="space-y-2">
                <label className="text-sm font-medium">📝 Name</label>
                <input
                  type="text"
                  className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Work, Personal, Side Project..."
                  autoFocus
                  maxLength={50}
                />
              </div>

              {/* Emoji picker */}
              <div className="space-y-2">
                <label className="text-sm font-medium">😊 Emoji</label>
                <div className="grid grid-cols-6 gap-2">
                  {EMOJI_OPTIONS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => setSelectedEmoji(emoji)}
                      className={`h-10 w-full rounded-md text-lg flex items-center justify-center border transition-all hover:scale-110 ${selectedEmoji === emoji
                          ? "ring-2 ring-primary border-primary bg-primary/10"
                          : "border-border hover:border-muted-foreground/50"
                        }`}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>

              {/* Color picker */}
              <div className="space-y-2">
                <label className="text-sm font-medium">🎨 Color</label>
                <div className="grid grid-cols-8 gap-2">
                  {PROFILE_COLORS.map((color) => (
                    <button
                      key={color.id}
                      type="button"
                      onClick={() => setSelectedColor(color.id)}
                      title={color.label}
                      className={`h-8 w-8 rounded-full mx-auto transition-all hover:scale-110 ${color.class} ${selectedColor === color.id
                          ? "ring-2 ring-primary ring-offset-2 ring-offset-background"
                          : ""
                        }`}
                    />
                  ))}
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  resetForm();
                  setView("list");
                }}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                disabled={!name.trim() || submitting}
                onClick={view === "create" ? handleCreate : handleUpdate}
              >
                {submitting
                  ? view === "create"
                    ? "Creating..."
                    : "Saving..."
                  : view === "create"
                    ? "Create Profile"
                    : "Save Changes"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
