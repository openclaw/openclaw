"use client";

import { Suspense } from "react";
import { motion } from "framer-motion";
import { pageTransition } from "@/lib/motion";
import { PageHeader } from "@/components/ui/page-header";
import { CodePipeline } from "@/components/code-pipeline";
import { SkeletonCard } from "@/components/ui/skeleton-card";

export default function CodePage() {
  return (
    <motion.div
      variants={pageTransition}
      initial="initial"
      animate="animate"
      exit="exit"
      className="px-3 sm:px-4 lg:px-6 py-4"
    >
      <PageHeader title="Code" description="Repository pipeline and git status" />
      <Suspense fallback={<SkeletonCard lines={5} />}>
        <CodePipeline />
      </Suspense>
    </motion.div>
  );
}
