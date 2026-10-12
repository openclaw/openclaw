import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import type { SsrFPolicy } from "openclaw/plugin-sdk/security-runtime";
import { z } from "zod";
import { redactCdpErrorText, withCdpSocket, type CdpSendFn } from "./cdp.helpers.js";
import { getChromeWebSocketEndpoint } from "./chrome.js";
import type { NativeBrowserPolicyStatus } from "./client.types.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";
import type { ResolvedBrowserProfile } from "./profile.types.js";

const policyEntrySchema = z.looseObject({
  value: z.json(),
  level: z.string(),
  scope: z.string(),
  source: z.string(),
  error: z.string().optional(),
  warning: z.string().optional(),
  ignored: z.boolean().optional(),
  restartRequired: z.boolean().optional(),
  future: z.boolean().optional(),
});
const identitySchema = z.object({
  browser: z.string().min(1).max(256),
  version: z.string().min(1).max(128),
  os: z.string().min(1).max(128),
  executablePath: z.string().max(4096),
});
const chromePoliciesSchema = z.object({
  chrome: z.object({ policies: z.record(z.string(), policyEntrySchema) }),
});
const policyExportSchema = z.union([
  z.object({ policyValues: chromePoliciesSchema }),
  z.object({ policyGroups: chromePoliciesSchema }),
]);

export type NativeBrowserPolicy = z.infer<typeof policyEntrySchema>;
export type NativeBrowserPolicyReport =
  | (z.infer<typeof identitySchema> & {
      state: "effective" | "none";
      policies: Record<string, NativeBrowserPolicy>;
      observedAt: number;
    })
  | { state: "unverified" | "unsupported" | "failed"; detail: string };

/** Passive status never opens browser tabs or interprets the OS policy store. */
export function nativePolicyAvailability(profile: ResolvedBrowserProfile): {
  state: "unverified" | "unsupported";
  detail: string;
} {
  if (profile.engine && profile.engine !== "chromium") {
    return {
      state: "unsupported",
      detail: "Native Chromium policy inspection is unavailable for this browser engine.",
    };
  }
  if (getBrowserProfileCapabilities(profile).usesChromeMcp || profile.driver === "extension") {
    return {
      state: "unsupported",
      detail:
        "Inspect chrome://policy in the attached browser. This transport cannot inspect native policy automatically.",
    };
  }
  return {
    state: "unverified",
    detail:
      "Run openclaw browser policy against the running browser to inspect effective native policy.",
  };
}

/** Chromium owns validation, provider precedence and policy enforcement. */
export function parseNativePolicyValues(
  identity: unknown,
  raw: unknown,
): NativeBrowserPolicyReport {
  const browserIdentity = identitySchema.parse(identity);
  // Derivatives own different policy providers. Support requires native browser
  // identity rather than a Chromium engine setting or a configured executable name.
  if (
    !["Google Chrome", "Chromium"].includes(browserIdentity.browser) ||
    browserIdentity.os !== "Linux"
  ) {
    return {
      state: "unsupported",
      detail: `Automatic native policy inspection has not been verified for ${browserIdentity.browser} on ${browserIdentity.os}. Inspect its policy page manually.`,
    };
  }
  const parsed = policyExportSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      "This browser's native policy export format is unsupported. Inspect chrome://policy manually.",
    );
  }
  const groups =
    "policyValues" in parsed.data ? parsed.data.policyValues : parsed.data.policyGroups;
  const policies = Object.fromEntries(
    Object.entries(groups.chrome.policies).toSorted(([a], [b]) => a.localeCompare(b)),
  );
  return {
    state: Object.keys(policies).length ? "effective" : "none",
    ...browserIdentity,
    policies,
    observedAt: Date.now(),
  };
}

/** Doctor is model-visible; raw enterprise values belong to explicit policy inspection. */
export function summarizeNativePolicy(
  report: NativeBrowserPolicyReport,
): NativeBrowserPolicyStatus {
  return {
    state: report.state,
    detail:
      "policies" in report
        ? `${report.browser}: ${Object.keys(report.policies).length} loaded policy entries; browser owns validation and enforcement`
        : report.detail,
  };
}

