import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold tracking-wide transition-colors",
  {
    variants: {
      variant: {
        default:
          "border-[color:var(--line-soft)] bg-[color:var(--bg-surface)] text-[color:var(--text-primary)]",
        cyan: "border-[#59b9c6] bg-[#e8f7f9] text-[#286f79]",
        emerald: "border-[#b9d08b] bg-[#f2f8e8] text-[#536f2a]",
        violet: "border-[#7058a3] bg-[#efe9f8] text-[#4e327f]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}
