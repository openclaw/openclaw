"use client";

import * as React from "react";
import { Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScopeCheckbox } from "./ScopeCheckbox";
import { ScopeGroup } from "./ScopeGroup";
import {
  getProviderScopes,
  getDefaultScopes,
  expandScopes,
  type ScopeDefinition,
  type ScopePreset,
} from "@/lib/scopes";

interface ScopeSelectorProps {
  providerId: string;
  selectedScopes: string[];
  onScopesChange: (scopes: string[]) => void;
  className?: string;
}

type ViewMode = "presets" | "custom";

export function ScopeSelector({
  providerId,
  selectedScopes,
  onScopesChange,
  className,
}: ScopeSelectorProps) {
  const [viewMode, setViewMode] = React.useState<ViewMode>("presets");
  const [selectedPreset, setSelectedPreset] = React.useState<string | null>(null);

  const providerConfig = getProviderScopes(providerId);

  // Build a set of selected scopes for quick lookup
  const selectedSet = React.useMemo(
    () => new Set(selectedScopes),
    [selectedScopes]
  );

  // Initialize with defaults if no scopes selected
  React.useEffect(() => {
    if (selectedScopes.length === 0) {
      const defaults = getDefaultScopes(providerId);
      if (defaults.length > 0) {
        onScopesChange(defaults);
      }
    }
  }, [providerId, selectedScopes.length, onScopesChange]);

  if (!providerConfig) {
    return (
      <div className={cn("text-sm text-muted-foreground", className)}>
        No scope configuration available for this provider.
      </div>
    );
  }

  const { scopes, categories, presets } = providerConfig;

  const handleScopeChange = (scopeId: string, checked: boolean) => {
    let newScopes: string[];
    if (checked) {
      // Add scope and any implied scopes
      const expanded = expandScopes(providerId, [scopeId]);
      newScopes = [...new Set([...selectedScopes, ...expanded])];
    } else {
      // Remove scope (unless required)
      const scope = scopes.find((s) => s.id === scopeId);
      if (scope?.required) return;
      newScopes = selectedScopes.filter((id) => id !== scopeId);
    }
    onScopesChange(newScopes);
    setSelectedPreset(null); // Clear preset when manually changing scopes
  };

  const handlePresetSelect = (preset: ScopePreset) => {
    setSelectedPreset(preset.id);
    onScopesChange(expandScopes(providerId, preset.scopes));
  };

  const handleSelectAll = () => {
    const allIds = scopes.map((s) => s.id);
    onScopesChange(expandScopes(providerId, allIds));
  };

  const handleSelectDefaults = () => {
    onScopesChange(getDefaultScopes(providerId));
  };

  // Group scopes by category (or show flat list if no categories)
  const hasCategories = categories && categories.length > 0;

  // For flat view, separate required/recommended from others
  const requiredScopes = scopes.filter((s) => s.required);
  const recommendedScopes = scopes.filter((s) => s.recommended && !s.required);
  const optionalScopes = scopes.filter((s) => !s.required && !s.recommended);

  return (
    <div className={cn("space-y-4", className)}>
      {/* View mode toggle and presets */}
      {presets && presets.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex gap-2">
              <Button
                type="button"
                variant={viewMode === "presets" ? "default" : "outline"}
                size="sm"
                onClick={() => setViewMode("presets")}
              >
                <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                Presets
              </Button>
              <Button
                type="button"
                variant={viewMode === "custom" ? "default" : "outline"}
                size="sm"
                onClick={() => setViewMode("custom")}
              >
                Custom
              </Button>
            </div>
            {viewMode === "custom" && (
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleSelectDefaults}
                >
                  Defaults
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleSelectAll}
                >
                  Select all
                </Button>
              </div>
            )}
          </div>

          {viewMode === "presets" && (
            <div className="grid gap-2">
              {presets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => handlePresetSelect(preset)}
                  className={cn(
                    "flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors",
                    selectedPreset === preset.id
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-primary/30"
                  )}
                >
                  <div className="flex w-full items-center justify-between">
                    <span className="text-sm font-medium">{preset.label}</span>
                    <Badge variant="outline" className="text-[10px]">
                      {preset.scopes.length} scopes
                    </Badge>
                  </div>
                  {preset.description && (
                    <span className="text-xs text-muted-foreground">
                      {preset.description}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Custom scope selection */}
      {(viewMode === "custom" || !presets || presets.length === 0) && (
        <div className="space-y-3">
          {hasCategories ? (
            // Grouped view
            categories!.map((category) => {
              const categoryScopes = scopes.filter((s) =>
                category.scopes.includes(s.id)
              );
              if (categoryScopes.length === 0) return null;
              return (
                <ScopeGroup
                  key={category.id}
                  category={category}
                  scopes={categoryScopes}
                  selectedScopes={selectedSet}
                  onScopeChange={handleScopeChange}
                />
              );
            })
          ) : (
            // Flat view with sections
            <>
              {requiredScopes.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Required
                  </p>
                  {requiredScopes.map((scope) => (
                    <ScopeCheckbox
                      key={scope.id}
                      scope={scope}
                      checked={selectedSet.has(scope.id)}
                      onCheckedChange={(checked) =>
                        handleScopeChange(scope.id, checked)
                      }
                    />
                  ))}
                </div>
              )}

              {recommendedScopes.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Recommended
                  </p>
                  {recommendedScopes.map((scope) => (
                    <ScopeCheckbox
                      key={scope.id}
                      scope={scope}
                      checked={selectedSet.has(scope.id)}
                      onCheckedChange={(checked) =>
                        handleScopeChange(scope.id, checked)
                      }
                    />
                  ))}
                </div>
              )}

              {optionalScopes.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Optional
                  </p>
                  {optionalScopes.map((scope) => (
                    <ScopeCheckbox
                      key={scope.id}
                      scope={scope}
                      checked={selectedSet.has(scope.id)}
                      onCheckedChange={(checked) =>
                        handleScopeChange(scope.id, checked)
                      }
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Selected scopes summary */}
      <div className="rounded-lg border border-border bg-muted/30 p-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">
            Selected permissions
          </span>
          <Badge variant="secondary" className="text-[10px]">
            {selectedScopes.length} scope{selectedScopes.length !== 1 ? "s" : ""}
          </Badge>
        </div>
        {selectedScopes.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {selectedScopes.slice(0, 6).map((scopeId) => {
              const scope = scopes.find((s) => s.id === scopeId);
              return (
                <Badge
                  key={scopeId}
                  variant="outline"
                  className="text-[10px] font-normal"
                >
                  {scope?.label ?? scopeId}
                </Badge>
              );
            })}
            {selectedScopes.length > 6 && (
              <Badge variant="outline" className="text-[10px] font-normal">
                +{selectedScopes.length - 6} more
              </Badge>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default ScopeSelector;
