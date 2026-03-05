"use client";

import { Suspense } from "react";
import { motion } from "framer-motion";
import { pageTransition } from "@/lib/motion";
import { PageHeader } from "@/components/ui/page-header";
import { TabBar, useTab } from "@/components/tab-bar";
import { KnowledgeBase } from "@/components/knowledge-base";
import { EcosystemView } from "@/components/ecosystem-view";
import { SkeletonCard } from "@/components/ui/skeleton-card";
import { Brain, Package } from "lucide-react";

const tabs = [
  { id: "knowledge", label: "Knowledge", icon: Brain },
  { id: "ecosystem", label: "Ecosystem", icon: Package },
];

function KnowledgeContent() {
  const activeTab = useTab(tabs, "knowledge");

  return (
    <>
      <div className="mb-4">
        <TabBar tabs={tabs} defaultTab="knowledge" layoutId="knowledge-tabs" />
      </div>
      {activeTab === "knowledge" && <KnowledgeBase />}
      {activeTab === "ecosystem" && <EcosystemView />}
    </>
  );
}

export default function KnowledgePage() {
  return (
    <motion.div
      variants={pageTransition}
      initial="initial"
      animate="animate"
      exit="exit"
      className="px-3 sm:px-4 lg:px-6 py-4"
    >
      <PageHeader title="Knowledge" description="Search workspace and explore the ecosystem" />
      <Suspense fallback={<SkeletonCard lines={5} />}>
        <KnowledgeContent />
      </Suspense>
    </motion.div>
  );
}
