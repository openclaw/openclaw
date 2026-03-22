"use client";

import { useState, useRef, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";

type CreateWorkspaceDialogProps = {
  isOpen: boolean;
  onClose: () => void;
  onCreated?: () => void;
};

function shortenPath(p: string): string {
  return p
    .replace(/^\/Users\/[^/]+/, "~")
    .replace(/^\/home\/[^/]+/, "~")
    .replace(/^[A-Za-z]:[/\\]Users[/\\][^/\\]+/, "~");
}

export function CreateWorkspaceDialog({ isOpen, onClose, onCreated }: CreateWorkspaceDialogProps) {
  const [workspaceName, setWorkspaceName] = useState("");
  const [seedBootstrap, setSeedBootstrap] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ workspaceDir: string; seededFiles: string[] } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setWorkspaceName("");
      setError(null);
      setResult(null);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  const handleCreate = async () => {
    const name = workspaceName.trim();
    if (!name) {
      setError("Please enter a workspace name.");
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      setError("Name must use only letters, numbers, hyphens, or underscores.");
      return;
    }

    setCreating(true);
    setError(null);

    try {
      const body: Record<string, unknown> = {
        workspace: name,
        seedBootstrap,
      };

      const res = await fetch("/api/workspace/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to create workspace.");
        return;
      }

      setResult({
        workspaceDir: data.workspaceDir,
        seededFiles: data.seededFiles ?? [],
      });
      onCreated?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent showCloseButton={!result} className="sm:max-w-md">
        {result ? (
          <>
            <div className="text-center py-4">
              <div
                className="w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3"
                style={{ background: "rgba(22, 163, 74, 0.1)" }}
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              </div>
              <p className="text-sm font-medium" style={{ color: "var(--color-text)" }}>
                Workspace created
              </p>
              <code
                className="text-xs px-2 py-1 rounded mt-2 inline-block"
                style={{
                  background: "var(--color-surface-hover)",
                  color: "var(--color-text-secondary)",
                  border: "1px solid var(--color-border)",
                }}
              >
                {shortenPath(result.workspaceDir)}
              </code>
              {result.seededFiles.length > 0 && (
                <p
                  className="text-xs mt-2"
                  style={{ color: "var(--color-text-muted)" }}
                >
                  Seeded: {result.seededFiles.join(", ")}
                </p>
              )}
            </div>
            <DialogFooter>
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium rounded-lg transition-colors hover:opacity-80 cursor-pointer"
                style={{ background: "var(--color-accent)", color: "#fff" }}
              >
                Done
              </button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>New Workspace</DialogTitle>
            </DialogHeader>

            <div className="space-y-4">
              <div>
                <label
                  className="block text-sm font-medium mb-1.5"
                  style={{ color: "var(--color-text-secondary)" }}
                >
                  Workspace name
                </label>
                <input
                  ref={inputRef}
                  type="text"
                  value={workspaceName}
                  onChange={(e) => {
                    setWorkspaceName(e.target.value);
                    setError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !creating) { void handleCreate(); }
                  }}
                  placeholder="e.g. work, personal, project-x"
                  className="w-full px-3 py-2 text-sm rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
                  style={{
                    background: "var(--color-bg)",
                    border: "1px solid var(--color-border)",
                    color: "var(--color-text)",
                  }}
                />
                <p className="text-xs mt-1" style={{ color: "var(--color-text-muted)" }}>
                  This creates a workspace under ~/.openclaw-dench/workspace-{"{name}"}.
                </p>
              </div>

              <label className="flex items-center gap-2 cursor-pointer hidden">
                <input
                  type="checkbox"
                  checked={seedBootstrap}
                  onChange={(e) => setSeedBootstrap(e.target.checked)}
                  className="rounded"
                  style={{ accentColor: "var(--color-accent)" }}
                />
                <span className="text-sm" style={{ color: "var(--color-text-secondary)" }}>
                  Seed bootstrap files and workspace database
                </span>
              </label>

              {error && (
                <p
                  className="text-sm px-3 py-2 rounded-lg"
                  style={{ background: "rgba(220, 38, 38, 0.08)", color: "var(--color-error)" }}
                >
                  {error}
                </p>
              )}
            </div>

            <DialogFooter>
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-[13px] rounded-full transition-all hover:bg-neutral-400/15 cursor-pointer"
                style={{ color: "var(--color-text-muted)" }}
              >
                Cancel
              </button>
              <button
                onClick={() => void handleCreate()}
                disabled={creating || !workspaceName.trim()}
                className="px-4 py-2 text-sm font-medium rounded-full transition-colors hover:opacity-80 disabled:opacity-50 cursor-pointer"
                style={{ background: "var(--color-accent)", color: "#fff" }}
              >
                {creating ? "Creating..." : "Create Workspace"}
              </button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
