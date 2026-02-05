"use client";

import * as React from "react";
import { ExternalLink, CheckCircle2, Loader2, ShieldCheck, Zap, KeyRound, Settings } from "lucide-react";

import { cn } from "@/lib/utils";
import { showSuccess } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { WizardSteps } from "@/components/composed/WizardSteps";
import { ScopeSelector } from "./ScopeSelector";
import { getProviderScopes, getDefaultScopes } from "@/lib/scopes";
import type {
  ConnectionWizardData,
  ConnectionAuthMethod,
  ConnectionAuthField,
  ConnectionSyncOption,
} from "./ConnectionWizardDialog";

// Re-export types from the base wizard
export type {
  ConnectionWizardData,
  ConnectionAuthMethod,
  ConnectionAuthField,
  ConnectionSyncOption,
  ConnectionAuthMethodType,
} from "./ConnectionWizardDialog";

const EMPTY_SYNC_OPTIONS: ConnectionSyncOption[] = [];
const EMPTY_AUTH_FIELDS: ConnectionAuthField[] = [];

interface ConnectionWizardWithScopesProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connection: ConnectionWizardData;
  onConnect: (payload: {
    authMethodId: string;
    values: Record<string, string>;
    options: Record<string, boolean>;
    scopes?: string[];
  }) => Promise<void>;
  onDisconnect?: () => Promise<void>;
  /** Enable granular scope selection for OAuth methods */
  enableScopeSelection?: boolean;
}

function maskSecret(value: string) {
  if (!value) return "";
  const trimmed = value.trim();
  if (trimmed.length <= 6) return "••••••";
  return `${trimmed.slice(0, 2)}••••${trimmed.slice(-2)}`;
}

/**
 * Enhanced connection wizard with OAuth scope selection.
 *
 * Adds a "Permissions" step for OAuth methods when the provider
 * has granular scope configuration available.
 */