const POLICY_VALUES_EXPRESSION = `(async () => {
  const read = async () => {
    if (location.href !== 'chrome://policy/') throw new Error('Native policy page did not load');
    if (document.readyState !== 'complete') await new Promise(resolve => window.addEventListener('load', resolve, {once:true}));
    const {addWebUiListener} = await import('chrome://resources/js/cr.js');
    return await new Promise(resolve => {
      addWebUiListener('policies-updated', (_names, groups) => resolve(groups));
      chrome.send('listenPoliciesUpdates');
    });
  };
  let timer;
  try {
    return await Promise.race([read(), new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('Native policy inspection timed out; inspect chrome://policy manually')), 5000);})]);
  } finally {clearTimeout(timer);}
})()`;

async function evaluateNativePage(
  send: CdpSendFn,
  sessionId: string,
  url: string,
  expression: string,
  signal: AbortSignal,
): Promise<unknown> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const ready = z.object({ result: z.object({ value: z.boolean().optional() }) }).parse(
      await send(
        "Runtime.evaluate",
        {
          expression: `location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`,
          returnByValue: true,
        },
        sessionId,
      ),
    );
    if (ready.result.value === true) {
      const result = z
        .object({
          result: z.object({ value: z.unknown().optional() }),
          exceptionDetails: z.unknown().optional(),
        })
        .parse(
          await send(
            "Runtime.evaluate",
            {
              expression,
              awaitPromise: true,
              returnByValue: true,
            },
            sessionId,
          ),
        );
      if (result.exceptionDetails) {
        throw new Error(
          "Native policy inspection failed. Inspect chrome://policy manually; this browser may restrict internal pages or use an unsupported WebUI version.",
        );
      }
      if (JSON.stringify(result.result.value)?.length > 256_000) {
        throw new Error("Native policy response exceeds the inspection limit.");
      }
      return result.result.value;
    }
    await sleepWithAbort(100, signal);
  }
  throw new Error("Native browser page did not load. Inspect chrome://policy manually.");
}

export async function inspectNativeBrowserPolicy(params: {
  profile: ResolvedBrowserProfile;
  ssrfPolicy?: SsrFPolicy;
  signal: AbortSignal;
  assertCurrent?: () => Promise<void>;
}): Promise<NativeBrowserPolicyReport> {
  const availability = nativePolicyAvailability(params.profile);
  if (availability.state === "unsupported") {
    return availability;
  }
  try {
    const endpoint = await getChromeWebSocketEndpoint(
      params.profile.cdpUrl,
      2000,
      params.ssrfPolicy,
      params.signal,
    );
    if (!endpoint) {
      return {
        state: "unverified",
        detail:
          "Browser control is unavailable. Run openclaw browser start; if enterprise policy disables remote debugging, contact the administrator and inspect chrome://policy manually.",
      };
    }
    return await withCdpSocket(
      endpoint.url,
      async (send) => {
        await params.assertCurrent?.();
        params.signal.throwIfAborted();
        const { targetId } = z
          .object({ targetId: z.string().min(1) })
          .parse(await send("Target.createTarget", { url: "chrome://version" }));
        try {
          const { sessionId } = z
            .object({ sessionId: z.string().min(1) })
            .parse(await send("Target.attachToTarget", { targetId, flatten: true }));
          params.signal.throwIfAborted();
          const identity = await evaluateNativePage(
            send,
            sessionId,
            "chrome://version/",
            `(async () => {
          const {loadTimeData} = await import('chrome://resources/js/load_time_data.js');
          return {browser:loadTimeData.getString('application_label'), version:loadTimeData.getString('version'), os:loadTimeData.getString('os_type'), executablePath:document.getElementById('executable_path')?.textContent?.trim() || ''};
        })()`,
            params.signal,
          );
          await params.assertCurrent?.();
          params.signal.throwIfAborted();
          await send("Page.navigate", { url: "chrome://policy" }, sessionId);
          const values = await evaluateNativePage(
            send,
            sessionId,
            "chrome://policy/",
            POLICY_VALUES_EXPRESSION,
            params.signal,
          );
          return parseNativePolicyValues(identity, values);
        } finally {
          // Close only the diagnostic target; cancellation still needs compensation.
          await send("Target.closeTarget", { targetId });
        }
      },
      {
        lookup: endpoint.lookup,
        commandTimeoutMs: 8000,
        handshakeRetries: 0,
        signal: params.signal,
      },
    );
  } catch (error) {
    params.signal.throwIfAborted();
    return {
      state: "failed",
      detail: redactCdpErrorText(error instanceof Error ? error.message : String(error)).slice(
        0,
        1000,
      ),
    };
  }
}
