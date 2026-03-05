"use client";

import { motion } from "framer-motion";
import { staggerContainer, staggerItem } from "@/lib/motion";
import { cn } from "@/lib/utils";

interface StaggerGridProps {
  children: React.ReactNode;
  className?: string;
  columns?: string;
}

export function StaggerGrid({
  children,
  className,
  columns = "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
}: StaggerGridProps) {
  return (
    <motion.div
      variants={staggerContainer}
      initial="initial"
      animate="animate"
      className={cn("grid gap-4", columns, className)}
    >
      {children}
    </motion.div>
  );
}

export function StaggerItem({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <motion.div variants={staggerItem} className={className}>
      {children}
    </motion.div>
  );
}
