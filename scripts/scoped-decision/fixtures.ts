import type { DecisionFixture, HostState } from "./types.ts";

const host: HostState = {
  actorId: "fixture-owner",
  sourceId: "home",
  decisionGrants: ["campaign-x", "campaign-y"],
  activities: [
    { id: "campaign-x", label: "campaign X", currentDirection: "A", destinationId: "company" },
    { id: "campaign-y", label: "campaign Y", currentDirection: "A", destinationId: "family" },
  ],
  releases: [
    {
      id: "release-x",
      sourceId: "home",
      activityId: "campaign-x",
      destinationId: "company",
      directions: ["A", "B"],
      allowed: true,
      importAllowed: true,
    },
    {
      id: "release-y",
      sourceId: "home",
      activityId: "campaign-y",
      destinationId: "family",
      directions: ["A", "B"],
      allowed: true,
      importAllowed: true,
    },
  ],
};
const directive = { kind: "directive", activityId: "campaign-x", direction: "B" } as const;
const positive = { ...directive, previews: true };
const noDirective = { kind: "none", previews: false } as const;

function fixture(
  id: string,
  message: string,
  expected: DecisionFixture["expected"],
  replay: unknown = directive,
  changeHost?: (state: HostState) => void,
): DecisionFixture {
  const state = structuredClone(host);
  changeHost?.(state);
  return {
    id,
    message,
    host: state,
    expected,
    replay: typeof replay === "string" ? replay : JSON.stringify(replay),
  };
}

// Replay answers deliberately include mistakes. These are not measured model outputs.
export const fixtures: DecisionFixture[] = [
  fixture("clear-authorized", "Use B for campaign X.", positive),
  fixture("brainstorm", "Maybe we should use B for campaign X.", noDirective),
  fixture("negated", "Don't use B for campaign X.", noDirective),
  fixture("quoted", 'Someone said: "Use B for campaign X."', noDirective),
  fixture("ambiguous-activity", "Use B for campaign.", { kind: "clarify", previews: false }),
  fixture("wrong-allowed-activity", "Use B for campaign X.", positive, {
    ...directive,
    activityId: "campaign-y",
  }),
  fixture("wrong-direction", "Use B for campaign X.", positive, { ...directive, direction: "A" }),
  fixture(
    "denied-authority",
    "Use B for campaign X.",
    { ...positive, previews: false },
    directive,
    (state) => {
      state.decisionGrants = [];
    },
  ),
  fixture(
    "denied-disclosure",
    "Use B for campaign X.",
    { ...positive, previews: false },
    directive,
    (state) => {
      const release = state.releases[0];
      if (!release) {
        throw new Error("Fixture release missing.");
      }
      release.allowed = false;
    },
  ),
  fixture(
    "denied-import",
    "Use B for campaign X.",
    { ...positive, previews: false },
    directive,
    (state) => {
      const release = state.releases[0];
      if (!release) {
        throw new Error("Fixture release missing.");
      }
      release.importAllowed = false;
    },
  ),
  fixture(
    "conflicting-policy",
    "Use B for campaign X.",
    { ...positive, previews: false },
    directive,
    (state) => {
      const release = state.releases[0];
      if (!release) {
        throw new Error("Fixture release missing.");
      }
      state.releases.push({ ...release, id: "release-conflict", allowed: false });
    },
  ),
  fixture("malformed-candidate", "Use B for campaign X.", positive, "not JSON"),
  fixture("spoofed-policy", "Use B for campaign X.", positive, {
    ...directive,
    sharingPolicy: "public",
  }),
  fixture(
    "private-rationale",
    "Use B for campaign X. Keep PRIVATE_RATIONALE_CANARY local.",
    noDirective,
  ),
  fixture("stop-observed", "Stop campaign X now.", { kind: "stop", previews: false }),
];
