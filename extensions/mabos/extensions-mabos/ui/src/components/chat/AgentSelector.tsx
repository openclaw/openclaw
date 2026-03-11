import { ChevronDown } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { getAgentIcon, getAgentName } from "@/lib/agent-icons";

const chatAgents = [
  "ceo",
  "cfo",
  "cmo",
  "coo",
  "cto",
  "hr",
  "knowledge",
  "legal",
  "strategy",
];

export function AgentSelector({
  activeAgent,
  onSelect,
}: {
  activeAgent: string;
  onSelect: (agentId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const ActiveIcon = getAgentIcon(activeAgent);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 hover:bg-[var(--bg-hover)] px-2 py-1 rounded transition-colors"
      >
        <div className="w-6 h-6 rounded-full bg-[var(--bg-tertiary)] border border-[var(--border-mabos)] flex items-center justify-center">
          <ActiveIcon className="w-3 h-3 text-[var(--accent-green)]" />
        </div>
        <div className="text-left">
          <div className="text-sm font-medium">{getAgentName(activeAgent)}</div>
        </div>
        <ChevronDown className="w-3 h-3 text-[var(--text-muted)]" />
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-56 bg-[var(--bg-card)] border border-[var(--border-mabos)] rounded-lg shadow-lg overflow-hidden z-50">
          {chatAgents.map((agentId) => {
            const Icon = getAgentIcon(agentId);
            return (
              <button
                key={agentId}
                onClick={() => {
                  onSelect(agentId);
                  setOpen(false);
                }}
                className={`flex items-center gap-3 w-full px-3 py-2 text-sm hover:bg-[var(--bg-hover)] transition-colors ${
                  agentId === activeAgent ? "bg-[var(--bg-hover)]" : ""
                }`}
              >
                <div className="w-6 h-6 rounded-full bg-[var(--bg-tertiary)] border border-[var(--border-mabos)] flex items-center justify-center">
                  <Icon className="w-3 h-3" />
                </div>
                <span>{getAgentName(agentId)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
