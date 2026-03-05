"use client";

import { motion } from "framer-motion";
import { pageTransition } from "@/lib/motion";
import { EmptyState } from "@/components/ui/empty-state";
import { FileQuestion } from "lucide-react";
import Link from "next/link";

export default function NotFound() {
  return (
    <motion.div
      variants={pageTransition}
      initial="initial"
      animate="animate"
      className="px-3 sm:px-4 lg:px-6 py-20"
    >
      <EmptyState
        icon={FileQuestion}
        title="Page not found"
        description="The page you're looking for doesn't exist."
        action={
          <Link
            href="/"
            className="px-4 py-2 text-xs font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/80 transition-colors"
          >
            Back to Mission Control
          </Link>
        }
      />
    </motion.div>
  );
}
