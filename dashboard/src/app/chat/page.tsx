"use client";

import { Suspense } from "react";
import { motion } from "framer-motion";
import { pageTransition } from "@/lib/motion";
import { PageHeader } from "@/components/ui/page-header";
import { TabBar, useTab } from "@/components/tab-bar";
import { ChatCenterView } from "@/components/chat-center-view";
import { GlassCard } from "@/components/ui/glass-card";
import { SkeletonCard } from "@/components/ui/skeleton-card";
import { MessageSquare, Terminal, Play, RefreshCw, Zap, Activity } from "lucide-react";

const tabs = [
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "command", label: "Command", icon: Terminal },
];

function CommandView() {
  const commands = [
    { label: "Trigger All Heartbeats", icon: Activity, description: "Wake all agents and run heartbeat checks" },
    { label: "Run Scout Scrape", icon: Play, description: "Trigger HiringCafe + LinkedIn job scrape" },
    { label: "Restart Gateway", icon: RefreshCw, description: "Restart the OpenClaw gateway process" },
    { label: "Compile Daily Summary", icon: Zap, description: "Have Jaum compile and send daily summary" },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-2xl">
      {commands.map((cmd) => (
        <GlassCard key={cmd.label} hover padding="md" className="cursor-pointer">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-lg bg-primary/[0.08]">
              <cmd.icon className="w-4 h-4 text-primary" />
            </div>
            <div>
              <p className="text-xs font-semibold">{cmd.label}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">{cmd.description}</p>
            </div>
          </div>
        </GlassCard>
      ))}
    </div>
  );
}

function ChatContent() {
  const activeTab = useTab(tabs, "chat");

  return (
    <>
      <div className="mb-4">
        <TabBar tabs={tabs} defaultTab="chat" layoutId="chat-tabs" />
      </div>
      {activeTab === "chat" && <ChatCenterView />}
      {activeTab === "command" && <CommandView />}
    </>
  );
}

export default function ChatPage() {
  return (
    <motion.div
      variants={pageTransition}
      initial="initial"
      animate="animate"
      exit="exit"
      className="px-3 sm:px-4 lg:px-6 py-4"
    >
      <PageHeader title="Chat" description="Communicate with your agents" />
      <Suspense fallback={<SkeletonCard lines={5} />}>
        <ChatContent />
      </Suspense>
    </motion.div>
  );
}
