import { Download, Play, Tag, User } from "lucide-react";

export type SkillCardProps = {
  name: string;
  version: string;
  description: string;
  author: string;
  tags: string[];
  onInstall?: () => void;
  onRun?: () => void;
};

const tagColors: Record<string, string> = {
  automation: "var(--accent-blue)",
  analytics: "var(--accent-purple)",
  security: "var(--accent-red)",
  integration: "var(--accent-green)",
  productivity: "var(--accent-orange)",
};

function getTagColor(tag: string): string {
  return tagColors[tag.toLowerCase()] ?? "var(--accent-blue)";
}

export function SkillCard({
  name,
  version,
  description,
  author,
  tags,
  onInstall,
  onRun,
}: SkillCardProps) {
  return (
    <div
      className="rounded-lg p-4 flex flex-col gap-3"
      style={{
        backgroundColor: "var(--bg-card)",
        borderWidth: 1,
        borderStyle: "solid",
        borderColor: "var(--border-mabos)",
      }}
    >
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            {name}
          </h3>
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            v{version}
          </span>
        </div>
      </div>

      {/* Description */}
      <p
        className="text-xs leading-relaxed line-clamp-3"
        style={{ color: "var(--text-secondary)" }}
      >
        {description}
      </p>

      {/* Author */}
      <div className="flex items-center gap-1.5">
        <User size={12} style={{ color: "var(--text-muted)" }} />
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>
          {author}
        </span>
      </div>

      {/* Tags */}
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
              style={{
                backgroundColor: `color-mix(in srgb, ${getTagColor(tag)} 15%, transparent)`,
                color: getTagColor(tag),
              }}
            >
              <Tag size={10} />
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 mt-auto pt-2">
        {onInstall && (
          <button
            type="button"
            onClick={onInstall}
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer"
            style={{
              backgroundColor: "var(--accent-purple)",
              color: "#fff",
            }}
          >
            <Download size={12} />
            Install
          </button>
        )}
        {onRun && (
          <button
            type="button"
            onClick={onRun}
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer"
            style={{
              backgroundColor: "transparent",
              color: "var(--accent-green)",
              borderWidth: 1,
              borderStyle: "solid",
              borderColor: "var(--accent-green)",
            }}
          >
            <Play size={12} />
            Run
          </button>
        )}
      </div>
    </div>
  );
}
