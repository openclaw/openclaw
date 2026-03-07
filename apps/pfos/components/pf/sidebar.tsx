"use client";

import { cn } from "@/lib/utils";
import { NAV_ITEMS } from "./mock-data";

export type PfView = "mission" | "workflows" | "timeline" | "operator" | "forge" | "pipeline" | "vision" | "cli";

export function Sidebar({ active, onChange }: { active: PfView; onChange: (v: PfView) => void }) {
  return (
    <aside className="border-r border-white/10 bg-black/40 p-4 lg:sticky lg:top-0 lg:h-screen">
      <div className="flex items-center gap-3 border-b border-white/10 pb-4">
        <div className="pf-glow grid h-11 w-11 place-items-center rounded-2xl border border-yellow-400/20 bg-gradient-to-br from-sky-500/20 via-slate-200/10 to-yellow-400/15">
          <span className="text-xs font-bold">PF</span>
        </div>
        <div className="leading-tight">
          <div className="text-xs font-extrabold tracking-[0.22em] uppercase">Platinum Fang OS</div>
          <div className="mt-1 text-[11px] font-semibold tracking-[0.22em] uppercase text-yellow-300/90">
            Intelligence With Teeth
          </div>
        </div>
      </div>

      <nav className="mt-4 flex flex-col gap-2">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.key}
            onClick={() => onChange(item.key)}
            className={cn(
              "flex items-center gap-3 rounded-2xl border px-3 py-3 text-left transition hover:-translate-y-[1px]",
              "border-white/10 bg-gradient-to-b from-slate-900/50 to-slate-950/30 hover:border-yellow-300/30",
              active === item.key && "pf-glow border-yellow-300/40 from-yellow-400/10 to-sky-900/30"
            )}
          >
            <span className="grid h-6 w-6 place-items-center text-[10px] font-bold text-yellow-300">{item.icon}</span>
            <span className="font-semibold text-slate-100/95">{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="mt-5 border-t border-white/10 pt-4 text-xs text-slate-200/60">
        <div>
          <span className="font-semibold text-slate-100/80">Signature:</span> By mNtLSpACE
        </div>
        <div className="mt-1">System Build: PF-OS v1.0 (SaaS Pack)</div>
      </div>
    </aside>
  );
}
