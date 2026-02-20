import { Heart, MessageSquare, ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const upcomingFeatures = [
  "Employee directory and profiles",
  "Hiring pipeline and applicant tracking",
  "Attendance tracking and leave management",
  "Performance reviews and goal setting",
];

export function HRPage() {
  return (
    <div className="space-y-6 max-w-2xl">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center"
          style={{
            backgroundColor:
              "color-mix(in srgb, var(--accent-purple) 15%, var(--bg-card))",
          }}
        >
          <Heart className="w-5 h-5 text-[var(--accent-purple)]" />
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-[var(--text-primary)]">
              HR
            </h1>
            <Badge
              variant="outline"
              className="border-[var(--accent-purple)]/30 text-[var(--accent-purple)] text-[10px]"
            >
              Coming Soon
            </Badge>
          </div>
          <p className="text-sm text-[var(--text-secondary)] mt-0.5">
            Workforce management and employee engagement
          </p>
        </div>
      </div>

      {/* Description card */}
      <Card className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-[var(--text-secondary)]">
            About this Module
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-[var(--text-primary)] leading-relaxed">
            Workforce management, hiring pipelines, and employee engagement.
          </p>
          <p className="text-sm text-[var(--text-muted)] mt-3 leading-relaxed">
            While this module is under development, you can interact with the{" "}
            <span className="text-[var(--accent-purple)] font-medium">
              HR (Harbor)
            </span>{" "}
            agent through the chat panel for workforce queries and operations.
          </p>
        </CardContent>
      </Card>

      {/* Upcoming features */}
      <Card className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-[var(--text-secondary)]">
            Upcoming Features
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-3">
            {upcomingFeatures.map((feature) => (
              <li key={feature} className="flex items-center gap-3">
                <ChevronRight className="w-4 h-4 text-[var(--accent-purple)] shrink-0" />
                <span className="text-sm text-[var(--text-primary)]">
                  {feature}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {/* Chat CTA */}
      <Card className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none">
        <CardContent className="py-4">
          <div className="flex items-center gap-3">
            <div
              className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
              style={{
                backgroundColor:
                  "color-mix(in srgb, var(--accent-green) 15%, var(--bg-card))",
              }}
            >
              <MessageSquare className="w-4 h-4 text-[var(--accent-green)]" />
            </div>
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)]">
                Use the Chat Panel
              </p>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                Open the chat panel and ask the HR (Harbor) agent about
                employees, hiring, or attendance.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
