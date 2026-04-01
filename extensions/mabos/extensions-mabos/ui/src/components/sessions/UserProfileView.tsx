import { User, Pencil, RefreshCw, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

type UserProfile = {
  content: string;
  updatedAt: string | null;
};

export function UserProfileView() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);

  async function fetchProfile() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/mabos/sessions/profile");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: UserProfile = await res.json();
      setProfile(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load profile");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchProfile();
  }, []);

  function handleEdit() {
    if (profile) {
      setEditContent(profile.content);
      setEditing(true);
    }
  }

  function handleCancel() {
    setEditing(false);
    setEditContent("");
  }

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch("/mabos/sessions/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: editContent }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setProfile({ content: editContent, updatedAt: new Date().toISOString() });
      setEditing(false);
    } catch {
      // Keep editing state so user can retry
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <Card className="bg-[var(--bg-card)] border-[var(--border-mabos)] p-6">
        <div className="flex items-center gap-3 mb-4">
          <Skeleton className="h-10 w-10 rounded-full" />
          <div className="space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-24" />
          </div>
        </div>
        <Skeleton className="h-32 w-full rounded-lg" />
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="bg-[var(--bg-card)] border-[var(--border-mabos)] p-6">
        <p className="text-sm text-[var(--accent-red)]">{error}</p>
        <button
          onClick={fetchProfile}
          className="mt-3 flex items-center gap-2 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
        >
          <RefreshCw className="w-3 h-3" /> Retry
        </button>
      </Card>
    );
  }

  if (!profile) return null;

  return (
    <Card className="bg-[var(--bg-card)] border-[var(--border-mabos)] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border-mabos)]">
        <div className="flex items-center gap-3">
          <div
            className="flex items-center justify-center w-10 h-10 rounded-full"
            style={{
              backgroundColor: "color-mix(in srgb, var(--accent-purple) 15%, transparent)",
            }}
          >
            <User className="w-5 h-5" style={{ color: "var(--accent-purple)" }} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">User Profile</h3>
            {profile.updatedAt && (
              <p className="text-[10px] text-[var(--text-muted)]">
                Updated {new Date(profile.updatedAt).toLocaleDateString()}
              </p>
            )}
          </div>
        </div>
        {!editing && (
          <button
            onClick={handleEdit}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
            style={{
              backgroundColor: "color-mix(in srgb, var(--accent-blue) 15%, transparent)",
              color: "var(--accent-blue)",
            }}
          >
            <Pencil className="w-3 h-3" /> Edit
          </button>
        )}
      </div>

      {/* Content */}
      <div className="px-6 py-4">
        {editing ? (
          <div className="space-y-3">
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              rows={12}
              className="w-full px-3 py-2 rounded-lg text-sm font-mono leading-relaxed resize-y outline-none"
              style={{
                backgroundColor: "var(--bg-secondary)",
                color: "var(--text-primary)",
                borderColor: "var(--border-mabos)",
                border: "1px solid var(--border-mabos)",
              }}
            />
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={handleCancel}
                disabled={saving}
                className="px-3 py-1.5 rounded-md text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
                style={{
                  backgroundColor: "color-mix(in srgb, var(--accent-green) 15%, transparent)",
                  color: "var(--accent-green)",
                }}
              >
                {saving && <Loader2 className="w-3 h-3 animate-spin" />}
                Save
              </button>
            </div>
          </div>
        ) : (
          <pre
            className="text-sm leading-relaxed whitespace-pre-wrap break-words font-mono p-4 rounded-lg"
            style={{
              backgroundColor: "var(--bg-secondary)",
              color: "var(--text-secondary)",
            }}
          >
            {profile.content || "No profile content yet."}
          </pre>
        )}
      </div>
    </Card>
  );
}
