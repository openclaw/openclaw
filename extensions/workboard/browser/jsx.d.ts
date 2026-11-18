import "@solidjs/web";

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-modal-actions": HTMLAttributes<HTMLElement>;
      "workboard-inline-text": HTMLAttributes<HTMLElement>;
      "openclaw-workboard-session-status": HTMLAttributes<HTMLElement>;
      "openclaw-workboard-toast": HTMLAttributes<HTMLElement>;
    }
  }
}
