import {
  CheckCircle,
  AlertTriangle,
  Zap,
  MessageCircle,
  Target,
  type LucideIcon,
} from "lucide-react";

type ActivityEvent = {
  id: string;
  icon: LucideIcon;
  iconColor: string;
  description: string;
  timestamp: string;
};

const recentActivities: ActivityEvent[] = [
  {
    id: "1",
    icon: Zap,
    iconColor: "var(--accent-green)",
    description: "BDI cycle completed - Atlas CEO evaluated 3 new beliefs",
    timestamp: "2 min ago",
  },
  {
    id: "2",
    icon: CheckCircle,
    iconColor: "var(--accent-blue)",
    description: "Task 'Update brand guidelines' moved to Done by Creative Director",
    timestamp: "8 min ago",
  },
  {
    id: "3",
    icon: Target,
    iconColor: "var(--accent-purple)",
    description: "Product Manager created goal: 'Launch Q2 wallpaper collection'",
    timestamp: "15 min ago",
  },
  {
    id: "4",
    icon: AlertTriangle,
    iconColor: "var(--accent-orange)",
    description: "Inventory Manager flagged low stock on 'Sunset Gradient' design",
    timestamp: "22 min ago",
  },
  {
    id: "5",
    icon: MessageCircle,
    iconColor: "var(--accent-blue)",
    description: "CS Director resolved customer inquiry #1847",
    timestamp: "35 min ago",
  },
  {
    id: "6",
    icon: Zap,
    iconColor: "var(--accent-green)",
    description: "Compass Strategy proposed new market expansion plan",
    timestamp: "1 hr ago",
  },
  {
    id: "7",
    icon: CheckCircle,
    iconColor: "var(--accent-blue)",
    description: "Compliance Director completed regulatory review",
    timestamp: "1.5 hr ago",
  },
  {
    id: "8",
    icon: Target,
    iconColor: "var(--accent-purple)",
    description: "Sales Director updated Q1 revenue forecast",
    timestamp: "2 hr ago",
  },
];

export function RecentActivity() {
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-[var(--text-primary)]">
        Recent Activity
      </h2>
      <div className="relative">
        {/* Timeline line */}
        <div
          className="absolute left-[15px] top-2 bottom-2 w-px"
          style={{ backgroundColor: "var(--border-mabos)" }}
        />

        <div className="space-y-1">
          {recentActivities.map((event) => {
            const Icon = event.icon;
            return (
              <div
                key={event.id}
                className="relative flex items-start gap-4 py-2.5 px-2 rounded-lg hover:bg-[var(--bg-hover)] transition-colors group"
              >
                {/* Icon circle */}
                <div
                  className="relative z-10 flex items-center justify-center w-[30px] h-[30px] rounded-full shrink-0"
                  style={{
                    backgroundColor: `color-mix(in srgb, ${event.iconColor} 15%, var(--bg-primary))`,
                  }}
                >
                  <Icon
                    className="w-3.5 h-3.5"
                    style={{ color: event.iconColor }}
                  />
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0 pt-1">
                  <p className="text-sm text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] transition-colors leading-snug">
                    {event.description}
                  </p>
                </div>

                {/* Timestamp */}
                <span className="text-xs text-[var(--text-muted)] whitespace-nowrap pt-1 shrink-0">
                  {event.timestamp}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
