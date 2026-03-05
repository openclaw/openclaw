"use client";

import { GlassCard } from "@/components/ui/glass-card";
import { EmptyState } from "@/components/ui/empty-state";
import { StaggerGrid, StaggerItem } from "@/components/ui/stagger-grid";
import { MessageCircle, Bell, Radio as RadioIcon } from "lucide-react";

export function CommsView() {
  return (
    <StaggerGrid columns="grid-cols-1 lg:grid-cols-2">
      <StaggerItem>
        <GlassCard>
          <div className="flex items-center gap-2 mb-4">
            <MessageCircle className="w-4 h-4 text-primary" />
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              WhatsApp Messages
            </h3>
          </div>
          <EmptyState
            icon={MessageCircle}
            title="WhatsApp integration active"
            description="Messages flow through Jaum via the WhatsApp channel. View conversation history in the Chat tab."
          />
        </GlassCard>
      </StaggerItem>

      <StaggerItem>
        <GlassCard>
          <div className="flex items-center gap-2 mb-4">
            <RadioIcon className="w-4 h-4 text-primary" />
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Discord Digest
            </h3>
          </div>
          <EmptyState
            icon={RadioIcon}
            title="No Discord connected"
            description="Connect a Discord channel to see message digests here."
          />
        </GlassCard>
      </StaggerItem>

      <StaggerItem className="lg:col-span-2">
        <GlassCard>
          <div className="flex items-center gap-2 mb-4">
            <Bell className="w-4 h-4 text-primary" />
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Notification History
            </h3>
          </div>
          <div className="space-y-2">
            {[
              { time: "9:08 AM", agent: "Jaum", message: "Daily standup summary sent via WhatsApp", type: "info" },
              { time: "7:08 AM", agent: "Jaum", message: "Morning nudge: Resume reviews overdue (Henry 90, Zapier 79)", type: "warning" },
              { time: "Yesterday", agent: "Apply", message: "Henry Schein FP&A application approved — submitting", type: "success" },
              { time: "Mar 3", agent: "Scout", message: "Capital One Director Analytics NYC (75) added to pipeline", type: "info" },
            ].map((n, i) => (
              <div key={i} className="flex items-start gap-3 py-2 border-b border-white/[0.03] last:border-0">
                <span className="text-[10px] text-muted-foreground font-mono w-16 shrink-0">{n.time}</span>
                <div>
                  <p className="text-[11px]">
                    <span className="font-medium text-primary">{n.agent}</span>
                    {" — "}
                    {n.message}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </GlassCard>
      </StaggerItem>
    </StaggerGrid>
  );
}
