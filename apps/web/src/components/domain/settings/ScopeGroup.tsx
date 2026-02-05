"use client";

import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScopeCheckbox } from "./ScopeCheckbox";
import type { ScopeCategory, ScopeDefinition } from "@/lib/scopes";

interface ScopeGroupProps {
  category: ScopeCategory;
  scopes: ScopeDefinition[];
  selectedScopes: Set<string>;
  onScopeChange: (scopeId: string, checked: boolean) => void;
  defaultCollapsed?: boolean;
}

export function ScopeGroup({
  category,
  scopes,
  selectedScopes,
  onScopeChange,
  defaultCollapsed,
}: ScopeGroupProps) {
  const [isCollapsed, setIsCollapsed] = React.useState(
    defaultCollapsed ?? category.collapsed ?? false
  );

  // Count selected scopes in this category
  const selectedCount = scopes.filter((s) => selectedScopes.has(s.id)).length;
  const totalCount = scopes.length;

  // Check if all scopes are selected
  const allSelected = selectedCount === totalCount;
  const someSelected = selectedCount > 0 && !allSelected;

  const handleToggleAll = () => {
    const newValue = !allSelected;
    for (const scope of scopes) {
      if (!scope.required) {
        onScopeChange(scope.id, newValue);
      }
    }
  };

  return (
    <div className="rounded-lg border border-border">
      <button
        type="button"
        onClick={() => setIsCollapsed(!isCollapsed)}
        className={cn(
          "flex w-full items-center justify-between gap-2 p-3 text-left transition-colors",
          "hover:bg-muted/50",
          !isCollapsed && "border-b border-border"
        )}
      >
        <div className="flex items-center gap-2">
          {isCollapsed ? (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
          <span className="text-sm font-medium">{category.label}</span>
          {category.description && (
            <span className="text-xs text-muted-foreground">
              {category.description}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {selectedCount}/{totalCount}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              handleToggleAll();
            }}
            className="h-6 px-2 text-xs"
          >
            {allSelected ? "Deselect all" : someSelected ? "Select all" : "Select all"}
          </Button>
        </div>
      </button>

      {!isCollapsed && (
        <div className="space-y-2 p-3">
          {scopes.map((scope) => (
            <ScopeCheckbox
              key={scope.id}
              scope={scope}
              checked={selectedScopes.has(scope.id)}
              onCheckedChange={(checked) => onScopeChange(scope.id, checked)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default ScopeGroup;
