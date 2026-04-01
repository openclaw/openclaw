import { Save, Eye, Edit3 } from "lucide-react";
import { useState } from "react";

export type SkillEditorProps = {
  initialContent: string;
  onSave: (content: string) => void;
};

export function SkillEditor({ initialContent, onSave }: SkillEditorProps) {
  const [content, setContent] = useState(initialContent);
  const [showPreview, setShowPreview] = useState(false);

  const isDirty = content !== initialContent;

  return (
    <div className="flex flex-col gap-3 h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowPreview(false)}
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer"
            style={{
              backgroundColor: !showPreview ? "var(--accent-purple)" : "transparent",
              color: !showPreview ? "#fff" : "var(--text-secondary)",
              borderWidth: 1,
              borderStyle: "solid",
              borderColor: !showPreview ? "var(--accent-purple)" : "var(--border-mabos)",
            }}
          >
            <Edit3 size={12} />
            Edit
          </button>
          <button
            type="button"
            onClick={() => setShowPreview(true)}
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer"
            style={{
              backgroundColor: showPreview ? "var(--accent-purple)" : "transparent",
              color: showPreview ? "#fff" : "var(--text-secondary)",
              borderWidth: 1,
              borderStyle: "solid",
              borderColor: showPreview ? "var(--accent-purple)" : "var(--border-mabos)",
            }}
          >
            <Eye size={12} />
            Preview
          </button>
        </div>

        <button
          type="button"
          onClick={() => onSave(content)}
          disabled={!isDirty}
          className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          style={{
            backgroundColor: isDirty ? "var(--accent-green)" : "var(--bg-secondary)",
            color: isDirty ? "#fff" : "var(--text-muted)",
          }}
        >
          <Save size={12} />
          Save
        </button>
      </div>

      {/* Editor / Preview */}
      <div className="flex-1 min-h-0">
        {showPreview ? (
          <div
            className="h-full rounded-lg p-4 overflow-auto"
            style={{
              backgroundColor: "var(--bg-secondary)",
              borderWidth: 1,
              borderStyle: "solid",
              borderColor: "var(--border-mabos)",
            }}
          >
            <pre
              className="text-xs leading-relaxed whitespace-pre-wrap font-mono"
              style={{ color: "var(--text-primary)" }}
            >
              {content}
            </pre>
          </div>
        ) : (
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="w-full h-full rounded-lg p-4 text-xs leading-relaxed font-mono resize-none outline-none"
            style={{
              backgroundColor: "var(--bg-secondary)",
              color: "var(--text-primary)",
              borderWidth: 1,
              borderStyle: "solid",
              borderColor: "var(--border-mabos)",
            }}
            spellCheck={false}
          />
        )}
      </div>
    </div>
  );
}
