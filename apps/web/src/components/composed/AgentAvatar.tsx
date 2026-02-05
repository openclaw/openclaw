"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export type AgentAvatarSize = "xs" | "sm" | "md" | "lg" | "xl";
export type AgentAvatarStatus = "active" | "ready" | "busy" | "paused" | "offline";

export interface AgentAvatarProps {
  /** Agent name (used for initials and color generation) */
  name: string;
  /** Optional avatar image URL */
  avatarUrl?: string;
  /** Size variant */
  size?: AgentAvatarSize;
  /** Status indicator */
  status?: AgentAvatarStatus;
  /** Additional CSS classes */
  className?: string;
  /** Whether to show the status dot */
  showStatus?: boolean;
}

const sizeClasses: Record<AgentAvatarSize, string> = {
  xs: "h-6 w-6 text-[10px]",
  sm: "h-8 w-8 text-xs",
  md: "h-12 w-12 text-sm",
  lg: "h-16 w-16 text-base",
  xl: "h-24 w-24 text-xl",
};

const statusColors: Record<AgentAvatarStatus, string> = {
  active: "bg-green-500",
  ready: "bg-green-500",
  busy: "bg-green-500",
  paused: "bg-orange-500",
  offline: "bg-muted-foreground/50",
};

const statusDotSizes: Record<AgentAvatarSize, string> = {
  xs: "h-1.5 w-1.5 ring-1",
  sm: "h-2 w-2 ring-2",
  md: "h-2.5 w-2.5 ring-2",
  lg: "h-3 w-3 ring-2",
  xl: "h-4 w-4 ring-[3px]",
};

// Ring sizes for the prominent outer ring
const ringPadding: Record<AgentAvatarSize, string> = {
  xs: "p-0.5",
  sm: "p-1",
  md: "p-1.5",
  lg: "p-2",
  xl: "p-3",
};

// Ring thickness for different states
const ringThickness: Record<AgentAvatarSize, string> = {
  xs: "ring-2",
  sm: "ring-2",
  md: "ring-[3px]",
  lg: "ring-4",
  xl: "ring-[5px]",
};

/**
 * Extract initials from a name (max 2 characters)
 */
function getInitials(name: string): string {
  return name
    .split(" ")
    .map((word) => word[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

/**
 * Generate a deterministic color class based on the name
 */
function getColorFromName(name: string): string {
  const colors = [
    "bg-chart-1/15 text-chart-1",
    "bg-chart-2/15 text-chart-2",
    "bg-chart-3/15 text-chart-3",
    "bg-chart-4/20 text-chart-4",
    "bg-chart-5/15 text-chart-5",
    "bg-primary/15 text-primary",
    "bg-accent/15 text-accent",
  ];

  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

export const AgentAvatar = React.memo(function AgentAvatar({
  name,
  avatarUrl,
  size = "md",
  status,
  className,
  showStatus = true,
}: AgentAvatarProps) {
  const [imageError, setImageError] = React.useState(false);
  const showImage = avatarUrl && !imageError;

  // Determine if we should show the prominent animated ring
  const isBusy = status === "busy" || status === "active";

  return (
    <div className={cn("relative inline-flex shrink-0", className)}>
      {/* Outer prominent ring container */}
      <div
        className={cn(
          "relative rounded-full transition-all duration-300",
          ringPadding[size],
          // Prominent ring styles
          isBusy && [
            "ring-green-500/60 bg-green-500/10",
            ringThickness[size],
            "animate-[spin_3s_linear_infinite]",
          ],
          !isBusy && showStatus && status && [
            "ring-muted/30",
            "ring-2",
          ]
        )}
      >
        {/* Avatar circle */}
        <div
          className={cn(
            "flex items-center justify-center font-medium overflow-hidden rounded-full",
            sizeClasses[size],
            !showImage && getColorFromName(name),
            // Add subtle pulse for busy state
            isBusy && "ring-2 ring-green-500 ring-offset-2 ring-offset-background"
          )}
        >
          {showImage ? (
            <img
              src={avatarUrl}
              alt={name}
              className="h-full w-full object-cover"
              onError={() => setImageError(true)}
            />
          ) : (
            getInitials(name)
          )}
        </div>

        {/* Status dot indicator */}
        {showStatus && status && (
          <span
            className={cn(
              "absolute -bottom-0.5 -right-0.5 rounded-full ring-background",
              statusDotSizes[size],
              statusColors[status],
              status === "active" && "animate-pulse"
            )}
            aria-label={`Status: ${status}`}
          />
        )}
      </div>
    </div>
  );
});

export default AgentAvatar;
