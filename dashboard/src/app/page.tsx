"use client";

import { Suspense } from "react";
import { motion } from "framer-motion";
import { pageTransition } from "@/lib/motion";
import { PageHeader } from "@/components/ui/page-header";
import { DashboardOverview } from "@/components/dashboard-overview";
import { SkeletonCard } from "@/components/ui/skeleton-card";

export default function HomePage() {
  return (
    <motion.div
      variants={pageTransition}
      initial="initial"
      animate="animate"
      exit="exit"
      className="px-3 sm:px-4 lg:px-6 py-4"
    >
      <PageHeader
        title="Mission Control"
        description="OpenClaw agent system overview"
      />
      <Suspense
        fallback={
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        }
      >
        <DashboardOverview />
      </Suspense>
    </motion.div>
  );
}
