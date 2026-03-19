"use client";

import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

const MIN_DRAWER_HEIGHT = 180;
const MAX_DRAWER_HEIGHT_RATIO = 0.75;
const DEFAULT_DRAWER_HEIGHT = 280;
const MOBILE_MAX_DRAWER_HEIGHT_RATIO = 0.6;
const MOBILE_DEFAULT_DRAWER_HEIGHT_RATIO = 0.5;
const STORAGE_KEY = "dench-terminal-height";
const DEFAULT_WS_PORT = 3101;
const MAX_TERMINALS = 8;

function isMobileViewport(): boolean {
  if (typeof window === "undefined") return false;
  return window.innerWidth < 768;
}

function maxDrawerHeight(): number {
  if (typeof window === "undefined") return DEFAULT_DRAWER_HEIGHT;
  const ratio = isMobileViewport() ? MOBILE_MAX_DRAWER_HEIGHT_RATIO : MAX_DRAWER_HEIGHT_RATIO;
  return Math.max(MIN_DRAWER_HEIGHT, Math.floor(window.innerHeight * ratio));
}

function clampHeight(height: number): number {
  const safe = Number.isFinite(height) ? height : DEFAULT_DRAWER_HEIGHT;
  return Math.min(Math.max(Math.round(safe), MIN_DRAWER_HEIGHT), maxDrawerHeight());
}

function loadHeight(): number {
  if (typeof window === "undefined") return DEFAULT_DRAWER_HEIGHT;
  if (isMobileViewport()) {
    return clampHeight(Math.floor(window.innerHeight * MOBILE_DEFAULT_DRAWER_HEIGHT_RATIO));
  }
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return DEFAULT_DRAWER_HEIGHT;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? clampHeight(parsed) : DEFAULT_DRAWER_HEIGHT;
}

function terminalTheme(): ITheme {
  const isDark = document.documentElement.classList.contains("dark");
  const rootStyles = getComputedStyle(document.documentElement);
  const background = rootStyles.getPropertyValue("--color-bg").trim() || (isDark ? "#0c0c0b" : "#f5f5f4");
  const foreground = rootStyles.getPropertyValue("--color-text").trim() || (isDark ? "#ececea" : "#1c1c1a");

  if (isDark) {
    return {
      background,
      foreground,
      cursor: "rgb(180, 203, 255)",
      selectionBackground: "rgba(180, 203, 255, 0.25)",
      scrollbarSliderBackground: "rgba(255, 255, 255, 0.1)",
      scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.18)",
      scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.22)",
      black: "#181e26",
      red: "#ff7a8e",
      green: "#86e795",
      yellow: "#f4cd72",
      blue: "#89beff",
      magenta: "#d0b0ff",
      cyan: "#7ce8ed",
      white: "#d2dae6",
      brightBlack: "#6e7888",
      brightRed: "#ffa8b4",
      brightGreen: "#b0f5ba",
      brightYellow: "#ffe095",
      brightBlue: "#aed2ff",
      brightMagenta: "#e5cbff",
      brightCyan: "#a7f4f7",
      brightWhite: "#f4f7fc",
    };
  }

  return {
    background,
    foreground,
    cursor: "rgb(38, 56, 78)",
    selectionBackground: "rgba(37, 63, 99, 0.2)",
    scrollbarSliderBackground: "rgba(0, 0, 0, 0.15)",
    scrollbarSliderHoverBackground: "rgba(0, 0, 0, 0.25)",
    scrollbarSliderActiveBackground: "rgba(0, 0, 0, 0.3)",
    black: "#2c3542",
    red: "#bf4657",
    green: "#3c7e56",
    yellow: "#927023",
    blue: "#4866a3",
    magenta: "#845695",
    cyan: "#357f8d",
    white: "#d2d7df",
    brightBlack: "#707b8c",
    brightRed: "#d45f70",
    brightGreen: "#55946f",
    brightYellow: "#ad852d",
    brightBlue: "#5b7cc2",
    brightMagenta: "#996bac",
    brightCyan: "#4695a4",
    brightWhite: "#ecf0f6",
  };
}

