/**
 * Gateway Authentication Guard
 *
 * Wraps the app and shows a blocking auth modal when gateway authentication is required.
 * Children are rendered when connected (or when live mode is disabled).
 */

import { GatewayAuthModal } from "./GatewayAuthModal";
import { useGatewayConnection, useGatewayUrl } from "@/hooks/useGatewayConnection";
import { Loader2 } from "lucide-react";

export interface GatewayAuthGuardProps {
  /** Whether to require gateway connection (if false, children render immediately) */
  enabled?: boolean;
  /** Children to render when connected */
  children: React.ReactNode;
}

/**
 * Guard component that blocks rendering until gateway is authenticated.
 * Shows a loading spinner while connecting, and the auth modal if auth fails.
 */
export function GatewayAuthGuard({ enabled = true, children }: GatewayAuthGuardProps) {
  const gatewayUrl = useGatewayUrl();
  const { state, needsAuth, isConnecting, authError, authenticate } = useGatewayConnection({
    autoConnect: enabled,
  });

  // If guard is disabled, render children immediately
  if (!enabled) {
    return <>{children}</>;
  }

  // Show auth modal when authentication is required
  if (needsAuth) {
    return (
      <>
        <GatewayAuthModal
          open={true}
          error={authError}
          gatewayUrl={gatewayUrl}
          onAuthenticate={authenticate}
          canCancel={false}
        />
        {/* Render dimmed/blurred background */}
        <div className="fixed inset-0 bg-background/80 backdrop-blur-sm" />
      </>
    );
  }

  // Show loading state while connecting
  if (isConnecting || state.status === "disconnected") {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="mt-4 text-sm text-muted-foreground">
          Connecting to Gateway...
        </p>
      </div>
    );
  }

  // Show error state
  if (state.status === "error") {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center bg-background">
        <div className="text-center space-y-4 max-w-md px-4">
          <div className="text-destructive text-lg font-medium">Connection Error</div>
          <p className="text-sm text-muted-foreground">
            {(state as { error: string }).error}
          </p>
          <p className="text-xs text-muted-foreground">
            Make sure the Gateway is running and refresh the page to try again.
          </p>
        </div>
      </div>
    );
  }

  // Connected - render children
  return <>{children}</>;
}

export default GatewayAuthGuard;
