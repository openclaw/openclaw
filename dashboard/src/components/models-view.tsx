"use client";

import { useAutoRefresh } from "@/hooks/use-auto-refresh";
import { GlassCard } from "@/components/ui/glass-card";
import { SkeletonCard } from "@/components/ui/skeleton-card";
import { Cpu, Sparkles } from "lucide-react";
import { formatNumber } from "@/lib/utils";

interface ModelProvider {
  providers: Record<
    string,
    {
      baseUrl: string;
      api: string;
      models: Array<{
        id: string;
        name: string;
        reasoning?: boolean;
        contextWindow?: number;
        maxTokens?: number;
        cost?: { input: number; output: number };
      }>;
    }
  >;
}

export function ModelsView() {
  // We can read models from agent detail, but let's use a simpler approach
  // The models come from the first agent's models.json
  const { data: agents, loading } = useAutoRefresh<
    Array<{ id: string; modelFull: string; model: string; name: string; emoji: string }>
  >("/api/agents");

  if (loading) return <SkeletonCard lines={6} />;

  // Deduplicate models from agents
  const modelUsage = new Map<string, string[]>();
  (agents || []).forEach((a) => {
    const existing = modelUsage.get(a.modelFull) || [];
    existing.push(`${a.emoji} ${a.name}`);
    modelUsage.set(a.modelFull, existing);
  });

  // Known models
  const knownModels = [
    { id: "grok-4-1-fast-reasoning", provider: "xai", name: "Grok 4.1 Fast Reasoning", reasoning: true, context: 131072, maxTokens: 8192 },
    { id: "claude-opus-4", provider: "claude-max-proxy", name: "Claude Opus 4 (Max Proxy)", reasoning: true, context: 200000, maxTokens: 16384 },
    { id: "claude-sonnet-4", provider: "claude-max-proxy", name: "Claude Sonnet 4 (Max Proxy)", reasoning: true, context: 200000, maxTokens: 16384 },
    { id: "claude-haiku-4", provider: "claude-max-proxy", name: "Claude Haiku 4 (Max Proxy)", reasoning: false, context: 200000, maxTokens: 16384 },
    { id: "gpt-5-mini", provider: "openai", name: "GPT-5 Mini", reasoning: false, context: 128000, maxTokens: 8192 },
    { id: "gpt-5.2-pro", provider: "openai", name: "GPT-5.2 Pro", reasoning: true, context: 128000, maxTokens: 16384 },
    { id: "auto", provider: "openrouter", name: "OpenRouter Auto", reasoning: false, context: 200000, maxTokens: 8192 },
  ];

  return (
    <GlassCard>
      <div className="flex items-center gap-2 mb-4">
        <Cpu className="w-4 h-4 text-primary" />
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Model Inventory
        </h3>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-white/[0.06]">
              <th className="text-left py-2.5 font-medium text-muted-foreground">Model</th>
              <th className="text-left py-2.5 font-medium text-muted-foreground">Provider</th>
              <th className="text-center py-2.5 font-medium text-muted-foreground">Reasoning</th>
              <th className="text-right py-2.5 font-medium text-muted-foreground">Context</th>
              <th className="text-right py-2.5 font-medium text-muted-foreground">Max Tokens</th>
              <th className="text-left py-2.5 font-medium text-muted-foreground">Used By</th>
            </tr>
          </thead>
          <tbody>
            {knownModels.map((model) => {
              const fullId = `${model.provider}/${model.id}`;
              const usedBy = modelUsage.get(fullId) || [];
              return (
                <tr key={model.id} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                  <td className="py-2.5">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium">{model.name}</span>
                    </div>
                  </td>
                  <td className="py-2.5 font-mono text-muted-foreground">{model.provider}</td>
                  <td className="py-2.5 text-center">
                    {model.reasoning ? (
                      <Sparkles className="w-3.5 h-3.5 text-amber-400 mx-auto" />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="py-2.5 text-right font-mono text-muted-foreground">
                    {formatNumber(model.context)}
                  </td>
                  <td className="py-2.5 text-right font-mono text-muted-foreground">
                    {formatNumber(model.maxTokens)}
                  </td>
                  <td className="py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {usedBy.map((agent, i) => (
                        <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.04]">
                          {agent}
                        </span>
                      ))}
                      {usedBy.length === 0 && (
                        <span className="text-muted-foreground">Available</span>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </GlassCard>
  );
}
