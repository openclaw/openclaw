"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

type Disposable = { dispose: () => void };

export type XtermTerminal = {
  write: (data: string) => void;
  writeln: (line: string) => void;
  clear: () => void;
  focus: () => void;
  open: (container: HTMLElement) => void;
  dispose: () => void;
  loadAddon: (addon: unknown) => void;
  onData: (handler: (data: string) => void) => Disposable;
  onResize: (handler: (size: { cols: number; rows: number }) => void) => Disposable;
};

type FitAddonLike = { fit: () => void };
type SearchAddonLike = unknown;

type XtermModule = {
  Terminal: new (options: Record<string, unknown>) => XtermTerminal;
};

type AddonModule<T> = {
  [key: string]: new () => T;
};

async function loadXterm(): Promise<{
  Terminal: XtermModule["Terminal"];
  FitAddon: new () => FitAddonLike;
  WebLinksAddon: new () => unknown;
  SearchAddon: new () => SearchAddonLike;
  ClipboardAddon: new () => unknown;
}> {
  const [terminalMod, fitMod, webLinksMod, searchMod, clipboardMod] = await Promise.all([
    import("@xterm/xterm") as Promise<unknown>,
    import("@xterm/addon-fit") as Promise<unknown>,
    import("@xterm/addon-web-links") as Promise<unknown>,
    import("@xterm/addon-search") as Promise<unknown>,
    import("@xterm/addon-clipboard") as Promise<unknown>,
    import("@xterm/xterm/css/xterm.css").catch(() => null),
  ]);

  if (typeof terminalMod !== "object" || terminalMod === null || !("Terminal" in terminalMod)) {
    throw new Error('Expected "@xterm/xterm" to export Terminal');
  }

  const Terminal = (terminalMod as XtermModule).Terminal;
  const FitAddon = (fitMod as AddonModule<FitAddonLike>).FitAddon;
  const WebLinksAddon = (webLinksMod as AddonModule<unknown>).WebLinksAddon;
  const SearchAddon = (searchMod as AddonModule<SearchAddonLike>).SearchAddon;
  const ClipboardAddon = (clipboardMod as AddonModule<unknown>).ClipboardAddon;

  if (typeof Terminal !== "function") {throw new Error('Invalid Terminal export from "@xterm/xterm"');}
  if (typeof FitAddon !== "function") {throw new Error('Invalid FitAddon export from "@xterm/addon-fit"');}
  if (typeof WebLinksAddon !== "function") {throw new Error('Invalid WebLinksAddon export from "@xterm/addon-web-links"');}
  if (typeof SearchAddon !== "function") {throw new Error('Invalid SearchAddon export from "@xterm/addon-search"');}
  if (typeof ClipboardAddon !== "function") {throw new Error('Invalid ClipboardAddon export from "@xterm/addon-clipboard"');}

  return { Terminal, FitAddon, WebLinksAddon, SearchAddon, ClipboardAddon };
}

export interface WebTerminalRef {
  write: (data: string) => void;
  writeln: (line: string) => void;
  clear: () => void;
  focus: () => void;
  fit: () => void;
  getTerminal: () => XtermTerminal | null;
}

export interface WebTerminalProps {
  className?: string;
  terminalClassName?: string;
  style?: React.CSSProperties;
  height?: number | string;

  welcomeMessage?: string;
  readOnly?: boolean;

  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
}

export const WebTerminal = React.forwardRef<WebTerminalRef, WebTerminalProps>(
  (
    {
      className,
      terminalClassName,
      style,
      height = 420,
      welcomeMessage,
      readOnly = false,
      onData,
      onResize,
    },
    ref
  ) => {
    const containerRef = React.useRef<HTMLDivElement | null>(null);
    const terminalRef = React.useRef<XtermTerminal | null>(null);
    const fitRef = React.useRef<FitAddonLike | null>(null);
    const searchRef = React.useRef<SearchAddonLike | null>(null);
    const resizeObserverRef = React.useRef<ResizeObserver | null>(null);
    const [loadError, setLoadError] = React.useState<string | null>(null);

    const fit = React.useCallback(() => {
      try {
        fitRef.current?.fit();
      } catch {
        // ignore: can happen if container is hidden during initial layout
      }
    }, []);

    React.useImperativeHandle(
      ref,
      () => ({
        write: (data) => terminalRef.current?.write(data),
        writeln: (line) => terminalRef.current?.writeln(line),
        clear: () => terminalRef.current?.clear(),
        focus: () => terminalRef.current?.focus(),
        fit,
        getTerminal: () => terminalRef.current,
      }),
      [fit]
    );

    React.useEffect(() => {
      if (!containerRef.current) {return;}

      let disposed = false;
      let dataDisposable: Disposable | null = null;
      let resizeDisposable: Disposable | null = null;

      loadXterm()
        .then(({ Terminal, FitAddon, WebLinksAddon, SearchAddon, ClipboardAddon }) => {
          if (disposed) {return;}

          const terminal = new Terminal({
            cursorBlink: true,
            fontSize: 13,
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
            scrollback: 6000,
            disableStdin: readOnly,
            theme: {
              background: "transparent",
            },
          });

          const fitAddon = new FitAddon();
          const searchAddon = new SearchAddon();

          terminal.loadAddon(fitAddon);
          terminal.loadAddon(new WebLinksAddon());
          terminal.loadAddon(searchAddon);
          terminal.loadAddon(new ClipboardAddon());

          terminal.open(containerRef.current!);

          terminalRef.current = terminal;
          fitRef.current = fitAddon;
          searchRef.current = searchAddon;

          dataDisposable = terminal.onData((data: string) => {
            onData?.(data);
          });
          resizeDisposable = terminal.onResize(({ cols, rows }: { cols: number; rows: number }) => {
            onResize?.(cols, rows);
          });

          resizeObserverRef.current = new ResizeObserver(() => fit());
          resizeObserverRef.current.observe(containerRef.current!);
          fit();

          if (welcomeMessage) {
            terminal.writeln(welcomeMessage);
          }
        })
        .catch((err: unknown) => {
          if (disposed) {return;}
          const message = err instanceof Error ? err.message : String(err);
          setLoadError(message);
        });

      return () => {
        disposed = true;
        resizeObserverRef.current?.disconnect();
        resizeObserverRef.current = null;
        dataDisposable?.dispose();
        resizeDisposable?.dispose();
        terminalRef.current?.dispose();
        terminalRef.current = null;
        fitRef.current = null;
        searchRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
      <div
        className={cn(
          "web-terminal rounded-xl border border-border bg-card/50 backdrop-blur-sm",
          className
        )}
        style={{ height, ...style }}
      >
        {loadError ? (
          <div className="p-4 text-sm text-muted-foreground">
            <div className="font-medium text-foreground">Terminal renderer unavailable</div>
            <div className="mt-1">
              Failed to load terminal libraries. This is usually a Vite cache issue.
            </div>
            <div className="mt-2">
              <strong>Solution:</strong>
              <ol className="list-decimal list-inside mt-1 space-y-1">
                <li>Stop the dev server (Ctrl+C)</li>
                <li>Clear browser cache (Cmd+Shift+R or Ctrl+Shift+R)</li>
                <li>Run: <code className="font-mono bg-muted px-1">cd apps/web && pnpm dev</code></li>
              </ol>
            </div>
            <div className="mt-3 font-mono text-xs text-destructive">{loadError}</div>
          </div>
        ) : (
          <div
            ref={containerRef}
            className={cn("h-full w-full overflow-hidden px-2 py-2", terminalClassName)}
          />
        )}
      </div>
    );
  }
);

WebTerminal.displayName = "WebTerminal";
