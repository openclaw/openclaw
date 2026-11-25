import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { stripInboundMetadata } from "../../src/auto-reply/reply/strip-inbound-meta.js";
import { readMockUserText } from "../e2e/lib/mock-inference-facts.js";

export const ANDROID_RELEASE_APPLICATION_ID = "ai.openclaw.app.debug";
const ANDROID_RELEASE_MARKERS = [
  "PHONE_FIRST",
  "PHONE_SECOND",
  "WEAR_FIRST",
  "WEAR_SECOND",
  "WEAR_RELAUNCH",
  "PHONE_RELAUNCH",
  "PHONE_RESTART",
  "LONG_REPLY",
].map((name) => `OPENCLAW_E2E_ANDROID_${name}`);
export const ANDROID_RELEASE_LONG_REPLY =
  "HEAD SENTINEL\n" +
  Array.from({ length: 85 }, (_, i) => `Reply line ${i + 1} is complete.`).join("\n") +
  "\nTRAILING SENTINEL";

type Command = (bin: string, args: string[]) => Promise<string>;

export async function androidReleaseSourceEvidence(command: Command, repo: string) {
  const status = await command("git", ["status", "--porcelain"]);
  if (!status) {
    return { clean: true };
  }
  const hash = createHash("sha256")
    .update(status)
    .update(await command("git", ["diff", "HEAD"]));
  const untracked = await command("git", ["ls-files", "--others", "--exclude-standard", "-z"]);
  for (const file of untracked.split("\0").filter(Boolean).toSorted()) {
    hash.update(file).update(await readFile(path.join(repo, file)));
  }
  return { clean: false, diffSha256: hash.digest("hex") };
}

/** Inspect the actual installed APKs, independently of Gradle's source configuration. */
export async function inspectAndroidReleaseApks(options: {
  command: Command;
  tool: (name: string) => string;
  phoneApk: string;
  wearApk: string;
}) {
  const { command, tool } = options;
  async function inspect(file: string) {
    const badging = await command(tool("aapt2"), ["dump", "badging", file]);
    const pkg = /package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/u.exec(badging);
    const signature = await command(tool("apksigner"), ["verify", "--print-certs", file]);
    const certificates = new Set(
      [
        ...signature.matchAll(
          /(?:Signer #\d+|V\d+ Signer):? certificate SHA-256 digest: ([a-f0-9]{64})/gu,
        ),
      ].map((match) => match[1]),
    );
    const certificateSha256 = [...certificates][0];
    const manifest = await command(tool("aapt2"), [
      "dump",
      "xmltree",
      file,
      "--file",
      "AndroidManifest.xml",
    ]);
    if (
      !pkg ||
      !certificateSha256 ||
      certificates.size !== 1 ||
      !manifest.includes("WearProxyListenerService")
    ) {
      throw new Error("invalid-apk-contract");
    }
    return {
      sha256: createHash("sha256")
        .update(await readFile(file))
        .digest("hex"),
      packageName: pkg[1],
      versionCode: Number(pkg[2]),
      versionName: pkg[3],
      certificateSha256,
      listenerDeclared: true,
    };
  }
  const phone = await inspect(options.phoneApk);
  const wear = await inspect(options.wearApk);
  if (
    phone.packageName !== ANDROID_RELEASE_APPLICATION_ID ||
    wear.packageName !== ANDROID_RELEASE_APPLICATION_ID ||
    phone.certificateSha256 !== wear.certificateSha256 ||
    wear.versionCode <= phone.versionCode
  ) {
    throw new Error("phone-wear-artifact-mismatch");
  }
  return {
    phone,
    wear,
    kind: "instrumented debug APKs; store release signing remains owned by the archive/upload lane",
  };
}

const transportSchema = z.object({
  role: z.enum(["phone", "wear"]),
  nodeId: z.string(),
  pid: z.number().int().positive(),
  healthy: z.literal(true),
  inbound: z.record(z.string(), z.number().int().nonnegative()),
  outbound: z.record(z.string(), z.number().int().nonnegative()),
});
export type AndroidReleaseTransportSnapshot = z.infer<typeof transportSchema> & { phase: string };

export function androidReleaseTransportSnapshot(
  input: unknown,
  role: "phone" | "wear",
  phase: string,
): AndroidReleaseTransportSnapshot {
  const health = transportSchema.parse(input);
  if (health.role !== role || health.nodeId !== `release-${role}`) {
    throw new Error("transport-identity-mismatch");
  }
  return { ...health, phase };
}

export function requireAndroidReleaseTransportEvidence(
  snapshots: AndroidReleaseTransportSnapshot[],
) {
  const find = (role: string, phase: string) => {
    const snapshot = snapshots.find((entry) => entry.role === role && entry.phase === phase);
    if (!snapshot) {
      throw new Error("transport-phase-missing");
    }
    return snapshot;
  };
  const phoneInitial = find("phone", "initial");
  const wearInitial = find("wear", "initial");
  const phone = find("phone", "reader");
  const wear = find("wear", "long-reply");
  if (
    phoneInitial.pid === phone.pid ||
    wearInitial.pid === wear.pid ||
    find("wear", "relaunch").pid !== wear.pid ||
    find("wear", "phone-restart").pid !== wear.pid
  ) {
    throw new Error("process-restart-mismatch");
  }
  const prefix = "/openclaw/wear/v1/";
  if (
    !(
      phone.inbound[`${prefix}request`]! > 0 &&
      phone.outbound[`${prefix}response`]! > 0 &&
      phone.outbound[`${prefix}event`]! > 0 &&
      wear.outbound[`${prefix}request`]! > 0 &&
      wear.inbound[`${prefix}response`]! > 0 &&
      wear.inbound[`${prefix}event`]! > 0
    )
  ) {
    throw new Error("protocol-path-not-exercised");
  }
}

/** Utility requests may quote chat markers. Count only primary-model real user turns. */
export function androidReleaseProviderEvidence(log: string) {
  const received = log
    .trim()
    .split("\n")
    .map((line) => {
      const entry = z.object({ path: z.string(), body: z.unknown() }).parse(JSON.parse(line));
      return entry.path === "/v1/responses"
        ? z
            .object({ model: z.string(), input: z.array(z.unknown()).optional() })
            .parse(JSON.parse(z.string().parse(entry.body)))
        : undefined;
    });
  const userTexts = received
    .filter((entry) => entry?.model === "android-e2e")
    .map((entry) => entry?.input?.map(readMockUserText).findLast((text) => text !== undefined))
    .filter((text): text is string => text !== undefined)
    .map((text) => stripInboundMetadata(text).trim());
  const turns = ANDROID_RELEASE_MARKERS.map((marker) => ({
    marker,
    count: userTexts.filter(
      (text) => text === `This is Android release validation. Reply with exactly: ${marker}`,
    ).length,
  }));
  if (
    turns.some(({ count }) => count !== 1) ||
    userTexts.length !== ANDROID_RELEASE_MARKERS.length
  ) {
    throw new Error("provider-message-mismatch");
  }
  return turns;
}
