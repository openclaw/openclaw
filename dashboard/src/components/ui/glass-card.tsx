"use client";

import { cn } from "@/lib/utils";
import { motion, type HTMLMotionProps } from "framer-motion";
import { forwardRef } from "react";

interface GlassCardProps extends HTMLMotionProps<"div"> {
  hover?: boolean;
  padding?: "sm" | "md" | "lg" | "none";
}

export const GlassCard = forwardRef<HTMLDivElement, GlassCardProps>(
  ({ className, hover = false, padding = "md", children, ...props }, ref) => {
    const paddingClass = {
      none: "",
      sm: "p-3",
      md: "p-4 sm:p-5",
      lg: "p-5 sm:p-6",
    }[padding];

    return (
      <motion.div
        ref={ref}
        className={cn(
          "glass-card",
          hover && "glass-card-hover cursor-pointer transition-all duration-200",
          paddingClass,
          className
        )}
        {...props}
      >
        {children}
      </motion.div>
    );
  }
);
GlassCard.displayName = "GlassCard";
