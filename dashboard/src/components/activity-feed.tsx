"use client";

import { GlassCard } from "@/components/ui/glass-card";
import { formatRelativeTime } from "@/lib/utils";
import {
  Activity,
  Bot,
  Zap,
  FileText,
  Server,
  CheckCircle,
  AlertCircle,
  type LucideIcon,
} from "lucide-react";

interface ActivityItem {
  _id: string;
  type: string;
  agentId?: string;
  title: string;
  description?: string;
  timestamp: number;
}

interface ActivityFeedProps {
  activities?: ActivityItem[];
}

const typeIcons: Record<string, { icon: LucideIcon; color: string }> = {
  heartbeat: { icon: Activity, color: "text-blue-400" },
  task: { icon: CheckCircle, color: "text-emerald-400" },
  approval: { icon: Zap, color: "text-amber-400" },
  system: { icon: Server, color: "text-purple-400" },
  deploy: { icon: Server, color: "text-green-400" },
  content: { icon: FileText, color: "text-pink-400" },
  scrape: { icon: Bot, color: "text-cyan-400" },
  error: { icon: AlertCircle, color: "text-red-400" },
};

export function ActivityFeed({ activities = [] }: ActivityFeedProps) {
  if (activities.length === 0) {
    return (
      <GlassCard>
        <div className="flex items-center gap-2 mb-3">
          <Activity className="w-4 h-4 text-primary" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Recent Activity
          </h3>
        </div>
        <p className="text-xs text-muted-foreground">
          No activity yet. Connect Convex to see real-time activity feed.
        </p>
      </GlassCard>
    );
  }

  return (
    <GlassCard>
      <div className="flex items-center gap-2 mb-3">
        <Activity className="w-4 h-4 text-primary" />
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Recent Activity
        </h3>
      </div>
      <div className="space-y-1">
        {activities.map((item) => {
          const config = typeIcons[item.type] || typeIcons.system;
          const Icon = config.icon;

          return (
            <div
              key={item._id}
              className="flex items-start gap-2.5 py-2 border-b border-white/[0.03] last:border-0"
            >
              <Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${config.color}`} />
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium">{item.title}</p>
                {item.description && (
                  <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-1">
                    {item.description}
                  </p>
                )}
              </div>
              <span className="text-[9px] text-muted-foreground shrink-0">
                {formatRelativeTime(item.timestamp)}
              </span>
            </div>
          );
        })}
      </div>
    </GlassCard>
  );
}
