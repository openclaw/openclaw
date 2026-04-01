import { ChevronDown, Cpu, Loader2, Zap, DollarSign, Layers } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

type ModelInfo = {
  id: string;
  name: string;
  provider: string;
  pricing: string;
  contextWindow: number;
};

type ModelSwitcherProps = {
  selectedModelId?: string;
  onSelect?: (model: ModelInfo) => void;
};

export function ModelSwitcher({ selectedModelId, onSelect }: ModelSwitcherProps) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    async function fetchModels() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/mabos/models/list");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: ModelInfo[] = await res.json();
        setModels(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load models");
      } finally {
        setLoading(false);
      }
    }
    fetchModels();
  }, []);

  const selected = models.find((m) => m.id === selectedModelId);

  function handleSelect(model: ModelInfo) {
    setOpen(false);
    onSelect?.(model);
  }

  function formatContext(tokens: number): string {
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
    if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
    return String(tokens);
  }

  if (loading) {
    return (
      <Card className="bg-[var(--bg-card)] border-[var(--border-mabos)] p-3">
        <div className="flex items-center gap-2">
          <Loader2 className="w-4 h-4 text-[var(--text-muted)] animate-spin" />
          <span className="text-xs text-[var(--text-muted)]">Loading models...</span>
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="bg-[var(--bg-card)] border-[var(--border-mabos)] p-3">
        <p className="text-xs text-[var(--accent-red)]">{error}</p>
      </Card>
    );
  }

  return (
    <div className="relative">
      {/* Trigger */}
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-3 px-4 py-3 rounded-lg border transition-colors"
        style={{
          backgroundColor: "var(--bg-card)",
          borderColor: open ? "var(--border-hover)" : "var(--border-mabos)",
        }}
      >
        <div
          className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0"
          style={{
            backgroundColor: "color-mix(in srgb, var(--accent-purple) 15%, transparent)",
          }}
        >
          <Cpu className="w-4 h-4" style={{ color: "var(--accent-purple)" }} />
        </div>
        <div className="flex-1 text-left min-w-0">
          {selected ? (
            <>
              <p className="text-sm font-medium text-[var(--text-primary)] truncate">
                {selected.name}
              </p>
              <p className="text-[10px] text-[var(--text-muted)]">{selected.provider}</p>
            </>
          ) : (
            <p className="text-sm text-[var(--text-muted)]">Select a model</p>
          )}
        </div>
        <ChevronDown
          className="w-4 h-4 text-[var(--text-muted)] shrink-0 transition-transform"
          style={{ transform: open ? "rotate(180deg)" : undefined }}
        />
      </button>

      {/* Dropdown */}
      {open && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            className="absolute z-20 mt-1 w-full rounded-lg border shadow-lg overflow-hidden"
            style={{
              backgroundColor: "var(--bg-card)",
              borderColor: "var(--border-mabos)",
            }}
          >
            <div className="max-h-80 overflow-y-auto">
              {models.map((model) => {
                const isSelected = model.id === selectedModelId;
                return (
                  <button
                    key={model.id}
                    onClick={() => handleSelect(model)}
                    className="w-full flex items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--bg-secondary)]"
                    style={{
                      backgroundColor: isSelected ? "var(--bg-secondary)" : undefined,
                    }}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-[var(--text-primary)] truncate">
                          {model.name}
                        </span>
                        {isSelected && (
                          <Badge
                            className="text-[10px]"
                            style={{
                              backgroundColor:
                                "color-mix(in srgb, var(--accent-green) 15%, transparent)",
                              color: "var(--accent-green)",
                            }}
                          >
                            active
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                        <span className="flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
                          <Zap className="w-3 h-3" />
                          {model.provider}
                        </span>
                        <span className="flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
                          <DollarSign className="w-3 h-3" />
                          {model.pricing}
                        </span>
                        <span className="flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
                          <Layers className="w-3 h-3" />
                          {formatContext(model.contextWindow)} ctx
                        </span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
