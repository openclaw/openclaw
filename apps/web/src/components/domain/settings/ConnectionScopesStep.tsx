"use client";

import * as React from "react";
import { ScopeSelector } from "./ScopeSelector";
import { getProviderScopes, getDefaultScopes } from "@/lib/scopes";

interface ConnectionScopesStepProps {
  providerId: string;
  selectedScopes: string[];
  onScopesChange: (scopes: string[]) => void;
  connectionName: string;
}

/**
 * Scope selection step for the connection wizard.
 * Shows when the selected auth method is OAuth.
 */
export function ConnectionScopesStep({
  providerId,
  selectedScopes,
  onScopesChange,
  connectionName,
}: ConnectionScopesStepProps) {
  const providerConfig = getProviderScopes(providerId);

  // If provider doesn't have granular scopes, show a simple message
  if (!providerConfig || providerConfig.scopes.length <= 3) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {connectionName} will request the following permissions:
        </p>
        <div className="rounded-lg border border-border bg-muted/30 p-4">
          <ul className="space-y-2 text-sm">
            {(providerConfig?.scopes ?? []).map((scope) => (
              <li key={scope.id} className="flex items-start gap-2">
                <span className="text-primary">•</span>
                <div>
                  <span className="font-medium">{scope.label}</span>
                  <span className="text-muted-foreground"> - {scope.description}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-muted-foreground">
          You can modify these permissions later in settings.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Select the permissions you want to grant. You can change these later.
      </p>
      <ScopeSelector
        providerId={providerId}
        selectedScopes={selectedScopes}
        onScopesChange={onScopesChange}
      />
    </div>
  );
}

/**
 * Hook for managing scope selection state in the wizard.
 */
export function useScopeSelection(providerId: string) {
  const [selectedScopes, setSelectedScopes] = React.useState<string[]>([]);

  // Initialize with defaults when provider changes
  React.useEffect(() => {
    const defaults = getDefaultScopes(providerId);
    setSelectedScopes(defaults);
  }, [providerId]);

  return {
    selectedScopes,
    setSelectedScopes,
  };
}

export default ConnectionScopesStep;
