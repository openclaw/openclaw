import { createHash } from "node:crypto";
import type { PluginStateKeyedStore } from "../api.js";
import type { ReadVisitorGatewayAccess } from "./access.js";
import { visitorTargetKey, type VisitorPolicyClient } from "./cloudflare.js";
import type { VisitorAccessConfig } from "./config.js";
import { VisitorAccessError } from "./errors.js";
import { visitorGrantTarget, type VisitorGrant } from "./grant-record.js";
import { accountSeatsText, expiryText } from "./invite-result.js";
import type { VisitorListDetails } from "./tool-results.js";
import { listSchema } from "./visitor-input.js";

const LIST_MAX_CHARS = 12_000;

// Called on the active service's queue; only reads and projects its existing owners.
export async function listVisitors(
  raw: unknown,
  {
    store,
    policy: client,
    readAccess,
    readLimits,
    assertCurrent,
  }: {
    store: Pick<PluginStateKeyedStore<VisitorGrant>, "entries">;
    policy: VisitorPolicyClient;
    readAccess: ReadVisitorGatewayAccess;
    readLimits: () => Pick<VisitorAccessConfig, "maxVisitors">;
    assertCurrent: () => void;
  },
): Promise<{ text: string; details: VisitorListDetails }> {
  const input = listSchema.safeParse(raw);
  if (!input.success) {
    throw new VisitorAccessError(
      "Invalid visitor list input. Use limit from 1 to 500 and the previous nextCursor, or omit cursor to start again.",
    );
  }
  const policy = await client.read(assertCurrent);
  const policyTargets = policy?.targets ?? [];
  const targetKeys = new Set(policyTargets.map(visitorTargetKey));
  const entries = (await store.entries()).toSorted((left, right) =>
    left.key.localeCompare(right.key),
  );
  assertCurrent();
  const managed = new Set(entries.map((entry) => entry.key));
  const unmanaged = policyTargets
    .filter((target) => !managed.has(visitorTargetKey(target)))
    .toSorted((left, right) => visitorTargetKey(left).localeCompare(visitorTargetKey(right)));
  // Bind offsets to the ordered inventory, not mutable access/metadata or service-local state.
  // A changed roster must restart instead of silently skipping or repeating shifted rows.
  const inventory = createHash("sha256")
    .update(JSON.stringify([entries.map(({ key }) => key), unmanaged.map(visitorTargetKey)]))
    .digest("hex");
  const offset = input.data.cursor ? Number(input.data.cursor.split(":")[2]) : 0;
  const total = entries.length + unmanaged.length;
  if (input.data.cursor && (input.data.cursor.split(":")[1] !== inventory || offset >= total)) {
    throw new VisitorAccessError(
      "Visitor inventory changed or cursor is invalid. Restart visitor_list without cursor.",
    );
  }
  const { maxVisitors } = readLimits();
  const pageSize = Math.min(input.data.limit ?? maxVisitors, maxVisitors);
  const pageEntries = entries.slice(offset, offset + pageSize);
  const pageUnmanaged = unmanaged.slice(
    Math.max(0, offset - entries.length),
    Math.max(0, offset + pageSize - entries.length),
  );
  const displayedTargets = [
    ...pageEntries.map(({ value }) => visitorGrantTarget(value)),
    ...pageUnmanaged,
  ];
  const access = await readAccess([
    ...new Set(displayedTargets.filter((target) => typeof target === "number")),
  ]);
  assertCurrent();
  const missing = entries.filter((entry) => !targetKeys.has(entry.key)).length;
  const accountSeats = await client.readAccountSeats(assertCurrent);
  const summary = `Visitors: ${entries.length} recorded; ${targetKeys.size} in policy. Drift: ${unmanaged.length} unmanaged, ${missing} missing from policy.`;
  const lines = [summary, accountSeatsText(accountSeats)];
  const details: VisitorListDetails = {
    accountSeats,
    counts: {
      recorded: entries.length,
      inPolicy: targetKeys.size,
      unmanaged: unmanaged.length,
      missingFromPolicy: missing,
    },
    grants: [],
    unmanaged: [],
    omitted: 0,
    nextCursor: null,
  };
  const rows: Array<
    | { line: string; grant: VisitorListDetails["grants"][number] }
    | { line: string; unmanaged: VisitorListDetails["unmanaged"][number] }
  > = pageEntries.map(({ value: grant }) => {
    const target = visitorGrantTarget(grant);
    const profileId = access.profileId(target);
    const missingFromPolicy = !targetKeys.has(visitorTargetKey(target));
    const expired = grant.expiresAt !== null && grant.expiresAt <= Date.now();
    const state = missingFromPolicy
      ? "MISSING FROM POLICY"
      : expired
        ? "EXPIRED; provider cleanup pending"
        : "managed";
    const gatewayAccess = access.describe(target);
    const githubLogin = access.githubLogin(target);
    const github = `Verified GitHub: ${githubLogin ? `@${githubLogin}` : "unavailable"}`;
    // Grants recorded before onboarding metadata have no welcome progress until first sign-in.
    const welcome = grant.onboarding && {
      state: grant.onboarding.state,
      ...(grant.onboarding.welcomeSessionKey
        ? { sessionKey: grant.onboarding.welcomeSessionKey }
        : {}),
    };
    const welcomeText = welcome
      ? ` | welcome ${welcome.state}${welcome.sessionKey ? ` ${welcome.sessionKey}` : ""}`
      : "";
    return {
      line: `${visitorTargetKey(target)} | ${github}${profileId ? ` | profileId ${profileId}` : ""}${grant.grantId ? ` | grantId ${grant.grantId}` : ""} | invited ${new Date(grant.createdAt).toISOString()} | grant expires ${expiryText(grant.expiresAt)} | ${state}${welcomeText} | ${gatewayAccess}`,
      grant: {
        ...(typeof target === "string" ? { email: target } : { githubAccountId: target }),
        ...(grant.grantId ? { grantId: grant.grantId } : {}),
        ...(profileId ? { profileId } : {}),
        ...(githubLogin ? { githubLogin } : {}),
        invitedAt: new Date(grant.createdAt).toISOString(),
        expiresAt: grant.expiresAt === null ? null : new Date(grant.expiresAt).toISOString(),
        state: missingFromPolicy ? "missing_from_policy" : expired ? "expired" : "managed",
        ...(welcome ? { welcome } : {}),
        gatewayAccess,
      },
    };
  });
  rows.push(
    ...pageUnmanaged.map((target) => {
      const gatewayAccess = access.describe(target);
      return {
        line: `${visitorTargetKey(target)} | UNMANAGED: no grant record; retained until explicit revoke. | ${gatewayAccess}`,
        unmanaged: {
          ...(typeof target === "string" ? { email: target } : { githubAccountId: target }),
          gatewayAccess,
        },
      };
    }),
  );
  let length = lines.join("\n").length;
  let shown = 0;
  for (const row of rows) {
    if (length + row.line.length + 1 > LIST_MAX_CHARS - 240) {
      if (shown === 0) {
        throw new VisitorAccessError(
          "A visitor row exceeds the list output budget. Inspect its profile or welcome-session metadata before listing again.",
        );
      }
      break;
    }
    lines.push(row.line);
    if ("grant" in row) {
      details.grants.push(row.grant);
    } else {
      details.unmanaged.push(row.unmanaged);
    }
    length += row.line.length + 1;
    shown++;
  }
  details.omitted = total - offset - shown;
  if (details.omitted > 0) {
    details.nextCursor = `v1:${inventory}:${offset + shown}`;
    lines.push(
      `${details.omitted} entries omitted from this page. Continue visitor_list with cursor: ${details.nextCursor}`,
    );
  }
  assertCurrent();
  return { text: lines.join("\n"), details };
}
