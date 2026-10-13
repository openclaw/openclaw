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

function strokePath(d: string) {
  return (
    <StrokeIcon>
      <path d={d} />
    </StrokeIcon>
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
    return strokePath("M5 3h14M5 21h14M7 3v4l5 5-5 5v4M17 3v4l-5 5 5 5v4");
  },
  get priorityLow() {
    return strokePath("m6 9 6 5 6-5");
  },
  get priorityNormal() {
    return strokePath("M6 12h12");
  },
  get priorityHigh() {
    return strokePath("m6 15 6-5 6 5");
  },
  get priorityUrgent() {
    return strokePath("m6 10 6-5 6 5m-12 9 6-5 6 5");
  },
  get check() {
    return strokePath("M20 6 9 17l-5-5");
  },
  get chevronDown() {
    return strokePath("M6 9l6 6 6-6");
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
    return strokePath("m9 6 6 6-6 6");
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
    return strokePath("M3 6h18M7 12h10M10 18h4");
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
    return strokePath("M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8M21 3v5h-5");
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
    return strokePath(
      "M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z",
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
    return strokePath(
      "M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49M14.084 14.158a3 3 0 0 1-4.242-4.242M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143M2 2l20 20",
    );
  },
  get list() {
    return strokePath("M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01");
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
    return strokePath("M4 9h16M4 15h16M10 3l2 2 2-2M12 2v3M10 21l2-2 2 2M12 22v-3");
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
    return strokePath("M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z");
  },
  get play() {
    return (
      <StrokeIcon>
        <path d="m7 4 13 8-13 8Z" fill="currentColor" stroke="none" />
      </StrokeIcon>
    );
  },
  get plus() {
    return strokePath("M5 12h14M12 5v14");
  },
  get stop() {
    return (
      <StrokeIcon>
        <rect width="14" height="14" x="5" y="5" rx="1" />
      </StrokeIcon>
    );
  },
  get trash() {
    return strokePath(
      "M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2M10 11v6M14 11v6",
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
  get calendar() {
    return strokePath(
      "M8 2v4M16 2v4M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM3 10h18",
    );
  },
  get dollar() {
    return strokePath("M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6");
  },
  get externalLink() {
    return strokePath(
      "M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
    );
  },
  get inbox() {
    return strokePath(
      "M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z",
    );
  },
  get lightbulb() {
    return strokePath(
      "M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5M9 18h6M10 22h4",
    );
  },
  get mail() {
    return strokePath(
      "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm18 3-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7",
    );
  },
  get megaphone() {
    return strokePath("m3 11 18-5v12L3 14v-3zM11.6 16.8a3 3 0 1 1-5.8-1.6");
  },
  get send() {
    return strokePath(
      "M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11zM21.854 2.147l-10.94 10.939",
    );
  },
  get shield() {
    return strokePath(
      "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
    );
  },
  get signpost() {
    return strokePath(
      "M12 13v8M12 3v3M18 6a2 2 0 0 1 1.387.56l2.307 2.22a1 1 0 0 1 0 1.44l-2.307 2.22A2 2 0 0 1 18 13H6a2 2 0 0 1-1.387-.56l-2.307-2.22a1 1 0 0 1 0-1.44l2.307-2.22A2 2 0 0 1 6 6z",
    );
  },
  get trendingUp() {
    return strokePath("M22 7l-8.5 8.5-5-5L2 17M16 7h6v6");
  },
  get undo() {
    return strokePath("M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11");
  },
};
