import { proxyActivities } from "@temporalio/workflow";

const { readTicket, readTimeline } = proxyActivities({
  startToCloseTimeout: "1 minute",
});

function toSafeObject(value) {
  return value && typeof value === "object" ? value : null;
}

export async function ticketReadbackWorkflow(input) {
  let ticketId = input?.ticketId;
  if (typeof ticketId !== "string" || ticketId.trim() === "") {
    throw new Error("ticketId is required");
  }

  ticketId = ticketId.trim();
  let closureArtifact = null;
  let ticket = null;
  let timeline = null;

  ticket = await readTicket(ticketId, toSafeObject(input));
  timeline = await readTimeline(ticketId, toSafeObject(input));

  closureArtifact = {
    ticketId,
    hasTicket: Boolean(ticket),
    timelineLength: Array.isArray(timeline) ? timeline.length : 0,
  };
  return closureArtifact;
}
