/**
 * DeviceCard - compact card for a paired device showing identity, roles,
 * and token status with actions behind a menu.
 */

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { PairedDevice, DeviceTokenSummary } from "@/lib/api/nodes";
import {
  MoreVertical,
  RotateCcw,
  ShieldOff,
  Key,
  Clock,
  Fingerprint,
} from "lucide-react";

interface DeviceCardProps {
  device: PairedDevice;
  onRotateToken: (deviceId: string, role: string, scopes?: string[]) => void;
  onRevokeToken: (deviceId: string, role: string) => void;
}

export function DeviceCard({
  device,
  onRotateToken,
  onRevokeToken,
}: DeviceCardProps) {
  const displayName = device.displayName ?? truncateId(device.deviceId);
  const shortId = truncateId(device.deviceId);
  const activeTokens = (device.tokens ?? []).filter(
    (t) => !t.revokedAtMs,
  );

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Fingerprint className="h-4 w-4 text-primary/70 shrink-0" />
            <span className="font-medium text-sm truncate">{displayName}</span>
          </div>
          <code className="text-[10px] text-muted-foreground font-mono block mt-0.5 truncate">
            {shortId}
          </code>
        </div>

        {/* Roles */}
        <div className="flex items-center gap-1 shrink-0">
          {(device.roles ?? []).map((role) => (
            <Badge key={role} variant="outline" className="text-[10px] px-1.5 py-0 h-4">
              {role}
            </Badge>
          ))}
        </div>
      </div>

      {/* Scopes */}
      {device.scopes && device.scopes.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {device.scopes.map((scope) => (
            <Badge
              key={scope}
              variant="secondary"
              className="text-[10px] px-1.5 py-0 h-4 font-mono"
            >
              {scope}
            </Badge>
          ))}
        </div>
      )}

      {/* Tokens */}
      {activeTokens.length > 0 && (
        <div className="space-y-1.5 pt-1 border-t border-border/50">
          <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            Tokens
          </div>
          {activeTokens.map((token, i) => (
            <TokenRow
              key={token.role + i}
              token={token}
              deviceId={device.deviceId}
              onRotate={() =>
                onRotateToken(device.deviceId, token.role, token.scopes)
              }
              onRevoke={() => onRevokeToken(device.deviceId, token.role)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TokenRow
// ---------------------------------------------------------------------------

function TokenRow({
  token,
  onRotate,
  onRevoke,
}: {
  token: DeviceTokenSummary;
  deviceId: string;
  onRotate: () => void;
  onRevoke: () => void;
}) {
  const age = token.createdAtMs
    ? formatRelativeTime(token.createdAtMs)
    : "unknown";

  return (
    <div className="flex items-center justify-between py-1">
      <div className="flex items-center gap-2 min-w-0">
        <Key className="h-3 w-3 text-muted-foreground shrink-0" />
        <span className="text-xs text-foreground/80 truncate">
          {token.role}
        </span>
        {token.active !== false && (
          <Badge variant="success" className="text-[9px] px-1 py-0 h-3.5">
            active
          </Badge>
        )}
        <span className="text-[10px] text-muted-foreground flex items-center gap-1">
          <Clock className="h-2.5 w-2.5" />
          {age}
        </span>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-6 w-6">
            <MoreVertical className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-36">
          <DropdownMenuItem onClick={onRotate}>
            <RotateCcw className="h-3.5 w-3.5 mr-2" />
            Rotate
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={onRevoke}
            className="text-destructive focus:text-destructive"
          >
            <ShieldOff className="h-3.5 w-3.5 mr-2" />
            Revoke
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}...${id.slice(-4)}`;
}

function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}
