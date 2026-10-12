/** @jsxImportSource @solidjs/web */
import type { JSX } from "@solidjs/web";

function StrokeIcon(props: { children: JSX.Element }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      {props.children}
    </svg>
  );
}
export const icons = {
  get gitPullRequest() {
    return (
      <StrokeIcon>
        <circle cx="6" cy="6" r="3" />
        <circle cx="18" cy="18" r="3" />
        <path d="M13 6h3a2 2 0 0 1 2 2v7M6 9v12" />
      </StrokeIcon>
    );
  },
  get gitMerge() {
    return (
      <StrokeIcon>
        <circle cx="6" cy="6" r="3" />
        <circle cx="18" cy="18" r="3" />
        <path d="M6 21V9a9 9 0 0 0 9 9" />
      </StrokeIcon>
    );
  },
  get paperclip() {
    return (
      <StrokeIcon>
        {" "}
        <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
      </StrokeIcon>
    );
  },
  get fileText() {
    return (
      <StrokeIcon>
        {" "}
        <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" x2="8" y1="13" y2="13" />
        <line x1="16" x2="8" y1="17" y2="17" />
        <line x1="10" x2="8" y1="9" y2="9" />
      </StrokeIcon>
    );
  },
  get info() {
    return (
      <StrokeIcon>
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4" />
        <path d="M12 8h.01" />
      </StrokeIcon>
    );
  },

  get hourglass() {
    return (
      <StrokeIcon>
        <path d="M5 3h14M5 21h14M7 3v4l5 5-5 5v4M17 3v4l-5 5 5 5v4" />
      </StrokeIcon>
    );
  },
  get priorityLow() {
    return (
      <StrokeIcon>
        <path d="m6 9 6 5 6-5" />
      </StrokeIcon>
    );
  },
  get priorityNormal() {
    return (
      <StrokeIcon>
        <path d="M6 12h12" />
      </StrokeIcon>
    );
  },
  get priorityHigh() {
    return (
      <StrokeIcon>
        <path d="m6 15 6-5 6 5" />
      </StrokeIcon>
    );
  },
  get priorityUrgent() {
    return (
      <StrokeIcon>
        <path d="m6 10 6-5 6 5m-12 9 6-5 6 5" />
      </StrokeIcon>
    );
  },
  get check() {
    return (
      <StrokeIcon>
        <path d="M20 6 9 17l-5-5" />
      </StrokeIcon>
    );
  },
  get chevronDown() {
    return (
      <StrokeIcon>
        <path d="M6 9l6 6 6-6" />
      </StrokeIcon>
    );
  },
  get chevronsUpDown() {
    return (
      <StrokeIcon>
        <path d="m7 15 5 5 5-5" />
        <path d="m7 9 5-5 5 5" />
      </StrokeIcon>
    );
  },
  get chevronRight() {
    return (
      <StrokeIcon>
        <path d="m9 6 6 6-6 6" />
      </StrokeIcon>
    );
  },
  get maximize() {
    return (
      <StrokeIcon>
        <polyline points="15 3 21 3 21 9" />
        <polyline points="9 21 3 21 3 15" />
        <line x1="21" x2="14" y1="3" y2="10" />
        <line x1="3" x2="10" y1="21" y2="14" />
      </StrokeIcon>
    );
  },
  get minimize() {
    return (
      <StrokeIcon>
        <polyline points="4 14 10 14 10 20" />
        <polyline points="20 10 14 10 14 4" />
        <line x1="14" x2="21" y1="10" y2="3" />
        <line x1="3" x2="10" y1="21" y2="14" />
      </StrokeIcon>
    );
  },
  get listFilter() {
    return (
      <StrokeIcon>
        <path d="M3 6h18M7 12h10M10 18h4" />
      </StrokeIcon>
    );
  },
  get moreHorizontal() {
    return (
      <StrokeIcon>
        <circle cx="5" cy="12" r="1" />
        <circle cx="12" cy="12" r="1" />
        <circle cx="19" cy="12" r="1" />
      </StrokeIcon>
    );
  },
  get refresh() {
    return (
      <StrokeIcon>
        <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8M21 3v5h-5" />
      </StrokeIcon>
    );
  },
  get search() {
    return (
      <StrokeIcon>
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.3-4.3" />
      </StrokeIcon>
    );
  },
  get alertTriangle() {
    return (
      <StrokeIcon>
        {" "}
        <path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
      </StrokeIcon>
    );
  },
  get archive() {
    return (
      <StrokeIcon>
        {" "}
        <rect width="20" height="5" x="2" y="3" rx="1" />
        <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
        <path d="M10 12h4" />
      </StrokeIcon>
    );
  },
  get archiveRestore() {
    return (
      <StrokeIcon>
        {" "}
        <rect width="20" height="5" x="2" y="3" rx="1" />
        <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
        <path d="m9 15 3-3 3 3" />
        <path d="M12 12v6" />
      </StrokeIcon>
    );
  },
  get bot() {
    return (
      <StrokeIcon>
        {" "}
        <path d="M12 8V4H8" />
        <rect width="16" height="12" x="4" y="8" rx="2" />
        <path d="M2 14h2" />
        <path d="M20 14h2" />
        <path d="M15 13v2" />
        <path d="M9 13v2" />
      </StrokeIcon>
    );
  },
  get calendarClock() {
    return (
      <StrokeIcon>
        {" "}
        <path d="M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5" />
        <path d="M16 2v4" />
        <path d="M8 2v4" />
        <path d="M3 10h5" />
        <path d="M17.5 17.5 16 16.3V14" />
        <circle cx="16" cy="16" r="6" />
      </StrokeIcon>
    );
  },
  get edit() {
    return (
      <StrokeIcon>
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
      </StrokeIcon>
    );
  },
  get eye() {
    return (
      <StrokeIcon>
        {" "}
        <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
        <circle cx="12" cy="12" r="3" />
      </StrokeIcon>
    );
  },
  get eyeOff() {
    return (
      <StrokeIcon>
        <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49M14.084 14.158a3 3 0 0 1-4.242-4.242M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143M2 2l20 20" />
      </StrokeIcon>
    );
  },
  get list() {
    return (
      <StrokeIcon>
        <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
      </StrokeIcon>
    );
  },
  get kanban() {
    return (
      <StrokeIcon>
        {" "}
        <rect width="18" height="18" x="3" y="3" rx="2" />
        <path d="M8 7v7" />
        <path d="M12 7v4" />
        <path d="M16 7v9" />
      </StrokeIcon>
    );
  },
  get layoutComfortable() {
    return (
      <StrokeIcon>
        <rect x="4" y="8" width="16" height="8" rx="2" />
        <path d="m10 4 2-2 2 2m-2-2v4m-2 14 2 2 2-2m-2 2v-4" />
      </StrokeIcon>
    );
  },
  get layoutCompact() {
    return (
      <StrokeIcon>
        <path d="M4 9h16M4 15h16M10 3l2 2 2-2M12 2v3M10 21l2-2 2 2M12 22v-3" />
      </StrokeIcon>
    );
  },
  get messageSquare() {
    return (
      <StrokeIcon>
        {" "}
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </StrokeIcon>
    );
  },
  get penLine() {
    return (
      <StrokeIcon>
        <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
      </StrokeIcon>
    );
  },
  get play() {
    return (
      <StrokeIcon>
        <path d="m7 4 13 8-13 8Z" fill="currentColor" stroke="none" />
      </StrokeIcon>
    );
  },
  get plus() {
    return (
      <StrokeIcon>
        <path d="M5 12h14M12 5v14" />
      </StrokeIcon>
    );
  },
  get stop() {
    return (
      <StrokeIcon>
        <rect width="14" height="14" x="5" y="5" rx="1" />
      </StrokeIcon>
    );
  },
  get trash() {
    return (
      <StrokeIcon>
        <path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2M10 11v6M14 11v6" />
      </StrokeIcon>
    );
  },
  get x() {
    return (
      <StrokeIcon>
        {" "}
        <path d="M18 6 6 18" />
        <path d="m6 6 12 12" />
      </StrokeIcon>
    );
  },
};
