"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { DecisionCard } from "./DecisionCard";
import type { DecisionAuditEntry } from "./decision-types";

interface DecisionTimelineProps {
  decisions: DecisionAuditEntry[];
  onViewDetails: (decision: DecisionAuditEntry) => void;
  className?: string;
}

/**
 * Groups decisions by date for the timeline view.
 */
function groupByDate(decisions: DecisionAuditEntry[]): Map<string, DecisionAuditEntry[]> {
  const groups = new Map<string, DecisionAuditEntry[]>();

  for (const decision of decisions) {
    const date = new Date(decision.timestamp);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    let key: string;
    if (date.toDateString() === today.toDateString()) {
      key = "Today";
    } else if (date.toDateString() === yesterday.toDateString()) {
      key = "Yesterday";
    } else {
      key = date.toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
      });
    }

    const existing = groups.get(key) || [];
    existing.push(decision);
    groups.set(key, existing);
  }

  return groups;
}

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.05 },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 10 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { type: "spring", stiffness: 400, damping: 30 },
  },
};

export function DecisionTimeline({ decisions, onViewDetails, className }: DecisionTimelineProps) {
  const grouped = React.useMemo(() => groupByDate(decisions), [decisions]);

  return (
    <div className={cn("space-y-6", className)}>
      <AnimatePresence mode="popLayout">
        {Array.from(grouped.entries()).map(([dateLabel, items]) => (
          <motion.div
            key={dateLabel}
            variants={containerVariants}
            initial="hidden"
            animate="visible"
            exit={{ opacity: 0, y: -10 }}
          >
            {/* Date Header */}
            <div className="flex items-center gap-3 mb-3">
              <div className="h-px flex-1 bg-border" />
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                {dateLabel}
              </span>
              <span className="text-xs text-muted-foreground">
                ({items.length} decision{items.length !== 1 ? "s" : ""})
              </span>
              <div className="h-px flex-1 bg-border" />
            </div>

            {/* Decision Cards */}
            <div className="space-y-2">
              {items.map((decision) => (
                <motion.div key={decision.id} variants={itemVariants} layout>
                  <DecisionCard
                    decision={decision}
                    onViewDetails={onViewDetails}
                  />
                </motion.div>
              ))}
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
