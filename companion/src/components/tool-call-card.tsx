import { useState, useMemo } from "react";
import { ChevronDownIcon, WrenchIcon, Loader2 } from "lucide-react";
import type { ToolCallPart, ToolResultPart } from "@/hooks/use-gateway";
import { cn } from "@/lib/utils";
import { resolveToolDisplay, formatToolDetail } from "@ui/tool-display";

type Props = {
  toolCall: ToolCallPart;
  toolResult?: ToolResultPart;
};

function truncate(str: string, max: number) {
  return str.length > max ? str.slice(0, max) + "…" : str;
}

export function ToolCallCard({ toolCall, toolResult }: Props) {
  const completed = !!toolResult;
  const [open, setOpen] = useState(false);

  const display = useMemo(
    () => resolveToolDisplay({ name: toolCall.name, args: toolCall.args }),
    [toolCall.name, toolCall.args],
  );
  const subtitle = useMemo(() => formatToolDetail(display), [display]);

  const argsStr = typeof toolCall.args === "string"
    ? toolCall.args
    : JSON.stringify(toolCall.args, null, 2);
  const resultStr = toolResult?.content ?? "";

  return (
    <div className="my-2 w-full rounded-md border border-border/60 bg-muted/60">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 p-3"
        onClick={() => setOpen(!open)}
      >
        <div className="flex items-center gap-2 min-w-0">
          {completed
            ? <WrenchIcon className="size-4 shrink-0 text-muted-foreground" />
            : <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
          }
          <span className="text-sm font-medium truncate">{display.label}</span>
          {subtitle && (
            <span className="text-xs text-muted-foreground/60 truncate hidden sm:inline">{subtitle}</span>
          )}
        </div>
        <ChevronDownIcon
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div className="border-t border-border/40 space-y-3 p-3">
          {argsStr && argsStr !== "{}" && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Parameters</p>
              <pre className="text-xs bg-card/60 rounded-md p-2.5 overflow-x-auto whitespace-pre-wrap break-all">
                {truncate(argsStr, 2000)}
              </pre>
            </div>
          )}
          {completed && resultStr && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Result</p>
              <pre className="text-xs bg-card/60 rounded-md p-2.5 overflow-x-auto whitespace-pre-wrap break-all">
                {truncate(resultStr, 2000)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
