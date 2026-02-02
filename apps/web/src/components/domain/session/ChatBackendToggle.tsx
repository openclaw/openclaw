/**
 * Chat Backend Toggle
 * Allows switching between Gateway and Vercel AI backends
 */

import * as React from "react";
import { usePreferencesStore, type ChatBackend } from "@/stores/usePreferencesStore";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Settings2, Check } from "lucide-react";

export interface ChatBackendToggleProps {
  className?: string;
}

const BACKEND_LABELS: Record<ChatBackend, string> = {
  gateway: "Gateway (Current)",
  "vercel-ai": "Vercel AI (Beta)",
};

const BACKEND_DESCRIPTIONS: Record<ChatBackend, string> = {
  gateway: "Production gateway with full feature support",
  "vercel-ai": "Experimental Vercel AI SDK integration",
};

export function ChatBackendToggle({ className }: ChatBackendToggleProps) {
  const { chatBackend, setChatBackend } = usePreferencesStore();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn("flex items-center gap-2", className)}
        >
          <Settings2 className="h-4 w-4" />
          <span className="text-xs hidden sm:inline">Backend</span>
          <Badge variant={chatBackend === "vercel-ai" ? "default" : "secondary"} className="text-[10px]">
            {chatBackend === "vercel-ai" ? "Beta" : "Stable"}
          </Badge>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Chat Backend</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => setChatBackend("gateway")}
          className="flex items-start gap-2 py-3"
        >
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <span className="font-medium">Gateway</span>
              {chatBackend === "gateway" && <Check className="h-4 w-4 text-primary" />}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {BACKEND_DESCRIPTIONS.gateway}
            </p>
          </div>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => setChatBackend("vercel-ai")}
          className="flex items-start gap-2 py-3"
        >
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <span className="font-medium">Vercel AI</span>
              <Badge variant="outline" className="text-[9px] px-1">BETA</Badge>
              {chatBackend === "vercel-ai" && <Check className="h-4 w-4 text-primary" />}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {BACKEND_DESCRIPTIONS["vercel-ai"]}
            </p>
          </div>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <div className="px-2 py-2">
          <p className="text-[10px] text-muted-foreground">
            Changes take effect immediately. Session history is maintained separately per backend.
          </p>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
