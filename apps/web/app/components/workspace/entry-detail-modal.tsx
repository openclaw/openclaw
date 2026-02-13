"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { RelationSelect } from "./relation-select";


// --- Types ---

type Field = {
  id: string;
  name: string;
  type: string;
  enum_values?: string[];
  enum_colors?: string[];
  enum_multiple?: boolean;
  related_object_id?: string;
  relationship_type?: string;
  related_object_name?: string;
  sort_order?: number;
};

type ReverseRelation = {
  fieldName: string;
  sourceObjectName: string;
  sourceObjectId: string;
  displayField: string;
  links: Array<{ id: string; label: string }>;
};

type EntryDetailData = {
  object: {
    id: string;
    name: string;
    description?: string;
    icon?: string;
  };
  fields: Field[];
  entry: Record<string, unknown>;
  relationLabels?: Record<string, Record<string, string>>;
  reverseRelations?: ReverseRelation[];
  effectiveDisplayField?: string;
};

type EntryDetailModalProps = {
  objectName: string;
  entryId: string;
  members?: Array<{ id: string; name: string; email: string; role: string }>;
  onClose: () => void;
  /** Navigate to another entry (opens new modal). */
  onNavigateEntry?: (objectName: string, entryId: string) => void;
  /** Navigate to an object table view. */
  onNavigateObject?: (objectName: string) => void;
  /** Called after an edit or delete to refresh parent data. */
  onRefresh?: () => void;
};

// --- Helpers ---

function parseRelationValue(value: string | null | undefined): string[] {
  if (!value) {return [];}
  const trimmed = value.trim();
  if (!trimmed) {return [];}
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {return parsed.map(String).filter(Boolean);}
    } catch {
      // not JSON
    }
  }
  return [trimmed];
}

// --- Cell renderers (lightweight variants of object-table ones) ---

function EnumBadge({
  value,
  enumValues,
  enumColors,
}: {
  value: string;
  enumValues?: string[];
  enumColors?: string[];
}) {
  const idx = enumValues?.indexOf(value) ?? -1;
  const color = idx >= 0 && enumColors ? enumColors[idx] : "#94a3b8";
  return (
    <span
      className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium"
      style={{
        background: `${color}20`,
        color,
        border: `1px solid ${color}40`,
      }}
    >
      {value}
    </span>
  );
}

function UserBadge({
  value,
  members,
}: {
  value: unknown;
  members?: Array<{ id: string; name: string }>;
}) {
  const memberId = String(value);
  const member = members?.find((m) => m.id === memberId);
  return (
    <span className="flex items-center gap-2">
      <span
        className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium flex-shrink-0"
        style={{ background: "var(--color-accent)", color: "white" }}
      >
        {(member?.name ?? memberId).charAt(0).toUpperCase()}
      </span>
      <span>{member?.name ?? memberId}</span>
    </span>
  );
}

