import type { MeetingParticipationSource } from "openclaw/plugin-sdk/meeting-runtime";

/** Source facts are supplied only by the live meeting owner, never tool arguments. */
export function meetParticipationSourceCheck(params: {
  meetingSessionId: string;
  source?: MeetingParticipationSource;
}): string {
  return `
  const expectedNativeSource = ${JSON.stringify(params.source)};
  const sourceCurrent = () => {
    const source = expectedNativeSource;
    if (!source) return true;
    if (!source.finalized || source.ownEcho === true) return false;
    if (source.kind === "caption") {
      const captions = window.__openclawMeetCaptions;
      if (captions?.sessionId !== ${JSON.stringify(params.meetingSessionId)} || captions.epoch !== source.epoch) return false;
      if ((captions.sourceRevisions?.get(source.id) || 0) > Number(source.revision)) return false;
      return [...(captions.lines || []), ...(captions.visible || [])].some((entry) =>
        entry.source?.id === source.id && entry.source.epoch === source.epoch &&
        entry.source.revision === source.revision && entry.source.finalized === true &&
        entry.source.ownEcho !== true && entry.text === source.text);
    }
    if (source.kind !== "chat" || source.ownEcho !== false) return false;
    const chat = window.__openclawMeetChat;
    const recorded = chat?.messages?.get(source.id);
    if (chat?.sessionId !== ${JSON.stringify(params.meetingSessionId)} || chat.disconnected || chat.epoch !== source.epoch ||
      !recorded?.finalized || recorded.historical || recorded.revision !== source.revision || recorded.text !== source.text) return false;
    const rows = [...document.querySelectorAll(".RLrADb[data-message-id]")]
      .filter((row) => row.getAttribute("data-message-id") === source.id);
    if (rows.length !== 1) return false;
    const row = rows[0];
    const sender = row.closest(".aops0b")?.querySelector(".HNucUd")?.querySelector(".poVWob");
    const value = (node) => (node?.innerText || node?.textContent || "").trim();
    return Boolean(sender && value(sender) && row.querySelector(".jO4O1:not(.chmVPb)") &&
      !row.querySelector(".jO4O1.chmVPb") && value(row.querySelector('div[jsname="dTKtvb"]')) === source.text);
  };
  `;
}
