"use client";

import { Suspense } from "react";
import { motion } from "framer-motion";
import { pageTransition } from "@/lib/motion";
import { PageHeader } from "@/components/ui/page-header";
import { TabBar, useTab } from "@/components/tab-bar";
import { OpsView } from "@/components/ops-view";
import { SuggestedTasksView } from "@/components/suggested-tasks-view";
import { CalendarView } from "@/components/calendar-view";
import { SkeletonCard } from "@/components/ui/skeleton-card";
import { Settings2, ListTodo, Calendar } from "lucide-react";

const tabs = [
  { id: "operations", label: "Operations", icon: Settings2 },
  { id: "tasks", label: "Tasks", icon: ListTodo },
  { id: "calendar", label: "Calendar", icon: Calendar },
];

function OpsContent() {
  const activeTab = useTab(tabs, "operations");

  return (
    <>
      <div className="mb-4">
        <TabBar tabs={tabs} defaultTab="operations" layoutId="ops-tabs" />
      </div>
      {activeTab === "operations" && <OpsView />}
      {activeTab === "tasks" && <SuggestedTasksView />}
      {activeTab === "calendar" && <CalendarView />}
    </>
  );
}

export default function OpsPage() {
  return (
    <motion.div
      variants={pageTransition}
      initial="initial"
      animate="animate"
      exit="exit"
      className="px-3 sm:px-4 lg:px-6 py-4"
    >
      <PageHeader title="Operations" description="System operations, tasks, and scheduling" />
      <Suspense fallback={<SkeletonCard lines={5} />}>
        <OpsContent />
      </Suspense>
    </motion.div>
  );
}
