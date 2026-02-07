"use client";

import * as React from "react";
import {
  AlertTriangle,
  RefreshCw,
  ArrowLeft,
  Bug,
  ChevronDown,
  Copy,
  Check,
} from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useUIStore } from "@/stores/useUIStore";
import * as Collapsible from "@radix-ui/react-collapsible";
import { cn } from "@/lib/utils";

/**
 * TanStack Router errorComponent interface.
 * When a route throws, TanStack Router passes { error, reset } to the errorComponent.
 */
export interface RouteErrorFallbackProps {
  error: Error;
  reset?: () => void;
  /** Override for the route/page name shown in the error */
  routeName?: string;
}

/**
 * Route-level error fallback for TanStack Router.
 *
 * Designed to be used as the `errorComponent` on individual routes,
 * isolating errors per-page so one broken view doesn't take down the whole app.
 *
 * Features:
 * - Shows which page crashed
 * - "Try Again" resets the route error
 * - "Go Back" returns to the previous page
 * - Error details collapsible (or auto-shown in power user mode)
 * - Copy error details to clipboard
 *
 * @example
 * export const Route = createFileRoute('/agents/')({
 *   component: AgentsPage,
 *   errorComponent: RouteErrorFallback,
 * })
 */
export function RouteErrorFallback({
  error,
  reset,
  routeName,
}: RouteErrorFallbackProps) {
  const router = useRouter();
  const powerUserMode = useUIStore((s) => s.powerUserMode);
  const [showDetails, setShowDetails] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  // Derive a human-friendly route name from the current location
  const derivedRouteName = React.useMemo(() => {
    if (routeName) return routeName;
    try {
      const path = window.location.pathname;
      if (path === "/") return "Dashboard";
      // Take the first meaningful segment: /agents/foo -> Agents
      const segment = path.split("/").filter(Boolean)[0];
      if (!segment) return "this page";
      return segment.charAt(0).toUpperCase() + segment.slice(1);
    } catch {
      return "this page";
    }
  }, [routeName]);

  const handleReset = React.useCallback(() => {
    if (reset) {
      reset();
    } else {
      // TanStack Router: invalidate and retry the current route
      router.invalidate();
    }
  }, [reset, router]);

  const handleGoBack = React.useCallback(() => {
    if (window.history.length > 1) {
      router.history.back();
    } else {
      router.navigate({ to: "/" });
    }
  }, [router]);

  const handleCopyError = React.useCallback(async () => {
    const text = [
      `Error in ${derivedRouteName}`,
      `Message: ${error.message}`,
      error.stack ? `\nStack:\n${error.stack}` : "",
      `\nURL: ${window.location.href}`,
      `Time: ${new Date().toISOString()}`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API might not be available
    }
  }, [error, derivedRouteName]);

  return (
    <div className="flex min-h-[400px] w-full items-center justify-center p-6">
      <Card className="w-full max-w-lg border-destructive/30 shadow-lg">
        <CardHeader className="text-center pb-2">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10">
            <AlertTriangle className="h-7 w-7 text-destructive" />
          </div>
          <CardTitle className="text-lg">
            {derivedRouteName} encountered an error
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-center text-sm text-muted-foreground">
            Something went wrong while loading this page. You can try again
            or go back to the previous page.
          </p>

          {/* Error details */}
          <Collapsible.Root
            open={powerUserMode || showDetails}
            onOpenChange={setShowDetails}
          >
            {!powerUserMode && (
              <Collapsible.Trigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-between text-muted-foreground"
                >
                  <span className="flex items-center gap-1.5">
                    <Bug className="h-3.5 w-3.5" />
                    Error details
                  </span>
                  <ChevronDown
                    className={cn(
                      "h-4 w-4 transition-transform duration-200",
                      showDetails && "rotate-180",
                    )}
                  />
                </Button>
              </Collapsible.Trigger>
            )}
            <Collapsible.Content>
              <div className="mt-2 rounded-lg bg-muted/50 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium text-muted-foreground">
                    Error
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs text-muted-foreground"
                    onClick={handleCopyError}
                  >
                    {copied ? (
                      <Check className="h-3 w-3 mr-1" />
                    ) : (
                      <Copy className="h-3 w-3 mr-1" />
                    )}
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </div>
                <pre className="whitespace-pre-wrap text-xs text-destructive break-all">
                  {error.message}
                </pre>
                {(powerUserMode || showDetails) && error.stack && (
                  <>
                    <p className="text-xs font-medium text-muted-foreground pt-1">
                      Stack Trace
                    </p>
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-[10px] text-muted-foreground leading-relaxed">
                      {error.stack}
                    </pre>
                  </>
                )}
              </div>
            </Collapsible.Content>
          </Collapsible.Root>

          {/* Action buttons */}
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              variant="outline"
              className="flex-1"
              onClick={handleGoBack}
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              Go Back
            </Button>
            <Button className="flex-1" onClick={handleReset}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Try Again
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default RouteErrorFallback;
