import { useRef, useEffect, useState } from "react";
import { Terminal as XTerm } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { WebLinksAddon } from "xterm-addon-web-links";
import "xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  makeStyles,
  tokens,
  Spinner,
  Button,
} from "@fluentui/react-components";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowCounterclockwise20Regular } from "@fluentui/react-icons";

interface OnboardingTerminalProps {
  className?: string;
  onExit?: (code: number) => void;
}

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    width: "100%",
    height: "100%",
    backgroundColor: tokens.colorTransparentBackground,
    borderRadius: tokens.borderRadiusXLarge,
    overflow: "hidden",
    position: "relative",
  },
  terminalContainer: {
    flex: 1,
    padding: "16px",
    backgroundColor: tokens.colorTransparentBackground,
    fontFamily: "Cascadia Code, Consolas, monospace",
    fontSize: "13px",
    lineHeight: "1.4",

    "& .xterm": {
      padding: "0 !important",
    },

    "& .xterm-viewport": {
      backgroundColor: `${tokens.colorTransparentBackground} !important`,
    },

    "& .xterm-screen": {
      backgroundColor: `${tokens.colorTransparentBackground} !important`,
    },
  },
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.colorNeutralBackground2,
    zIndex: 100,
    gap: "16px",
    animationName: {
      from: { opacity: 0 },
      to: { opacity: 1 },
    },
    animationDuration: "0.2s",
    animationTimingFunction: "ease-out",
  },
});

export const OnboardingTerminal = ({
  className,
  onExit,
}: OnboardingTerminalProps) => {
  const styles = useStyles();
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<string | null>(null);

  const [isLoading, setIsLoading] = useState(true);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Cascadia Code, Consolas, "Courier New", monospace',
      allowTransparency: true,
      theme: {
        background: tokens.colorTransparentBackground,
        foreground: tokens.colorNeutralForeground1,
        cursor: tokens.colorBrandForeground1,
        selectionBackground: tokens.colorBrandBackground2,
      },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon((_event, url) => {
      openUrl(url).catch(console.error);
    });

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    let unlistenOutput: (() => void) | undefined;
    let unlistenExit: (() => void) | undefined;

    const startSession = async () => {
      setIsLoading(true);
      setExitCode(null);

      const id = crypto.randomUUID();
      sessionRef.current = id;

      try {
        // Register listeners before spawn so early output is not dropped.
        unlistenOutput = await listen<{ id: string; data: string }>(
          "terminal-output",
          (event) => {
            if (event.payload.id === id) {
              const cleanOutput = event.payload.data.replace(
                // eslint-disable-next-line no-control-regex
                /[\x1b\x9b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
                ""
              );
              if (/[a-zA-Z0-9]/.test(cleanOutput)) {
                setIsLoading(false);
              }
              if (xtermRef.current) xtermRef.current.write(event.payload.data);
            }
          }
        );

        unlistenExit = await listen<{ id: string; code: number }>(
          "terminal-exit",
          (event) => {
            console.log(
              `[OnboardingTerminal] Received terminal-exit for id ${id}:`,
              event.payload
            );
            if (id === event.payload.id) {
              setExitCode(event.payload.code);
              setIsLoading(false);
              if (onExit) onExit(event.payload.code);
            }
          }
        );

        const dims = fitAddon.proposeDimensions();
        await invoke<string>("run_onboarding_terminal", {
          id,
          rows: dims?.rows ?? 24,
          cols: dims?.cols ?? 80,
        });

        term.onData((data: string) => {
          if (data === "\x03") {
            const selection = term.getSelection();
            if (selection) {
              navigator.clipboard.writeText(selection);
              return;
            }
            return;
          }
          invoke("write_terminal_stdin", { id, input: data });
        });

        term.onResize((size: { cols: number; rows: number }) => {
          invoke("resize_terminal", { id, rows: size.rows, cols: size.cols });
        });
      } catch (error) {
        console.error("[OnboardingTerminal] Spawn error:", error);
        term.write(
          `\r\n\x1b[31mFailed to start onboarding terminal: ${error}\x1b[0m\r\n`
        );
        setIsLoading(false);
        setExitCode(1);
      }
    };

    startSession();

    const resizeObserver = new ResizeObserver(() => {
      if (fitAddonRef.current) fitAddonRef.current.fit();
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      if (sessionRef.current) {
        invoke("kill_terminal_command", { id: sessionRef.current }).catch(
          () => {}
        );
        sessionRef.current = null;
      }
      if (unlistenOutput) unlistenOutput();
      if (unlistenExit) unlistenExit();
      resizeObserver.disconnect();
      term.dispose();
      xtermRef.current = null;
    };
  }, [retryCount, onExit]);

  const handleRetry = () => {
    setRetryCount((prev) => prev + 1);
  };

  return (
    <div className={`${styles.root} ${className}`}>
      {isLoading && exitCode === null && (
        <div className={styles.overlay}>
          <Spinner />
        </div>
      )}

      {exitCode !== null && exitCode !== 0 && (
        <div className={styles.overlay}>
          <Button
            icon={<ArrowCounterclockwise20Regular />}
            onClick={handleRetry}
            appearance="primary"
          >
            Restart Onboarding
          </Button>
        </div>
      )}

      <div className={styles.terminalContainer} ref={containerRef} />
    </div>
  );
};
