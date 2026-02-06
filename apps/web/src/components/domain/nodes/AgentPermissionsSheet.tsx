/**
 * AgentPermissionsSheet - slide-out panel showing the effective permissions
 * for a specific agent. Shows inherited vs overridden values with edit mode.
 */

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  PolicySelectRow,
  PolicyToggleRow,
} from "./ExecApprovalsPolicyRow";
import type {
  ExecApprovalsDefaults,
  ExecApprovalsAgent,
} from "@/lib/api/nodes";
import {
  Pencil,
  Save,
  X,
  Plus,
  Trash2,
  Shield,
  ListChecks,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Policy option definitions
// ---------------------------------------------------------------------------

const SECURITY_OPTIONS = [
  { value: "deny", label: "Deny" },
  { value: "allowlist", label: "Allowlist" },
  { value: "full", label: "Full" },
];

const ASK_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "on-miss", label: "On miss" },
  { value: "always", label: "Always" },
];

const ASK_FALLBACK_OPTIONS = [
  { value: "deny", label: "Deny" },
  { value: "allowlist", label: "Allowlist" },
  { value: "full", label: "Full" },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface AgentPermissionsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  agentName?: string;
  defaults: ExecApprovalsDefaults;
  agentOverrides: ExecApprovalsAgent;
  onSave: (agentId: string, overrides: ExecApprovalsAgent) => void;
}

export function AgentPermissionsSheet({
  open,
  onOpenChange,
  agentId,
  agentName,
  defaults,
  agentOverrides,
  onSave,
}: AgentPermissionsSheetProps) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState<ExecApprovalsAgent>({});
  const [newPattern, setNewPattern] = React.useState("");

  // Reset draft when opening
  React.useEffect(() => {
    if (open) {
      setDraft({ ...agentOverrides });
      setEditing(false);
      setNewPattern("");
    }
  }, [open, agentOverrides]);

  const handleSave = () => {
    onSave(agentId, draft);
    setEditing(false);
  };

  const handleCancel = () => {
    setDraft({ ...agentOverrides });
    setEditing(false);
  };

  const addPattern = () => {
    const trimmed = newPattern.trim();
    if (!trimmed) return;
    const existing = draft.allowlist ?? [];
    if (existing.some((e) => e.pattern === trimmed)) return;
    setDraft({ ...draft, allowlist: [...existing, { pattern: trimmed }] });
    setNewPattern("");
  };

  const removePattern = (index: number) => {
    const list = [...(draft.allowlist ?? [])];
    list.splice(index, 1);
    setDraft({ ...draft, allowlist: list.length > 0 ? list : undefined });
  };

  const overrideCount = [
    draft.security,
    draft.ask,
    draft.askFallback,
    draft.autoAllowSkills,
  ].filter((v) => v !== undefined).length + (draft.allowlist?.length ? 1 : 0);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-lg overflow-y-auto"
      >
        <SheetHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div>
              <SheetTitle className="flex items-center gap-2">
                <Shield className="h-4 w-4 text-primary" />
                {agentName ?? agentId}
              </SheetTitle>
              <SheetDescription>
                Execution permissions and approval policy
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>

        {/* Edit/Save controls */}
        <div className="flex items-center justify-between px-4 pb-3 border-b">
          {overrideCount > 0 && !editing && (
            <Badge variant="secondary" className="text-xs">
              {overrideCount} override{overrideCount !== 1 ? "s" : ""}
            </Badge>
          )}
          {overrideCount === 0 && !editing && (
            <span className="text-xs text-muted-foreground">
              All inherited from defaults
            </span>
          )}
          {editing && (
            <span className="text-xs text-muted-foreground">Editing</span>
          )}
          <div className="flex items-center gap-2 ml-auto">
            {editing ? (
              <>
                <Button variant="ghost" size="sm" onClick={handleCancel}>
                  <X className="h-3.5 w-3.5 mr-1" />
                  Cancel
                </Button>
                <Button size="sm" onClick={handleSave}>
                  <Save className="h-3.5 w-3.5 mr-1" />
                  Save
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEditing(true)}
              >
                <Pencil className="h-3.5 w-3.5 mr-1" />
                Edit
              </Button>
            )}
          </div>
        </div>

        {/* Policy fields */}
        <div className="px-4 py-3 space-y-1">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
            Policy
          </div>
          <div className="divide-y divide-border/50">
            <PolicySelectRow
              label="Security"
              description="Default security mode for exec"
              value={draft.security}
              defaultValue={defaults.security ?? "deny"}
              options={SECURITY_OPTIONS}
              onChange={(v) => setDraft({ ...draft, security: v })}
              editing={editing}
            />
            <PolicySelectRow
              label="Ask"
              description="Prompt policy for execution"
              value={draft.ask}
              defaultValue={defaults.ask ?? "on-miss"}
              options={ASK_OPTIONS}
              onChange={(v) => setDraft({ ...draft, ask: v })}
              editing={editing}
            />
            <PolicySelectRow
              label="Ask fallback"
              description="When UI prompt is unavailable"
              value={draft.askFallback}
              defaultValue={defaults.askFallback ?? "deny"}
              options={ASK_FALLBACK_OPTIONS}
              onChange={(v) => setDraft({ ...draft, askFallback: v })}
              editing={editing}
            />
            <PolicyToggleRow
              label="Auto-allow skill CLIs"
              description="Allow executables listed by gateway"
              value={draft.autoAllowSkills}
              defaultValue={defaults.autoAllowSkills ?? false}
              onChange={(v) => setDraft({ ...draft, autoAllowSkills: v })}
              editing={editing}
            />
          </div>
        </div>

        {/* Allowlist */}
        <div className="px-4 py-3 border-t">
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                <ListChecks className="h-3 w-3" />
                Allowlist
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Case-insensitive glob patterns
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <AnimatePresence initial={false}>
              {(draft.allowlist ?? []).map((entry, i) => (
                <motion.div
                  key={entry.pattern + i}
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="flex items-center gap-2"
                >
                  <code className="flex-1 text-xs bg-muted/50 px-2.5 py-1.5 rounded-md font-mono truncate">
                    {entry.pattern}
                  </code>
                  {entry.lastUsedAt && (
                    <span className="text-[10px] text-muted-foreground shrink-0">
                      used {formatRelativeTime(entry.lastUsedAt)}
                    </span>
                  )}
                  {editing && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0 text-destructive/70 hover:text-destructive"
                      onClick={() => removePattern(i)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  )}
                </motion.div>
              ))}
            </AnimatePresence>

            {editing && (
              <div className="flex items-center gap-2 pt-1">
                <Input
                  value={newPattern}
                  onChange={(e) => setNewPattern(e.target.value)}
                  placeholder="e.g. git *"
                  className="h-8 text-xs font-mono"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addPattern();
                    }
                  }}
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 shrink-0"
                  onClick={addPattern}
                  disabled={!newPattern.trim()}
                >
                  <Plus className="h-3 w-3 mr-1" />
                  Add
                </Button>
              </div>
            )}

            {!editing && (draft.allowlist ?? []).length === 0 && (
              <div className="text-xs text-muted-foreground italic py-2">
                No patterns defined
              </div>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}
