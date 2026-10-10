import "@solidjs/web";

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "workboard-inline-text": HTMLAttributes<HTMLElement>;
      "openclaw-workboard-session-status": HTMLAttributes<HTMLElement>;
      "openclaw-workboard-toast": HTMLAttributes<HTMLElement>;
    }
  }
}
