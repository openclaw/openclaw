"use client";

import * as React from "react";
import { createLazyFileRoute, Navigate } from "@tanstack/react-router";
import { PlugZap, Plug, Trash2, Terminal as TerminalIcon, Loader2 } from "lucide-react";

import { useUIStore } from "@/stores/useUIStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import type { WebTerminalRef } from "@/components/composed/WebTerminal";
import {
  createGatewayClient,
  type GatewayClient,
  type GatewayEvent,
  type GatewayStatus,
} from "@/lib/api";

// Lazy-load WebTerminal and all xterm dependencies
const LazyWebTerminal = React.lazy(() =>
  import("@/components/composed/WebTerminal").then((mod) => ({
    default: mod.WebTerminal,
  }))
);

export const Route = createLazyFileRoute("/debug/terminal")({
  component: DebugTerminalPage,
});

function DebugTerminalPage() {
  const powerUserMode = useUIStore((s) => s.powerUserMode);
  const terminalRef = React.useRef<WebTerminalRef | null>(null);
  const clientRef = React.useRef<GatewayClient | null>(null);
  const inputBufferRef = React.useRef("");

  const [gatewayUrl, setGatewayUrl] = React.useState("ws://127.0.0.1:18789");
  const [status, setStatus] = React.useState<GatewayStatus>("disconnected");

  const connected = status === "connected";

  React.useEffect(() => {
    if (!powerUserMode) return;
    terminalRef.current?.writeln("Clawdbrain Debug Terminal (v3 Protocol)");
    terminalRef.current?.writeln("Commands:");
    terminalRef.current?.writeln("  /connect  - connect to gateway");
    terminalRef.current?.writeln("  /disconnect");
    terminalRef.current?.writeln("  /clear");
    terminalRef.current?.writeln("");
    terminalRef.current?.write("> ");
  }, [powerUserMode]);

  const handleEvent = React.useCallback((event: GatewayEvent) => {
    terminalRef.current?.writeln("");
    terminalRef.current?.writeln(`[event] ${event.event}: ${JSON.stringify(event.payload ?? {}, null, 0)}`);
    terminalRef.current?.write("> ");
  }, []);

  const handleStatusChange = React.useCallback((newStatus: GatewayStatus) => {
    setStatus(newStatus);
    terminalRef.current?.writeln("");
    terminalRef.current?.writeln(`[status] ${newStatus}`);
    terminalRef.current?.write("> ");
  }, []);

  const connect = React.useCallback(async () => {
    terminalRef.current?.writeln("");
    terminalRef.current?.writeln(`[gateway] connecting... (${gatewayUrl})`);

    // Stop existing client
    clientRef.current?.stop();

    // Create new client with unified v3 protocol
    const client = createGatewayClient({
      url: gatewayUrl,
      onStatusChange: handleStatusChange,
      onEvent: handleEvent,
      onError: (err) => {
        terminalRef.current?.writeln("");
        terminalRef.current?.writeln(`[error] ${err.message}`);
        terminalRef.current?.write("> ");
      },
      onHello: (hello) => {
        terminalRef.current?.writeln("");
        terminalRef.current?.writeln(`[hello] protocol=${hello.protocol}, methods=${hello.features?.methods?.length ?? 0}`);
        terminalRef.current?.write("> ");
      },
      onGap: (info) => {
        terminalRef.current?.writeln("");
        terminalRef.current?.writeln(`[gap] expected seq ${info.expected}, got ${info.received}`);
        terminalRef.current?.write("> ");
      },
    });
    clientRef.current = client;

    try {
      await client.connect();
    } catch (err) {
      setStatus("error");
      terminalRef.current?.writeln(`[gateway] connect error: ${err instanceof Error ? err.message : String(err)}`);
      terminalRef.current?.write("> ");
    }
  }, [gatewayUrl, handleStatusChange, handleEvent]);

  const disconnect = React.useCallback(() => {
    clientRef.current?.stop();
    clientRef.current = null;
    setStatus("disconnected");
    terminalRef.current?.writeln("");
    terminalRef.current?.writeln("[gateway] disconnected (manual)");
    terminalRef.current?.write("> ");
  }, []);

  const runCommand = React.useCallback(
    async (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed) return;

      if (trimmed === "/clear") {
        terminalRef.current?.clear();
        terminalRef.current?.writeln("Clawdbrain Debug Terminal (v3 Protocol)");
        terminalRef.current?.write("> ");
        return;
      }

      if (trimmed === "/connect") {
        await connect();
        return;
      }

      if (trimmed === "/disconnect") {
        disconnect();
        return;
      }

      // Try to parse as RPC command
      if (trimmed.startsWith("/rpc ")) {
        const method = trimmed.slice(5).trim();
        if (clientRef.current?.isConnected()) {
          try {
            const result = await clientRef.current.request(method, {});
            terminalRef.current?.writeln("");
            terminalRef.current?.writeln(`[rpc] ${JSON.stringify(result, null, 2)}`);
          } catch (err) {
            terminalRef.current?.writeln("");
            terminalRef.current?.writeln(`[rpc error] ${err instanceof Error ? err.message : String(err)}`);
          }
          terminalRef.current?.write("> ");
          return;
        } else {
          terminalRef.current?.writeln("\n[error] not connected");
          terminalRef.current?.write("> ");
          return;
        }
      }

      terminalRef.current?.writeln(`\nunknown command: ${trimmed}`);
      terminalRef.current?.writeln("Try: /connect, /disconnect, /clear, /rpc <method>");
      terminalRef.current?.write("> ");
    },
    [connect, disconnect]
  );

  const onTerminalData = React.useCallback(
    (data: string) => {
      // Ignore escape sequences (arrows, etc)
      if (data.startsWith("\u001b")) return;

      // Enter
      if (data === "\r") {
        const line = inputBufferRef.current;
        inputBufferRef.current = "";
        terminalRef.current?.writeln("");
        void runCommand(line);
        return;
      }

      // Backspace
      if (data === "\u007f") {
        if (inputBufferRef.current.length === 0) return;
        inputBufferRef.current = inputBufferRef.current.slice(0, -1);
        terminalRef.current?.write("\b \b");
        return;
      }

      // Printable
      inputBufferRef.current += data;
      terminalRef.current?.write(data);
    },
    [runCommand]
  );

  if (!powerUserMode) {
    return <Navigate to="/" />;
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
              <TerminalIcon className="h-5 w-5 text-primary" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-semibold">Terminal</h1>
                <Badge variant={connected ? "success" : status === "connecting" ? "secondary" : "secondary"}>
                  {status === "connected" ? "Connected" : status === "connecting" ? "Connecting..." : "Disconnected"}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                Debug terminal with v3 protocol gateway client.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => terminalRef.current?.clear()} className="gap-2">
              <Trash2 className="h-4 w-4" />
              Clear
            </Button>
            {connected ? (
              <Button variant="destructive" onClick={disconnect} className="gap-2">
                <Plug className="h-4 w-4" />
                Disconnect
              </Button>
            ) : (
              <Button onClick={() => void connect()} className="gap-2">
                <PlugZap className="h-4 w-4" />
                Connect
              </Button>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Input
            value={gatewayUrl}
            onChange={(e) => setGatewayUrl(e.target.value)}
            placeholder="ws://127.0.0.1:18789"
          />
          <Button variant="outline" onClick={() => terminalRef.current?.fit()}>
            Fit
          </Button>
        </div>

        <React.Suspense
          fallback={
            <div className="flex items-center justify-center bg-background rounded-lg border border-border" style={{ height: 520 }}>
              <div className="flex flex-col items-center gap-3">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                <div className="text-sm text-muted-foreground">Loading terminal...</div>
              </div>
            </div>
          }
        >
          <LazyWebTerminal
            ref={terminalRef}
            height={520}
            welcomeMessage={undefined}
            onData={onTerminalData}
          />
        </React.Suspense>
      </div>
    </div>
  );
}
