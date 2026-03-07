import * as React from "react";
import { cn } from "@/lib/utils";

export function Avatar(props: React.HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cn("grid place-items-center overflow-hidden rounded-full", props.className)} />;
}

export function AvatarFallback(props: React.HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cn("grid h-full w-full place-items-center", props.className)} />;
}
