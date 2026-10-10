import type { JSX } from "@solidjs/web";

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "workboard-inline-text": JSX.HTMLAttributes<HTMLElement>;
      "openclaw-workboard-session-status": JSX.HTMLAttributes<HTMLElement>;
      "openclaw-workboard-toast": JSX.HTMLAttributes<HTMLElement>;
    }
  }
}
