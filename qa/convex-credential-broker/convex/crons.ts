import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "qa-credential-lease-event-retention",
  { hours: 1 },
  internal.credentials.cleanupLeaseEvents,
  {},
);

export default crons;
