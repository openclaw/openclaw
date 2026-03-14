"use client";

import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

export interface Tab {
  id: string;
  label: string;
  icon?: LucideIcon;
}

interface TabBarProps {
  tabs: Tab[];
  defaultTab?: string;
  layoutId?: string;
}

export function TabBar({ tabs, defaultTab, layoutId = "tab-indicator" }: TabBarProps) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const activeTab = searchParams.get("tab") || defaultTab || tabs[0]?.id;

  function setTab(tabId: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (tabId === (defaultTab || tabs[0]?.id)) {
      params.delete("tab");
    } else {
      params.set("tab", tabId);
    }
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  return (
    <div className="flex items-center gap-1 p-1 rounded-xl bg-white/[0.03] border border-white/[0.04]">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        const Icon = tab.icon;

        return (
          <button
            key={tab.id}
            onClick={() => setTab(tab.id)}
            className={cn(
              "relative flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors",
              isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {isActive && (
              <motion.div
                layoutId={layoutId}
                className="absolute inset-0 rounded-lg bg-white/[0.06] border border-white/[0.08]"
                transition={{ type: "spring", stiffness: 400, damping: 30 }}
              />
            )}
            <span className="relative flex items-center gap-1.5">
              {Icon && <Icon className="w-3.5 h-3.5" />}
              {tab.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function useTab(tabs: Tab[], defaultTab?: string): string {
  const searchParams = useSearchParams();
  return searchParams.get("tab") || defaultTab || tabs[0]?.id || "";
}
