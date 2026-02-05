"use client";

import * as React from "react";
import { Check, AlertTriangle, Info, Shield } from "lucide-react";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ScopeDefinition, ScopeRiskLevel } from "@/lib/scopes";

interface ScopeCheckboxProps {
  scope: ScopeDefinition;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}

function getRiskColor(risk: ScopeRiskLevel): string {
  switch (risk) {
    case "high":
      return "text-red-500";
    case "medium":
      return "text-yellow-500";
    default:
      return "text-green-500";
  }
}

function getRiskBadgeVariant(risk: ScopeRiskLevel): "destructive" | "warning" | "secondary" {
  switch (risk) {
    case "high":
      return "destructive";
    case "medium":
      return "warning";
    default:
      return "secondary";
  }
}

function RiskIcon({ risk }: { risk: ScopeRiskLevel }) {
  const colorClass = getRiskColor(risk);
  switch (risk) {
    case "high":
      return <AlertTriangle className={cn("h-3.5 w-3.5", colorClass)} />;
    case "medium":
      return <Info className={cn("h-3.5 w-3.5", colorClass)} />;
    default:
      return <Shield className={cn("h-3.5 w-3.5", colorClass)} />;
  }
}

export function ScopeCheckbox({
  scope,
  checked,
  disabled,
  onCheckedChange,
}: ScopeCheckboxProps) {
  const isDisabled = disabled || scope.required;

  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-lg border p-3 transition-colors",
        checked ? "border-primary/40 bg-primary/5" : "border-border",
        isDisabled && "opacity-60"
      )}
    >
      <Checkbox
        id={`scope-${scope.id}`}
        checked={checked}
        disabled={isDisabled}
        onCheckedChange={onCheckedChange}
        className="mt-0.5"
      />
      <div className="flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <label
            htmlFor={`scope-${scope.id}`}
            className={cn(
              "text-sm font-medium leading-none cursor-pointer",
              isDisabled && "cursor-not-allowed"
            )}
          >
            {scope.label}
          </label>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <RiskIcon risk={scope.risk} />
                </span>
              </TooltipTrigger>
              <TooltipContent>
                <p className="capitalize">{scope.risk} risk permission</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          {scope.required && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
              Required
            </Badge>
          )}
          {scope.recommended && !scope.required && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
              Recommended
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{scope.description}</p>
        {scope.examples && scope.examples.length > 0 && checked && (
          <div className="mt-2 flex flex-wrap gap-1">
            {scope.examples.slice(0, 3).map((example) => (
              <Badge
                key={example}
                variant="outline"
                className="text-[10px] font-normal"
              >
                {example}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default ScopeCheckbox;
