"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional fallback to render instead of the default error UI. */
  fallback?: ReactNode;
  /** Name shown in the error card so users know which section failed. */
  viewName?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ViewErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(
      `[ViewErrorBoundary] ${this.props.viewName ?? "Unknown"} crashed:`,
      error,
      info.componentStack,
    );
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {return this.props.fallback;}

      return (
        <div className="flex-1 flex items-center justify-center p-12">
          <div className="glass-card max-w-md w-full p-8 text-center space-y-4">
            {/* Icon */}
            <div className="w-14 h-14 rounded-2xl bg-destructive/10 flex items-center justify-center mx-auto">
              <AlertTriangle className="w-7 h-7 text-destructive" />
            </div>

            {/* Title */}
            <h3 className="text-lg font-semibold">
              {this.props.viewName
                ? `${this.props.viewName} encountered an error`
                : "Something went wrong"}
            </h3>

            {/* Message */}
            <p className="text-sm text-muted-foreground leading-relaxed">
              This section crashed unexpectedly. You can retry loading it, or
              navigate to a different view.
            </p>

            {/* Error detail (collapsed in production) */}
            {this.state.error && (
              <details className="text-left bg-muted/50 rounded-lg p-3 text-xs font-mono text-muted-foreground">
                <summary className="cursor-pointer select-none font-medium text-foreground/70 mb-1">
                  Error details
                </summary>
                <pre className="whitespace-pre-wrap break-words mt-1">
                  {this.state.error.message}
                </pre>
              </details>
            )}

            {/* Actions */}
            <div className="flex items-center justify-center gap-3 pt-2">
              <Button onClick={this.handleRetry} className="gap-2">
                <RefreshCw className="w-4 h-4" />
                Retry
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  window.location.hash = "";
                  window.location.reload();
                }}
              >
                Go to Dashboard
              </Button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
