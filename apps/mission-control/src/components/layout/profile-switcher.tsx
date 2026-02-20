"use client";

import { useProfiles, type Profile } from "@/lib/hooks/use-profiles";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Check, ChevronDown, Settings } from "lucide-react";

// ---------------------------------------------------------------------------
// Color map – maps profile color names to Tailwind background classes
// ---------------------------------------------------------------------------

const COLOR_MAP: Record<string, string> = {
  blue: "bg-blue-500",
  emerald: "bg-emerald-500",
  amber: "bg-amber-500",
  rose: "bg-rose-500",
  violet: "bg-violet-500",
  cyan: "bg-cyan-500",
  orange: "bg-orange-500",
  slate: "bg-slate-500",
};

// ---------------------------------------------------------------------------
// Size map for the avatar circle
// ---------------------------------------------------------------------------

const SIZE_MAP: Record<"sm" | "md" | "lg", string> = {
  sm: "w-7 h-7 text-xs",
  md: "w-9 h-9 text-sm",
  lg: "w-12 h-12 text-lg",
};

// ---------------------------------------------------------------------------
// ProfileAvatar
// ---------------------------------------------------------------------------

export function ProfileAvatar({
  profile,
  size = "md",
}: {
  profile: Profile;
  size?: "sm" | "md" | "lg";
}) {
  const bg = COLOR_MAP[profile.avatar_color] ?? "bg-slate-500";

  return (
    <span
      className={`${bg} ${SIZE_MAP[size]} rounded-full flex items-center justify-center text-white select-none shrink-0`}
    >
      {profile.avatar_emoji}
    </span>
  );
}

// ---------------------------------------------------------------------------
// ProfileSwitcher
// ---------------------------------------------------------------------------

export function ProfileSwitcher({
  onManageProfiles,
}: {
  onManageProfiles: () => void;
}) {
  const { profiles, activeProfile, setActiveProfileId } = useProfiles();

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className="flex items-center gap-2 rounded px-2 py-1.5 text-sm font-medium text-muted-foreground hover:text-primary hover:bg-primary/5 transition-all"
        >
          {activeProfile && <ProfileAvatar profile={activeProfile} size="sm" />}
          <span className="hidden sm:inline truncate max-w-[120px]">
            {activeProfile?.name ?? "Select profile"}
          </span>
          <ChevronDown className="w-3.5 h-3.5 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-72 rounded-lg border border-border bg-card p-0 shadow-xl"
      >
        {/* Header */}
        <div className="px-4 pt-4 pb-3 border-b border-border">
          <h3 className="text-sm font-semibold tracking-wide">
            Switch Account
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Both accounts run in the background
          </p>
        </div>

        {/* Profile list */}
        <div className="py-1.5">
          {profiles.map((profile) => {
            const isActive = activeProfile?.id === profile.id;

            return (
              <button
                key={profile.id}
                onClick={() => setActiveProfileId(profile.id)}
                className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                  isActive
                    ? "bg-primary/5 text-primary"
                    : "text-foreground hover:bg-muted/60"
                }`}
              >
                <ProfileAvatar profile={profile} size="sm" />

                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{profile.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {profile.workspaces.length}{" "}
                    {profile.workspaces.length === 1
                      ? "workspace"
                      : "workspaces"}
                  </p>
                </div>

                {isActive && (
                  <Check className="w-4 h-4 shrink-0 text-primary" />
                )}
              </button>
            );
          })}
        </div>

        {/* Footer */}
        <div className="border-t border-border px-4 py-2.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={onManageProfiles}
            className="w-full justify-start gap-2 text-muted-foreground hover:text-primary"
          >
            <Settings className="w-4 h-4" />
            Manage Profiles
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
