import {
  Play,
  Square,
  User,
  Cog,
  Code,
  GitBranch,
  Columns2,
  LayoutTemplate,
  Rows2,
} from "lucide-react";
import type { DragEvent } from "react";

interface PaletteItem {
  type: string;
  subType?: string;
  label: string;
  icon: React.ReactNode;
  category: string;
}

const PALETTE_ITEMS: PaletteItem[] = [
  // Events
  {
    type: "startEvent",
    label: "Start",
    icon: <Play className="w-4 h-4" />,
    category: "Events",
  },
  {
    type: "endEvent",
    label: "End",
    icon: <Square className="w-4 h-4" />,
    category: "Events",
  },
  // Activities
  {
    type: "task",
    subType: "user",
    label: "User Task",
    icon: <User className="w-4 h-4" />,
    category: "Activities",
  },
  {
    type: "task",
    subType: "service",
    label: "Service Task",
    icon: <Cog className="w-4 h-4" />,
    category: "Activities",
  },
  {
    type: "task",
    subType: "script",
    label: "Script Task",
    icon: <Code className="w-4 h-4" />,
    category: "Activities",
  },
  // Gateways
  {
    type: "gateway",
    subType: "exclusive",
    label: "Exclusive",
    icon: <GitBranch className="w-4 h-4" />,
    category: "Gateways",
  },
  {
    type: "gateway",
    subType: "parallel",
    label: "Parallel",
    icon: <Columns2 className="w-4 h-4" />,
    category: "Gateways",
  },
  // Swimlanes
  {
    type: "pool",
    label: "Pool",
    icon: <LayoutTemplate className="w-4 h-4" />,
    category: "Swimlanes",
  },
  {
    type: "lane",
    label: "Lane",
    icon: <Rows2 className="w-4 h-4" />,
    category: "Swimlanes",
  },
];

function onDragStart(event: DragEvent, item: PaletteItem) {
  const data = JSON.stringify({
    type: item.type,
    subType: item.subType,
    label: item.label,
  });
  event.dataTransfer.setData("application/bpmn-element", data);
  event.dataTransfer.effectAllowed = "move";
}

export function BpmnPalette() {
  const categories = [...new Set(PALETTE_ITEMS.map((i) => i.category))];

  return (
    <div className="w-48 border-r border-[var(--border-mabos)] bg-[var(--bg-secondary)] overflow-y-auto flex-shrink-0">
      <div className="p-3">
        <h3 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3">
          Elements
        </h3>
        {categories.map((cat) => (
          <div key={cat} className="mb-4">
            <p className="text-[10px] font-medium text-[var(--text-muted)] uppercase mb-1.5">
              {cat}
            </p>
            <div className="space-y-1">
              {PALETTE_ITEMS.filter((i) => i.category === cat).map((item) => (
                <div
                  key={`${item.type}-${item.subType || ""}`}
                  draggable
                  onDragStart={(e) => onDragStart(e, item)}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-md cursor-grab
                    hover:bg-[var(--bg-hover)] text-[var(--text-secondary)]
                    active:cursor-grabbing transition-colors"
                >
                  {item.icon}
                  <span className="text-xs">{item.label}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
