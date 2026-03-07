import * as React from "react";
import { cn } from "@/lib/utils";

export function Badge({
  className,
  variant,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { variant?: "secondary" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-white/10 px-2 py-1 text-xs",
        variant === "secondary" ? "bg-slate-950/35 text-slate-100" : "bg-yellow-300/10 text-yellow-100",
        className
      )}
      {...props}
    />
  );
}
