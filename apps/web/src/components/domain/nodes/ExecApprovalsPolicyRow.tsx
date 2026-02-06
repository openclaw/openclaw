/**
 * ExecApprovalsPolicyRow - a compact row showing a policy field (Security, Ask,
 * Ask Fallback, Auto-allow) with its effective value and inherited indicator.
 *
 * When editing, it shows a select with "Use default (value)" as first option.
 */

import { cn } from "@/lib/utils";
import { InheritedBadge } from "./InheritedValue";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

// ---------------------------------------------------------------------------
// Select-based policy row
// ---------------------------------------------------------------------------

interface PolicySelectRowProps {
  label: string;
  description: string;
  /** The value set directly on this scope (undefined = inherited). */
  value: string | undefined;
  /** The resolved default value. */
  defaultValue: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string | undefined) => void;
  editing?: boolean;
}

export function PolicySelectRow({
  label,
  description,
  value,
  defaultValue,
  options,
  onChange,
  editing = false,
}: PolicySelectRowProps) {
  const inherited = value === undefined;
  const effectiveValue = value ?? defaultValue;
  const effectiveLabel =
    options.find((o) => o.value === effectiveValue)?.label ?? effectiveValue;

  if (!editing) {
    return (
      <div className="flex items-center justify-between py-2.5 px-1 group">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">{label}</div>
          <div className="text-xs text-muted-foreground">{description}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span
            className={cn(
              "text-sm",
              inherited ? "text-foreground/70" : "text-foreground font-medium",
            )}
          >
            {effectiveLabel}
          </span>
          {inherited && <InheritedBadge />}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between py-2.5 px-1">
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{label}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
      <Select
        value={inherited ? "__default__" : value}
        onValueChange={(v) =>
          onChange(v === "__default__" ? undefined : v)
        }
      >
        <SelectTrigger className="w-[180px] h-8 text-sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__default__">
            Use default ({options.find((o) => o.value === defaultValue)?.label ?? defaultValue})
          </SelectItem>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toggle-based policy row
// ---------------------------------------------------------------------------

interface PolicyToggleRowProps {
  label: string;
  description: string;
  value: boolean | undefined;
  defaultValue: boolean;
  onChange: (value: boolean | undefined) => void;
  editing?: boolean;
}

export function PolicyToggleRow({
  label,
  description,
  value,
  defaultValue,
  onChange,
  editing = false,
}: PolicyToggleRowProps) {
  const inherited = value === undefined;
  const effectiveValue = value ?? defaultValue;

  return (
    <div className="flex items-center justify-between py-2.5 px-1">
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{label}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {!editing && inherited && <InheritedBadge />}
        <Switch
          checked={effectiveValue}
          onCheckedChange={(checked) => {
            if (!editing) return;
            // If toggling back to the default value, clear the override
            if (checked === defaultValue) {
              onChange(undefined);
            } else {
              onChange(checked);
            }
          }}
          disabled={!editing}
        />
      </div>
    </div>
  );
}
