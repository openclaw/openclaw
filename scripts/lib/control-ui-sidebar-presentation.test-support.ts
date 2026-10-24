/** Browser-only structural probe. Hidden actions and tooltip DOM never enter the signature. */
export function sidebarPresentationProbe() {
  const frames: Array<{
    at: number;
    cached: boolean;
    changed: boolean;
    rows: Array<{
      key: string;
      glyphs: string[];
      unread: number;
      pullRequests: string[];
      avatars: string[];
    }>;
    issues: { present: boolean; count: string | null };
    footerAvatars: string[];
    layout: {
      bodyHeight: number | null;
      chrome: Array<{ classes: string; height: number; top: number }>;
    };
  }> = [];
  const mutations: Array<{ at: number; count: number }> = [];
  const describes: Array<{
    key: string;
    requestedAt: number;
    receivedAt?: number;
    ownerType?: string;
    ownerIdentity?: string;
    unread?: boolean;
    status?: string;
    participants?: number;
  }> = [];
  const OriginalSocket = window.WebSocket;
  window.WebSocket = new Proxy(OriginalSocket, {
    construct(target, args) {
      const socket: WebSocket = Reflect.construct(target, args);
      const pending = new Map<string, (typeof describes)[number]>();
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        if (typeof data === "string") {
          const frame = JSON.parse(data);
          if (frame.type === "req" && frame.method === "sessions.describe") {
            const record = { key: String(frame.params?.key ?? ""), requestedAt: performance.now() };
            describes.push(record);
            pending.set(frame.id, record);
          }
        }
        send(data);
      };
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") {
          return;
        }
        const frame = JSON.parse(event.data);
        const record = pending.get(frame.id);
        if (record) {
          pending.delete(frame.id);
          const row = frame.payload?.session;
          Object.assign(record, {
            receivedAt: performance.now(),
            ownerType: row?.owner?.actor?.type,
            ownerIdentity: row?.owner?.actor?.identity?.type,
            unread: row?.unread,
            status: row?.status,
            participants: row?.participants?.length,
          });
        }
      });
      return socket;
    },
  });
  let stopped = false;
  let dirty = true;
  let signature: string | undefined;
  const avatar = (element: Element) => {
    const loaded = element.getAttribute("data-avatar-state") === "loaded";
    const image = element.querySelector("img");
    return [
      element.classList.contains("identity-avatar--agent") ? "agent" : "user",
      loaded
        ? "image"
        : element.getAttribute("data-avatar-state") === "pending"
          ? "pending"
          : "fallback",
      loaded && image?.complete && image.naturalWidth > 0 ? "decoded" : "",
      element.getAttribute("data-viewer-id") ?? "",
    ].join(":");
  };
  const avatarSelector = ".viewer-avatar:not(.viewer-avatar--overflow), .identity-avatar--agent";
  const observer = new MutationObserver((records) => {
    let count = 0;
    for (const record of records) {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      if (
        target?.closest("aside.sidebar") &&
        !target.closest(".session-action, .tooltip-surface, .sidebar-session-hovercard")
      ) {
        dirty = true;
        count++;
      }
    }
    if (count) {
      mutations.push({ at: performance.now(), count });
    }
  });
  observer.observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  const sample = () => {
    if (stopped) {
      return;
    }
    const sidebar = document.querySelector("aside.sidebar");
    if (sidebar && dirty) {
      dirty = false;
      const viewport = sidebar.querySelector(".sidebar-shell__body")?.getBoundingClientRect();
      const rows = [
        ...sidebar.querySelectorAll(".sidebar-session-content .sidebar-recent-session"),
      ].filter((row) => {
        const rect = row.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          (!viewport || (rect.bottom > viewport.top && rect.top < viewport.bottom))
        );
      });
      if (rows.length) {
        const presentation = {
          rows: rows.map((row) => ({
            key: row.getAttribute("data-session-key") ?? "",
            glyphs: [...row.querySelectorAll(".session-glyph")].map((glyph) =>
              JSON.stringify({
                classes: [...glyph.classList].filter(
                  (name) => name !== "session-run-indicator--offscreen",
                ),
                content: [...glyph.querySelectorAll(".session-glyph__content svg")]
                  .filter((svg) => !svg.closest(".viewer-avatar, .identity-avatar--agent"))
                  .map((svg) => svg.innerHTML),
                badge: glyph.querySelectorAll(".session-glyph__badge--unread").length,
              }),
            ),
            unread: row.querySelectorAll(".session-glyph__badge--unread, .session-unread-dot")
              .length,
            pullRequests: [...row.querySelectorAll(".session-row-badge--pull-request")].map(
              (badge) =>
                `${badge.getAttribute("data-pull-request-state")}:${badge.textContent?.trim() ?? ""}`,
            ),
            avatars: [...row.querySelectorAll(avatarSelector)].map(avatar),
          })),
          issues: {
            present: Boolean(sidebar.querySelector(".sidebar-issues-button")),
            count:
              sidebar.querySelector(".sidebar-issues-button__count")?.textContent?.trim() ?? null,
          },
          footerAvatars: [...sidebar.querySelectorAll(avatarSelector)]
            .filter((element) => !element.closest(".sidebar-recent-session, [popover]"))
            .map(avatar),
        };
        const next = JSON.stringify(presentation);
        const cached = sidebar.getAttribute("data-snapshot-state") === "cached";
        if (next !== signature || frames.at(-1)?.cached !== cached) {
          const changed = next !== signature;
          signature = next;
          frames.push({
            at: performance.now(),
            cached,
            changed,
            ...presentation,
            layout: {
              bodyHeight: viewport?.height ?? null,
              chrome: [
                ...sidebar.querySelectorAll(
                  ".sidebar-shell__footer, .sidebar-session-catalog-error, .sidebar-session-error, .gateway-status",
                ),
              ].map((element) => {
                const rect = element.getBoundingClientRect();
                return { classes: element.className, height: rect.height, top: rect.top };
              }),
            },
          });
        }
      }
    }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
  Reflect.set(window, "__sidebarPresentation", {
    read() {
      stopped = true;
      observer.disconnect();
      const firstCached = frames.findIndex((frame) => frame.cached);
      const afterFirstPaint = firstCached < 0 ? frames : frames.slice(firstCached);
      const handoff = afterFirstPaint.findIndex((frame) => !frame.cached);
      const before = afterFirstPaint[handoff - 1];
      const after = afterFirstPaint[handoff];
      const handoffChanges = { glyphs: 0, avatars: 0 };
      if (before && after) {
        for (const row of before.rows) {
          const live = after.rows.find((item) => item.key === row.key);
          if (live) {
            handoffChanges.glyphs += Number(
              JSON.stringify(row.glyphs) !== JSON.stringify(live.glyphs),
            );
            handoffChanges.avatars += Number(
              JSON.stringify(row.avatars) !== JSON.stringify(live.avatars),
            );
          }
        }
      }
      return {
        frames,
        mutations,
        describes,
        waves: Math.max(0, afterFirstPaint.filter((frame) => frame.changed).length - 1),
        handoffChanges,
      };
    },
  });
}
