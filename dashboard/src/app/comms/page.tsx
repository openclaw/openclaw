"use client";

import { Suspense } from "react";
import { motion } from "framer-motion";
import { pageTransition } from "@/lib/motion";
import { PageHeader } from "@/components/ui/page-header";
import { TabBar, useTab } from "@/components/tab-bar";
import { CommsView } from "@/components/comms-view";
import { CrmView } from "@/components/crm-view";
import { SkeletonCard } from "@/components/ui/skeleton-card";
import { Radio, Users } from "lucide-react";

const tabs = [
  { id: "comms", label: "Comms", icon: Radio },
  { id: "crm", label: "CRM", icon: Users },
];

function CommsContent() {
  const activeTab = useTab(tabs, "comms");

  return (
    <>
      <div className="mb-4">
        <TabBar tabs={tabs} defaultTab="comms" layoutId="comms-tabs" />
      </div>
      {activeTab === "comms" && <CommsView />}
      {activeTab === "crm" && <CrmView />}
    </>
  );
}

export default function CommsPage() {
  return (
    <motion.div
      variants={pageTransition}
      initial="initial"
      animate="animate"
      exit="exit"
      className="px-3 sm:px-4 lg:px-6 py-4"
    >
      <PageHeader title="Communications" description="Channels, notifications, and client pipeline" />
      <Suspense fallback={<SkeletonCard lines={5} />}>
        <CommsContent />
      </Suspense>
    </motion.div>
  );
}
