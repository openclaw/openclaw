// The stress harness runs this fixture in a fresh process before starting each dist Gateway.
// Reuse the offline session/transcript/registry writers; never copy live state databases.
import { generateTeamShapeFixture, parseTeamShapeOptions } from "./team-shape-fixture.ts";

export async function generateTeamShapeStressFixture(options: {
  stateDir: string;
  port: number;
  seed: number;
  sessions?: number;
  transcriptMiB?: number;
}) {
  const sessions = options.sessions ?? 10_800;
  if (!Number.isSafeInteger(sessions) || sessions < 100) {
    throw new Error("Stress fixtures require an integer session count >= 100");
  }
  return generateTeamShapeFixture(
    parseTeamShapeOptions([
      "--state-dir",
      options.stateDir,
      "--port",
      String(options.port),
      "--seed",
      String(options.seed),
      "--sessions",
      String(sessions),
      "--runs",
      String(Math.floor((sessions * 4_300) / 10_800)),
      "--settled-runs",
      "--team-stress",
      "--transcript-mib",
      String(options.transcriptMiB ?? 128),
      "--projects",
      "4",
      "--approvals",
      "24",
      "--cron",
      "40",
    ]),
  );
}
