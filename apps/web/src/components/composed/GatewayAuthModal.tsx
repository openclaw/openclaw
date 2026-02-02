/**
 * Gateway Authentication Modal
 *
 * A blocking modal that appears when Gateway authentication is required.
 * Supports Token and Password authentication with a tabbed interface.
 * Designed to replace the toast spam UX from the ui/* Control UI.
 */

import { useState, useCallback, useEffect } from "react";
import { KeyRound, Lock, AlertCircle, Loader2, Eye, EyeOff, Clipboard, Terminal } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { GatewayAuthCredentials } from "@/lib/api/gateway-client";
import {
  loadAuthMethodPreference,
  storeAuthMethodPreference,
  type AuthMethod,
} from "@/lib/api/device-auth-storage";

export interface GatewayAuthModalProps {
  /** Whether the modal is open */
  open: boolean;
  /** Error message from previous auth attempt */
  error?: string;
  /** Gateway URL to display */
  gatewayUrl: string;
  /** Callback when user submits credentials */
  onAuthenticate: (credentials: GatewayAuthCredentials) => Promise<void>;
  /** Optional callback to cancel (only shown if previously authenticated) */
  onCancel?: () => void;
  /** Whether the user can cancel the modal */
  canCancel?: boolean;
}

export function GatewayAuthModal({
  open,
  error,
  gatewayUrl,
  onAuthenticate,
  onCancel,
  canCancel = false,
}: GatewayAuthModalProps) {
  const [authMethod, setAuthMethod] = useState<AuthMethod>(() => loadAuthMethodPreference());
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [localError, setLocalError] = useState<string | undefined>(error);

  // Update local error when prop changes
  useEffect(() => {
    setLocalError(error);
  }, [error]);

  // Remember auth method preference
  const handleTabChange = useCallback((value: string) => {
    const method = value as AuthMethod;
    setAuthMethod(method);
    storeAuthMethodPreference(method);
    setLocalError(undefined);
  }, []);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setLocalError(undefined);
      setIsAuthenticating(true);

      try {
        const credentials: GatewayAuthCredentials =
          authMethod === "token"
            ? { type: "token", value: token.trim() }
            : { type: "password", value: password };

        if (!credentials.value) {
          setLocalError(authMethod === "token" ? "Please enter a token" : "Please enter a password");
          setIsAuthenticating(false);
          return;
        }

        await onAuthenticate(credentials);
        // Success - modal will be closed by parent
      } catch (err) {
        setLocalError(err instanceof Error ? err.message : "Authentication failed");
      } finally {
        setIsAuthenticating(false);
      }
    },
    [authMethod, token, password, onAuthenticate]
  );

  const handlePasteToken = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setToken(text.trim());
      }
    } catch {
      // Clipboard access denied
    }
  }, []);

  return (
    <Dialog open={open} onOpenChange={canCancel && onCancel ? () => onCancel() : undefined}>
      <DialogContent
        className="sm:max-w-md"
        showCloseButton={canCancel}
        onPointerDownOutside={(e) => !canCancel && e.preventDefault()}
        onEscapeKeyDown={(e) => !canCancel && e.preventDefault()}
      >
        <DialogHeader className="text-center sm:text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
            <Lock className="h-7 w-7 text-primary" />
          </div>
          <DialogTitle className="text-xl">Connect to Gateway</DialogTitle>
          <DialogDescription className="space-y-2">
            <span className="block text-sm font-mono bg-muted px-2 py-1 rounded text-center">
              {gatewayUrl}
            </span>
          </DialogDescription>
        </DialogHeader>

        {localError && (
          <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            <span>{localError}</span>
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <Tabs value={authMethod} onValueChange={handleTabChange} className="w-full">
            <TabsList className="w-full">
              <TabsTrigger value="token" className="flex-1">
                <KeyRound className="mr-1.5 h-4 w-4" />
                Token
              </TabsTrigger>
              <TabsTrigger value="password" className="flex-1">
                <Lock className="mr-1.5 h-4 w-4" />
                Password
              </TabsTrigger>
            </TabsList>

            <TabsContent value="token" className="mt-4 space-y-4">
              <div className="space-y-2">
                <div className="relative">
                  <Input
                    type="text"
                    placeholder="Enter your gateway token..."
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    disabled={isAuthenticating}
                    className="pr-10 font-mono text-sm"
                    autoFocus
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="absolute right-1 top-1/2 -translate-y-1/2"
                    onClick={handlePasteToken}
                    disabled={isAuthenticating}
                    title="Paste from clipboard"
                  >
                    <Clipboard className="h-4 w-4" />
                  </Button>
                </div>
                <div className="flex items-start gap-2 text-xs text-muted-foreground">
                  <Terminal className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                  <span>
                    Get your token by running:{" "}
                    <code className="bg-muted px-1 py-0.5 rounded font-mono">
                      clawdbrain dashboard --no-open
                    </code>
                  </span>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="password" className="mt-4 space-y-4">
              <div className="space-y-2">
                <div className="relative">
                  <Input
                    type={showPassword ? "text" : "password"}
                    placeholder="Enter your gateway password..."
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={isAuthenticating}
                    className="pr-10"
                    autoFocus
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="absolute right-1 top-1/2 -translate-y-1/2"
                    onClick={() => setShowPassword(!showPassword)}
                    disabled={isAuthenticating}
                    title={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Enter the password configured in your gateway settings.
                </p>
              </div>
            </TabsContent>
          </Tabs>

          <DialogFooter className="mt-6 gap-2 sm:gap-0">
            {canCancel && onCancel && (
              <Button type="button" variant="outline" onClick={onCancel} disabled={isAuthenticating}>
                Cancel
              </Button>
            )}
            <Button type="submit" className="flex-1 sm:flex-none" disabled={isAuthenticating}>
              {isAuthenticating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Connecting...
                </>
              ) : (
                "Connect"
              )}
            </Button>
          </DialogFooter>
        </form>

        {/* Future OAuth section placeholder */}
        <div className="mt-4 text-center text-xs text-muted-foreground border-t pt-4">
          <p>OAuth sign-in coming soon</p>
          <p className="mt-0.5 opacity-75">Google, GitHub, and more</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default GatewayAuthModal;
