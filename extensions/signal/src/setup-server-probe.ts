import type { WizardPrompter } from "openclaw/plugin-sdk/setup-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SignalApiMode } from "./client-adapter.js";

export type SignalSetupServerProbeParams = {
  httpUrl: string;
  account: string;
  apiMode: SignalApiMode;
};

export type SignalSetupServerProbeResult =
  | {
      ok: true;
      version?: string | null;
    }
  | {
      ok: false;
      error: string;
      accountRequired?: true;
    };

export type SignalSetupServerProbe = (
  params: SignalSetupServerProbeParams,
) => Promise<SignalSetupServerProbeResult>;

let signalSetupServerProbeForTest: SignalSetupServerProbe | undefined;

export function setSignalSetupServerProbeForTest(probe: SignalSetupServerProbe | undefined): void {
  signalSetupServerProbeForTest = probe;
}

async function defaultSignalSetupServerProbe(
  params: SignalSetupServerProbeParams,
): Promise<SignalSetupServerProbeResult> {
  const { probeSignal } = await import("./probe.js");
  const probe = await probeSignal(params.httpUrl, 5_000, {
    account: params.account,
    apiMode: params.apiMode,
  });
  if (probe.ok) {
    if (probe.error) {
      return {
        ok: false,
        error: probe.error,
      };
    }
    return { ok: true, version: probe.version };
  }
  return {
    ok: false,
    error: probe.error ?? `Signal server was not ready (${probe.readiness})`,
    ...(probe.readiness === "account_missing" ? { accountRequired: true as const } : {}),
  };
}

function resolveSignalSetupServerProbe(): SignalSetupServerProbe {
  return signalSetupServerProbeForTest ?? defaultSignalSetupServerProbe;
}

export async function promptReachableSignalServerUrl(params: {
  prompter: WizardPrompter;
  title: string;
  message: string;
  initialValue: string;
  placeholder: string;
  account: string;
  apiMode: SignalApiMode;
}): Promise<{ httpUrl: string; accountRequired?: true } | null> {
  while (true) {
    const httpUrl = normalizeOptionalString(
      await params.prompter.text({
        message: params.message,
        initialValue: params.initialValue,
        placeholder: params.placeholder,
        validate: (value) => (normalizeOptionalString(value) ? undefined : "Required"),
      }),
    );
    if (!httpUrl) {
      throw new Error("Signal server URL is required.");
    }

    const progress = params.prompter.progress("Testing Signal server URL");
    try {
      progress.update(`Testing ${httpUrl}`);
      const probe = await resolveSignalSetupServerProbe()({
        httpUrl,
        account: params.account,
        apiMode: params.apiMode,
      });
      if (probe.ok) {
        progress.stop("Signal server reachable");
        return { httpUrl };
      }
      if (probe.accountRequired) {
        progress.stop("Signal server reachable; account required");
        return { httpUrl, accountRequired: true };
      }
      progress.stop();
      await params.prompter.note(
        [
          `OpenClaw could not reach a working Signal server at ${httpUrl}.`,
          `Error: ${probe.error}`,
          "",
          "Start or fix the Signal helper, then try this URL again. OpenClaw will not save this setup until the server check passes.",
        ].join("\n"),
        params.title,
      );
    } catch (error) {
      progress.stop();
      await params.prompter.note(
        [
          `OpenClaw could not check the Signal server at ${httpUrl}.`,
          `Error: ${String(error)}`,
          "",
          "Start or fix the Signal helper, then try this URL again. OpenClaw will not save this setup until the server check passes.",
        ].join("\n"),
        params.title,
      );
    }

    const retry = await params.prompter.confirm({
      message: "Try the Signal server URL again?",
      initialValue: true,
    });
    if (!retry) {
      return null;
    }
    params.initialValue = httpUrl;
  }
}