function RelationChips({
  value,
  field,
  relationLabels,
  onNavigateEntry,
}: {
  value: unknown;
  field: Field;
  relationLabels?: Record<string, Record<string, string>>;
  onNavigateEntry?: (objectName: string, entryId: string) => void;
}) {
  const fieldLabels = relationLabels?.[field.name];
  const ids = parseRelationValue(String(value));
  if (ids.length === 0) {return <EmptyValue />;}

  return (
    <span className="flex items-center gap-1.5 flex-wrap">
      {ids.map((id) => {
        const label = fieldLabels?.[id] ?? id;
        const handleClick = field.related_object_name && onNavigateEntry
          ? () => onNavigateEntry(field.related_object_name!, id)
          : undefined;
        return (
          <button
            type="button"
            key={id}
            onClick={handleClick}
            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium ${handleClick ? "cursor-pointer hover:opacity-80" : ""}`}
            style={{
              background: "rgba(96, 165, 250, 0.1)",
              color: "#60a5fa",
              border: "1px solid rgba(96, 165, 250, 0.2)",
            }}
            title={handleClick ? `Open ${label}` : label}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0" style={{ opacity: 0.5 }}>
              <path d="M7 7h10v10" /><path d="M7 17 17 7" />
            </svg>
            <span className="truncate max-w-[200px]">{label}</span>
          </button>
        );
      })}
    </span>
  );
}

function EmptyValue() {
  return (
    <span style={{ color: "var(--color-text-muted)", opacity: 0.5 }}>--</span>
  );
}

/** Render a set of reverse relation links (incoming references from another object). */
function ReverseRelationSection({
  relation,
  onNavigateEntry,
}: {
  relation: ReverseRelation;
  onNavigateEntry?: (objectName: string, entryId: string) => void;
}) {
  const displayLinks = relation.links.slice(0, 10);
  const overflow = relation.links.length - displayLinks.length;

  return (
    <div>
      <label
        className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider mb-1.5"
        style={{ color: "var(--color-text-muted)" }}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.4 }}>
          <path d="m12 19-7-7 7-7" /><path d="M19 12H5" />
        </svg>
        <span className="capitalize">{relation.sourceObjectName}</span>
        <span className="normal-case tracking-normal font-normal opacity-60">
          via {relation.fieldName}
        </span>
      </label>
      <div className="flex items-center gap-1.5 flex-wrap text-sm min-h-[1.75rem]">
        {displayLinks.map((link) => (
          <button
            type="button"
            key={link.id}
            onClick={() => onNavigateEntry?.(relation.sourceObjectName, link.id)}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium cursor-pointer hover:opacity-80"
            style={{
              background: "rgba(192, 132, 252, 0.1)",
              color: "#c084fc",
              border: "1px solid rgba(192, 132, 252, 0.2)",
            }}
            title={`Open ${link.label} in ${relation.sourceObjectName}`}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0" style={{ opacity: 0.5 }}>
              <path d="M7 7h10v10" /><path d="M7 17 17 7" />
            </svg>
            <span className="truncate max-w-[200px]">{link.label}</span>
          </button>
        ))}
        {overflow > 0 && (
          <span className="text-xs px-1.5 py-0.5 rounded" style={{ color: "var(--color-text-muted)" }}>
            +{overflow} more
          </span>
        )}
      </div>
    </div>
  );
}

function FieldValue({
  value,
  field,
  members,
  relationLabels,
  onNavigateEntry,
}: {
  value: unknown;
  field: Field;
  members?: Array<{ id: string; name: string }>;
  relationLabels?: Record<string, Record<string, string>>;
  onNavigateEntry?: (objectName: string, entryId: string) => void;
}) {
  if (value === null || value === undefined || value === "") {return <EmptyValue />;}

  switch (field.type) {
    case "enum":
      return (
        <EnumBadge
          value={String(value)}
          enumValues={field.enum_values}
          enumColors={field.enum_colors}
        />
      );
    case "boolean": {
      const isTrue = value === true || value === "true" || value === "1" || value === "yes";
      return <span style={{ color: isTrue ? "#22c55e" : "var(--color-text-muted)" }}>{isTrue ? "Yes" : "No"}</span>;
    }
    case "user":
      return <UserBadge value={value} members={members} />;
    case "relation":
      return (
        <RelationChips
          value={value}
          field={field}
          relationLabels={relationLabels}
          onNavigateEntry={onNavigateEntry}
        />
      );
    case "email":
      return (
        <a href={`mailto:${value}`} className="underline underline-offset-2" style={{ color: "#60a5fa" }}>
          {String(value)}
        </a>
      );
    case "richtext":
      return <span className="whitespace-pre-wrap">{String(value)}</span>;
    case "number":
      return <span className="tabular-nums">{String(value)}</span>;
    case "date":
      return <span>{String(value)}</span>;
    default:
      return <span>{String(value)}</span>;
  }
}

// --- Modal Component ---

export function EntryDetailModal({
  objectName,
  entryId,
  members,
  onClose,
  onNavigateEntry,
  onNavigateObject,
  onRefresh,
}: EntryDetailModalProps) {
  const [data, setData] = useState<EntryDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);

  // Fetch entry data
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    async function load() {
      try {
        const res = await fetch(
          `/api/workspace/objects/${encodeURIComponent(objectName)}/entries/${encodeURIComponent(entryId)}`,
        );
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "Failed to load" }));
          if (!cancelled) {
            setError(err.error ?? "Failed to load entry");
            setLoading(false);
          }
          return;
        }
        const json = await res.json();
        if (!cancelled) {
          setData(json);
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setError("Network error");
          setLoading(false);
        }
      }
    }

    load();
    return () => { cancelled = true; };
  }, [objectName, entryId]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {onClose();}
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // Close on backdrop click
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === backdropRef.current) {onClose();}
    },
    [onClose],
  );

  // ── Edit handler ──
  const handleSaveField = useCallback(async (fieldName: string, value: string) => {
    setSaving(true);
    try {
      const res = await fetch(
        `/api/workspace/objects/${encodeURIComponent(objectName)}/entries/${encodeURIComponent(entryId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fields: { [fieldName]: value } }),
        },
      );
      if (res.ok) {
        // Update local data optimistically
        setData((prev) => {
          if (!prev) {return prev;}
          return { ...prev, entry: { ...prev.entry, [fieldName]: value } };
        });
        setEditingField(null);
        onRefresh?.();
      }
    } catch { /* ignore */ }
    finally { setSaving(false); }
  }, [objectName, entryId, onRefresh]);

  // ── Delete handler ──
  const handleDelete = useCallback(async () => {
    if (!confirm("Are you sure you want to delete this entry?")) {return;}
    setDeleting(true);
    try {
      await fetch(
        `/api/workspace/objects/${encodeURIComponent(objectName)}/entries/${encodeURIComponent(entryId)}`,
        { method: "DELETE" },
      );
      onRefresh?.();
      onClose();
    } catch { /* ignore */ }
    finally { setDeleting(false); }
  }, [objectName, entryId, onRefresh, onClose]);

  const displayField = data?.effectiveDisplayField;
  const title = displayField && data?.entry[displayField]
    ? String(data.entry[displayField])
    : `${objectName} entry`;

  return (
    <div
      ref={backdropRef}
      onClick={handleBackdropClick}
      className="fixed inset-0 z-50 flex items-start justify-center"
      style={{ background: "rgba(0, 0, 0, 0.5)", backdropFilter: "blur(2px)" }}
    >
      <div
        className="relative mt-12 mb-12 w-full max-w-2xl rounded-2xl overflow-hidden shadow-2xl flex flex-col"
        style={{
          background: "var(--color-bg)",
          border: "1px solid var(--color-border)",
          maxHeight: "calc(100vh - 6rem)",
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-6 py-4 border-b flex-shrink-0"
          style={{ borderColor: "var(--color-border)" }}
        >
          <div className="flex items-center gap-3 min-w-0">
            {/* Object badge */}
            <button
              type="button"
              onClick={() => onNavigateObject?.(objectName)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium capitalize transition-colors hover:opacity-80 flex-shrink-0"
              style={{
                background: "var(--color-accent-light)",
                color: "var(--color-accent)",
                border: "1px solid var(--color-border)",
              }}
              title={`Go to ${objectName}`}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3v18" /><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M3 9h18" /><path d="M3 15h18" />
              </svg>
              {objectName}
            </button>
            <h2
              className="text-lg font-semibold truncate"
              style={{ color: "var(--color-text)" }}
            >
              {loading ? "Loading..." : title}
            </h2>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {/* Delete button */}
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              className="p-1.5 rounded-lg flex-shrink-0"
              style={{ color: "var(--color-error)" }}
              title="Delete entry"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
              </svg>
            </button>
            {/* Close button */}
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg flex-shrink-0"
              style={{ color: "var(--color-text-muted)" }}
              title="Close"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18" /><path d="m6 6 12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {loading && (
            <div className="flex items-center justify-center py-16">
              <div
                className="w-6 h-6 border-2 rounded-full animate-spin"
                style={{ borderColor: "var(--color-border)", borderTopColor: "var(--color-accent)" }}
              />
            </div>
          )}
          {error && (
            <div className="text-center py-16">
              <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>{error}</p>
            </div>
          )}
          {data && !loading && (
            <div className="space-y-4">
              {data.fields.map((field) => {
                const value = data.entry[field.name];
                return (
                  <div key={field.id}>
                    <label
                      className="block text-xs font-medium uppercase tracking-wider mb-1.5"
                      style={{ color: "var(--color-text-muted)" }}
                    >
                      {field.name}
                      {field.type === "relation" && field.related_object_name && (
                        <span className="normal-case tracking-normal font-normal opacity-60 ml-1">
                          ({field.related_object_name})
                        </span>
                      )}
                    </label>
                    <div
                      className="text-sm min-h-[1.75rem] flex items-center"
                      style={{ color: "var(--color-text)" }}
                    >
                      {editingField === field.name ? (
                        field.type === "relation" && field.related_object_name ? (
                          <div className="flex items-center gap-2 w-full">
                            <div className="flex-1">
                              <RelationSelect
                                relatedObjectName={field.related_object_name}
                                value={String(value ?? "")}
                                multiple={field.relationship_type === "many_to_many"}
                                onChange={(v) => { handleSaveField(field.name, v); }}
                                autoFocus
                              />
                            </div>
                            <button type="button" onClick={() => setEditingField(null)} className="px-2 py-1 text-xs rounded-lg flex-shrink-0" style={{ color: "var(--color-text-muted)", border: "1px solid var(--color-border)" }}>
                              Cancel
                            </button>
                          </div>
                        ) : (
                        <form
                          onSubmit={(e) => { e.preventDefault(); handleSaveField(field.name, editValue); }}
                          className="flex items-center gap-2 w-full"
                        >
                          {field.type === "enum" && field.enum_values ? (
                            <select
                              value={editValue}
                              onChange={(e) => { setEditValue(e.target.value); handleSaveField(field.name, e.target.value); }}
                              autoFocus
                              className="flex-1 px-2 py-1 text-sm rounded-lg outline-none"
                              style={{ background: "var(--color-surface-hover)", color: "var(--color-text)", border: "2px solid var(--color-accent)" }}
                            >
                              <option value="">--</option>
                              {field.enum_values.map((v) => <option key={v} value={v}>{v}</option>)}
                            </select>
                          ) : field.type === "boolean" ? (
                            <select
                              value={editValue}
                              onChange={(e) => { setEditValue(e.target.value); handleSaveField(field.name, e.target.value); }}
                              autoFocus
                              className="flex-1 px-2 py-1 text-sm rounded-lg outline-none"
                              style={{ background: "var(--color-surface-hover)", color: "var(--color-text)", border: "2px solid var(--color-accent)" }}
                            >
                              <option value="true">Yes</option>
                              <option value="false">No</option>
                            </select>
                          ) : (
                            <>
                              <input
                                type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
                                value={editValue}
                                onChange={(e) => setEditValue(e.target.value)}
                                autoFocus
                                className="flex-1 px-2 py-1 text-sm rounded-lg outline-none"
                                style={{ background: "var(--color-surface-hover)", color: "var(--color-text)", border: "2px solid var(--color-accent)" }}
                              />
                              <button type="submit" disabled={saving} className="px-2 py-1 text-xs rounded-lg font-medium" style={{ background: "var(--color-accent)", color: "white" }}>
                                {saving ? "..." : "Save"}
                              </button>
                            </>
                          )}
                          <button type="button" onClick={() => setEditingField(null)} className="px-2 py-1 text-xs rounded-lg" style={{ color: "var(--color-text-muted)", border: "1px solid var(--color-border)" }}>
                            Cancel
                          </button>
                        </form>
                        )
                      ) : (
                        <div
                          className={`flex-1 ${!["user"].includes(field.type) ? "cursor-pointer hover:opacity-80" : ""}`}
                          onClick={() => {
                            if (!["user"].includes(field.type)) {
                              setEditingField(field.name);
                              setEditValue(String(value ?? ""));
                            }
                          }}
                          title={!["user"].includes(field.type) ? "Click to edit" : undefined}
                        >
                          <FieldValue
                            value={value}
                            field={field}
                            members={members}
                            relationLabels={data.relationLabels}
                            onNavigateEntry={onNavigateEntry}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {/* Reverse relations (incoming links from other objects) */}
              {data.reverseRelations && data.reverseRelations.length > 0 && (
                <div
                  className="pt-4 mt-4 border-t space-y-4"
                  style={{ borderColor: "var(--color-border)" }}
                >
                  <div
                    className="text-[10px] font-medium uppercase tracking-widest"
                    style={{ color: "var(--color-text-muted)", opacity: 0.6 }}
                  >
                    Linked from
                  </div>
                  {data.reverseRelations.map((rr) => (
                    <ReverseRelationSection
                      key={`${rr.sourceObjectName}_${rr.fieldName}`}
                      relation={rr}
                      onNavigateEntry={onNavigateEntry}
                    />
                  ))}
                </div>
              )}

              {/* Timestamps */}
              {(data.entry.created_at != null || data.entry.updated_at != null) && (
                <div
                  className="pt-4 mt-4 border-t text-xs flex gap-6"
                  style={{ borderColor: "var(--color-border)", color: "var(--color-text-muted)" }}
                >
                  {data.entry.created_at != null && (
                    <span>Created: {String(data.entry.created_at as string)}</span>
                  )}
                  {data.entry.updated_at != null && (
                    <span>Updated: {String(data.entry.updated_at as string)}</span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
