"use client";

import { Suspense } from "react";
import { motion } from "framer-motion";
import { pageTransition } from "@/lib/motion";
import { PageHeader } from "@/components/ui/page-header";
import { TabBar, useTab } from "@/components/tab-bar";
import { AgentsView } from "@/components/agents-view";
import { ModelsView } from "@/components/models-view";
import { SkeletonCard } from "@/components/ui/skeleton-card";
import { Bot, Cpu } from "lucide-react";

const tabs = [
  { id: "agents", label: "Agents", icon: Bot },
  { id: "models", label: "Models", icon: Cpu },
];

function AgentsContent() {
  const activeTab = useTab(tabs, "agents");

  return (
    <>
      <div className="mb-4">
        <TabBar tabs={tabs} defaultTab="agents" layoutId="agents-tabs" />
      </div>
      {activeTab === "agents" && <AgentsView />}
      {activeTab === "models" && <ModelsView />}
    </>
  );
}

export default function AgentsPage() {
  return (
    <motion.div
      variants={pageTransition}
      initial="initial"
      animate="animate"
      exit="exit"
      className="px-3 sm:px-4 lg:px-6 py-4"
    >
      <PageHeader title="Agents" description="Agent squad and model inventory" />
      <Suspense fallback={<SkeletonCard lines={5} />}>
        <AgentsContent />
      </Suspense>
    </motion.div>
  );
}
