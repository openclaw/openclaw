import { Eye, Pencil, Save, RotateCcw } from "lucide-react";
import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { MarkdownViewer } from "@/components/ui/markdown-viewer";
import { Skeleton } from "@/components/ui/skeleton";
import { useAgentFile, useUpdateAgentFile } from "@/hooks/useAgentFiles";

type AgentFileEditorProps = {
  agentId: string;
  filename: string;
  editable?: boolean;
};

export function AgentFileEditor({ agentId, filename, editable = false }: AgentFileEditorProps) {
  const { data, isLoading, error } = useAgentFile(agentId, filename);
  const updateFile = useUpdateAgentFile(agentId);

  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState("");

  // Sync draft with fetched content
  useEffect(() => {
    if (data?.content != null) {
      setDraft(data.content);
    }
  }, [data?.content]);

  // Reset edit state when filename changes
  useEffect(() => {
    setIsEditing(false);
  }, [filename]);

  const isDirty = data?.content != null && draft !== data.content;

  function handleSave() {
    updateFile.mutate({ filename, content: draft }, { onSuccess: () => setIsEditing(false) });
  }

  function handleReset() {
    if (data?.content != null) {
      setDraft(data.content);
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 text-sm text-[var(--text-muted)] italic">
        Failed to load {filename}. The file may not exist yet for this agent.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      {editable && (
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--border-mabos)] shrink-0">
          <span className="text-xs text-[var(--text-muted)] font-mono">{filename}</span>
          <div className="flex items-center gap-1.5">
            {isDirty && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleReset}
                  disabled={updateFile.isPending}
                  className="h-7 px-2 text-xs border-[var(--border-mabos)] text-[var(--text-secondary)] gap-1"
                >
                  <RotateCcw className="w-3 h-3" />
                  Reset
                </Button>
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={updateFile.isPending}
                  className="h-7 px-2 text-xs bg-[var(--accent-purple)] text-white gap-1"
                >
                  <Save className="w-3 h-3" />
                  {updateFile.isPending ? "Saving…" : "Save"}
                </Button>
              </>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setIsEditing(!isEditing)}
              className="h-7 px-2 text-xs border-[var(--border-mabos)] text-[var(--text-secondary)] gap-1"
            >
              {isEditing ? (
                <>
                  <Eye className="w-3 h-3" />
                  Preview
                </>
              ) : (
                <>
                  <Pencil className="w-3 h-3" />
                  Edit
                </>
              )}
            </Button>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {isEditing ? (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="w-full h-full min-h-[300px] p-4 text-sm font-mono bg-transparent text-[var(--text-secondary)] resize-none focus:outline-none"
            spellCheck={false}
          />
        ) : (
          <div className="p-4">
            <MarkdownViewer content={draft || data?.content || ""} />
          </div>
        )}
      </div>
    </div>
  );
}