export function ConnectionWizardWithScopes({
  open,
  onOpenChange,
  connection,
  onConnect,
  onDisconnect,
  enableScopeSelection = true,
}: ConnectionWizardWithScopesProps) {
  const [currentStep, setCurrentStep] = React.useState(0);
  const [selectedMethodId, setSelectedMethodId] = React.useState<string>(
    connection.authMethods[0]?.id ?? ""
  );
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [options, setOptions] = React.useState<Record<string, boolean>>({});
  const [selectedScopes, setSelectedScopes] = React.useState<string[]>([]);
  const [oauthAuthorized, setOauthAuthorized] = React.useState(false);
  const [isConnecting, setIsConnecting] = React.useState(false);
  const [isDisconnecting, setIsDisconnecting] = React.useState(false);

  const method = connection.authMethods.find((m) => m.id === selectedMethodId);
  const syncOptions = connection.syncOptions ?? EMPTY_SYNC_OPTIONS;

  // Check if this provider has scope configuration
  const providerScopes = getProviderScopes(connection.id);
  const hasScopeConfig = enableScopeSelection && providerScopes && providerScopes.scopes.length > 3;
  const isOAuthMethod = method?.type === "oauth";
  const showScopesStep = isOAuthMethod && hasScopeConfig;

  // Reset state when dialog opens
  React.useEffect(() => {
    if (!open) return;
    setCurrentStep(0);
    setSelectedMethodId(connection.authMethods[0]?.id ?? "");
    setValues({});
    setOauthAuthorized(false);
    setIsConnecting(false);
    setIsDisconnecting(false);
    setOptions(
      syncOptions.reduce<Record<string, boolean>>((acc, option) => {
        acc[option.id] = option.defaultEnabled ?? true;
        return acc;
      }, {})
    );
    // Initialize scopes with defaults
    const defaults = getDefaultScopes(connection.id);
    setSelectedScopes(defaults);
  }, [open, connection.authMethods, connection.id, syncOptions]);

  // Build steps list based on method type
  const steps = React.useMemo(() => {
    const list = ["Method"];
    if (showScopesStep) {
      list.push("Permissions");
    }
    list.push("Access");
    if (syncOptions.length > 0) {
      list.push("Preferences");
    }
    list.push("Review");
    return list;
  }, [showScopesStep, syncOptions.length]);

  const stepId = steps[currentStep] ?? steps[0];
  const authFields = method?.fields ?? EMPTY_AUTH_FIELDS;

  const isAccessComplete = React.useMemo(() => {
    if (!method) return false;
    if (method.type === "oauth") return oauthAuthorized;
    const requiredFields = authFields.filter((field) => field.required !== false);
    return requiredFields.every((field) => values[field.id]?.trim());
  }, [authFields, method, oauthAuthorized, values]);

  const canProceed = React.useMemo(() => {
    if (stepId === "Method") return !!method;
    if (stepId === "Permissions") return selectedScopes.length > 0;
    if (stepId === "Access") return isAccessComplete;
    return true;
  }, [stepId, method, selectedScopes.length, isAccessComplete]);

  const isLastStep = currentStep === steps.length - 1;

  const handleNext = () => {
    if (!canProceed) return;
    setCurrentStep((prev) => Math.min(prev + 1, steps.length - 1));
  };

  const handleBack = () => {
    setCurrentStep((prev) => Math.max(prev - 1, 0));
  };

  const handleConnect = async () => {
    if (!method || !isAccessComplete) return;
    setIsConnecting(true);
    try {
      await onConnect({
        authMethodId: method.id,
        values,
        options,
        scopes: isOAuthMethod ? selectedScopes : undefined,
      });
      showSuccess(`${connection.name} connected successfully`);
      onOpenChange(false);
    } finally {
      setIsConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    if (!onDisconnect) return;
    setIsDisconnecting(true);
    try {
      await onDisconnect();
      showSuccess(`${connection.name} disconnected`);
      onOpenChange(false);
    } finally {
      setIsDisconnecting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
              {connection.icon}
            </div>
            <div>
              <DialogTitle>{connection.name}</DialogTitle>
              <DialogDescription>{connection.description}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="mt-5 space-y-4">
          <WizardSteps steps={steps} currentStep={currentStep} onStepChange={setCurrentStep} />

          {/* Method selection step */}
          {stepId === "Method" && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Choose how you want to authenticate. You can switch methods later.
              </p>
              <div className="grid gap-3">
                {connection.authMethods.map((auth) => {
                  const isSelected = auth.id === selectedMethodId;
                  return (
                    <button
                      key={auth.id}
                      type="button"
                      onClick={() => setSelectedMethodId(auth.id)}
                      className={cn(
                        "flex items-start gap-3 rounded-lg border p-3 text-left transition",
                        isSelected
                          ? "border-primary/60 bg-primary/5"
                          : "border-border hover:border-primary/30"
                      )}
                    >
                      <div className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-md bg-muted">
                        {auth.type === "oauth" ? (
                          <Zap className="h-4 w-4 text-primary" />
                        ) : auth.type === "api_key" ? (
                          <KeyRound className="h-4 w-4 text-primary" />
                        ) : (
                          <ShieldCheck className="h-4 w-4 text-primary" />
                        )}
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-foreground">{auth.label}</p>
                          {auth.badge && (
                            <Badge variant="secondary" className="text-[10px]">
                              {auth.badge}
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">{auth.description}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Permissions/Scopes step (OAuth only) */}
          {stepId === "Permissions" && showScopesStep && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Select the permissions you want to grant {connection.name}. You can change these later.
              </p>
              <ScopeSelector
                providerId={connection.id}
                selectedScopes={selectedScopes}
                onScopesChange={setSelectedScopes}
              />
            </div>
          )}

          {/* Access step */}
          {stepId === "Access" && method && (
            <div className="space-y-4">
              {method.type === "oauth" ? (
                <div className="space-y-4">
                  <div className="rounded-lg border border-border bg-muted/50 p-4">
                    <p className="text-sm font-medium">Authorize with {connection.name}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      You will be redirected to {connection.name} to approve access.
                    </p>
                    {selectedScopes.length > 0 && (
                      <div className="mt-3">
                        <p className="text-xs text-muted-foreground mb-1">Requested permissions:</p>
                        <div className="flex flex-wrap gap-1">
                          {selectedScopes.slice(0, 5).map((scopeId) => {
                            const scope = providerScopes?.scopes.find((s) => s.id === scopeId);
                            return (
                              <Badge key={scopeId} variant="outline" className="text-[10px]">
                                {scope?.label ?? scopeId}
                              </Badge>
                            );
                          })}
                          {selectedScopes.length > 5 && (
                            <Badge variant="outline" className="text-[10px]">
                              +{selectedScopes.length - 5} more
                            </Badge>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                  <Button onClick={() => setOauthAuthorized(true)} className="w-full">
                    <ExternalLink className="mr-2 h-4 w-4" />
                    {method.ctaLabel ?? `Continue with ${connection.name}`}
                  </Button>
                  {method.ctaHint && (
                    <p className="text-xs text-muted-foreground text-center">{method.ctaHint}</p>
                  )}
                  {oauthAuthorized && (
                    <div className="flex items-center gap-2 rounded-lg border border-green-500/30 bg-green-500/10 p-3 text-sm">
                      <CheckCircle2 className="h-4 w-4 text-green-600" />
                      Authorization received. Continue to finish setup.
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  {authFields.map((field) => (
                    <div key={field.id} className="space-y-2">
                      <Label htmlFor={`${connection.id}-${field.id}`}>{field.label}</Label>
                      {field.multiline ? (
                        <Textarea
                          id={`${connection.id}-${field.id}`}
                          rows={field.rows ?? 4}
                          placeholder={field.placeholder}
                          value={values[field.id] ?? ""}
                          onChange={(event) =>
                            setValues((prev) => ({ ...prev, [field.id]: event.target.value }))
                          }
                        />
                      ) : (
                        <Input
                          id={`${connection.id}-${field.id}`}
                          type={field.type ?? "text"}
                          placeholder={field.placeholder}
                          value={values[field.id] ?? ""}
                          onChange={(event) =>
                            setValues((prev) => ({ ...prev, [field.id]: event.target.value }))
                          }
                        />
                      )}
                      {field.helpText && (
                        <p className="text-xs text-muted-foreground">{field.helpText}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Preferences step */}
          {stepId === "Preferences" && syncOptions.length > 0 && (
            <div className="space-y-3">
              {syncOptions.map((option) => (
                <div
                  key={option.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border p-3"
                >
                  <div>
                    <p className="text-sm font-medium">{option.label}</p>
                    <p className="text-xs text-muted-foreground">{option.description}</p>
                  </div>
                  <Switch
                    checked={options[option.id] ?? false}
                    onCheckedChange={(checked) =>
                      setOptions((prev) => ({ ...prev, [option.id]: checked }))
                    }
                  />
                </div>
              ))}
            </div>
          )}

          {/* Review step */}
          {stepId === "Review" && (
            <div className="space-y-4">
              <div className="rounded-lg border border-border bg-muted/50 p-4">
                <p className="text-sm font-medium">Summary</p>
                <div className="mt-3 space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Auth method</span>
                    <span className="font-medium">{method?.label}</span>
                  </div>
                  {isOAuthMethod && selectedScopes.length > 0 && (
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Permissions</span>
                      <span className="font-medium">{selectedScopes.length} scopes</span>
                    </div>
                  )}
                  {method?.fields && method.fields.length > 0 && (
                    <div className="space-y-2">
                      {method.fields.map((field) => (
                        <div key={field.id} className="flex items-center justify-between">
                          <span className="text-muted-foreground">{field.label}</span>
                          <span className="font-medium">
                            {field.type === "password"
                              ? maskSecret(values[field.id] ?? "")
                              : values[field.id] || "—"}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  {syncOptions.length > 0 && (
                    <div className="mt-3">
                      <p className="text-xs text-muted-foreground">Sync preferences</p>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {syncOptions
                          .filter((option) => options[option.id])
                          .map((option) => (
                            <Badge key={option.id} variant="outline" className="text-[10px]">
                              {option.label}
                            </Badge>
                          ))}
                        {syncOptions.every((option) => !options[option.id]) && (
                          <span className="text-xs text-muted-foreground">
                            No sync options enabled
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
              {connection.connected && (
                <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-3 text-sm">
                  <CheckCircle2 className="mr-2 inline h-4 w-4 text-green-600" />
                  {connection.name} is already connected.
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="mt-6 flex-row gap-2 sm:justify-between">
          {connection.connected && onDisconnect && (
            <Button
              variant="destructive"
              onClick={handleDisconnect}
              disabled={isDisconnecting || isConnecting}
            >
              {isDisconnecting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Disconnect
            </Button>
          )}
          <div className="flex-1" />
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {currentStep > 0 && (
            <Button variant="outline" onClick={handleBack}>
              Back
            </Button>
          )}
          {!isLastStep ? (
            <Button onClick={handleNext} disabled={!canProceed}>
              Next
            </Button>
          ) : (
            <Button onClick={handleConnect} disabled={!isAccessComplete || isConnecting}>
              {isConnecting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {connection.connected ? "Update" : "Connect"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default ConnectionWizardWithScopes;
