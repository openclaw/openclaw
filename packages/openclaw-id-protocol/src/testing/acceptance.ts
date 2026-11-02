// Owner-key spec section 11 acceptance tests: what this package proves at the protocol
// level, and the end-to-end tests the integration worker must add (by these exact names).

/** Component that owns an integration test. */
export type AcceptanceOwner = "loader" | "gateway" | "tunnel-child" | "discovery" | "control-ui";

/** One spec section 11 acceptance test. */
export type AcceptanceCase = {
  id: number;
  title: string;
  /** Protocol-level coverage in src/acceptance/*.test.ts (empty when only the full system can show it). */
  protocol: boolean;
  /** Tests that need the full system, with the component that owns them. */
  integration: { name: string; owner: AcceptanceOwner; asserts: string }[];
};

/** The twelve acceptance tests of owner-key spec v0.2 section 11. */
export const SPEC_11_ACCEPTANCE: readonly AcceptanceCase[] = [
  {
    id: 1,
    title: "descriptor substitution is refused before any socket or credential is used",
    protocol: true,
    integration: [
      {
        name: "id-e2e: substituted descriptor opens no iroh connection and reads no stored token",
        owner: "loader",
        asserts:
          "replay the spike's substitution against a pinned profile: no connect() to the substituted key, token store untouched",
      },
    ],
  },
  {
    id: 2,
    title: "SAS relay in the middle shows a mismatch; the commitment prevents grinding",
    protocol: true,
    integration: [
      {
        name: "id-e2e: SAS mismatch through the Discovery mailbox aborts on both screens",
        owner: "control-ui",
        asserts:
          "a mailbox relay that substitutes ephemeral keys yields different codes; confirming on one side and rejecting on the other aborts both and warns",
      },
    ],
  },
  {
    id: 3,
    title: "Discovery-forged MembershipChange or InviteCap is refused by the Gateway",
    protocol: true,
    integration: [
      {
        name: "id-e2e: forged statements injected into the real mailbox are refused and logged",
        owner: "gateway",
        asserts:
          "Gateway refuses with the protocol code, state unchanged, a security log line with fp labels only",
      },
    ],
  },
  {
    id: 4,
    title: "Discovery withholding a revocation does not keep the removed member connected",
    protocol: true,
    integration: [
      {
        name: "id-e2e: removed member is refused by the tunnel child while Discovery serves a stale snapshot",
        owner: "tunnel-child",
        asserts:
          "live connection closed with code 2 (revoked); a new connection is closed with code 1 (not_a_member) before any stream",
      },
    ],
  },
  {
    id: 5,
    title: "a device token replayed from a different peer key W is refused and logged",
    protocol: false,
    integration: [
      {
        name: "id-e2e: device token presented with another W is refused and logged as a security event",
        owner: "gateway",
        asserts:
          "the Gateway reads W from the ingress contract (never a client header), compares it with the token's bound W, refuses and logs",
      },
    ],
  },
  {
    id: 6,
    title: "a binding rollback to a client that has seen a higher seq is refused",
    protocol: true,
    integration: [
      {
        name: "id-e2e: loader refuses a rolled-back binding and keeps its stored pin",
        owner: "loader",
        asserts:
          "Discovery serves binding_seq n-1 after the client saw n: no socket, pin unchanged",
      },
    ],
  },
  {
    id: 7,
    title: "relayed traffic cannot perform a root ceremony even though it arrives on loopback",
    protocol: true,
    integration: [
      {
        name: "id-e2e: root ceremony through the tunnel child is refused; direct loopback succeeds",
        owner: "gateway",
        asserts:
          "the ingress classifies tunnel-child traffic as tunnel (per-boot proxy token), never as local_operator",
      },
    ],
  },
  {
    id: 8,
    title: "kit enrollment notifies every owner device and compacts chains",
    protocol: true,
    integration: [
      {
        name: "id-e2e: kit enrollment notifies every online owner device",
        owner: "control-ui",
        asserts: "each owner device shows the kit-used notice and offers a kit rotation",
      },
    ],
  },
  {
    id: 9,
    title:
      "conflicting root rotations freeze remote changes until the local operator resolves them",
    protocol: true,
    integration: [
      {
        name: "id-e2e: local operator resolves conflicting rotations",
        owner: "gateway",
        asserts:
          "frozen state survives a Gateway restart; the local-operator re-pin over direct loopback clears it",
      },
    ],
  },
  {
    id: 10,
    title: "the invite fragment never reaches a server, and a second redemption is refused",
    protocol: true,
    integration: [
      {
        name: "id-e2e: invite fragment never appears in Gateway, tunnel child, Discovery or relay logs",
        owner: "discovery",
        asserts:
          "grep every component log after a full invite flow for the secret and the fragment",
      },
    ],
  },
  {
    id: 11,
    title:
      "a redemption without owner approval stays pending; an approval via Discovery is refused",
    protocol: true,
    integration: [
      {
        name: "id-e2e: approval injected through the real mailbox is refused; pending expires after 7 days",
        owner: "gateway",
        asserts:
          "invitee cannot connect while pending; a mailbox-delivered approval is refused; expiry consumes the invite",
      },
    ],
  },
  {
    id: 12,
    title: "removing a member mid-run cancels the run and keeps the transcript up to the cut",
    protocol: true,
    integration: [
      {
        name: "id-e2e: removing a member mid-run cancels the run and keeps the transcript",
        owner: "gateway",
        asserts:
          "cancel_runs event cancels the member's active run; the transcript ends at the cut",
      },
    ],
  },
];

/** Title used for a case's describe block. */
export function acceptanceTitle(id: number): string {
  const entry = SPEC_11_ACCEPTANCE.find((candidate) => candidate.id === id);
  if (!entry) {
    throw new Error(`no acceptance case ${id}`);
  }
  return `spec 11.${id}: ${entry.title}`;
}
