import { LayoutGrid, Network } from "lucide-react";

export type GoalViewMode = "grid" | "diagram";

type GoalViewToggleProps = {
  viewMode: GoalViewMode;
  onViewModeChange: (mode: GoalViewMode) => void;
};

export function GoalViewToggle({ viewMode, onViewModeChange }: GoalViewToggleProps) {
  return (
    <div className="flex items-center rounded-lg border border-[var(--border-mabos)] overflow-hidden">
      <button
        onClick={() => onViewModeChange("grid")}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors"
        style={{
          backgroundColor: viewMode === "grid" ? "var(--bg-secondary)" : "transparent",
          color: viewMode === "grid" ? "var(--text-primary)" : "var(--text-muted)",
        }}
      >
        <LayoutGrid className="w-3.5 h-3.5" />
        Cards
      </button>
      <button
        onClick={() => onViewModeChange("diagram")}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors"
        style={{
          backgroundColor: viewMode === "diagram" ? "var(--bg-secondary)" : "transparent",
          color: viewMode === "diagram" ? "var(--text-primary)" : "var(--text-muted)",
        }}
      >
        <Network className="w-3.5 h-3.5" />
        Diagram
      </button>
    </div>
  );
}