function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /mac/i.test(navigator.platform);
}

// ---------------------------------------------------------------------------
// TerminalViewport — single xterm instance connected to a WS/PTY session
// ---------------------------------------------------------------------------

interface TerminalViewportProps {
  terminalId: string;
  active: boolean;
  focusRequestId: number;
  resizeEpoch: number;
  drawerHeight: number;
  cwd?: string;
  onExited: () => void;
}

function TerminalViewport({
  terminalId,
  active,
  focusRequestId,
  resizeEpoch,
  drawerHeight,
  cwd,
  onExited,
}: TerminalViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const onExitedRef = useRef(onExited);

  useEffect(() => {
    onExitedRef.current = onExited;
  }, [onExited]);

  useEffect(() => {
    const mount = containerRef.current;
    if (!mount) return;

    let disposed = false;
    let connectTimer: ReturnType<typeof setTimeout> | null = null;

    const fitAddon = new FitAddon();
    const terminal = new Terminal({
      cursorBlink: true,
      lineHeight: 1.2,
      fontSize: 12,
      scrollback: 5_000,
      fontFamily:
        '"SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
      theme: terminalTheme(),
    });
    terminal.loadAddon(fitAddon);
    terminal.open(mount);

    termRef.current = terminal;
    fitRef.current = fitAddon;

    const connectWs = async () => {
      if (disposed) return;

      // Fit now that the container has layout dimensions
      fitAddon.fit();
      const cols = terminal.cols > 0 ? terminal.cols : 80;
      const rows = terminal.rows > 0 ? terminal.rows : 24;

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";

      let useProxy = false;
      let wsPort = DEFAULT_WS_PORT;
      try {
        const res = await fetch("/api/terminal/port");
        const json = await res.json();
        if (json.port) wsPort = json.port;
        if (json.proxy) useProxy = true;
      } catch {}

      if (disposed) return;

      const wsUrl = useProxy
        ? `${protocol}//${window.location.host}/terminal-ws/`
        : `${protocol}//127.0.0.1:${wsPort}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) return;
        ws.send(
          JSON.stringify({
            type: "spawn",
            cols,
            rows,
            ...(cwd ? { cwd } : {}),
          }),
        );
      };

      ws.onmessage = (ev) => {
        if (disposed) return;
        let msg: { type: string; data?: string; exitCode?: number; signal?: number };
        try {
          msg = JSON.parse(ev.data as string);
        } catch {
          return;
        }
        if (msg.type === "output" && msg.data) {
          terminal.write(msg.data);
        } else if (msg.type === "exit") {
          terminal.write(`\r\n[process exited]\r\n`);
          onExitedRef.current();
        } else if (msg.type === "ready") {
          // Re-fit and send correct dimensions now that the shell is alive
          window.requestAnimationFrame(() => {
            if (disposed) return;
            fitAddon.fit();
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
            }
            if (active) terminal.focus();
          });
        }
      };

      ws.onerror = () => {
        if (disposed) return;
        terminal.write("\r\n\x1b[31m[terminal] connection failed — is the server running?\x1b[0m\r\n");
      };

      ws.onclose = () => {
        if (disposed) return;
        terminal.write("\r\n[connection closed]\r\n");
      };

      terminal.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data }));
        }
      });
    };

    // Defer WS connection until the container has been laid out (next frame + small buffer)
    connectTimer = setTimeout(connectWs, 50);

    const sendToWs = (data: string) => {
      const w = wsRef.current;
      if (w && w.readyState === WebSocket.OPEN) {
        w.send(JSON.stringify({ type: "input", data }));
      }
    };

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const key = event.key.toLowerCase();

      // Cmd+K / Ctrl+L — clear terminal
      if (
        (isMac() && key === "k" && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) ||
        (key === "l" && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey)
      ) {
        event.preventDefault();
        sendToWs("\u000c");
        return false;
      }

      // Cmd+J — let it bubble to toggle the drawer
      if (
        key === "j" &&
        ((isMac() && event.metaKey) || (!isMac() && event.ctrlKey)) &&
        !event.altKey &&
        !event.shiftKey
      ) {
        return false;
      }

      // Option+Left/Right — word navigation
      if (isMac() && event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
        if (key === "arrowleft") { event.preventDefault(); sendToWs("\x1bb"); return false; }
        if (key === "arrowright") { event.preventDefault(); sendToWs("\x1bf"); return false; }
      }

      // Cmd+Left/Right — line start/end
      if (isMac() && event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey) {
        if (key === "arrowleft") { event.preventDefault(); sendToWs("\x01"); return false; }
        if (key === "arrowright") { event.preventDefault(); sendToWs("\x05"); return false; }
      }

      return true;
    });

    // Theme observer — defer read until after CSS recalculates
    let themeFrame: number | null = null;
    const applyTheme = () => {
      if (themeFrame !== null) cancelAnimationFrame(themeFrame);
      themeFrame = requestAnimationFrame(() => {
        themeFrame = null;
        const t = termRef.current;
        if (!t) return;
        t.options.theme = terminalTheme();
        t.refresh(0, t.rows - 1);
      });
    };

    const themeObserver = new MutationObserver(applyTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    themeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    const colorSchemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
    colorSchemeQuery.addEventListener("change", applyTheme);

    return () => {
      disposed = true;
      if (connectTimer !== null) clearTimeout(connectTimer);
      themeObserver.disconnect();
      colorSchemeQuery.removeEventListener("change", applyTheme);
      if (themeFrame !== null) cancelAnimationFrame(themeFrame);
      if (wsRef.current) wsRef.current.close();
      wsRef.current = null;
      termRef.current = null;
      fitRef.current = null;
      terminal.dispose();
    };
    // terminalId is the stable identity; active only used at mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId]);

  // Focus when becoming active
  useEffect(() => {
    if (!active) return;
    const t = termRef.current;
    if (!t) return;
    const frame = window.requestAnimationFrame(() => t.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [active, focusRequestId]);

  // Re-fit on resize
  useEffect(() => {
    const t = termRef.current;
    const f = fitRef.current;
    const ws = wsRef.current;
    if (!t || !f) return;
    const frame = window.requestAnimationFrame(() => {
      const wasAtBottom = t.buffer.active.viewportY >= t.buffer.active.baseY;
      f.fit();
      if (wasAtBottom) t.scrollToBottom();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: t.cols, rows: t.rows }));
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [drawerHeight, resizeEpoch]);

  return <div ref={containerRef} className="h-full w-full overflow-hidden rounded-[4px]" />;
}

// ---------------------------------------------------------------------------
// TerminalDrawer — T3 Code-style bottom drawer
// ---------------------------------------------------------------------------

interface TerminalDrawerProps {
  onClose: () => void;
  cwd?: string;
}

interface TerminalTab {
  id: string;
  label: string;
}

export default function TerminalDrawer({ onClose, cwd }: TerminalDrawerProps) {
  const [drawerHeight, setDrawerHeight] = useState(loadHeight);
  const [resizeEpoch, setResizeEpoch] = useState(0);
  const [focusRequestId, setFocusRequestId] = useState(0);
  const [terminals, setTerminals] = useState<TerminalTab[]>(() => [
    { id: crypto.randomUUID(), label: "Terminal 1" },
  ]);
  const [activeId, setActiveId] = useState(() => terminals[0].id);

  const drawerHeightRef = useRef(drawerHeight);
  const resizeStateRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);
  const didResizeRef = useRef(false);

  useEffect(() => {
    drawerHeightRef.current = drawerHeight;
  }, [drawerHeight]);

  // Persist height
  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, String(drawerHeight));
  }, [drawerHeight]);

  // Window resize
  useEffect(() => {
    const onResize = () => {
      const clamped = clampHeight(drawerHeightRef.current);
      if (clamped !== drawerHeightRef.current) {
        setDrawerHeight(clamped);
        drawerHeightRef.current = clamped;
      }
      setResizeEpoch((v) => v + 1);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Drag resize handlers
  const handlePointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    didResizeRef.current = false;
    resizeStateRef.current = {
      pointerId: e.pointerId,
      startY: e.clientY,
      startHeight: drawerHeightRef.current,
    };
  }, []);

  const handlePointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const state = resizeStateRef.current;
    if (!state || state.pointerId !== e.pointerId) return;
    e.preventDefault();
    const next = clampHeight(state.startHeight + (state.startY - e.clientY));
    if (next === drawerHeightRef.current) return;
    didResizeRef.current = true;
    drawerHeightRef.current = next;
    setDrawerHeight(next);
  }, []);

  const handlePointerEnd = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const state = resizeStateRef.current;
    if (!state || state.pointerId !== e.pointerId) return;
    resizeStateRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (didResizeRef.current) {
      setResizeEpoch((v) => v + 1);
    }
  }, []);

  // Terminal management
  const addTerminal = useCallback(() => {
    if (terminals.length >= MAX_TERMINALS) return;
    const id = crypto.randomUUID();
    const label = `Terminal ${terminals.length + 1}`;
    setTerminals((prev) => [...prev, { id, label }]);
    setActiveId(id);
    setFocusRequestId((v) => v + 1);
  }, [terminals.length]);

  const closeTerminal = useCallback(
    (id: string) => {
      setTerminals((prev) => {
        const next = prev.filter((t) => t.id !== id);
        if (next.length === 0) {
          onClose();
          return prev;
        }
        return next;
      });
      if (activeId === id) {
        setActiveId((prev) => {
          const remaining = terminals.filter((t) => t.id !== id);
          return remaining[0]?.id ?? prev;
        });
      }
    },
    [activeId, terminals, onClose],
  );

  const handleExited = useCallback(
    (_id: string) => {
      // Keep the drawer open so the user can see "[process exited]" and any
      // error output. They can close manually with Cmd+J or the close button.
    },
    [],
  );

  const hasMultiple = terminals.length > 1;
  const hasReachedLimit = terminals.length >= MAX_TERMINALS;

  const terminalLabels = useMemo(
    () => new Map(terminals.map((t, i) => [t.id, `Terminal ${i + 1}`])),
    [terminals],
  );

  return (
    <aside
      className="relative flex min-w-0 shrink-0 flex-col overflow-hidden"
      style={{
        height: `${drawerHeight}px`,
        borderTop: "1px solid var(--color-border)",
        background: "var(--color-bg)",
      }}
    >
      {/* Resize handle */}
      <div
        className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
      />

      {/* Action buttons (when single terminal) */}
      {!hasMultiple && (
        <div className="pointer-events-none absolute right-2 top-2 z-20">
          <div
            className="pointer-events-auto inline-flex items-center overflow-hidden rounded-md"
            style={{ border: "1px solid var(--color-border)", background: "var(--color-surface)" }}
          >
            <ActionButton
              label={hasReachedLimit ? `New Terminal (max ${MAX_TERMINALS})` : "New Terminal"}
              disabled={hasReachedLimit}
              onClick={addTerminal}
            >
              <PlusIcon />
            </ActionButton>
            <div className="h-4 w-px" style={{ background: "var(--color-border)" }} />
            <ActionButton label="Close Terminal" onClick={onClose}>
              <TrashIcon />
            </ActionButton>
          </div>
        </div>
      )}

      <div className="min-h-0 w-full flex-1">
        <div className={`flex h-full min-h-0 ${hasMultiple ? "gap-0" : ""}`}>
          {/* Terminal viewports */}
          <div className="min-w-0 flex-1">
            <div className="h-full p-1">
              {terminals.map((tab) => (
                <div
                  key={tab.id}
                  className="h-full"
                  style={{ display: tab.id === activeId ? "block" : "none" }}
                >
                  <TerminalViewport
                    terminalId={tab.id}
                    active={tab.id === activeId}
                    focusRequestId={focusRequestId}
                    resizeEpoch={resizeEpoch}
                    drawerHeight={drawerHeight}
                    cwd={cwd}
                    onExited={() => handleExited(tab.id)}
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Terminal sidebar (when multiple) */}
          {hasMultiple && (
            <aside
              className="flex w-36 min-w-36 flex-col"
              style={{
                borderLeft: "1px solid var(--color-border)",
                background: "var(--color-surface)",
              }}
            >
              <div
                className="flex h-[28px] items-stretch justify-end"
                style={{ borderBottom: "1px solid var(--color-border)" }}
              >
                <div className="inline-flex h-full items-stretch">
                  <ActionButton
                    label={
                      hasReachedLimit ? `New Terminal (max ${MAX_TERMINALS})` : "New Terminal"
                    }
                    disabled={hasReachedLimit}
                    onClick={addTerminal}
                    className="inline-flex h-full items-center px-1.5"
                  >
                    <PlusIcon />
                  </ActionButton>
                  <ActionButton
                    label="Close Terminal"
                    onClick={() => closeTerminal(activeId)}
                    className="inline-flex h-full items-center px-1.5"
                    borderLeft
                  >
                    <TrashIcon />
                  </ActionButton>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
                {terminals.map((tab) => {
                  const isActive = tab.id === activeId;
                  return (
                    <div
                      key={tab.id}
                      className="group flex items-center gap-1 rounded px-1 py-0.5 text-[11px]"
                      style={{
                        background: isActive ? "var(--color-accent-light)" : "transparent",
                        color: isActive ? "var(--color-text)" : "var(--color-text-muted)",
                      }}
                      onMouseEnter={(e) => {
                        if (!isActive) (e.currentTarget as HTMLElement).style.background = "var(--color-surface-hover)";
                      }}
                      onMouseLeave={(e) => {
                        if (!isActive) (e.currentTarget as HTMLElement).style.background = "transparent";
                      }}
                    >
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-1 text-left"
                        onClick={() => {
                          setActiveId(tab.id);
                          setFocusRequestId((v) => v + 1);
                        }}
                      >
                        <TerminalIcon />
                        <span className="truncate">
                          {terminalLabels.get(tab.id) ?? "Terminal"}
                        </span>
                      </button>
                      {hasMultiple && (
                        <button
                          type="button"
                          className="inline-flex items-center justify-center rounded md:opacity-0 md:group-hover:opacity-100"
                          style={{
                            width: 14,
                            height: 14,
                            color: "var(--color-text-muted)",
                          }}
                          onClick={() => closeTerminal(tab.id)}
                          title={`Close ${terminalLabels.get(tab.id) ?? "terminal"}`}
                        >
                          <XIcon />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </aside>
          )}
        </div>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Small icons (inline SVGs matching Lucide style)
// ---------------------------------------------------------------------------

function ActionButton({
  label,
  disabled,
  onClick,
  children,
  className,
  borderLeft,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
  borderLeft?: boolean;
}) {
  return (
    <button
      type="button"
      className={className ?? "p-1"}
      onClick={disabled ? undefined : onClick}
      aria-label={label}
      title={label}
      style={{
        color: "var(--color-text-muted)",
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
        borderLeft: borderLeft ? "1px solid var(--color-border)" : undefined,
      }}
      onMouseEnter={(e) => {
        if (!disabled) (e.currentTarget as HTMLElement).style.background = "var(--color-surface-hover)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = "transparent";
      }}
    >
      {children}
    </button>
  );
}

function PlusIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14" /><path d="M12 5v14" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 10 11 4 5" /><line x1="12" x2="20" y1="19" y2="19" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18" /><path d="m6 6 12 12" />
    </svg>
  );
}
