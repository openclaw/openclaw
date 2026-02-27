import { Megaphone, MessageSquare, ChevronRight, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAgents } from "@/hooks/useAgents";
import type { AgentListResponse } from "@/lib/types";

const BUSINESS_ID = "vividwalls";
const ACCENT = "#ec4899";

const upcomingFeatures = [
  "Campaign planning and scheduling",
  "Content creation workflows",
  "Audience segmentation and targeting",
  "Marketing performance analytics",
];

export function MarketingPage() {
  const { data: agentsRaw } = useAgents(BUSINESS_ID);

  const agentsResponse = agentsRaw as AgentListResponse | undefined;
  const relatedAgents = agentsResponse?.agents?.filter(
    (a) => a.id.includes("marketing") || a.id.includes("creative"),
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center"
          style={{
            backgroundColor: `color-mix(in srgb, ${ACCENT} 15%, var(--bg-card))`,
          }}
        >
          <Megaphone className="w-5 h-5" style={{ color: ACCENT }} />
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-[var(--text-primary)]">Marketing</h1>
            <Badge
              variant="outline"
              className="text-[10px]"
              style={{
                borderColor: `color-mix(in srgb, ${ACCENT} 30%, transparent)`,
                color: ACCENT,
              }}
            >
              Coming Soon
            </Badge>
          </div>
          <p className="text-sm text-[var(--text-secondary)] mt-0.5">
            Campaigns, content creation, and audience targeting
          </p>
        </div>
      </div>

      {/* Relevant Agent Status */}
      {relatedAgents && relatedAgents.length > 0 && (
        <Card className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-[var(--text-secondary)] flex items-center gap-2">
              <Users className="w-4 h-4" />
              Related Agents
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {relatedAgents.map((agent) => (
                <div
                  key={agent.id}
                  className="flex items-center gap-3 p-3 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-mabos)]"
                >
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{
                      backgroundColor:
                        agent.status === "active"
                          ? "var(--accent-green)"
                          : agent.status === "error"
                            ? "var(--accent-red)"
                            : "var(--accent-orange)",
                    }}
                  />
                  <div className="min-w-0">
                    <p className="text-sm text-[var(--text-primary)] truncate">{agent.name}</p>
                    <p className="text-[10px] text-[var(--text-muted)] capitalize">
                      {agent.status} - {agent.beliefs} beliefs, {agent.goals} goals
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="max-w-2xl space-y-6">
        {/* Description card */}
        <Card className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-[var(--text-secondary)]">
              About this Module
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-[var(--text-primary)] leading-relaxed">
              Plan campaigns, create content, and target audiences to grow your brand presence.
            </p>
            <p className="text-sm text-[var(--text-muted)] mt-3 leading-relaxed">
              While this module is under development, you can interact with the{" "}
              <span className="font-medium" style={{ color: ACCENT }}>
                Marketing Director
              </span>{" "}
              agent through the chat panel for marketing-related queries and operations.
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
                  <ChevronRight className="w-4 h-4 shrink-0" style={{ color: ACCENT }} />
                  <span className="text-sm text-[var(--text-primary)]">{feature}</span>
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
                  backgroundColor: "color-mix(in srgb, var(--accent-green) 15%, var(--bg-card))",
                }}
              >
                <MessageSquare className="w-4 h-4 text-[var(--accent-green)]" />
              </div>
              <div>
                <p className="text-sm font-medium text-[var(--text-primary)]">Use the Chat Panel</p>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">
                  Open the chat panel and ask the Marketing Director agent about campaigns, content,
                  or audience targeting.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
