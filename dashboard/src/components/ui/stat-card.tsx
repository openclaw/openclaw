"use client";

import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

interface StatCardProps {
  label: string;
  value: string | number;
  icon?: LucideIcon;
  trend?: { value: number; label?: string };
  className?: string;
}

export function StatCard({ label, value, icon: Icon, trend, className }: StatCardProps) {
  return (
    <div className={cn("glass-card p-4", className)}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
            {label}
          </p>
          <p className="text-2xl font-semibold mt-1 tracking-tight">{value}</p>
        </div>
        {Icon && (
          <div className="p-2 rounded-lg bg-primary/[0.08]">
            <Icon className="w-4 h-4 text-primary" />
          </div>
        )}
      </div>
      {trend && (
        <div className="mt-2 flex items-center gap-1">
          <span
            className={cn(
              "text-xs font-medium",
              trend.value > 0 ? "text-emerald-400" : trend.value < 0 ? "text-red-400" : "text-muted-foreground"
            )}
          >
            {trend.value > 0 ? "+" : ""}
            {trend.value}%
          </span>
          {trend.label && (
            <span className="text-[10px] text-muted-foreground">{trend.label}</span>
          )}
        </div>
      )}
    </div>
  );
}
