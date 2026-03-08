import { cn } from "@/lib/utils";

type StatusColor = "green" | "red" | "yellow" | "blue" | "gray";

interface StatusDotProps {
  color: StatusColor;
  pulse?: boolean;
  size?: "sm" | "md";
  className?: string;
}

const colorMap: Record<StatusColor, string> = {
  green: "bg-emerald-400",
  red: "bg-red-400",
  yellow: "bg-amber-400",
  blue: "bg-blue-400",
  gray: "bg-zinc-500",
};

export function StatusDot({ color, pulse = false, size = "sm", className }: StatusDotProps) {
  const sizeClass = size === "sm" ? "w-1.5 h-1.5" : "w-2 h-2";

  return (
    <span
      className={cn(
        "inline-block rounded-full",
        sizeClass,
        colorMap[color],
        pulse && "animate-pulse-dot",
        className
      )}
    />
  );
}
