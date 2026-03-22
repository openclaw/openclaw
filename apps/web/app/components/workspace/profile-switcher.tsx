"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "../ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";

export type WorkspaceInfo = {
  name: string;
  stateDir: string;
  workspaceDir: string | null;
  isActive: boolean;
  hasConfig: boolean;
};

export type ProfileSwitcherTriggerProps = {
  isOpen: boolean;
  onClick: () => void;
  activeWorkspace: string | null;
  switching: boolean;
};

type ProfileSwitcherProps = {
  onWorkspaceSwitch?: () => void;
  onWorkspaceDelete?: (workspaceName: string) => void;
  onCreateWorkspace?: () => void;
  /** Parent-tracked active workspace, used to trigger refetches after changes. */
  activeWorkspaceHint?: string | null;
  /** When set, this renders instead of the default button; dropdown still opens below. */
  trigger?: (props: ProfileSwitcherTriggerProps) => React.ReactNode;
};

function shortenPath(p: string): string {
  return p
    .replace(/^\/Users\/[^/]+/, "~")
    .replace(/^\/home\/[^/]+/, "~")
    .replace(/^[A-Za-z]:[/\\]Users[/\\][^/\\]+/, "~");
}

export function ProfileSwitcher({
  onWorkspaceSwitch,
  onWorkspaceDelete,
  onCreateWorkspace,
  activeWorkspaceHint,
  trigger,
}: ProfileSwitcherProps) {
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [deletingWorkspace, setDeletingWorkspace] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const fetchWorkspaces = useCallback(async () => {
    try {
      const res = await fetch("/api/workspace/list");
      const data = await res.json();
      const nextWorkspaces = ((data.workspaces ?? data.profiles ?? []) as WorkspaceInfo[])
        .filter((workspace) => Boolean(workspace.workspaceDir));
      const nextActiveWorkspace =
        (data.activeWorkspace ?? data.activeProfile ?? null) as string | null;
      const activeFromList =
        nextActiveWorkspace && nextWorkspaces.some((workspace) => workspace.name === nextActiveWorkspace)
          ? nextActiveWorkspace
          : (nextWorkspaces.find((workspace) => workspace.isActive)?.name ?? nextWorkspaces[0]?.name ?? null);
      setWorkspaces(nextWorkspaces);
      setActiveWorkspace(activeFromList);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void fetchWorkspaces();
  }, [fetchWorkspaces, activeWorkspaceHint]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Element;
      if (dropdownRef.current && !dropdownRef.current.contains(target)) {
        if (target.closest?.('[data-slot="dropdown-menu-item"], [data-slot="dropdown-menu-content"]')) return;
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen]);

  const handleSwitch = async (workspaceName: string) => {
    if (workspaceName === activeWorkspace) {
      setIsOpen(false);
      return;
    }
    setActionError(null);
    setSwitching(true);
    try {
      const res = await fetch("/api/workspace/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace: workspaceName }),
      });
      if (res.ok) {
        const data = await res.json();
        setActiveWorkspace((data.activeWorkspace ?? data.activeProfile ?? null) as string | null);
        onWorkspaceSwitch?.();
        void fetchWorkspaces();
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setActionError(data.error ?? "Failed to switch workspace.");
      }
    } catch {
      setActionError("Failed to switch workspace.");
    } finally {
      setSwitching(false);
      setIsOpen(false);
    }
  };

  const handleDeleteWorkspace = async (workspaceName: string) => {
    setActionError(null);
    setDeletingWorkspace(workspaceName);
    setConfirmDelete(null);
    try {
      const res = await fetch("/api/workspace/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace: workspaceName }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setActionError(data.error ?? `Failed to delete workspace '${workspaceName}'.`);
        return;
      }
      if (workspaceName === activeWorkspace) {
        onWorkspaceSwitch?.();
      }
      onWorkspaceDelete?.(workspaceName);
      await fetchWorkspaces();
    } catch {
      setActionError(`Failed to delete workspace '${workspaceName}'.`);
    } finally {
      setDeletingWorkspace(null);
    }
  };

  const showSwitcher = workspaces.length > 0;
  const handleToggle = () => {
    if (showSwitcher) { setIsOpen((o) => !o); }
  };

  if (!trigger && !showSwitcher) { return null; }

  return (
    <div
      className={`relative ${trigger ? "flex-1 min-w-0" : ""}`}
      ref={dropdownRef}
    >
      {trigger ? (
        trigger({
          isOpen,
          onClick: handleToggle,
          activeWorkspace,
          switching,
        })
      ) : (
        <button
          onClick={handleToggle}
          disabled={switching}
          className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
          style={{ color: "var(--color-text-secondary)" }}
          title="Switch workspace"
        >
          {/* Workspace icon */}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
          </svg>
          <span className="truncate max-w-[120px]">
            {activeWorkspace ?? "No workspace"}
          </span>
          <svg
            className={`w-3 h-3 transition-transform ${isOpen ? "rotate-180" : ""}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      )}

      {showSwitcher && isOpen && (
        <div
          className="absolute left-0 top-full mt-1.5 w-64 rounded-2xl overflow-hidden z-50 p-1 bg-neutral-100/[0.67] dark:bg-neutral-900/[0.67] border border-white dark:border-white/10 backdrop-blur-md shadow-[0_0_25px_0_rgba(0,0,0,0.16)]"
        >
          <div
            className="px-2.5 py-1.5 text-[11px] font-medium"
            style={{ color: "var(--color-text-muted)" }}
          >
            Workspaces
          </div>

          <div className="max-h-64 overflow-y-auto">
            {workspaces.map((workspace) => {
              const isCurrent = workspace.name === activeWorkspace;
              return (
                <div
                  key={workspace.name}
                  className="group flex items-center rounded-xl transition-all hover:bg-neutral-400/15 cursor-pointer"
                  onClick={() => void handleSwitch(workspace.name)}
                  style={{ color: "var(--color-text)" }}
                >
                  <div className="flex-1 min-w-0 flex items-center gap-2 px-2.5 py-1.5">
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{
                        background: isCurrent ? "var(--color-success)" : "transparent",
                        border: isCurrent ? "none" : "1px solid var(--color-border-strong)",
                      }}
                    />
                    <div className="flex-1 min-w-0">
                      <span className="truncate font-medium text-[13px] block">
                        {workspace.name}
                      </span>
                      <span
                        className="text-[11px] truncate block mt-0.5"
                        style={{ color: "var(--color-text-muted)" }}
                      >
                        {workspace.workspaceDir
                          ? shortenPath(workspace.workspaceDir)
                          : "No workspace yet"}
                      </span>
                    </div>
                    {isCurrent && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full shrink-0 bg-neutral-400/15" style={{ color: "var(--color-text-muted)" }}>
                        Active
                      </span>
                    )}
                  </div>

                  {workspace.workspaceDir && (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        onClick={(e) => e.stopPropagation()}
                        className="p-1 mr-1 rounded-lg transition-all opacity-0 group-hover:opacity-100 hover:bg-neutral-400/25 shrink-0 cursor-pointer"
                        style={{ color: "var(--color-text-muted)" }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" />
                        </svg>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent side="right" align="start" sideOffset={4} className="min-w-[140px]">
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() => setConfirmDelete(workspace.name)}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" />
                          </svg>
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              );
            })}
          </div>

          {actionError && (
            <p
              className="mx-2 mb-1 mt-1 rounded-xl px-2.5 py-1.5 text-xs"
              style={{
                background: "rgba(220, 38, 38, 0.08)",
                color: "var(--color-error)",
              }}
            >
              {actionError}
            </p>
          )}

          <div className="border-t border-neutral-400/15 mt-0.5 pt-0.5">
            <button
              onClick={() => {
                setIsOpen(false);
                onCreateWorkspace?.();
              }}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 text-sm rounded-xl transition-all hover:bg-neutral-400/15 cursor-pointer"
              style={{ color: "var(--color-accent)" }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14" /><path d="M5 12h14" />
              </svg>
              New Workspace
            </button>
          </div>
        </div>
      )}

      <Dialog open={!!confirmDelete} onOpenChange={(open) => { if (!open) setConfirmDelete(null); }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete workspace</DialogTitle>
            <DialogDescription>
              This will permanently delete <strong style={{ color: "var(--color-text)" }}>{confirmDelete}</strong> and all its data. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              onClick={() => setConfirmDelete(null)}
              className="px-3 py-1.5 text-[13px] rounded-full transition-all hover:bg-neutral-400/15 cursor-pointer"
              style={{ color: "var(--color-text-muted)" }}
            >
              Cancel
            </button>
            <button
              onClick={() => { if (confirmDelete) void handleDeleteWorkspace(confirmDelete); }}
              disabled={!!deletingWorkspace}
              className="px-3 py-1.5 text-[13px] font-medium rounded-full transition-all hover:opacity-80 disabled:opacity-50 cursor-pointer"
              style={{ background: "var(--color-error)", color: "#fff" }}
            >
              {deletingWorkspace === confirmDelete ? "Deleting..." : "Delete"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
